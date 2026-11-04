import {
  BasicIndex,
  createCollection,
  createLiveQueryCollection,
  eq,
  not,
} from "@tanstack/db"
import { QueryClient } from "@tanstack/query-core"
import { queryCollectionOptions } from "@tanstack/query-db-collection"
import { expect, test } from "vitest"

type Row = { id: number; date: string | null; status: number }

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

// 300 rows, 60 of them filtered out by `status != 4`. The first `nullCount`
// rows have a NULL date.
function makeRows(nullCount: number): Row[] {
  return Array.from({ length: 300 }, (_, i) => ({
    id: i + 1,
    date:
      i < nullCount ? null : `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
    status: i % 5 === 0 ? 4 : 1,
  }))
}

// Fake backend that behaves like Postgres: evaluates `where` (including the
// loader's cursor predicates), sorts with NULLS FIRST/LAST, applies
// offset/limit.
// biome-ignore lint/suspicious/noExplicitAny: tiny IR evaluator
function evaluate(e: any, row: any): any {
  if (e.type === "val") return e.value
  if (e.type === "ref") return row[e.path.join(".")]
  const a = e.args.map((x: unknown) => evaluate(x, row))
  switch (e.name) {
    case "and":
      return a.every(Boolean)
    case "or":
      return a.some(Boolean)
    case "not":
      return !a[0]
    case "isNull":
    case "isUndefined":
      return a[0] == null
    case "eq":
      return a[0] != null && a[0] === a[1]
    case "gt":
      return a[0] != null && a[1] != null && a[0] > a[1]
    case "gte":
      return a[0] != null && a[1] != null && a[0] >= a[1]
    case "lt":
      return a[0] != null && a[1] != null && a[0] < a[1]
    case "lte":
      return a[0] != null && a[1] != null && a[0] <= a[1]
    default:
      throw new Error(`fake backend: unsupported ${e.name}`)
  }
}

// biome-ignore lint/suspicious/noExplicitAny: LoadSubsetOptions
function serve(rows: Row[], o: any): Row[] {
  const out = rows.filter((r) => (o.where ? evaluate(o.where, r) : true))
  for (const term of [...(o.orderBy ?? [])].reverse()) {
    const { direction, nulls } = term.compareOptions
    out.sort((x, y) => {
      const a = evaluate(term.expression, x)
      const b = evaluate(term.expression, y)
      if (a == null || b == null) {
        if (a == null && b == null) return 0
        return (a == null) === (nulls === "first") ? -1 : 1
      }
      const c = a < b ? -1 : a > b ? 1 : 0
      return direction === "desc" ? -c : c
    })
  }
  const offset = o.offset ?? 0
  return out.slice(offset, o.limit ? offset + o.limit : undefined)
}

type Scenario = {
  nullCount: number
  stringSort?: "lexical" | "locale"
  indexed?: boolean
  /** Release the old window before subscribing the new one. */
  releaseFirst?: boolean
}

/**
 * Mounts an ordered, limited window (DESC), then switches it to ASC the way a
 * UI framework does when a reactive sort changes: the new live query is
 * subscribed, then the old one is released.
 */
async function switchSortDirection(s: Scenario) {
  const rows = makeRows(s.nullCount)
  const requests: string[] = []
  const source = createCollection(
    queryCollectionOptions<Row>({
      id: `rows-${JSON.stringify(s)}`,
      getKey: (r) => r.id,
      queryClient: new QueryClient(),
      queryKey: ["rows"],
      syncMode: "on-demand",
      queryFn: async (ctx) => {
        await wait(20)
        const o = ctx.meta?.loadSubsetOptions ?? {}
        const data = serve(rows, o)
        requests.push(`limit=${o.limit ?? "none"} -> ${data.length} rows`)
        return data
      },
    }),
  )
  if (s.indexed) {
    // Indexes matching each window's compareOptions, as the dev warning asks.
    for (const nulls of ["first", "last"] as const)
      source.createIndex((r) => r.date, {
        indexType: BasicIndex,
        options: {
          compareOptions: {
            direction: "asc",
            nulls,
            stringSort: s.stringSort ?? "lexical",
          },
        },
      })
    source.createIndex((r) => r.status, { indexType: BasicIndex })
  }

  const window = (direction: "asc" | "desc") =>
    createLiveQueryCollection((q) =>
      q
        .from({ r: source })
        .where(({ r }) => not(eq(r.status, 4)))
        .orderBy(({ r }) => r.date, {
          direction,
          nulls: direction === "desc" ? "first" : "last",
          stringSort: s.stringSort ?? "lexical",
        })
        .orderBy(({ r }) => r.id, direction)
        .limit(50),
    )

  const desc = window("desc")
  const descSub = desc.subscribeChanges(() => {})
  await wait(300)
  const before = { window: desc.size, source: source.size }

  const releaseDesc = async () => {
    descSub.unsubscribe()
    await desc.cleanup()
  }
  if (s.releaseFirst) await releaseDesc()
  const asc = window("asc")
  const ascSub = asc.subscribeChanges(() => {})
  if (!s.releaseFirst) await releaseDesc()
  await wait(500)

  const after = { window: asc.size, source: source.size }
  console.log(JSON.stringify(s), { before, after, requests })
  ascSub.unsubscribe()
  await asc.cleanup()
  return { after, before }
}

test("control: no NULL dates", async () => {
  const { before, after } = await switchSortDirection({ nullCount: 0 })
  expect(before.window).toBe(50)
  expect(after.window).toBe(50)
  expect(after.source).toBeGreaterThan(0)
})

test("control: NULL page end, old window released before the new one subscribes", async () => {
  const { after } = await switchSortDirection({
    nullCount: 130,
    releaseFirst: true,
  })
  expect(after.window).toBe(50)
  expect(after.source).toBeGreaterThan(0)
})

// With DESC NULLS FIRST, the first page of 50 ends on a NULL date, so the
// loader falls back to reading the whole filter (documented fallback).
test("BUG: first page ends on NULL -> source emptied after the sort switch", async () => {
  const { before, after } = await switchSortDirection({ nullCount: 130 })
  expect(before.window).toBe(50)
  expect(after.window).toBe(50) // actual: 0
  expect(after.source).toBeGreaterThan(0) // actual: 0
})

test("BUG: same with indexes matching the compareOptions", async () => {
  const { after } = await switchSortDirection({ indexed: true, nullCount: 130 })
  expect(after.window).toBe(50) // actual: 0
  expect(after.source).toBeGreaterThan(0) // actual: 0
})

// Another trigger of the full-source fallback, without any NULL.
test("BUG: locale string sort, no NULL -> source emptied too", async () => {
  const { after } = await switchSortDirection({
    nullCount: 0,
    stringSort: "locale",
  })
  expect(after.window).toBe(50) // actual: 0
  expect(after.source).toBeGreaterThan(0) // actual: 0
})

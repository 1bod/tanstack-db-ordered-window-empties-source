# TanStack DB: switching an ordered window empties the source collection

Minimal reproduction for `@tanstack/db@1.0.0-rc.1.3`,
`@tanstack/query-db-collection@1.5.1`, `@tanstack/query-core@5.105.3`.

```sh
npm install
npm test   # 2 controls pass, 3 BUG tests fail
```

## Setup

- One `syncMode: "on-demand"` query collection, 300 rows, static `queryKey`.
- A fake backend (`serve()` in `repro.test.ts`) that honours `where` (with
  cursor predicates), `orderBy` with `NULLS FIRST/LAST`, `offset` and `limit`,
  like Postgres does.
- One live query:
  `where(status != 4).orderBy(date, desc, nulls first).orderBy(id, desc).limit(50)`.

The test mounts the DESC window, waits, then switches it to ASC the way a UI
framework does when a reactive sort changes. It subscribes the new live query
first, then releases the old one.

## Result

| Scenario | Requests (`limit` -> rows) | Source after | ASC window |
| --- | --- | --- | --- |
| control: no NULL dates | 50, none -> 8 (tie), 50, none -> 240 | 240 | 50 |
| control: NULL page end, old window released **before** the new one subscribes | 50, none -> 240, 50, none -> 4 | 52 | 50 |
| **BUG**: first page ends on NULL | 50, none -> 240, 50, none -> 240 | **0** | **0** |
| **BUG**: same, with indexes matching the compareOptions (no dev warning) | same | **0** | **0** |
| **BUG**: `stringSort: "locale"`, no NULL at all | same | **0** | **0** |

Expected: the ASC window shows 50 rows and the source collection keeps them.

## What it looks like

The bug shows when both windows fall back to a full-source read (no `limit`)
of the **same filter**:

1. The DESC window's first page ends on a NULL `date` (or `stringSort` is
   `locale`). The loader falls back to a full-source read of
   `status != 4`. This fallback is documented.
2. The ASC window subscribes while the DESC window still holds that subset. It
   also does a full-source read of `status != 4`: the identical subset.
3. The DESC window is released. All rows leave the source collection, even
   though the ASC window still needs them. The ASC window stays at 0 rows and
   does not recover.

Both changing the order (release first) and avoiding the identical
full-source subset (the no-NULL control only reads the boundary tie) make it
work. Two plain unordered live queries with the same `where`, overlapping the
same way, keep their rows. The bug seems specific to subsets acquired by the
ordered loader's full-source fallback.

## Where we hit it

In a Vue app (`useLiveQuery` / `useLiveInfiniteQuery`), a task list sorted by
a nullable date `DESC NULLS FIRST`. Toggling the sort direction emptied the
shared tasks collection for every view. Our workaround is to split the query
into a `isNull(date)` window and a `not(isNull(date))` window with
`stringSort: "lexical"`, so no page boundary is ever NULL.

Possibly related: TanStack/db#2160 (rows lost across reentrant final-owner
cleanup), TanStack/db#2352 (identical subset reuse), TanStack/db#2268
(full-source fallback on NULL page ends).

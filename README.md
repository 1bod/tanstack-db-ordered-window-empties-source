# TanStack DB: switching an ordered window empties the source collection

`@tanstack/db@1.0.0-rc.1.3`, `@tanstack/query-db-collection@1.5.1`,
`@tanstack/query-core@5.105.3`.

```sh
npm install
npm test   # 2 controls pass, 3 BUG tests fail
```

An on-demand query collection (fake Postgres-like backend in `serve()`) and
one live query:

```ts
q.from({ r: source })
  .where(({ r }) => not(eq(r.status, 4)))
  .orderBy(({ r }) => r.date, { direction, nulls, stringSort: "lexical" })
  .orderBy(({ r }) => r.id, direction)
  .limit(50)
```

The test mounts it DESC, then switches to ASC like a UI framework does:
subscribe the new live query, then release the old one.

| Scenario | Source after | ASC window |
| --- | --- | --- |
| control: no NULL dates | 240 | 50 |
| control: NULL page end, old window released first | 52 | 50 |
| **BUG**: first page ends on NULL | **0** | **0** |
| **BUG**: same, with indexes matching the compareOptions | **0** | **0** |
| **BUG**: `stringSort: "locale"`, no NULL | **0** | **0** |

In the failing cases both windows fall back to a full-source read of the same
filter. Releasing the old window removes all rows, though the new window holds
the same subset.

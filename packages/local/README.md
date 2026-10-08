# @wainwright/local: tickets on the home network

`tickets.wainwright.fun` served from the Mac Studio (Wainsburys/local docker compose service `tickets`, `Dockerfile.local` at the repo root), on the shared Postgres database. Hosted (CDK stacks, Lambda, DynamoDB) is untouched; nothing here deploys anything.

- **Handlers.** `src/routes.ts` runs the hosted `packages/infra/lambda/task-routes.ts` unchanged. `src/pg-ddb.ts` (`PgDocumentClient`) answers its DynamoDB document-client calls (Get/Put/Delete/Query/Scan on tasks, task-completions, job-board, rewards, reward-redemptions, term-dates) from schema `tickets` and `core.term_dates`; anything else throws. `build.mjs` swaps the hosted `kid-routes` and `budget-routes` imports for `src/shims/` (no device tokens, no Wainsbury's budget).
- **Schema** (`migrations/001_tickets.sql`): `tickets.tasks`, `board`, `awards`, `rewards`, `redemptions`, view `balances`; children are `core.people` ids (foreign keys and a trigger for `assigned_to`). Spendable = all awards − all redemptions, as hosted. `tickets.award(...)`/`tickets.revoke(...)` let another app (household) award tickets in its own transaction; those awards cannot be edited or deleted through the tickets API.
- **Identity** (`src/identity.ts`, the same code as Snacks): by client IP from `core.devices` (Caddy's `X-Real-IP`). Kid devices: that kid only, never the admin. Parent devices: admin plus "act as" any child. Unknown: "This device isn't set up", no data. No sign-in, pairing or tokens.
- **Every API request is one transaction**; writes take an advisory lock, so two redeems cannot overspend.
- **Front ends.** The kid app (`apps/tickets`, built with `VITE_LOCAL_AUTH=1 VITE_API_URL=/api` into `dist-local`) and the admin's Tickets panel alone (`apps/admin/local-tickets.html`, `vite.local-tickets.config.ts`, served at `/admin/`).
- **Import** (`src/import-hosted.ts`): from read-only scans of the six hosted tables; mirrors the library, upserts hosted awards and redemptions, keeps local ones, and commits only when the result matches hosted item for item with equal balances. Idempotent. See Wainsburys/local README "Tickets".

```bash
pnpm --filter @wainwright/local build
TICKETS_TEST_DATABASE_URL=postgres://wainsburys:wainsburys@127.0.0.1:5432/tickets_local_test pnpm --filter @wainwright/local test
pnpm --filter @wainwright/local typecheck
```

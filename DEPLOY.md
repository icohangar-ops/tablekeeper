# Deploy runbook — production in ~10 minutes

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Ficohangar-ops%2Ftablekeeper&root-directory=app&project-name=tablekeeper)

The button pre-selects `app/` as the Root Directory — you only paste a Neon
pooled URL as `DATABASE_URL`. The manual path below is equivalent.

The app is deploy-ready: set one env var (`DATABASE_URL`) and ship it. No
DATABASE_URL? It still runs — on an embedded Postgres 17 (PGlite/WASM) with
the identical schema and invariant — but on serverless every instance gets a
fresh embedded database, so **production demos must use a real Postgres**.

## 1 · Database — Neon (free tier)

1. Sign up at <https://neon.tech> (GitHub login works).
2. Create a project (region closest to where you'll deploy, e.g. `aws-us-east-1`).
3. Copy the **pooled** connection string — it looks like:
   ```
   postgresql://USER:PASS@ep-xxxx-pooler.region.aws.neon.tech/neondb?sslmode=require
   ```
   Keep `?sslmode=require`. The pooled endpoint matters under serverless
   (many short-lived lambdas, few Postgres connections).

Everything else is automatic on first boot: schema (incl. `btree_gist` and the
`reservation_no_overlap` exclusion constraint) and seed data are applied
behind a Postgres advisory lock, so any number of cold-starting instances can
race safely — exactly one applies the boot.

Verify locally before deploying (optional):

```bash
cd app
DATABASE_URL="<neon pooled url>" npm run db:migrate
# expect: [tablekeeper] invariant constraint reservation_no_overlap: present ✓
```

## 2 · Vercel

1. Push the repo (already on <https://github.com/icohangar-ops/tablekeeper>).
2. <https://vercel.com/new> → import `icohangar-ops/tablekeeper`.
3. **Root Directory: `app`** (the Next.js app lives in `app/`).
4. Environment variable: `DATABASE_URL` = the Neon pooled string (all environments).
5. Deploy.

Framework detection: Next.js. Node runtime is already declared per route
(`runtime = "nodejs"`); `db/schema.sql` is force-included in serverless output
via `outputFileTracingIncludes`; `@electric-sql/pglite` is marked external so
its WASM/extension bundles resolve from disk (harmless when unused in prod).

## 3 · Post-deploy checks

```bash
# liveness + the invariant self-check (must say engine "postgres",
# constraintPresent: true)
curl https://<app>.vercel.app/api/health | jq

# evidence feed
curl "https://<app>.vercel.app/api/audit?limit=5"
```

Then open `/kill-demo` and fire 12 racers — the money shot. Expected verdict:
**exactly one 201, everyone else 409**.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `constraintPresent: false` | `btree_gist` missing — Neon supports it; re-run `npm run db:migrate` with `DATABASE_URL` set |
| Connection timeouts | Use the **pooled** (`-pooler`) Neon endpoint; don't use direct endpoints |
| SSL errors | Keep `?sslmode=require` on the URL |
| Fresh DB but empty restaurants | Seed runs on first request; check `/api/restaurants` after one page load |
| Data "disappears" locally | You're on PGlite with no `TK_DATA_DIR` — set `TK_DATA_DIR=./.tkdata` to persist between restarts |

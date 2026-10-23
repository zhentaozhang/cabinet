# ADR 2026-10-22: Delivery pipeline (CI / CD / Docker / Makefile)

- **Status:** Proposed (rev 3, 2026-10-22)
- **Scope:** `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `compose.prod.yml`,
  `compose.smoke.yml`, `Makefile`, `pnpm-workspace.yaml`, `.github/workflows/ci.yml`,
  `.github/workflows/release.yml`, `src/app/api/health/route.ts`, `src/proxy.ts`,
  `src/app/login/page.tsx`, startup env validation, `.env.example`, `.env.prod.example`, `.nvmrc`,
  `package.json` `engines`, `next.config.ts`, `scripts/check-migration.ts`, `docs/runbook.md`.
- **Non-goals:** splitting into `apps/web` + `apps/api`; a queue/worker implementation; object
  storage; a staging environment; Kubernetes; semantic retrieval; moving timezone handling out of
  `src/lib/format.ts` (recorded as a follow-up in D16).

## Context

The repository already runs a verification pipeline. `.github/workflows/ci.yml` is a single
`verify` job against a `postgres:18` service container:
`pnpm install --frozen-lockfile → db:migrate → typecheck → lint → test → build`. It is green and
genuinely useful, but it only **verifies** — it caches nothing, produces no image, and deploys
nowhere. `docker-compose.yml` exists but holds a single `db` service. There is no Dockerfile, no
`.dockerignore`, no Makefile, and no delivery workflow.

The work was deferred on the grounds that "the multi-Agent composition is not finished yet". That
reasoning is half right. What a multi-Agent composition changes is the **process topology and
external dependencies**: `docs/superpowers/plans/2026-10-22-external-connectors.md` introduces
`connectors` / `tool_calls` / `outbox` plus exponential-backoff retry, and that is the first
component that genuinely needs a resident worker; `2026-10-22-data-trust-and-real-data.md` Task 8
needs object storage and Task 7 needs a server-side secret store. What it does **not** change is
how an image is built, migrated, or released. Deferring the pipeline on that basis conflates a
topology decision with a build decision.

The protocol layer is already deployment-shaped, which is the strongest evidence that
containerising now is safe:

- Production forces authentication (`src/proxy.ts:5-10`; `src/lib/auth/mode.ts:5-10` makes
  `isAuthRequired()` true whenever `NODE_ENV=production`).
- Destructive endpoints self-disable in production (`src/app/api/demo/reset/route.ts:5-14`,
  `scripts/seed.ts:8-17`).
- Rate limiting and the audit chain are database-backed and therefore multi-instance safe
  (`src/lib/api/rate-limit.ts:19-35` upserts a `rate_limits` counter atomically;
  `src/lib/audit.ts:49` serialises per-user chains with
  `select pg_advisory_xact_lock(hashtext(${input.userId}))`).
- Nine of ten pages declare `export const dynamic = "force-dynamic"`; there is no ISR, no
  `next/image`, no `"use server"`, and no `instrumentation.ts`. There is no cache-coherence problem
  to solve at the infrastructure layer.

### Three gaps that block delivery

1. **The runtime image cannot migrate.** `drizzle-kit` and `tsx` are devDependencies, and
   `db:migrate` / `db:seed` / `db:sync-policy` need the repository plus those devDeps. A
   `standalone` output contains neither.
2. **There is no health endpoint.** `/api/health` does not exist among the 36 `route.ts` files, so
   neither the container healthcheck nor automated rollback has a probe to attach to.
3. **There is no single source of version truth.** CI pins `node-version: 22` (`ci.yml:39`), the
   local machine runs v24.17.0, and `package.json` has neither `engines` nor a `.nvmrc`.

### Pre-existing defects found while writing this ADR

Live bugs, not artefacts of the proposed design. L1 fixes them anyway, and two would have silently
sabotaged the pipeline.

**B1 — `docker compose up -d` cannot start the development database at all.**
`docker-compose.yml:12` mounts the volume at `/var/lib/postgresql/data`. In `postgres:18` the image
sets `PGDATA=/var/lib/postgresql/18/docker` and declares `VOLUME /var/lib/postgresql` (verified
with `docker image inspect postgres:18`). The entrypoint treats a mount at
`/var/lib/postgresql/data` as a legacy database and **refuses to start**:

```
Error: in 18+, these Docker images are configured to store database data in a
       format which is compatible with "pg_ctlcluster" ...
       Counter to that, there appears to be PostgreSQL data in:
         /var/lib/postgresql/data (unused mount/volume)
```

Observed directly: `cabinet-db` is `Exited (1)` with exactly this message, and the mount is
detected even when the volume is empty — `(unused mount/volume)` is literal. The repo's only
Docker path to a database is therefore dead, and local development actually runs against a native
Postgres on 5432 (hence the `zhentao@localhost:5432` fallbacks and `.env.example:1`).

**B2 — the new health endpoint would be 401'd by our own middleware.**
`src/proxy.ts:11-18` whitelists only `/login`, `/api/auth*`, `/_next*`, `/favicon.ico`, and the
matcher at `src/proxy.ts:39` covers `/api/health`; `src/proxy.ts:25-30` returns 401 JSON without a
session cookie. A health endpoint added without touching the whitelist would make the container
permanently unhealthy, so every deploy would roll back.

**B3 — `.env.example` does not match `docker-compose.yml`.** `.env.example:1` points at
`postgres://user@localhost:5432/cabinet_dev`; the compose service exposes **5433** with user and
password `cabinet` against `cabinet_dev` (`docker-compose.yml:5-9`). `.env.example:12` also ships
`DEMO_LOGIN_ENABLED=true`, which — copied into a `.env.prod` starting point — configures a
password-bypassing login entry point.

**B4 — one page bakes environment into the build.** `src/app/login/page.tsx:9-13` reads
`DEMO_LOGIN_ENABLED`, `AUTH_REQUIRED`, and `NODE_ENV` with no `export const dynamic`, so it is
prerendered at build time. It renders correctly today only because CI builds with
`AUTH_REQUIRED=false` and `NODE_ENV=production`; the values are nevertheless frozen into the HTML.

**B5 — other silent fallbacks.** `drizzle.config.ts:9-12` duplicates the
`postgres://zhentao@localhost:5432/cabinet_dev` fallback from `src/lib/db/index.ts:6-8`, and
`tests/global-setup.ts:20-22` duplicates it as `cabinet_test`. CI sets `DATABASE_URL_TEST`
(`ci.yml:27`) so CI is unaffected, but a fresh Linux checkout without that variable tries to
connect as user `zhentao`.

**B6 — the CI `db:migrate` step is redundant.** `tests/global-setup.ts:34-44` creates
`<db>_<runId>` and `:50-55` applies every migration from `drizzle/` into it. The `cabinet_test`
database that `ci.yml:42` migrates is never read by any test.

**B7 — the compose project name is shared.** `docker compose config` on the current file resolves
`name: cabinet`. Putting `compose.prod.yml` and `compose.smoke.yml` in the same directory would give
all three stacks the project name `cabinet`, so `docker compose -f compose.smoke.yml down -v` would
destroy the development volume `cabinet_pgdata` — a local smoke test silently deleting the dev
database. `docker-compose.yml:4`'s `container_name: cabinet-db` is additionally a global name that
blocks two stacks from coexisting.

## Decisions

### D1 — Three layers; L1 is independent of Agent progress

| Layer | Deliverables | Acceptance | Blast radius |
|---|---|---|---|
| **L1 Reproducible** | `Makefile`, `.nvmrc` + `engines` + `engineStrict`, `.env.example` / `.env.prod.example`, `Dockerfile`, `.dockerignore`, `/api/health` + proxy whitelist, startup validation, B1–B7 fixes, `src/app/login/page.tsx` `force-dynamic`, `scripts/check-migration.ts`, `ci.yml` rework, `docs/runbook.md` skeleton | `make ci` green locally; `make docker-smoke` returns 200 for `/api/health` with `db:"ok"` **and** 200 for a real `_next/static` asset it extracted from a page | none (never touches a host) |
| **L2 Production loop** | `compose.prod.yml` (caddy + web + db), `make bootstrap` / `backup` / `restore-test` / `restore` / `deploy` / `rollback`, completed `docs/runbook.md` | `make deploy` succeeds on the VPS; a restored dump is readable; a failed health check rolls back | one VPS |
| **L3 Continuous delivery** | GHCR push, SSH deploy job, automatic rollback | the D14 rehearsal passes | automation only |

L1 lands first with zero production risk. L2 and L3 need no redesign when the worker arrives,
because the worker is a `command` on an existing image target plus one compose service.

### D2 — One image, multiple targets, explicit image naming

`runtime` is the deliverable web image: `standalone` output, production dependencies only,
`USER node`, `CMD ["node", "server.js"]`. `tools` retains devDeps (`drizzle-kit`, `tsx`) plus
`drizzle/` and `scripts/`, and runs migrations and operational scripts. Both derive from one `build`
stage, so migration code is always the exact revision of the running image, and the VPS needs no
node, no pnpm, and no checkout to migrate.

**Image naming is defined once** — the earlier draft used `IMAGE_TAG` in compose and `TAG` in the
Makefile, which fails at compose interpolation time (`${IMAGE_TAG:?}` is a config-parse error, so
`make deploy` would die before `pull`, and rollback would die the same way):

```make
IMAGE     ?= ghcr.io/<owner>/cabinet
IMAGE_TAG := $(TAG)-runtime       # TAG comes from the command line
TOOLS_TAG := $(TAG)-tools
export IMAGE IMAGE_TAG TOOLS_TAG
```

`compose.prod.yml` references only `${IMAGE}:${IMAGE_TAG:?run make deploy TAG=<sha>}` and
`${IMAGE}:${TOOLS_TAG:?}`; `.release/current` stores the bare sha, never a suffixed tag. Both
suffixed tags are pushed by the release workflow and produced by `make docker-build`.

Three details are load-bearing and easy to omit:

- **`standalone` does not include `public/` or `.next/static/`.** Per
  `node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/output.md` they
  must be copied explicitly. Omitting them yields a white page while `/api/health` still returns
  200 — a *false green* in every health-based gate, which is why D9 asserts a real asset.
- **`HOSTNAME` / `PORT` are set in compose `environment:`, not only as image `ENV`.** Docker
  injects `HOSTNAME=<container-id>` at container creation, and the generated `server.js` reads
  `process.env.HOSTNAME || '0.0.0.0'`. Rather than rely on the precedence between image `ENV` and
  runtime injection, the authoritative value is set in the service definition; the image keeps
  `ENV PORT=3000` as a default.
- **The build stage must install devDependencies.** `next build` defaults to Turbopack in Next 16
  and the CSS pipeline depends on `@tailwindcss/turbopack`, a devDependency. Only `runtime` is
  pruned.

`output: "standalone"` is test-neutral: it changes only `next build`'s output layout, `next dev`
does not use it, and no test runs `next build` (only `tests/unit/security-headers.test.ts:3`
imports `next.config.ts`, to assert `headers()` exists).

The web container is a monolith: RSC calls its own `/api/*` over loopback. `apps/web` + `apps/api`
is deliberately not done now — it would add cross-container HTTP, CORS, and cookie `SameSite`
rework for no present benefit. `compose.prod.yml` declares a `worker` service under
`profiles: ["worker"]`, disabled by default and **not implemented** (no worker entry point exists
in `scripts/`). It exists so that adopting a resident worker is a profile and a command, not a
rebuild of the delivery model; no Make target may depend on it.

### D3 — Node 24; `.nvmrc` is the source, `engineStrict` is the guard

| Version | Status (2026-10) | EOL |
|---|---|---|
| 22 | maintenance, security fixes only | 2027-04-30 |
| **24** | **Active LTS** | **2028-04-30** |
| 26 | Current | 2029-04-30 |

Pin 24: Active LTS, matching the local machine, without betting production on a non-LTS release.
`.nvmrc` holds `24`; `package.json` gets `engines.node: ">=24 <25"`; CI uses
`node-version-file: .nvmrc`; the Dockerfile takes `ARG NODE_VERSION=24`, overridden by
`--build-arg NODE_VERSION=$(cat .nvmrc)`.

`engines` alone is documentation: `engineStrict` defaults to false and `pnpm install` exits 0
silently on a mismatched Node (verified). It becomes a guard only with `engineStrict: true` in
`pnpm-workspace.yaml` (pnpm ≥11 moved `engine-strict` out of `.npmrc`). A CI consistency check
covers the Dockerfile side:

```bash
test "$(cat .nvmrc)" = "$(node -p 'process.versions.node.split(".")[0]')"
```

`ci.yml:34-36` must drop its `version: 11` input so that `packageManager: pnpm@11.15.1` is the only
pnpm declaration. The image activates pnpm through corepack.

### D4 — Three compose files, three project names, production never publishes the database port

`docker-compose.yml` stays development-only (it publishes `5433:5432` for a local GUI client);
production has the opposite requirement. Keeping both in one file behind `profiles` means someone
eventually exposes the production database with a plain `up`.

Per B7 every file gets an explicit top-level `name:` — `cabinet-dev`, `cabinet-smoke`,
`cabinet-prod` — and `docker-compose.yml:4`'s `container_name: cabinet-db` is removed. Without
this, `docker compose -f compose.smoke.yml down -v` deletes `cabinet_pgdata` and takes the
development database with it.

**B1 is fixed in the dev file too**, since the mistake would otherwise be copied forward:

```yaml
volumes:
  - cabinet_pgdata:/var/lib/postgresql      # NOT /var/lib/postgresql/data
```

Data at the old path needs a `pg_dump` from a `postgres:17` container and a restore into the new
layout; the entrypoint's pg_upgrade path applies only within the 18+ layout. Development data is
rebuilt instead — noting that an empty volume is **not** immediately seedable, because
`src/lib/db/seed.ts:67` begins with `TRUNCATE` and needs the schema to exist:

```sh
make db-up && make db-migrate && ALLOW_DESTRUCTIVE_SEED=true make db-seed
```

Production topology:

```
caddy    :80/:443   ACME certificates, reverse_proxy to web:3000, volumes caddy_data/caddy_config
web      expose 3000  ${IMAGE}:${IMAGE_TAG}
                      env_file .env.prod (mode 600), depends_on db(healthy)
                      healthcheck → /api/health, restart: unless-stopped
                      HOSTNAME=0.0.0.0, PORT=3000, TZ=<product tz>
                      mem_limit 1g, NODE_OPTIONS=--max-old-space-size=768
db       postgres:18  no published ports, volume cabinet_pgdata:/var/lib/postgresql
                      healthcheck pg_isready, POSTGRES_USER/PASSWORD/DB from .env.prod
migrate  profiles: ["tools"]    ${IMAGE}:${TOOLS_TAG}, command drizzle-kit migrate
worker   profiles: ["worker"]   ${IMAGE}:${TOOLS_TAG}, reserved, not implemented
```

Every service carries the same logging cap, because unbounded `json-file` logs fill the disk and a
full disk makes Postgres PANIC — a worse failure than a 502:

```yaml
x-logging: &logging
  driver: json-file
  options: { max-size: "10m", max-file: "3" }
```

Memory limits are part of the design, not a nicety: `src/lib/llm.ts:61-62` aborts only after 20
seconds, so concurrent SSR requests hold memory for a long time, and without a cap the OOM killer
may choose `postgres` on a 2 GB host. Pool sizing is a budget rather than a constant:
`instances × DATABASE_POOL_MAX ≤ max_connections − 20`. With one instance and
`DATABASE_POOL_MAX=10` (`src/lib/db/index.ts:20`, capped at 50) there is ample headroom against
Postgres's default 100.

`restart: unless-stopped` restarts only on **process exit**; a container that is alive but
`unhealthy` (for example because the database is unreachable) is never restarted by compose. That
is the correct behaviour — restarting web cannot fix a database outage — but it means
"alive but unhealthy" is invisible without external monitoring, which is recorded in D16.

### D5 — Environment variables are classified by lifecycle

**Build-time: none required.** `NEXT_PUBLIC_API_BASE_URL` (`src/lib/api/browser.ts:8-11`) defaults
to `""` with `credentials: "same-origin"`, and `NEXT_PUBLIC_BETTER_AUTH_URL`
(`src/lib/auth-client.ts:4-7`) defaults to `window.location.origin` in the browser and `undefined`
on the server. Both mean same-origin, so **one image promotes from local to production without a
rebuild** — a direct benefit of not splitting the frontend from the backend, since separate domains
would turn both into build-time inputs and force one image per environment.

The claim is narrower than "nothing is baked in": B4 is a counter-example today, fixed in L1 by
adding `export const dynamic = "force-dynamic"` to `src/app/login/page.tsx`.
`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` is likewise build-time, not runtime: Next inlines it into the
client bundle at build time (`node_modules/next/dist/build/webpack-config.js:1737`) with
`serverActionsManifest.encryptionKey` as the runtime fallback
(`node_modules/next/dist/server/app-render/encryption-utils.js:78`). The repository contains no
`"use server"` today, so it is **not** placed in `.env.prod`; when the first Server Action lands it
becomes a build argument and requires a rebuild. Setting it only at runtime would create a mismatch
that fails in production and nowhere else. Its failure mode is cross-instance, so it belongs on the
same "revisit when a second instance appears" list as `deploymentId`.

**Runtime secrets** (`.env.prod`, mode 600, never in the image): `DATABASE_URL`,
`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `TRUSTED_ORIGINS`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`,
`OPENAI_MODEL`, `POSTGRES_PASSWORD`, `POSTGRES_USER`, `POSTGRES_DB`, `DOMAIN`. Note that
`src/lib/auth.ts:8-12` throws at import time when `BETTER_AUTH_SECRET` is missing, so this is
already a hard requirement, not a preference.

**Runtime tuning** (defaulted): `DATABASE_POOL_MAX` (10, max 50), `RATE_LIMIT_GLOBAL_PER_MINUTE`
(300), `RATE_LIMIT_PER_MINUTE` (60).

**Must be set explicitly:**

| Variable | Value | Consequence if unset |
|---|---|---|
| `API_BASE_URL` | `http://127.0.0.1:3000` | `resolveBaseUrl()` (`src/lib/api/server.ts:12-23`) rebuilds the public URL from `x-forwarded-host ?? host` and infers `https`; RSC hairpins through DNS and TLS to reach itself |
| `HOSTNAME` / `PORT` | `0.0.0.0` / `3000` | Docker's injected `HOSTNAME` may not resolve; see D2 |
| `TZ` | product timezone | `weekLabel()` (`src/lib/format.ts:141-152`) uses host-local `getDay()` / `getFullYear()`; see D16 |
| `DEMO_LOGIN_ENABLED` | `false` | a password-bypassing login entry point is configured (B3) |
| `DEMO_MODE` | `false` | demo behaviour replaces failed model calls with deterministic drafts |
| `DEMO_RESET_ENABLED` | unset | must stay unset; the real switch at `src/app/api/demo/reset/route.ts:8` |
| `ALLOW_DESTRUCTIVE_SEED` | unset | must stay unset; the real switch at `scripts/seed.ts:10` |

`NODE_ENV` is not listed: the generated `server.js` sets it to `production` itself. It matters only
for the `tools` image, where `drizzle-kit` and `tsx` run directly.

`.env.example` is corrected (5433, `cabinet:cabinet`, `DEMO_LOGIN_ENABLED=false`) and a separate
`.env.prod.example` ships with production-forced values, so nobody starts `.env.prod` by copying a
development file.

### D6 — Startup validation fails fast, and rejects demo mode in production

`src/lib/db/index.ts:6-8` and `drizzle.config.ts:9-12` both fall back to
`postgres://zhentao@localhost:5432/cabinet_dev`, so in a container a misconfiguration surfaces as a
runtime 500 rather than a startup failure. L1 refuses to start when `NODE_ENV=production` and
`DATABASE_URL` or `BETTER_AUTH_SECRET` is missing.

The check also rejects a combination the code currently permits, which is worth more than the
presence check:

```
NODE_ENV=production && (DEMO_LOGIN_ENABLED=true || DEMO_MODE=true)  → refuse to start
```

That is what turns B3 from a documentation note into an enforced invariant.

### D7 — `/api/health` contract: liveness returns 200, database state is a reported field

The endpoint must be reachable without a session — B2 — so it is added to the `src/proxy.ts:11-18`
whitelist and carries no authentication, no rate limit, and no audit entry.

```
GET /api/health → 200 {"ok": true, "db": "ok" | "down"}
```

HTTP status reflects **process liveness only**; the database state is a field. The distinction is
load-bearing:

- The **container healthcheck** accepts any 200, so a database blip does not mark the container
  unhealthy and cannot trigger a restart loop that fixes nothing (D4).
- **`make health-wait`** requires `db == "ok"`, so a deploy is not declared successful while the
  new image cannot reach its database.
- **`make docker-smoke`** requires `db == "ok"` after running migrations.

A single endpoint with two levels of assertion keeps the probe count at one. It also means a
database outage is genuinely invisible to Docker — acceptable, since restarting the app is not the
remedy, and recorded as a monitoring gap in D16.

### D8 — Caddy in front: buffering off, and connection retries across the swap

```
{$DOMAIN} {
    encode zstd gzip
    reverse_proxy web:3000 {
        lb_try_duration 90s
        lb_try_interval 500ms
        flush_interval -1
    }
    request_body { max_size 10MB }
}
```

`flush_interval -1` is required, not cosmetic: Next's self-hosting guidance requires proxy buffering
to be off, otherwise the 20-second `AbortController` in `src/lib/llm.ts:61-62` presents as a page
that hangs and then paints everything at once. Caddy has no default read timeout, satisfying the
≥60s the LLM call implies; if nginx replaces it, `proxy_read_timeout 60s` must be explicit.

`lb_try_duration` exists because `docker compose up -d web` on a single container is
**stop-then-start**, not rolling: Caddy cannot connect during the gap and would return 502. With
retries, requests queue instead: the normal path costs 1–3 s of latency, and the failure path (a
broken image waiting out `health-wait`, then rolling back) costs up to ~70 s of queuing rather than
~70 s of 502s. The window is bounded by `lb_try_duration 90s`, which must stay above
`health-wait`'s total budget.

The container healthcheck uses node rather than curl, because `bookworm-slim` ships without curl:

```yaml
healthcheck:
  test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
  interval: 30s
  timeout: 5s
  retries: 3
  start_period: 40s
```

### D9 — Make is the single source of truth; CI calls it

CI does not carry bare commands; the workflow's substance is `make ci`. A CI failure is then
reproducible locally with the same command, and deployment logic lives under version control and
review rather than in an ad-hoc SSH session.

```
develop  install  dev  db-up  db-down  db-migrate  db-seed  db-sync-policy
quality  lint  typecheck  test  build  ci  migrate-check
image    docker-build  docker-smoke
release  bootstrap  deploy  rollback  switch  health  health-wait  ps  logs
data     backup  restore-test  restore FILE=...
```

`make ci` = `install --frozen-lockfile → typecheck → lint → test → build`. Per B6, `db:migrate` is
**removed** from CI: `tests/global-setup.ts` already creates a fresh database and applies every
migration to it, a strictly stronger check. A dedicated `make migrate-check` (migrate a scratch
database, then drop it) remains for migration review.

`make docker-smoke` is separate because it needs a Docker daemon and a database. It also needs the
migrations, because the health probe touches the database:

```make
docker-smoke: docker-build
	docker compose -f compose.smoke.yml up -d db --wait
	docker compose -f compose.smoke.yml run --rm migrate
	docker compose -f compose.smoke.yml up -d --wait
	@curl -fsS http://127.0.0.1:3100/api/health | grep -q '"db":"ok"'
	@asset=$$(curl -fsS http://127.0.0.1:3100/login | grep -o '/_next/static/[^"]*\.js' | head -1); \
	 test -n "$$asset" || { echo "no _next/static reference in /login"; exit 1; }; \
	 curl -fsS -o /dev/null -w '%{http_code}' "http://127.0.0.1:3100$$asset" | grep -q '^200$$'
	docker compose -f compose.smoke.yml down -v --remove-orphans
```

Four traps this encodes, each of which made an earlier draft of this ADR falsely green:

- **The asset assertion targets `/login`, not `/`.** Unauthenticated `/` is a 302 to `/login`
  (`src/proxy.ts:32-35`), and `curl -f` treats 3xx as success, so the body would be empty and the
  grep would fail for the wrong reason. `/login` is whitelisted (`src/proxy.ts:12`) and does not
  query the database (`src/app/login/page.tsx`), so it is the only page that can be asserted before
  any schema exists.
- **A real asset URL is fetched, not just its name grepped from HTML.** That is what actually
  proves `public/` and `.next/static/` were copied (D2); a substring check passes on a white page.
- **`up --wait` is only a gate for services that define a healthcheck.** Compose treats a service
  without one as ready as soon as it is running, so `compose.smoke.yml` must define a healthcheck on
  `web` — otherwise `--wait` returns in under a second against a container that is not listening.
- **`down -v` is safe only because `compose.smoke.yml` has its own project name** (B7/D4).

`compose.smoke.yml` therefore defines `db` (healthcheck on `pg_isready`), `migrate`, and `web` with
`DATABASE_URL` pointing at the internal hostname, `BETTER_AUTH_SECRET` set (required by
`src/lib/auth.ts:8-12` at import time), `AUTH_REQUIRED=false`, and a healthcheck identical to D8's.
The app publishes on `127.0.0.1:3100`.

`make docker-build` must also assert that no environment file entered the image, and it must fail
**closed** — an earlier draft ended in `|| true`, which also passes when the `docker run` itself
fails on a malformed image reference:

```bash
docker run --rm "${IMAGE}:${IMAGE_TAG}" \
  sh -c '[ ! -e /app/.env ] && [ ! -e /app/.env.local ] && [ ! -e /app/.env.prod ]'
```

`PNPM ?= pnpm` is overridable so the sandboxed environment noted in the README can substitute an
equivalent invocation without editing the Makefile.

### D10 — The VPS keeps a git checkout

`/srv/cabinet` on the VPS is a git repository checked out with a read-only deploy key. Deployment
is `git fetch && git checkout <sha> && make deploy TAG=<sha>`. The alternative — CI scp'ing
`compose.prod.yml` and the Makefile onto the host — detaches the orchestration definition from git
history and makes "what did last Tuesday's compose file look like" unanswerable.

### D11 — Deploy and rollback share one switch primitive

The earlier draft wrote `current` before switching, never wrote `previous` at all, and let
`rollback` skip its own health check. The invariant is now explicit and enforced by structure:

> `current` = the tag known to be healthy and serving. `previous` = the tag it replaced.

```make
require-TAG:
	@test -n "$(TAG)" || { echo "用法: make deploy TAG=<sha>"; exit 1; }

# The single switch primitive. `current` is written only after the health check passes.
switch: require-TAG
	docker compose -f compose.prod.yml pull web
	docker compose -f compose.prod.yml up -d --no-deps web
	$(MAKE) health-wait
	@printf '%s\n' "$(TAG)" > .release/current.tmp && mv .release/current.tmp .release/current

deploy: require-TAG
	@mkdir -p .release
	docker compose -f compose.prod.yml pull web migrate    # fail before touching anything
	$(MAKE) backup
	docker compose -f compose.prod.yml run --rm migrate    # abort here: web not yet restarted
	@if [ -f .release/current ]; then \
	   cp .release/current .release/previous.tmp && mv .release/previous.tmp .release/previous; \
	 fi
	@$(MAKE) switch TAG=$(TAG) \
	   || { echo "▶ 健康检查失败，回滚到 $$(cat .release/previous 2>/dev/null)"; $(MAKE) rollback; exit 1; }

rollback:
	@test -f .release/previous || { echo "没有可回滚版本，需要人工介入"; exit 1; }
	@$(MAKE) switch TAG=$$(cat .release/previous)
```

`rollback` verifies health through the same primitive and writes `current` only on success, so a bad
`previous` can never be recorded as good. Because `current` is written last, a failed deploy leaves
it pointing at the last good release; `previous` is rotated before the switch, so after a failed
deploy followed by a rollback both files name the same tag — consistent, and harmless.

`health-wait` runs **inside** the web container, because prod `web` only `expose`s 3000 and the host
cannot reach it, and because the host is not guaranteed to have curl. The inner `fetch` carries its
own timeout, because `docker compose exec` has none and a hung `/api/health` would otherwise stall
the whole deploy indefinitely:

```make
health-wait:
	@for i in $$(seq 1 45); do \
	   docker compose -f compose.prod.yml exec -T web node -e \
	     'fetch("http://127.0.0.1:3000/api/health",{signal:AbortSignal.timeout(3000)}).then(async r=>process.exit(r.ok && (await r.json()).db==="ok" ?0:1)).catch(()=>process.exit(1))' \
	     && exit 0; \
	   sleep 2; \
	 done; exit 1
```

45 × 2 s = 90 s, matched to `lb_try_duration` (D8).

Four other details are load-bearing:

- **Pull first.** A registry failure aborts while the running deployment is untouched.
- **Migrate before restarting web.** Combined with D12's forward-compatibility rule, the old web
  runs safely against the new schema during that window.
- **`--no-deps`.** Without it, `up -d web` recreates `db`. On a single VPS that is catastrophic.
- **`make bootstrap`** runs `docker compose -f compose.prod.yml up -d db caddy` and is documented
  as a prerequisite for the first deploy, because `up -d --no-deps web` will not start `db` and
  `caddy`, and a web container without a resolvable `db` fails its health check and rolls straight
  back.

**`rollback` contains no `migrate`, deliberately.** It swaps the web image only and never touches
the schema. Encoding a fake migration rollback would be worse than admitting the constraint.

Image pruning uses `docker image prune -f --filter "until=168h"` **without `-a`**, which removes
only dangling layers and therefore never touches the tagged `previous` image that rollback needs.
`switch` pulls its target before starting it, so a pruned registry-side absence fails while the old
container is still serving.

### D12 — Migration is the only irreversible step, so it is bracketed and machine-checked

Release order is fixed: **pull → backup → migrate → switch web → health check**.

Mirror rollback is a tag change; migration rollback does not exist. `drizzle/` holds 21 migrations
with no down files and drizzle-kit does not generate them. Therefore:

1. **Back up immediately before migrating.** That dump is the only real safety net, and
   `make restore` plus `make restore-test` (D13) are what make it a net rather than a gesture.
2. **Migrations must be forward compatible** — add tables and columns only; do not drop, do not
   alter semantics. That is what makes mirror rollback sufficient: old code runs against the new
   schema.
3. **The rule is enforced.** `drizzle.config.ts:14` is `strict: false`, and the repository already
   contains non-additive statements that happened to be safe (`drizzle/0014_classy_sersi.sql:1` and
   `drizzle/0017_provider_attempt.sql:1-4` both relax constraints, so older code still runs). A
   reviewer's diligence is not a control. `scripts/check-migration.ts` scans newly added
   `drizzle/*.sql` for `DROP TABLE|DROP COLUMN|DROP CONSTRAINT|RENAME|ALTER COLUMN … TYPE` and
   fails `make lint`, with an explicit allow-list for the rare intentional exception.

The honest test of forward compatibility is not the static check but starting the **previous** image
against the **already migrated** database; that is part of the D14 rehearsal.

### D13 — Backup, and a restore that is actually exercised

- `make backup` → `docker compose -f compose.prod.yml exec -T db pg_dump -U "$POSTGRES_USER"
  -d "$POSTGRES_DB" -Fc` → `./backups/cabinet-<UTC>.dump`. The compose file must be named
  explicitly (otherwise the dev file is resolved) and the credentials come from the compose
  environment rather than a second copy in the Makefile.
- Retention: 7 daily + 4 weekly, implemented as `find ./backups -name '*.dump' -mtime +7 -delete`,
  with the weekly copy taken by the same host cron. Host cron at 03:00.
- `make restore-test` → restore the newest dump into `cabinet_restoretest`, `count(*)` several key
  tables, drop it.
- `make restore FILE=...` → a real restore path, because `restore-test` only proves the dump is
  readable, not that recovery works.

An unexercised backup is not a backup, and on a single-VPS topology it is the only fallback.

### D14 — Acceptance includes rehearsing the failure path

L3 is not accepted by "a merge reached production". It is accepted by:

> Commit a change that makes `/api/health` report `db != "ok"` → the release log shows `rollback` →
> `make health` reports the previous tag serving. Then start the previous image against the
> migrated database and confirm it serves.

The second clause is the real test of D12's forward-compatibility rule. An automatic rollback that
has never executed is indistinguishable from one that does not work, and it is simultaneously the
least-exercised and most critical branch in the pipeline.

### D15 — Secrets never enter CI

`.env.prod` is placed on the VPS by hand, mode 600, never committed and never transmitted through
CI. GitHub holds only `SSH_HOST`, `SSH_USER`, `SSH_KEY`, and `GHCR_PAT`. If CI held
`BETTER_AUTH_SECRET` and `OPENAI_API_KEY`, compromising CI would mean compromising production.
CI's job is to build a keyless image and invoke an audited script.

`.dockerignore` is therefore a security control, not a build-speed tweak: `.env*` with
`!.env.example`, `.git`, `node_modules`, `.next`, `.worktrees`, `.research`, `.tmp-types`,
`.pnpm-home`, `.release`, `tests`, `docs`, `backups`, `coverage`. A real `.env.local` exists in the
working tree today, and any `COPY . .` build stage would bake it into an intermediate layer
published to GHCR; D9's `docker-build` assertion checks the result.

`GHCR_PAT` is a fine-grained token with only *Packages: read* on this package, installed as
`/root/.docker/config.json` with mode 600, rotated every 90 days. Its expiry symptom is a `denied`
during `make deploy`'s pull step — which fails **before** anything is touched. The runbook records
that the correct response is to re-login and re-run, never to `up` a stale image by hand. The pull
token and the release workflow's `GITHUB_TOKEN` are distinct credentials with distinct scopes.

### D16 — Operational duties this design depends on

- **`rate_limits` has no TTL.** `src/lib/api/rate-limit.ts:19-35` inserts one row per user/action/
  minute window (`src/lib/db/schema.ts:721-736`, unique index at `:731`). At 300 requests/minute it
  grows without bound, so the daily cron also runs
  `DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`.
- **Log budget.** 10 MB × 3 files × 6 containers ≈ 180 MB (D4).
- **Image budget.** Seven days of ~200–400 MB images plus a 30-day `prune -a` when no rollback is
  expected; the runbook records the arithmetic.
- **Timezone is a product decision, not a host accident.** `weekLabel()`
  (`src/lib/format.ts:141-152`) derives ISO weeks from host-local `getDay()` / `getFullYear()`, and
  reaches production through `currentWeek()` and `src/lib/db/seed.ts`'s `reviews.period`. Rendered
  dates are safe because every call site passes an explicit `timeZone`. Production therefore sets
  `TZ` to the product timezone explicitly, and CI's `TZ: UTC` (`ci.yml:31`) is recorded as a
  deliberate difference. **Follow-up (out of scope here):** make `weekLabel` / `currentWeek` take an
  explicit timezone so the container's `TZ` stops mattering.
- **Monitoring gap.** Nothing watches `/api/health` from outside. An `unhealthy` container is not
  restarted and Caddy keeps returning 502; an external probe (or an uptime check on
  `https://<domain>/api/health` asserting `db:"ok"`) is required to notice. Deferred to L3, but it
  is a real gap, not a non-issue.

## Consequences

**Accepted costs**

- One extra release step (`docker compose run --rm migrate`), bought by keeping `drizzle-kit`,
  `tsx`, and `vitest` out of the production image.
- Migrations must be forward compatible indefinitely. Non-additive changes require a two-release
  expand/contract sequence, enforced by `scripts/check-migration.ts` rather than by memory.
- Three compose files with distinct project names to keep conceptually in sync, in exchange for
  never publishing the production database port and never letting a smoke test delete dev data.
- The VPS holds a git checkout and a deploy key.
- **A stop-then-start deploy is not zero-downtime.** Normal path: 1–3 s of queued requests.
  Failed-deploy path: up to ~70 s of queued requests (health-wait budget plus rollback), never 502
  as long as `lb_try_duration` stays above the health-wait budget. Hashed `_next/static` chunks
  cached by an already-open browser can 404 for that same window.
  `deploymentId` is deliberately **not** introduced: with a single container there is no second
  deployment to route to, and it would disable static optimisation for no benefit. If a second
  instance is ever added, this decision must be revisited together with
  `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`.

**Benefits**

- A single image promotes across environments with no rebuild.
- Adopting a resident worker costs one compose service and one command.
- CI failures are reproducible locally via `make ci`.
- A verified, periodically restored backup exists before the first production write.
- Seven latent defects (B1–B7) that would have blocked or silently undermined the pipeline are
  fixed as part of L1.

## Verification

**L1** — `make ci` green on a clean machine after `make db-up`; `make docker-build` builds both
targets and its image contains no `.env*` file; `make docker-smoke` returns `db:"ok"` from
`/api/health` and 200 for an extracted `_next/static` asset; with `DATABASE_URL` unset and
`NODE_ENV=production` the container exits with a clear message; `NODE_ENV=production
DEMO_LOGIN_ENABLED=true` refuses to start; `docker compose -f docker-compose.yml up -d` reaches
healthy on the fixed volume path; `make docker-smoke` leaves `cabinet_pgdata` intact.

**L2** — `make bootstrap` then `make deploy TAG=<sha>` completes on the VPS; `curl
https://<domain>/api/health` reports `db:"ok"`; `make restore-test` reads the newest dump and
`make restore` recovers into a scratch database; `docker compose -f compose.prod.yml ps` shows no
published port on `db`; `make health` reports the running tag.

**L3** — the D14 rehearsal passes, including the previous-image-against-migrated-database step; a
normal merge to `main` deploys within one workflow run.

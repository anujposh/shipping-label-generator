# Original implementation plan: Shipping Label Generator

> Historical record preserved from `posh-web-nodejs/.omx/plans/shipping-label-generator.md`. It documents the original monorepo design, including paths and a backend-hosted seam that have since been superseded by the standalone relocation. See `architecture.md` for the current architecture; the original decisions below are retained for context rather than as current instructions.

Status: HISTORICAL — original FINAL v3 implementation plan; Critic review findings applied (see Changelog).

## 1. Requirements Summary

Create a new, fully isolated project under `projects/shipping-label-generator/` that:

1. Provides a secure, vendor-accessible **public-link workflow**: an internal user creates a vendor link, sends it to a vendor; the vendor opens the link, enters shipment details (addresses, package weight/dimensions), views carrier rates, and downloads a shipping label generated under **our company carrier accounts** (FedEx, UPS, USPS, Stamps.com).
2. Reuses the existing carrier integrations and shipping business logic through a well-defined API — no duplication of carrier client code.
3. Enforces strict tenant isolation: vendors can never access internal application data, API credentials, or other vendors' shipments.
4. Includes: vendor/token management (create, expiry, revocation), submission tracking, shipment status view, and an internal admin dashboard.
5. Keeps frontend, backend, database migrations, config, docs, and tests inside the new project folder; existing apps (`admin/`, `web/`, `backend/`, `logistics/`) remain untouched except for the single reviewed carrier-API seam (see Decision 1).

## 2. Codebase Facts (verified)

- Carrier integrations live in `backend/src/modules/carriers/` — `carrier.service.ts` exposes a uniform `CarrierClient` interface (`rateShop`, `validateAddress`, `createShipment`, `voidShipment`, `track`, `schedulePickup`) over `fedex.client.ts`, `ups.client.ts`, `usps.client.ts`, `stamps.client.ts`, with typed contracts in `carrier-types.ts` and credential override support (`CarrierCredentialOverride`).
- Credentials resolve server-side inside the backend: env-based (`CARRIER_ENV_CREDENTIALS`, `FEDEX_*`, `UPS_*`, `USPS_*` env vars; see `backend/src/modules/carriers/carrier-direct.tmp.mjs` probes and `backend/src/modules/logistics/services/shipping.service.ts` lines 713, 771, 839–840) — carrier secrets never leave the backend.
- Existing shipping orchestration: `backend/src/modules/logistics/services/shipping.service.ts` (rate quote, create shipment, account pinning lines 1246–1270), routes in `backend/src/modules/logistics/routes/shipping.routes.ts` (`/rate-quote` line 64, `/validate-address` line 77) behind `requireLogisticsAuth` middleware.
- Labels persist to Postgres table `logistics_shipping_labels` (`backend/src/modules/logistics/services/shipping-label-store.ts`; migrations `backend/migrations/20260928120000_create_logistics_shipping_labels.ts`, `...20260930200000_add_label_size_voided_at...`, `...20261001130000_add_account_number...`) keyed by `whse_ship_no`, storing `label_pdf_base64`/`label_zpl`.
- Backend: Express (`backend/src/server.ts`), Knex + Postgres (`backend/knexfile.ts`, `backend/src/core/db`), helmet, core rate-limit (`backend/src/core/rate-limit.ts`), JWT auth patterns (`backend/src/modules/auth/services/auth.service.ts`, `customer-auth.service.ts` — `jsonwebtoken`, HS256, `timingSafeEqual` in `backend/src/core/password.ts`).
- Monorepo shape: separate `package.json` per app, orchestrated via `npm --prefix` from root (`package.json` lines 6–13); **no npm workspaces**; each app has its own Dockerfile; no existing `projects/` directory.
- Testing: per-app unit (`node:test` via tsx in backend), integration behind `npm run schema`/`integration`, Playwright e2e at root and per app.

## 3. Proposed Folder Structure

```
projects/shipping-label-generator/
├── README.md                      # what it is, how to run, security model
├── docs/
│   ├── architecture.md            # diagrams, data flow, isolation model
│   ├── api.md                     # internal + vendor API contracts
│   └── security.md                # token design, threat model, audit
├── app/                           # Next.js 16 frontend (vendor UI + admin dashboard)
│   ├── Dockerfile                 # mirrors per-app Dockerfile convention
│   ├── package.json               # own deps; no root workspace coupling
│   ├── src/app/(public)/l/[token]/page.tsx   # vendor link landing (no auth chrome)
│   ├── src/app/(public)/l/[token]/shipment/  # details form → rates → label download
│   ├── src/app/(admin)/admin/               # login + dashboard (vendors, links, shipments)
│   └── src/app/api/               # BFF routes proxying to api/ service (server-side only)
├── api/                           # Node/Express + Knex service
│   ├── Dockerfile
│   ├── package.json
│   ├── knexfile.ts                # own migration dir; SAME Postgres DB, slg_* table prefix, AND a distinct migrations bookkeeping table (`migrations.tableName: "slg_knex_migrations"`) — backend's knexfile.ts uses the default `knex_migrations` on the same DB, so sharing it would corrupt both projects' migrate/rollback state
│   ├── migrations/                # slg_vendors, slg_links, slg_shipments, slg_labels, slg_admin_users, slg_audit_log
│   └── src/
│       ├── server.ts              # helmet, rate-limit, request logging (mirrors backend core patterns)
│       ├── carriers/proxy.ts      # the ONLY carrier access path → backend seam (Decision 1)
│       ├── modules/
│       │   ├── vendors/           # vendor CRUD (internal)
│       │   ├── links/             # token create/expiry/revoke, token hashing
│       │   ├── shipments/         # submission, rate retrieval, label creation, status
│       │   ├── admin-auth/        # dashboard session (Decision 2)
│       │   └── audit/             # security-relevant event log
│       └── tests/                 # unit + integration (own TEST_DATABASE_URL schema)
├── tests/e2e/                     # Playwright specs for vendor flow + admin flow
└── .env.example                   # SLG_* vars only; carrier secrets stay in backend
```

## 4. Key Decisions (CONFIRMED by user)

**Decision 1 — Carrier reuse seam: Option A (confirmed).**
Add one reviewed, additive router to `backend/src/server.ts` — `/internal/shipping/*` (rate-quote, create-shipment) authenticated by a shared secret (timingSafeEqual, mirrors `backend/src/core/metrics.ts` pattern), IP-allowlisted, returning only sanitized rate/label payloads, gated behind `SLG_INTERNAL_API_ENABLED` + `SLG_INTERNAL_API_KEY` env (no behavior change when disabled). The new project's `api/` calls this seam as its only carrier path.

**Session/BC strategy (review finding):** the seam must NOT call `shipping.service.createShipment` — it requires a `LogisticsSession` and does Business Central reads (`resolveServiceCode` → `bcReadList(session, "tliShippingAgentServices", ...)`, credential resolution at `shipping.service.ts` lines 713–840). Instead the seam calls `backend/src/modules/carriers/carrier.service.ts` clients **directly** with env-resolved credentials (`CARRIER_ENV_CREDENTIALS` path — per-field env fallback confirmed at `shipping.service.ts` lines 713–714) and an explicit service code supplied by the caller. Service-type catalogs are exposed as a static per-carrier list on the seam (env-overridable), not via BC lookups. This keeps the seam stateless and free of Logistics/OIDC session coupling.

**Decision 2 — Admin dashboard authentication: Option A (confirmed).**
`slg_admin_users` table, JWT session, credentials seeded via env/CLI. Fully isolated; no coupling to OIDC/internal-users.

## 5. Security & Isolation Model

- Vendor links: `/l/{token}` with 128-bit+ random tokens (`crypto.randomBytes(32)`), stored **hashed** (SHA-256) in `slg_links`; expiry (`expires_at`), single-purpose, revocable (`revoked_at`); per-token rate limiting; constant-time lookup by hash.
- Token → vendor binding is the ONLY join to identity; vendor API responses are strictly scoped by `link_id`/`vendor_id` — no listing endpoints on public routes.
- Carrier credentials: never present in the new project (env or DB); all carrier calls flow through the seam, which resolves credentials server-side as today (`shipping.service.ts` lines 713–840).
- Labels generated under company accounts; label bytes stored in the new project's `slg_labels` (own table) or referenced from the seam response; vendors can re-download only their own label while the link is valid.
- Audit log (`slg_audit_log`): link created/revoked/expired, submission created, rate retrieved, label created/downloaded, admin login **(success and failure)** — with actor, IP, timestamp; seam invocations are correlated via a request id echoed in backend logs.
- Public vendor routes: strict payload validation, no free-text injection into carrier requests without sanitization, per-IP + per-token rate limits (reuse pattern from `backend/src/core/rate-limit.ts`).
- Token-in-URL hygiene: `Referrer-Policy: no-referrer` on all `/l/*` pages, `Cache-Control: no-store` on token-authenticated API responses, token values scrubbed from request logs, and `app.set("trust proxy", ...)` configured explicitly so per-IP limits use the real client IP behind the reverse proxy (prevents `X-Forwarded-For` spoofing).
- Ship-from pinning: the origin address is pinned server-side to an approved company warehouse per link (admin-selectable); vendors enter only the destination. This prevents arbitrary-origin labels on company accounts.
- Link delivery: v1 is copy-paste from the admin dashboard (no email dependency); email delivery is an explicit follow-up, not in scope.

## 6. Database Schema (new tables, `slg_` prefix, own migrations)

- `slg_vendors` — id, name, contact_email, notes, created_at, archived_at.
- `slg_links` — id, vendor_id (FK), token_hash (unique), expires_at, revoked_at, max_uses, use_count, created_by, created_at.
- `slg_shipments` — id, link_id (FK), vendor_id (FK), status (`draft|rated|label_created|voided|expired`), ship_from/ship_to (JSONB, validated), packages (JSONB), selected_rate (JSONB), carrier, service_type, tracking_number, created_at, updated_at.
- `slg_labels` — id, shipment_id (FK), label_pdf_base64, label_zpl, label_size, carrier, account_number, voided_at, created_at.
- `slg_admin_users` — id, email, password_hash, created_at (Decision 2A only).
- `slg_audit_log` — id, actor_type (`admin|vendor`), actor_id, link_id, action, ip, details (JSONB), created_at.

## 7. Implementation Steps (after approval)

1. **Scaffold** `projects/shipping-label-generator/` per §3: app/, api/, docs/, .env.example, README, Dockerfiles mirroring `logistics/Dockerfile` conventions.
2. **Migrations + core store**: write `api/knexfile.ts` + `slg_*` migrations; vendor/link/shipment/label data-access services with unit tests (fake-knex seam pattern from `shipping-label-store.ts` lines 10–12).
3. **Carrier seam (Decision 1A)**: additive `backend` internal router (flag-gated by `SLG_INTERNAL_API_ENABLED` + `SLG_INTERNAL_API_KEY` env), exposing sanitized rate-quote/create-shipment; integration tests against carrier mocks; **this is the only existing-app change and ships as its own reviewed diff.**
4. **Vendor API**: token resolution middleware (hash lookup, expiry/revocation/max-uses, audit write), `POST /v1/shipment`, `POST /v1/rates`, `POST /v1/label`, `GET /v1/label.pdf`, `GET /v1/status` — all scoped by link; rate-limited; integration tests.
5. **Admin API + auth (Decision 2)**: admin session, vendor CRUD, link create/revoke/list, shipment list/detail with filters, audit view.
6. **Vendor frontend** (`app/`): token landing page (validity states: active/expired/revoked/exhausted), shipment details form, rates list, label download, status view.
7. **Admin dashboard frontend**: vendors/links/shipments tables, link creation with expiry presets, revocation, shipment status drill-down.
8. **E2E + docs**: Playwright specs (happy path, expired/revoked token, cross-vendor isolation attempt, rate limit); finalize `docs/architecture.md`, `docs/api.md`, `docs/security.md`, README.
9. **Deployment + runbook (repo rule)**: add routing/DNS/Portainer definition for the new public app + api service; secrets provisioning and rotation runbook for `SLG_INTERNAL_API_KEY`; document rollout order (backend seam deploy must precede first api service deploy); update `.agents/skills/deploy-posh-production/references/production-runbook.md` in the same change (required by AGENTS.md when adding public routes, migrations, and services); wire the new suites into CI as a separate job that does not modify existing suites.

## 8. Acceptance Criteria (testable)

1. A vendor with a valid link can complete details → rates → label download end-to-end via only public `/l/{token}` routes; Playwright e2e passes.
2. Requests with expired, revoked, or exhausted tokens receive HTTP 410/403 respectively and an audited event; unit + e2e tests cover each state.
3. Vendor A's token cannot read Vendor B's shipment or label (attempt returns 403/404) — proven by an isolation e2e test.
4. No carrier credential (`FEDEX_*`, `UPS_*`, `USPS_*`, `STAMPS_*`) appears in the new project's env, config, or codebase — verified by grep gate in CI/test script.
5. The existing backend diff is limited to the additive flag-gated seam router; with the flag off, all existing backend unit/integration tests pass unchanged.
6. Label PDF downloads work and `slg_labels` persists bytes; a voided label cannot be re-downloaded.
7. All public vendor endpoints enforce per-IP and per-token rate limits (429 beyond threshold) — integration test.
8. New project tests (unit + integration + e2e) run green from its own scripts and in its own CI job, without modifying existing app test suites; the new project runs `prettier --check` over its own files (root format:check does not cover `projects/`, so this gate must be local to the project).

## 9. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Seam router becomes an unintended internal-data surface | Allowlist exact endpoints (rate-quote, create-shipment only), shared-secret + flag gate, sanitized response DTOs, audit log, integration tests asserting 404 for anything else |
| Carrier account abuse via leaked vendor links | Short default expiries, max-uses, per-token rate limits, revocation, audit trail, package-count/value sanity caps in validation |
| Token brute force | 256-bit tokens, hashed storage, constant-time compare, rate-limited lookup failures |
| Migration collision with existing backend migrations | Distinct `migrations.tableName` (`slg_knex_migrations`) + own migration directory + `slg_` prefix; never run backend knex against new tables |
| Label blob growth in Postgres | Same tradeoff as existing `logistics_shipping_labels`; keep parity, revisit MinIO offload as follow-up (docs/minio-image-storage-policy.md) |
| Build coupling if Decision 1B were chosen | Moot — Decision 1A confirmed; keep contract tests on the seam DTOs |

## 10. Verification Steps

1. `npm --prefix projects/shipping-label-generator/api run test` (unit + integration against `TEST_DATABASE_URL` schema).
2. Backend suites unchanged: `npm --prefix backend run unit && npm --prefix backend run integration` with seam flag off and on (mock carriers).
3. Playwright e2e: `projects/shipping-label-generator/tests/e2e` covering §8 criteria 1–3, 6–7.
4. Secrets grep gate (§8.4).
5. Manual security pass per `docs/security.md` checklist (token states, isolation, rate limits, audit completeness).

## Open Questions

None — both decisions confirmed. Ready for implementation go-ahead.

## Changelog

- v1: initial draft (post codebase recon).
- v2: user confirmed Decision 1A (internal API seam) and Decision 2A (own local admin accounts).
- v3: applied Critic (oracle) review findings: distinct knex migrations bookkeeping table (`slg_knex_migrations`); seam bypasses `shipping.service`/LogisticsSession/BC and calls `carrier.service` directly with env-resolved credentials + explicit service codes; token-in-URL hygiene, trust-proxy for rate limits, admin login-failure auditing, ship-from pinning, copy-paste link delivery (v1); added deployment/runbook/CI step 9; replaced vacuous AC8. Reviewer's "corrupted document" finding was a read-tool compression artifact — file verified intact via grep.

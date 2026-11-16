# Project Handoff — Shipping Label Generator

**Date:** 2026-11-16
**Repo:** https://github.com/anujposh/shipping-label-generator
**Status:** Feature-complete for both companies, E2E-tested, all session fixes pushed. One ops blocker (Mailgun SMTP passwords) and a few low-priority follow-ups remain.

---

## 1. What this system does

Self-hosted shipping-label portal for two Business Central companies:

- **Admin** (`/admin`) — sign in, create vendor links scoped to a BC company (Posh Textiles Inc. / Silk Crafts, Inc.), view links, shipments, and the audit trail.
- **Vendor** (`/l/{token}`) — public one-time link: enter shipment details → real rate shopping (FedEx / UPS / USPS) → create label → download PDF → optional email notification.

| Piece | Stack | Port | Run |
|---|---|---|---|
| API | Express + Knex + Postgres (`slg_dev`), TypeScript | 3010 | `cd api && npm run build && npm run start` |
| App | Next.js 16 (App Router) | 3011 | `cd app && npm run build && npm run start` |
| DB | Postgres, migrations via `npx knex migrate:latest` (run from `api/`) | 5432 | — |

Both `npm run start` scripts redirect output to `logs/api.log` / `logs/app.log`. Run them with `setsid`/`&` (or systemd/pm2) so they survive the terminal closing.

## 2. Environment / secrets

Everything secret lives in **`api/.env`** and **`app/.env.local`** — both gitignored, never committed. Templates: `.env.example` (root), `api/.env.example`, `app/.env.example`.

Key variables (see templates for the full list):

- `DATABASE_URL`, `JWT_SECRET`, `SLG_INTERNAL_API_*` — core
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` — admin login
- `BC_TENANT_ID`, `BC_CLIENT_ID`, `BC_CLIENT_SECRET` — live Business Central company directory
- Carrier sandbox credentials (FedEx/UPS/USPS test keys)
- `SMTP_HOST/PORT/SECURE` — shared SMTP transport (smtp.mailgun.org)
- **Per-company mail identities** (new this session): `POSH_SMTP_USER/PASSWORD/FROM`, `SILK_SMTP_USER/PASSWORD/FROM`; falls back to generic `SMTP_USER/PASSWORD/FROM` when a company has no complete identity

## 3. What was done this session (2026-11-16)

Full E2E browser test of both companies (real carrier sandboxes + live BC), report in
`docs/e2e-test-report-2026-11-16.md`. Four bugs found; all fixed, verified, and pushed:

1. **FedEx scheduled-pickup always failed 422** — wrong field name (`readyDateTimestamp` → `readyPickupDateTime`) in `api/src/carriers/fedex.client.ts`. Vendors saw "Shipping temporarily unavailable" on the default pickup option.
2. **False 409 "label already created"** — conflict check passed a link id into a shipment-scoped query (`api/src/routes/vendor.routes.ts`). Added `labels.store.getLabelsByLink()` (joins via `slg_shipments.link_id`) and use it for the guard.
3. **Notification-email audit events never persisted** — `slg_audit_events_event_type_check` rejected `notification_email_*` types (PG 23514). Migration `20261116160000_add_notification_email_to_audit_events.ts` extends the constraint (applied to `slg_dev`).
4. **Mail credentials were not per company** (dead config) — implemented `resolveSmtpIdentity()` in `api/src/core/mailer.ts`: link's BC company selects `POSH_SMTP_*` / `SILK_SMTP_*` / generic fallback; transport pool per identity; `vendor.routes.ts` passes `link.bc_company_name` as `sendingCompany`. Unit-tested (mailer 12/12). Live-verified: Silk now attempts its own SMTP auth.

Verified E2E per company: admin login/sections/company dropdown, link creation (API + UI), rate shopping, label creation (FedEx sandbox trackings `794910622753` / `794910623635`), PDF download, shipment history, mail audit events recorded.

## 4. Outstanding work (also tracked in local beads)

| # | Item | Priority |
|---|---|---|
| 1 | **Mail delivery blocked (ops):** `POSH_SMTP_PASSWORD` / `SILK_SMTP_PASSWORD` in `api/.env` are mailbox passwords; `smtp.mailgun.org` needs **domain SMTP credentials** (`postmaster@mg.<domain>` + generated SMTP password). Code is correct; only creds are wrong. Mail failure never blocks label creation. | High |
| 2 | Make notification-email dispatch async — SMTP timeouts currently delay the label API response (observed ~5 min on auth failure). | Medium |
| 3 | Unit-test env isolation — `api/.env` leaks `BC_*` / `DATABASE_URL` into `config.test` / `admin.routes.test` (4 pre-existing failures on a fully-configured machine). | Low |
| 4 | `/favicon.ico` 404 (cosmetic). | Low |
| 5 | No process supervisor for dev servers (API crashed once on a transient DB pool timeout). | Low |

## 5. Gotchas & notes

- **DB migrations:** knex + ts-node is slow under load; if `migrate:latest` hangs, the constraint migration can be applied via direct SQL — but the knex migrations-table row must also be inserted (this was done for `slg_dev`; see session notes in the test report).
- **Tests:** `cd api && npm run unit` (192/196 pass on a clean env; 4 failures are the isolation issue above). App Playwright specs need a machine that can boot `next dev` within 120s.
- **Ports:** API 3010, app 3011. Check `ss -tlnp | grep 301` before starting — stale instances cause silent EADDRINUSE crashes (visible only in `logs/*.log`).
- **Beads:** issue tracker DB is local (`.beads/`, gitignored). Configure a Dolt remote and run `bd dolt push` if you need it on other machines.
- E2E artifacts (label PDFs, screenshots, browser scripts, tokens) are in `/tmp/opencode/` — ephemeral, will not survive reboot.

## 6. Quick start on a new machine

```bash
git clone https://github.com/anujposh/shipping-label-generator.git
cd shipping-label-generator
cp .env.example api/.env      # fill real values (DB, BC, carriers, admin, SMTP)
cp app/.env.example app/.env.local
createdb slg_dev
cd api && npm ci && npx knex migrate:latest && npm run build && setsid npm run start &
cd ../app && npm ci && npm run build && setsid npm run start &
# app: http://localhost:3011  api: http://localhost:3010/healthz
```

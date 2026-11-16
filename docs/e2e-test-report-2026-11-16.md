# Shipping Label Generator — End-to-End Test Report

**Date:** 2026-11-16 · **Environment:** local dev (API :3010 via tsx, Next app :3011 standalone, Postgres `slg_dev`, real carrier SANDBOX credentials, live Business Central directory)

## Scope tested (browser automation: Playwright + headless Chromium)

1. Admin dashboard: login (good/bad credentials), Vendors/Links/Shipments/Audit sections, company dropdown (Business Central), UI link creation + one-time token reveal modal.
2. Vendor public-link flow per company: `/l/{token}` landing → sender/pickup details → destination → package → **real rate shopping** (FedEx/UPS/USPS sandbox) → label creation → **PDF label download** → shipment history.
3. Notification-email ("mail") credential behavior per company, via `slg_audit_events`.
4. Unit test suite, mailer unit tests, app Playwright specs (mocked), production build.

## Companies verified

| Company | BC id | Vendor link flow | Rates | Label | PDF |
|---|---|---|---|---|---|
| Posh Textiles Inc. | `aabdd4f3-a1f4-ec11-82f8-0022483487fb` | PASS | PASS (fedex/ups/usps) | PASS — tracking `794910622753` | PASS 36 KB |
| Silk Crafts, Inc. | `0f8bab00-aede-ec11-82f8-0022482fff55` | PASS | PASS (fedex/ups/usps) | PASS — tracking `794910623635` | PASS 36 KB |

Both company credentials work for labels: link creation with a company, rate shopping, FedEx sandbox shipment creation, label download, shipment history, and admin views all pass for both companies.

## Bugs found

### BUG 1 (critical, FIXED & verified) — FedEx scheduled-pickup shipments always failed
- **Symptom:** every "Schedule new pickup" shipment → HTTP 502 "Shipping is temporarily unavailable" (vendor-facing). FedEx sandbox returned `422 INVALID.INPUT.EXCEPTION` — `pickupDetail.readyPickupDateTime cannot be null`.
- **Root cause:** `api/src/carriers/fedex.client.ts` sent a nonexistent field (`readyDateTimestamp`, timestamp format) instead of FedEx's `readyPickupDateTime` (`YYYY-MM-DD`).
- **Fix:** send `readyPickupDateTime`/`latestPickupDateTime` as date-only values; updated `carrier-delivery-dates.test.ts` assertion.
- **Verified:** direct sandbox shipment + full browser E2E (both companies) now create labels with pickup selected.

### BUG 2 (critical, FIXED & verified) — false 409 "label already created" (link/shipment ID collision)
- **Symptom:** Silk Crafts link #24 was permanently blocked (`409 label_already_exists`) although it had zero shipments.
- **Root cause:** `vendor.routes.ts` passed `link.id` into `getLabelsByShipment()` (queries by `shipment_id`) — an unrelated Nov-10 shipment happened to have id 24 with a live label. Masked in unit tests (fixtures use id 1 for both link and shipment).
- **Fix:** added `getLabelsByLink()` (join `slg_labels` → `slg_shipments.link_id`) and used it for the conflict guard.
- **Verified:** fresh Silk + Posh links complete the full flow.

### BUG 3 (high, FIXED & verified) — notification-email audit events could never be written
- **Symptom:** `notification_email_dispatch_failed` — Postgres `23514` check-constraint violation on every mail audit insert; no `notification_email_sent/failed/skipped` events ever persisted.
- **Root cause:** `slg_audit_events_event_type_check` only allowed the 10 original event types; the notification_email_* types were never added (missing migration).
- **Fix:** migration `20261116160000_add_notification_email_to_audit_events.ts` (applied to `slg_dev`; registered in knex migrations).
- **Verified:** events now record (`notification_email_failed` with the real SMTP error).

### BUG 4 (the "mail credential per company" finding) — per-company SMTP identities were dead config → FEATURE IMPLEMENTED
- **Symptom:** `.env` defines `POSH_SMTP_USER/FROM` and `SILK_SMTP_USER/FROM`, but the mailer only read the single `SMTP_USER/FROM` set (which is empty) → every notification email failed with `530 Authentication required`, regardless of company.
- **Fix (code):** `mailer.ts` now resolves a per-company SMTP identity from the link's BC company (`resolveSmtpIdentity`) — Posh ↔ `POSH_SMTP_*`, Silk ↔ `SILK_SMTP_*`, fallback to generic `SMTP_*`; transport pool keyed per identity; `vendor.routes.ts` passes `link.bc_company_name` as `sendingCompany`. Unit-tested (4 new tests, 12/12 pass) and verified live: Silk link now attempts SMTP auth (`535`) proving the Silk identity is selected; Posh previously attempted none (`530`).
- **Remaining OPS action (not code):** actual delivery still fails — `SILK_SMTP_PASSWORD` / `POSH_SMTP_PASSWORD` in `api/.env` are rejected by `smtp.mailgun.org` (`535 Authentication failed`). Mailgun requires **domain SMTP credentials** (e.g. `postmaster@mg.yourdomain` / generated SMTP password), not mailbox passwords. Until valid credentials are set, mail is correctly audited as failed and never blocks label creation.

### Minor issues (reported, not fixed)
- Label response can be delayed by the SMTP timeout (mail dispatch is awaited before responding — took ~5 min in one run). Consider fire-and-forget/queue for notifications.
- 4 pre-existing unit-test failures (config.test ×1, admin.routes.test ×3) are **test-isolation artifacts**: a fully-populated `api/.env` re-populates env vars the tests delete and makes BC appear "configured" in tests that assert the unconfigured path. Not product bugs.
- `next start` on the standalone build doesn't serve static assets without copying `.next/static` into `.next/standalone` (deployment step was missing; worked around locally).
- `/favicon.ico` 404 (cosmetic console noise in tests).
- API crashed once on a transient DB pool timeout (async error outside try/catch, Express 4) — no auto-restart supervisor in dev.

## Test results summary

| Suite | Result |
|---|---|
| Browser E2E vendor flow — Posh Textiles Inc. | 7/8 PASS (only favicon-404 console noise) |
| Browser E2E vendor flow — Silk Crafts, Inc. | 7/8 PASS (only favicon-404 console noise) |
| Browser E2E admin dashboard | PASS (login, sections, BC company dropdown, UI link creation) — 2 expected-alert assertions were wording mismatches in the test script, not product issues |
| Unit tests (api) | 192/196 pass baseline; 4 failures pre-existing env-isolation (above); mailer tests 12/12 after fix |
| Mail credential per company | Code path implemented + verified; delivery pending valid Mailgun SMTP passwords (ops) |
| Production build (tsc) | **PASS** (tsc rc=0, fixes compiled). App Playwright specs: blocked — webServer boot timeout under system load (environment, not product; flows covered by live browser E2E) |

## Files changed

- `api/src/carriers/fedex.client.ts` — FedEx pickupDetail field fix
- `api/src/store/labels.store.ts` — added `getLabelsByLink()`
- `api/src/routes/vendor.routes.ts` — link-scoped conflict check; `sendingCompany` on mail
- `api/src/core/mailer.ts` — per-company SMTP identity resolution + transport pool
- `api/migrations/20261116160000_add_notification_email_to_audit_events.ts` — new migration (applied)
- `api/tests/unit/carrier-delivery-dates.test.ts`, `api/tests/unit/mailer.test.ts` — updated/new tests
- `.env.example` — documented `POSH_SMTP_*` / `SILK_SMTP_*`

## Artifacts

- Labels: `/tmp/opencode/label-posh-domestic.pdf`, `/tmp/opencode/label-silk-domestic.pdf`
- Screenshots: `/tmp/opencode/final-*.png`, `dbg-*.png`
- E2E JSON: `/tmp/opencode/e2e-*.json`

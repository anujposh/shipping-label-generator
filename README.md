# Shipping Label Generator (SLG)

Standalone project that provides a secure, vendor-facing public-link workflow for generating shipping labels on company carrier accounts.

## What it is

- Internal staff create time-boxed, usage-limited vendor links.
- Vendors open a `/l/{token}` URL, enter destination shipment details, view carrier rates, and download a shipping label.
- Carrier account credentials, rate shopping, and shipment creation now run in the SLG API itself: `slg-api` owns the carrier clients and serves the internal seam (`/internal/shipping/*`) locally. It calls its own seam via `SLG_INTERNAL_API_BASE_URL` (`http://127.0.0.1:3010` in `.env.example`). The main posh backend no longer mounts this seam; SLG carrier credentials are configured in the `slg-api` runtime environment, while unrelated backend carrier workflows remain unchanged.
- Tenant isolation is enforced: vendors cannot access internal app data, carrier credentials, other vendors' shipments, or administrative functions.

## Scope within this folder

| Folder | Purpose |
|--------|---------|
| `api/` | Node/Express + Knex API service (vendor public routes, admin routes, seam client) |
| `app/` | Next.js 16 frontend (vendor link UI + admin dashboard) |
| `tests/e2e/` | Playwright end-to-end specs |
| `docs/` | Architecture, API contract, and security documentation |

## How to run (local)

Run all commands in this README from the project root.

1. Copy `api/.env.example` to `api/.env` and fill in values.
2. Install API dependencies:
   ```bash
   npm --prefix api install
   ```
3. Run migrations against `DATABASE_URL`:
   ```bash
   npm --prefix api run migrate
   ```
4. Start the API:
   ```bash
   npm --prefix api run dev
   ```
5. (Optional) Start the Next.js app:
   ```bash
   npm --prefix app install
   npm --prefix app run dev
   ```

## Security model summary

- **Token design**: 256-bit random tokens generated with `crypto.randomBytes(32)`. Only the SHA-256 hash is stored in `slg_links.token_hash`. Tokens are single-purpose and looked up by hash.
- **Link lifecycle**: Each link has `expires_at`, `max_uses`, `use_count`, and `revoked_at`. Expired, revoked, or exhausted links return `410`/`403` and are audited.
- **Tenant isolation**: All vendor routes require a valid link token and every query is scoped to `link_id`/`vendor_id`.
- **Ship-from pinning**: Origin address is pinned server-side per link; vendors only supply destination details.
- **Rate limiting**: Per-IP and per-token rate limits mirror the backend `rate-limiter-flexible` pattern.
- **Audit trail**: All security-relevant events are recorded in `slg_audit_events` (link create/revoke/expiry, submission, rates, label, admin login success/failure).
- **Carrier secrets live in slg-api**: `slg-api` now owns the `/internal/shipping/*` seam and the carrier clients. SLG carrier credential variables (`FEDEX_*`, `UPS_*`, `USPS_*`, `STAMPS_*`) are configured in the slg-api runtime env (`api/.env` in development) and are never exposed to `slg-app` or vendors; the posh backend retains separate credentials for unrelated workflows. The seam client uses a shared secret (`SLG_INTERNAL_API_KEY`) against the local seam at `SLG_INTERNAL_API_BASE_URL`. For credential-free non-production development, `SLG_INTERNAL_FAKE_CARRIERS=true` substitutes deterministic fake carriers.
- **Token-in-URL hygiene**: `Referrer-Policy: no-referrer` on token pages, `Cache-Control: no-store` on token-authenticated responses, token values scrubbed from request logs, and explicit `trust proxy` configuration for accurate client-IP rate limiting behind a reverse proxy.

## Tests

```bash
npm --prefix api run unit
npm --prefix api run integration
```

E2E tests (later lane):

```bash
npm --prefix tests/e2e run test
```
# shipping-label-generator

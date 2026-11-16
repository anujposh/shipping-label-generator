# Security

## Threat model

- **Leaked vendor link** → mitigated by short expiry, max-uses, revocation, per-token rate limits, audit trail, and package sanity caps.
- **Token brute force** → mitigated by 256-bit tokens, hashed storage, and rate-limited lookup failures.
- **Backend seam abuse** → mitigated by flag gate (`SLG_INTERNAL_API_ENABLED`), shared secret with constant-time comparison, IP allowlist, exact endpoint allowlist, sanitized DTOs, and audit correlation. The seam is now served by `slg-api` itself; the main posh backend no longer mounts it.
- **Cross-vendor data access** → mitigated by strict query scoping on `link_id`/`vendor_id`. Reusable vendor details are returned only from the link resolved from the presented bearer token; no vendor-account login or cross-link profile lookup exists.
- **Vendor detail exposure** → link status and shipment responses use `Cache-Control: no-store`; each shipment keeps its own submitted shipper snapshot, and only authenticated admins can view shipment-level vendor details.
- **X-Forwarded-For spoofing** → mitigated by explicit Express `trust proxy` configuration.

## Token handling

- Tokens are generated with `crypto.randomBytes(32)` (256 bits).
- Only SHA-256 hashes are stored in `slg_links.token_hash`.
- Token lookup is by hash; collisions are infeasible.
- Token values are scrubbed from logs.

## Audit events

Recorded in `slg_audit_events`:

- `link_created`, `link_revoked`, `link_expired`
- `submission_created`
- `rate_retrieved`
- `label_created`, `label_downloaded`
- `admin_login_success`, `admin_login_failure`

Each event records: event type, actor, actor type, IP, timestamp, `request_id`, and `link_id` when applicable.

## Secrets

- `SLG_INTERNAL_API_KEY` authenticates calls to the `/internal/shipping/*` seam, which is now served by `slg-api` itself (loopback via `SLG_INTERNAL_API_BASE_URL`). Rotate via runbook.
- `JWT_SECRET` signs admin sessions; must be >= 32 characters in production.
- SLG carrier credentials (`FEDEX_*`, `UPS_*`, `USPS_*`, `STAMPS_*`) are configured in the slg-api runtime environment (`api/.env` in development) and are never exposed to `slg-app` or vendors. The posh backend retains separate credentials for unrelated carrier workflows. For credential-free non-production development, `SLG_INTERNAL_FAKE_CARRIERS=true` substitutes deterministic fake carriers.

## Open items (Lane E)

- Full DFD and attack tree.
- IP allowlist specification for seam.
- Package value/dimension sanity limits.
- Secrets rotation runbook.

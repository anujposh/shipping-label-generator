# Shipping label frontend

Isolated Next.js App Router application. No imports from sibling applications.

## Run

Copy `.env.example` to `.env.local` and set `SLG_API_BASE_URL` to the API service origin. This variable is server-only. Run `npm install --no-audit --no-fund`, then `npm run dev` (port 3011, bound to `0.0.0.0` for LAN access). Production: `npm run build` and `npm start`.

## Routes

- `/l/[token]`: link validity and start screen.
- `/l/[token]/shipment`: vendor pickup/contact/tax details, destination/packages, rates, confirmation, PDF download.
- `/l/[token]/status`: scoped history and label re-download.
- `/admin/login`: local admin sign-in.
- `/admin/vendors`: searchable/paginated table, create, archive confirmation.
- `/admin/links`: vendor filter, creation with legacy origin record, revoke confirmation, one-time token copy.
- `/admin/shipments`: vendor/status filters, searchable/paginated table.
- `/admin/shipments/[id]`: shipment detail.
- `/admin/audit`: read-only searchable/paginated history.
- `/api/l/[token]/[action]` and `/api/admin/[...path]`: allowlisted BFF routes.

## Contract reconciliation required

The task's supplied API contract was truncated. These are the implemented assumptions to reconcile with the API lane before end-to-end acceptance:

- Rates: POST `{vendorDetails,shipTo,packages:[{weight,length,width,height}]}`; pounds/inches. `vendorDetails` contains the vendor-submitted company/contact/pickup address and optional tax IDs. Response `{rates:[{id?,rateId?,carrier,serviceType,totalCharge?,totalPrice?,amount?,currency?,estimatedDelivery?,estimatedDays?}]}`.
- Shipment: POST `{vendorDetails,shipTo,packages,selectedRate,rateId?,carrier,serviceType}`; response `{shipment:{id,status,trackingNumber}}` or flat shipment. A 409 sends the user to scoped history without creating another shipment. Status returns the current link's saved `vendorDetails` for reuse; every rates/shipment/estimate submission validates and updates them.
- Label: GET `/v1/label.pdf?shipmentId=<id>`. Only the shipment ID, never the bearer token, enters query parameters.
- Admin login: `{email,password}`; expects `{token}` or `{accessToken}`. JWT is removed from the client response and stored in an HttpOnly, SameSite=Strict cookie (Secure in production), with an eight-hour upper bound. API JWT verification remains authoritative.
- Lists accept arrays or `{vendors|links|shipments|audit|items|events:[...]}`; record fields may be snake_case or camelCase for display. Filters use `vendorId` and `status`.
- Vendor creation: `{name,contactEmail,notes}`; archive PATCH `{archived:true}`.
- Link creation: `{vendorId,expiresAt,maxUses,shipFrom}`, expects `{token}` once. Link revocation: POST `{}`.
- Vendor dropdown currently expects `{vendors:[...]}`. Tables paginate the returned result client-side; if the API enforces server pagination, wire response totals/cursors before release.
- Link status must permit scoped history and downloads after exhaustion if re-downloads are intended. A 403/410 status response without shipments cannot render history.

## Security and operations

No analytics, external assets, or token persistence in local/session storage. All routes send `Referrer-Policy: no-referrer`; BFF responses are `no-store`. Vendor tokens only appear in route paths and upstream Authorization headers. Deployment access logs must redact `/l/*` and `/api/l/*` paths. The BFF does not log request URLs or forward browser-supplied authorization/client-IP headers.

Mutations require matching Origin; reverse-proxy deployments must preserve the external origin/host as seen by Next. The BFF forwards only allowlisted methods, paths, and filter parameters. It never proxies arbitrary upstream URLs. Admin session cookies are not proof of authorization; all API requests are validated by the upstream API.

Deployment/runbook changes belong to the orchestrator's documentation lane; this lane is restricted to this app folder. No existing deployment or production routes are changed here.

## Validation

Assigned install and production build passed. Browser, API integration, accessibility automation, and end-to-end tests were not assigned/run. The first build exposed a missing copied DataTable select dependency; copying it unchanged fixed the build. `bd` was unavailable in this environment.

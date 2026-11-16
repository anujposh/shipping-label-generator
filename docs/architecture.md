# Architecture

## Overview

The Shipping Label Generator (SLG) is an isolated project that lets external vendors create shipping labels using company carrier accounts without accessing internal systems or credentials.

## Components

- `slg-api` — Express + Knex service. Owns the carrier clients and serves the `/internal/shipping/*` seam itself.
- `slg-app` — Next.js 16 frontend (vendor UI + internal admin dashboard).
- `backend` — the existing monorepo backend. It no longer mounts the `/internal/shipping/*` seam; that seam now lives in `slg-api`.

## Data flow

1. Admin creates a vendor and generates a link in the admin dashboard.
2. Link token is sent to the vendor out-of-band (v1: copy-paste).
3. Vendor visits `/l/{token}` in `slg-app` and submits company, contact, pickup-address, and applicable tax-identification details without creating an account.
4. `slg-app` BFF/server-side routes proxy to `slg-api`.
5. `slg-api` validates the token and mandatory vendor details, saves reusable details on that link and a snapshot on each shipment, records audit events, and calls its own local seam (`/internal/shipping/*`, reached via `SLG_INTERNAL_API_BASE_URL`) for carrier operations.
6. Label PDF is stored in `slg_labels.label_pdf_base64` and returned to the vendor. FedEx domestic labels use the submitted details as shipper; international labels also use them as exporter and shipper tax identification.
7. For FedEx international shipments, the validated customs snapshot is stored in `slg_shipments.customs`; generated/uploaded trade documents are stored separately in `slg_documents` and downloaded through link-scoped vendor routes.

## Isolation model

- Each vendor has a distinct `slg_vendors` row.
- Links belong to exactly one vendor and carry usage limits and expiry.
- All vendor-facing queries are scoped by `link_id` and `vendor_id`; reusable `vendor_details` are read and updated only through the authenticated link.
- Admin users are stored separately in `slg_admin_users` with their own JWT sessions.

## Deployment notes

- `slg-api` serves `/internal/shipping/*` itself; the seam client calls it over loopback using `SLG_INTERNAL_API_BASE_URL` (`http://127.0.0.1:3010` in `.env.example`). No backend deployment is required for the seam.
- SLG carrier secrets (`FEDEX_*`, `UPS_*`, `USPS_*`, `STAMPS_*`) are configured in the `slg-api` runtime environment. The posh backend retains separate credentials for its own checkout and logistics workflows.
- `slg-api` and `slg-app` run as separate containers/services.
- The seam is protected by `SLG_INTERNAL_API_KEY` shared-secret auth plus optional `SLG_INTERNAL_API_ALLOWED_IPS` allowlist.

## Open items (Lane E)

- Sequence / ER diagram.
- Detailed seam request/response DTOs.
- Runbook integration with `.agents/skills/deploy-posh-production/references/production-runbook.md`.

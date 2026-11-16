# API Documentation

## Internal seam (slg-api)

`/internal/shipping/*` is now owned and served by `slg-api` itself (the main posh backend no longer mounts it). The `slg-api` seam client calls this local seam using `SLG_INTERNAL_API_BASE_URL` (`http://127.0.0.1:3010` in `.env.example`) with a shared secret. The seam is flag-gated (`SLG_INTERNAL_API_ENABLED=true`); when off, every sub-path returns 404 like an unknown route. SLG carrier credentials are configured in the slg-api runtime environment.

### `POST /internal/shipping/rate-quote`

Authenticated by `Authorization: Bearer ${SLG_INTERNAL_API_KEY}`.

Request DTO (to be finalized):

- `ship_from`: approved origin address object
- `ship_to`: destination address object
- `packages`: package list (weight/dimensions)
- `carrier` (optional): filter by carrier
- `service_type` (optional): filter by service

Response DTO:

- List of rates with carrier, service, amount, currency, transit days.

### `POST /internal/shipping/duty-tax-estimate`

Authenticated by `Authorization: Bearer ${SLG_INTERNAL_API_KEY}`. Calls FedEx Estimated Duty & Tax for an international commodity shipment and returns sanitized, explicitly non-guaranteed estimate details.

### `POST /internal/shipping/create-shipment`

Authenticated by `Authorization: Bearer ${SLG_INTERNAL_API_KEY}`.

Request DTO:

- `ship_from`, `ship_to`, `packages`
- `selected_rate`: chosen rate object
- `service_type`: explicit service code

Response DTO:

- `tracking_number`
- `label_pdf_base64`
- Carrier/environment metadata

## SLG public vendor routes

Mounted under `/v1` in `slg-api`. All require a valid link token (passed in `Authorization: Bearer {token}` or a secure cookie) and are rate-limited.

- `POST /v1/rates`
- `POST /v1/shipment`
- `POST /v1/label`
- `GET /v1/label.pdf`
- `GET /v1/status`
- `GET /v1/documents?shipmentId=...`
- `GET /v1/document?documentId=...`
- `POST /v1/duty-tax-estimate`

FedEx international requests accept a validated `customs` object for documents-only or multi-commodity shipments. Document list/status responses contain metadata only; document bytes require the link-scoped download route. Duty/tax estimates are explicitly non-guaranteed. See [FedEx International Shipping](fedex-international.md) for the customs, ETD, validation, and document contracts.

### Vendor details contract

`POST /v1/rates`, `POST /v1/shipment`, and `POST /v1/duty-tax-estimate` require a `vendorDetails` object containing `companyName`, `contactName`, `contactEmail`, `contactPhone`, `addressLine1`, optional `addressLine2`, `city`, `state`, `zipCode`, `countryCode`, and an optional `taxIds` array. Each tax ID contains `number` and an official FedEx `tinType`. All fields except `addressLine2` and `taxIds` are mandatory and validated server-side; validation responses use `fieldErrors` paths prefixed with `vendorDetails.`.

The API saves validated details to `slg_links.vendor_details` for reuse on subsequent shipments through the same private link. `GET /v1/status` returns only the authenticated link's `link.vendorDetails` and derived `link.shipFromCountryCode`. Each shipment stores an independent snapshot in `slg_shipments.ship_from`, so later edits do not rewrite prior submissions. Admin shipment detail exposes this snapshot as `shipFrom`.

The submitted details are the carrier origin for rates, estimates, and labels. For FedEx international shipments, the server makes the same details authoritative for `customs.exporter` and shipper tax IDs; browser-supplied exporter overrides are not honored. Carrier credentials remain server-side and are never part of this contract.

## SLG admin routes

Mounted under `/admin/v1` in `slg-api`. Require JWT session.

- `POST /admin/v1/login`
- `POST /admin/v1/logout`
- Vendors CRUD
- Links create / revoke / list
- Shipments list / detail
- Audit events view

## Open items (Lane E)

- Complete request/response schemas with examples.
- Error code catalog.
- Rate-limit headers.

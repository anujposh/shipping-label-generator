# FedEx International Shipping

This project supports FedEx international commodity and documents-only shipments through the existing vendor-link workflow. Domestic requests and non-FedEx carrier requests retain their existing payload path.

## Service selection and shipment classification

- Shipper and recipient ISO country codes determine whether a shipment is international. The browser receives `link.shipFromCountryCode` in `/v1/status`; the API repeats the check server-side and is authoritative.
- `POST /v1/rates` returns the carrier services returned by the carrier Rates APIs plus `shipmentContext` with the origin, destination, and international classification. FedEx international service availability is not hardcoded.
- A rate's canonical `service` code is sent on shipment creation. Display names are never substituted for FedEx `serviceType` values.
- The customs UI is shown only for a selected FedEx international rate. Customs data is required again by the public API and internal seam, so bypassing the browser cannot bypass validation.

## Customs data

The public `customs` object supports:

- Shipment purpose, invoice number, shipment reference, Incoterm, and one ISO 4217 currency per shipment.
- Documents-only description or multiple commodities with name, detailed description, intended use, HS code, country of manufacture, quantity/unit, total line weight/unit, unit price/currency, and business/consumer purpose.
- Automatically calculated line and total customs values. The server recomputes totals and rejects mismatches. No currency conversion is performed; mixed item currencies are rejected rather than summed incorrectly.
- Shipper, recipient, exporter, importer-of-record, and third-party payor details, including the six FedEx-supported tax ID types.
- Duties payment by `SENDER`, `RECIPIENT`, or `THIRD_PARTY`. Third-party payment requires an account and contact/address details.
- Freight, insurance, miscellaneous, packing, and handling charges; declarations, comments, related-party status, export compliance statements, and Canadian B13A filing options.

Commodity intended use is included in the FedEx commodity description because the Ship API has no free-text `intendedUse` field. Commodity `purpose` is restricted to FedEx's `BUSINESS` or `CONSUMER` values.

Documents-only Express shipments require a user-declared positive customs value; some destinations reject zero or null values. The application sends one contents line derived from the document description, declared value, and actual package weight. It never invents a nominal amount. Documents-only Ground requests are rejected before carrier I/O.

Validation failures return HTTP 400 with the existing `details` array and `fieldErrors`, an object keyed by paths such as `customs.commodities[0].hsCode`. HS validation checks structure (6–14 digits, dots allowed); it does not assert that a tariff classification is correct. Users remain responsible for classification and export compliance.

US export compliance checks cover the documented CN/RU/VE/HK routes and the USD 2,500 commodity-line threshold. Canadian non-document exports outside CA/US/PR/VI require a B13A filing option; the CAD 2,000 export-statement threshold is evaluated separately.

## Trade documents and ETD

Supported generated-document requests are Commercial Invoice, Pro Forma Invoice, Certificate of Origin, USMCA Certification of Origin, and USMCA Commercial Invoice/Certification of Origin. Generated documents use PDF/`PAPER_LETTER` format and are parsed separately from shipping labels.

Users can upload up to five documents, each no larger than 5 MiB decoded. The backend accepts the document formats listed by FedEx's Trade Documents Upload API. The browser deliberately exposes a conservative PDF/PNG/JPEG/TIFF/text picker.

Electronic Trade Documents use the official workflows:

- **Pre-shipment:** upload to `/documents/v1/etds/encodedmultiupload`, correlate `documentResponses` by `fileReferenceId`, and attach returned IDs using `{documentId, documentType}`. Failure stops the request before a label is created.
- **Post-shipment:** create with `POST_SHIPMENT_UPLOAD_REQUESTED`, then upload with the tracking number, create-response ship date, and location codes when returned. An upload failure after label creation produces a warning and `FAILED` document status; it does not make another label request safe or necessary.
- USMCA uploads include `formCode: "USMCA"`. Ground uploads use `FDXG`; Express uploads use `FDXE`.

The document host is selected separately from the Ship/Rates host:

- Sandbox: `https://documentapitest.prod.fedex.com/sandbox/`
- Production: `https://documentapi.prod.fedex.com/`
- Optional test/operations override: `FEDEX_DOCUMENT_BASE_URL`

FedEx and destination-country acceptance varies. Physical original documents may still be required. If FedEx returns only a document URL rather than encoded bytes, the application reports a warning instead of treating that URL as a stored document.

## Duty and tax estimates

`POST /v1/duty-tax-estimate` and `POST /internal/shipping/duty-tax-estimate` call FedEx `POST /dutytax/v1/estimate` for international commodity shipments. Requests can include service and selected shipping cost. Canada/Brazil state or province is required on either side of the estimate route.

Responses sanitize duty, fee, tax, and summary fields, tolerate FedEx's `totalDuty`/`totalDuties` discrepancy, and always identify the result as **non-guaranteed**. An unavailable or unauthorized estimate is reported explicitly and never replaced with a fabricated amount. Estimates do not create shipments and do not block the separate label workflow.

## Persistence and vendor routes

The additive migration `20261110200000_add_international_customs_and_documents.ts` adds:

- `slg_shipments.customs` — the validated customs snapshot.
- `slg_documents` — generated/uploaded document bytes and metadata, linked to shipment and optional label.

Vendor endpoints remain bearer-token protected and scoped to the token's link:

- `GET /v1/documents?shipmentId=...` lists metadata only.
- `GET /v1/document?documentId=...` downloads a document after verifying `documentId → shipment → link` ownership.
- `/v1/status` and shipment responses include document metadata and warnings, never document base64.

Customs documents can contain personal and commercially sensitive data. Do not log document bytes or request bodies, apply the same retention/deletion policy as shipment labels, and use the existing authenticated download path rather than public object URLs.

## Verification

```bash
npm --prefix api run typecheck
npm --prefix api run unit
npm --prefix api run integration  # requires TEST_DATABASE_URL; use a disposable schema

cd app
npx playwright test --reporter=line
npm run build
```

The Playwright suite covers domestic payload preservation, documents-only/ETD, multiple commodities and totals, missing/invalid fields, currency mismatch, third-party duties, uploads, B13A/tax IDs, estimate summaries, and mobile overflow. API unit/integration suites additionally cover the exact browser-to-seam-to-FedEx contract, upload response association, label/document discrimination, persistence, and tenant isolation.

## Official references

- Ship API guide: https://developer.fedex.com/api/en-us/catalog/ship/v1/docs.html
- Ship OpenAPI resource: https://developer.fedex.com/wirc/json/api_groups/Ship/Shipment-Resource.json
- Trade Documents Upload guide: https://developer.fedex.com/api/en-us/catalog/upload-documents/docs.html
- Trade Documents Upload OpenAPI resource: https://developer.fedex.com/wirc/json/api_groups/ETDUpload/EDUDocuments-Resource.json
- Estimated Duty & Tax guide: https://developer.fedex.com/api/en-us/catalog/dutiestaxes/docs.html
- Estimated Duty & Tax OpenAPI resource: https://developer.fedex.com/wirc/json/api_groups/DutiesAndTaxesAPI/DutiesAndTaxesAPI-Resource.json
- Rates and Transit Times guide: https://developer.fedex.com/api/en-us/catalog/rate/v1/docs.html

## Sandbox verification (2026-11-11)

All live checks used the existing sandbox configuration and synthetic data; no production shipment was created. Sanitized outcomes are under `api/test-results/sandbox-labels/`.

- **Domestic FedEx control:** rate quote and one-page Ground label succeeded. The rendered label passed visual QA. The same carrier sweep returned unrelated UPS shipper-number and USPS label errors; their rate calls succeeded and those errors are outside this FedEx change.
- **US → CA commodity shipment:** `INTERNATIONAL_PRIORITY` returned a one-page international label, Commercial Invoice, and Certificate of Origin. The invoice contains two commodities and the correct 95 USD total. All three rendered documents passed visual QA.
- **Documents-only:** FedEx first rejected a zero declared value with `CUSTOMS.VALUE.INVALID`. After changing the contract to require a user-supplied positive value, the explicit 1 USD test scenario returned a one-page documents-only label. PDF structure/content checks passed; a full rendered visual review was not available.
- **Pre-shipment ETD:** FedEx accepted the uploaded Commercial Invoice, returned its document ID, attached it with `ATTACHED` status, and created the ETD label plus generated Commercial Invoice and Certificate of Origin. The live single-object upload response exposed and verified the need to accept both object and array response forms. Deterministic PDF checks passed; a separate rendered ETD visual review was not available in this environment.
- **Estimated Duty & Tax:** FedEx returned `FORBIDDEN.ERROR` for the configured credentials. Estimates therefore remain unverified against live data and are shown as unavailable; no estimate was fabricated or retried.

Key result files are `international-us-ca-results.json`, `documents-only-results.json`, and `results.json` (latest ETD scenario). They contain no credentials, request bodies, or raw carrier responses.

Useful opt-in commands:

```bash
cd api
npm run sandbox:labels
npm run sandbox:labels -- --scenario=international-us-ca --with-duty-estimate
npm run sandbox:labels -- --scenario=documents-only
npm run sandbox:labels -- --scenario=international-us-ca --with-etd-upload
```


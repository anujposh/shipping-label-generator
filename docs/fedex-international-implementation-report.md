# FedEx International Shipping — Implementation Report

Date: 2026-11-11

## Delivered

- Runtime FedEx service discovery through the existing Rates API; no hardcoded international service list.
- Automatic origin/destination country classification in browser and server.
- FedEx international commodity and documents-only shipment flows with server-authoritative validation and structured field errors.
- Dynamic add/edit/remove commodities with automatic customs value and LB/KG weight totals, HS/origin/intended-use fields, and single-currency enforcement without implicit FX conversion.
- Shipment purpose, invoice/reference, Incoterms, exporter/importer/recipient tax IDs and party details, duties payer (shipper/recipient/third party), charges, declarations, related parties, US export compliance, and Canadian B13A filing options.
- FedEx `customsClearanceDetail`, `commodities`, `commercialInvoice`, `shippingDocumentSpecification`, ETD special-service, party, duties, reference, and export-detail mapping verified against official OpenAPI artifacts.
- Generated Commercial Invoice, Pro Forma Invoice, Certificate of Origin, and USMCA document specifications.
- Pre- and post-shipment encoded ETD upload workflows, per-document response correlation, USMCA form codes, FDXE/FDXG selection, single-object and array upload-response support, and post-upload warning semantics that prevent duplicate-label retries.
- Separate label/customs-document response parsing and persistent, link-scoped document metadata/list/download support.
- Optional Estimated Duty & Tax API integration with explicit non-guaranteed presentation and graceful permission-failure behavior.
- Opt-in sandbox scenarios for domestic, US→CA commodities, documents-only, ETD upload, and duty estimates. Existing domestic behavior and legacy direct-carrier customs fallback remain intact.

## Main files changed

### API implementation

- `api/src/carriers/customs.ts` — new customs validation, normalization, FedEx mapping, document specification, and estimate mapping.
- `api/src/carriers/carrier-types.ts` — customs/document contracts.
- `api/src/carriers/fedex.client.ts` — international shipment creation, ETD upload/attach, generated documents, response parsing, and duty estimates.
- `api/src/carriers/carrier.service.ts`
- `api/src/carriers/seam-client.ts`
- `api/src/core/validation.ts`
- `api/src/internal-shipping/internal-shipping.dto.ts`
- `api/src/internal-shipping/routes/internal-shipping.routes.ts`
- `api/src/internal-shipping/services/fake-carriers.ts`
- `api/src/routes/vendor.routes.ts`
- `api/src/server.ts` — route-scoped 40 MB customs parsers; other endpoints retain 256 kB.
- `api/src/store/documents.store.ts` — new document persistence/read store.
- `api/src/store/shipments.store.ts`
- `api/src/types/index.ts`
- `api/migrations/20261110200000_add_international_customs_and_documents.ts` — `slg_shipments.customs` and `slg_documents`.
- `api/scripts/sandbox-label-check.ts`
- `api/.env.example`

### Frontend

- `app/src/components/vendor-flow.tsx`
- `app/src/components/customs-fields.tsx` — new customs/party/commodity/document UI.
- `app/src/components/shipment-documents.tsx` — new metadata/download/warning UI.
- `app/src/components/fields.tsx`
- `app/src/lib/customs.ts`
- `app/src/lib/duty-estimate.ts`
- `app/src/lib/proxy.ts`
- `app/src/app/api/l/[token]/[action]/route.ts`
- `app/src/app/globals.css`
- `app/playwright.config.ts`
- `app/tests/international.spec.ts`

### Tests

- New unit suites: `customs.test.ts`, `fedex-international.test.ts`, `internal-shipping-customs.test.ts`, `vendor.international.test.ts`, `vendor.ui-contract.test.ts`, `customs-invoice-details.test.ts`, and `sandbox-label-check.test.ts`.
- Updated unit support: `api/tests/unit/fake-knex.ts` and existing regression suites.
- `api/tests/integration/vendor-international.test.ts` — new migration-backed international/persistence/IDOR suite.
- `api/tests/integration/vendor-flow.test.ts` — domestic compatibility.
- `app/tests/international.spec.ts` — seven browser scenarios.

### Documentation/configuration

- `README.md`
- `.env.example`
- `docs/api.md`
- `docs/architecture.md`
- `docs/fedex-international.md`
- `graphify-out/` regenerated with `graphify update .`.

## Verification evidence

| Check | Result |
|---|---|
| API TypeScript typecheck | Passed |
| API production build (`tsc -p .`) | Passed |
| API Prettier check across src/scripts/migrations/tests | Passed |
| API unit suite | **142/145 passed**; only the three pre-existing baseline failures remain |
| Real PostgreSQL migrations + integration suite in an isolated disposable schema | **12/12 passed** |
| Exact browser payload → public validation → vendor route → seam → FedEx mapping | Passed |
| UI Playwright suite | **7/7 passed** |
| UI production build (Next.js/TypeScript) | Passed |
| Targeted ESLint on touched frontend files | Passed |
| Graphify AST update | Passed: 1,276 nodes / 2,448 edges |

The unchanged baseline failures are two admin-route tests (`creates and lists vendors`, `revokes a link and audits`) and one config test (`missing DATABASE_URL` expectation). The baseline full frontend lint also has an existing `admin.tsx` `react-hooks/set-state-in-effect` error and unrelated warnings; the touched frontend files lint cleanly.

## Actual FedEx sandbox results

All carrier writes used synthetic data and the existing sandbox environment. No production shipment was created and no credentials or raw request bodies were written to results.

### Domestic control

- FedEx rate quote: HTTP 200.
- FedEx Ground label: HTTP 200, one-page PDF, visual QA passed.
- Unrelated existing carrier results: UPS label failed with `120100: Missing or invalid shipper number`; USPS label failed with HTTP 400; both rate calls succeeded. Stamps remains rate-only by design.

### US → CA multi-commodity shipment

- Service: `INTERNATIONAL_PRIORITY`.
- Label: HTTP 200, one-page international PDF, visual QA passed.
- Commercial Invoice: FedEx-generated PDF with two commodities and correct 95 USD total; visual QA passed.
- Certificate of Origin: FedEx-generated PDF; visual QA passed.
- Artifacts include `fedex-international-us-ca-sandbox.pdf` and corresponding Commercial Invoice/Certificate of Origin PDFs.

### Documents-only

- The initial zero-value request was correctly rejected by FedEx with `CUSTOMS.VALUE.INVALID`.
- The implementation was corrected to require a user-declared positive value rather than inventing one.
- The explicit 1 USD synthetic test then succeeded with a one-page documents-only label.
- PDF structure/content checks passed; a separate full rendered review was not available.
- Result: `api/test-results/sandbox-labels/documents-only-results.json`.

### Electronic Trade Documents

- Encoded pre-shipment Commercial Invoice upload succeeded.
- FedEx returned a document ID; the upload was attached with `ATTACHED` status.
- ETD label creation succeeded, and FedEx also returned generated Commercial Invoice and Certificate of Origin PDFs.
- The live response confirmed that a one-document upload may return `documentResponses` as an object rather than an array; the parser now accepts both forms with regression coverage.
- Result and artifact metadata: `api/test-results/sandbox-labels/international-us-ca-results.json` and `results.json`.
- Deterministic PDF checks passed; a separate rendered ETD visual review was unavailable in this environment.

### Estimated Duty & Tax

FedEx returned `FORBIDDEN.ERROR` for the configured credentials. The feature is implemented and tested with mocked responses, but live estimate data remains unverified. The application reports the estimate as unavailable, does not retry or fabricate it, and always labels estimates non-guaranteed.

## Remaining limitations and operational notes

- FedEx/destination acceptance of ETD and generated documents varies; physical originals may still be required.
- Documents returned only by URL are not persisted as bytes; a warning is surfaced instead.
- HS validation checks structure, not tariff correctness. Users remain responsible for classification, export filings, and declared values.
- Mixed currencies in one shipment are intentionally rejected; no exchange-rate conversion is attempted.
- Full production behavior was not tested. Production rollout should run the migration, deploy API/app together, verify credential permissions for ETD and Estimated Duty & Tax, and repeat a controlled certification shipment.
- No git commit or push was created.

## Reproduction commands

```bash
npm --prefix api run typecheck
npm --prefix api run unit
npm --prefix api run format:check
npm --prefix api run build
npm --prefix api run integration  # use TEST_DATABASE_URL in a disposable schema

cd app
npx playwright test --reporter=line
npm run build

cd ../api
npm run sandbox:labels
npm run sandbox:labels -- --scenario=international-us-ca --with-duty-estimate
npm run sandbox:labels -- --scenario=documents-only
npm run sandbox:labels -- --scenario=international-us-ca --with-etd-upload
```

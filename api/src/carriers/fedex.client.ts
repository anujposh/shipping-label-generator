import {
  CarrierApiError,
  CarrierAuthError,
  CarrierConfigError,
  CarrierUnavailableError,
  CarrierValidationError,
} from "./carrier-errors";
import {
  bearerRequest,
  CARRIER_DEFAULT_TIMEOUT_MS,
  CARRIER_SHIPMENT_TIMEOUT_MS,
  configFingerprint,
  createTokenCache,
  isAbortError,
  readCarrierJson,
  type CarrierTransport,
} from "./carrier-client";
import { applyDocTabZones } from "./doc-tab-layout";
import { composeDocTabLabelPdf } from "./label-pdf-crop";
import {
  fedexRequestedDocumentTypes,
  fedexShippingDocumentSpecification,
  mapDutyTaxEstimateResponse,
  toFedexCustomsMapping,
  buildDutyTaxEstimateRequest,
  USMCA_DOCUMENT_TYPES,
  type DutyTaxEstimate,
  type DutyTaxEstimateInput,
} from "./customs";
import type {
  AddressCandidate,
  AddressValidationResult,
  CarrierAddress,
  CarrierLabel,
  CustomsItem,
  CustomsUpload,
  FedexCredentialOverride,
  PickupResult,
  RateQuote,
  RateShopArgs,
  ShipmentDocument,
  ShipmentRequest,
  TrackingInfo,
  VoidShipmentResult,
} from "./carrier-types";

type FetchLike = typeof fetch;

let transport: FetchLike = fetch;

/** Test-only fetch seam — production code never calls this. */
export function __setFedexTransportForTests(
  next: CarrierTransport | null,
): void {
  transport = next ?? fetch;
}

// Local structured-logging facade — mirrors core/logger's JSON envelope but
// keeps the carrier client dependency-free (it is deliberately standalone,
// ported from shipping-cli; unit tests import it without the app core).
function log(
  level: "info" | "warn",
  event: string,
  fields: Record<string, unknown>,
): void {
  const entry = JSON.stringify({
    ...fields,
    timestamp: new Date().toISOString(),
    level,
    service: "backend",
    event,
  });
  (level === "warn" ? console.warn : console.log)(entry);
}

interface FedexConfig {
  apiKey: string;
  apiSecret: string;
  accountNumber: string;
  useSandbox: boolean;
  /** Explicit API base URL (BC tliLocation override); wins over useSandbox. */
  baseUrl?: string;
}

/** Token caches keyed by fingerprint of the full effective config. */
const tokenCaches = new Map<
  string,
  (forceRefresh?: boolean) => Promise<string>
>();

/** Configs already covered by a base-URL coherence warning (log once each). */
const coherenceWarned = new Set<string>();

/** Test-only: clears per-credential token caches. */
export function __resetForTests(): void {
  tokenCaches.clear();
  coherenceWarned.clear();
}

export const FEDEX_PRODUCTION_HOST = "https://apis.fedex.com/";

/** Production credentials apply to rate reads only, never shipment writes. */
export function fedexProductionRateQuoteOverride():
  FedexCredentialOverride | undefined {
  const apiKey = process.env.FEDEX_PRODUCTION_API_KEY?.trim();
  const apiSecret = process.env.FEDEX_PRODUCTION_API_SECRET?.trim();
  const accountNumber = process.env.FEDEX_PRODUCTION_ACCOUNT_NUMBER?.trim();
  if (!apiKey || !apiSecret || !accountNumber) return undefined;
  return { apiKey, apiSecret, accountNumber, baseUrl: FEDEX_PRODUCTION_HOST };
}

function effectiveConfig(cfg?: FedexCredentialOverride): FedexConfig {
  const apiKey = cfg?.apiKey || process.env.FEDEX_API_KEY;
  const apiSecret = cfg?.apiSecret || process.env.FEDEX_API_SECRET;
  const accountNumber = cfg?.accountNumber || process.env.FEDEX_ACCOUNT_NUMBER;
  if (!apiKey || !apiSecret || !accountNumber) {
    throw new CarrierConfigError(
      "FedEx is not configured: set FEDEX_API_KEY, FEDEX_API_SECRET, FEDEX_ACCOUNT_NUMBER",
    );
  }
  const config: FedexConfig = {
    apiKey,
    apiSecret,
    accountNumber,
    useSandbox: process.env.CARRIER_SANDBOX === "true",
    baseUrl: cfg?.baseUrl || process.env.FEDEX_BASE_URL || undefined,
  };
  warnBaseUrlCoherence(config);
  return config;
}

function baseUrl(config: Pick<FedexConfig, "baseUrl" | "useSandbox">): string {
  if (config.baseUrl) {
    return config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`;
  }
  return config.useSandbox
    ? "https://apis-sandbox.fedex.com/"
    : "https://apis.fedex.com/";
}

/** Same host precedence as shipment/track calls; rate-only overrides do not apply. */
export function fedexEnvironment(
  cfg?: Pick<FedexCredentialOverride, "baseUrl">,
): "sandbox" | "production" {
  const url = baseUrl({
    baseUrl: cfg?.baseUrl || process.env.FEDEX_BASE_URL || undefined,
    useSandbox: process.env.CARRIER_SANDBOX === "true",
  });
  return /sandbox/i.test(new URL(url).hostname) ? "sandbox" : "production";
}

/**
 * Flags a base URL that contradicts the sandbox flag: a tliLocations
 * override pointing at the sandbox host while CARRIER_SANDBOX is off (the
 * live failure mode from the 2026-09-30 probe: live keys + sandbox host =
 * OAuth 403 on every call), or the reverse. Key type is not derivable from
 * the key material itself, so this is a source-coherence warning only — the
 * OAuth 403 mapping below is the authoritative mismatch detector.
 */
function warnBaseUrlCoherence(config: FedexConfig): void {
  if (!config.baseUrl) return;
  const url = baseUrl(config);
  const sandboxHost = /sandbox/i.test(url);
  if (sandboxHost === config.useSandbox) return;
  const key = configFingerprint(config);
  if (coherenceWarned.has(key)) return;
  coherenceWarned.add(key);
  if (sandboxHost) {
    console.warn(
      `fedex_base_url_coherence: tliLocations fedExBaseURLRESTAPI/fedexURL override targets the SANDBOX host (${url}) while CARRIER_SANDBOX is not enabled — verify the FedEx API key/secret are sandbox-issued; live credentials are rejected there with OAuth 403.`,
    );
  } else {
    console.warn(
      `fedex_base_url_coherence: CARRIER_SANDBOX=true is ignored — the tliLocations fedExBaseURLRESTAPI/fedexURL override targets the PRODUCTION host (${url}).`,
    );
  }
}

function environmentLabel(config: FedexConfig): string {
  const url = baseUrl(config);
  return url.includes("sandbox") ? `SANDBOX (${url})` : `PRODUCTION (${url})`;
}

/**
 * Official ETD document hosts. These are NOT the API host — the upload
 * endpoints live on documentapi(.prod).fedex.com. A test/ops override
 * (FEDEX_DOCUMENT_BASE_URL) or a non-FedEx FEDEX_BASE_URL (unit test server)
 * wins so the transport seam stays exercisable offline.
 */
const FEDEX_DOCUMENTS_SANDBOX_HOST =
  "https://documentapitest.prod.fedex.com/sandbox/";
const FEDEX_DOCUMENTS_PRODUCTION_HOST = "https://documentapi.prod.fedex.com/";
const CARRIER_DOCUMENT_TIMEOUT_MS = 60_000;

function documentApiBaseUrl(config: FedexConfig): string {
  const override = process.env.FEDEX_DOCUMENT_BASE_URL?.trim();
  if (override) return override.endsWith("/") ? override : `${override}/`;
  if (config.baseUrl) {
    const host = new URL(config.baseUrl).hostname;
    if (/^apis-sandbox\./i.test(host)) return FEDEX_DOCUMENTS_SANDBOX_HOST;
    if (/^apis\./i.test(host)) return FEDEX_DOCUMENTS_PRODUCTION_HOST;
    return config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`;
  }
  return config.useSandbox
    ? FEDEX_DOCUMENTS_SANDBOX_HOST
    : FEDEX_DOCUMENTS_PRODUCTION_HOST;
}

async function documentRequest<T>(
  config: FedexConfig,
  path: string,
  body: unknown,
): Promise<T> {
  const url = `${documentApiBaseUrl(config)}${path}`;
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await bearerRequest(
      transport,
      (force) => getAccessToken(config, force ?? false),
      () => ({}),
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      },
      CARRIER_DOCUMENT_TIMEOUT_MS,
    );
  } catch (error) {
    if (
      error instanceof CarrierApiError ||
      error instanceof CarrierAuthError ||
      error instanceof CarrierConfigError
    ) {
      throw error;
    }
    throw new CarrierUnavailableError(error);
  }
  logFedexCall("POST", path, response.status, startedAt);
  return readCarrierJson<T>(response, `FedEx document POST ${path}`);
}

interface FedexUploadedDocument {
  /** Caller-supplied unique reference used to correlate the response. */
  fileReferenceId: string;
  /** Original request `shipDocumentType` (never the abbreviated response type). */
  shipDocumentType: string;
  documentId?: string;
  /** FedEx diagnostics only (CO/CI/AWB…). */
  responseDocumentType?: string;
  error?: string;
}

interface FedexDocumentResponseEntry {
  fileReferenceId?: string;
  metaData?: {
    docId?: string;
    documentType?: string;
    formCode?: string;
  };
  alerts?: Array<{ code?: string; message?: string }>;
}

/** Ground services must upload under the FDXG operating company. */
function fedexDocumentCarrierCode(
  serviceType: string | undefined,
): "FDXG" | "FDXE" {
  const service = (serviceType ?? "").toUpperCase();
  return service.startsWith("FEDEX_GROUND") ||
    service.startsWith("FEDEX_HOME_DELIVERY")
    ? "FDXG"
    : "FDXE";
}

/**
 * Uploads the shipment's attached customs documents to the official ETD
 * encoded multi-upload endpoint (pre- or post-shipment workflow).
 *
 * Requests carry a unique `fileReferenceId` per document; responses are
 * correlated on that id (`output.documentResponses[].metaData.docId`) rather
 * than array position. Per-document problems are surfaced rather than thrown
 * here so callers can distinguish partial failure from total failure.
 *
 * Never logs document bytes, file names or base64 — counts and types only.
 */
async function uploadCustomsDocuments(
  config: FedexConfig,
  shipment: ShipmentRequest,
  workflowName: "ETDPreshipment" | "ETDPostshipment",
  extra: {
    trackingNumber?: string;
    shipmentDate?: string;
    originLocationCode?: string;
    destinationLocationCode?: string;
  } = {},
): Promise<FedexUploadedDocument[]> {
  const documentSet = shipment.customs?.customsDocuments;
  const uploads = documentSet?.uploads ?? [];
  if (uploads.length === 0) return [];
  const postShipment = workflowName === "ETDPostshipment";
  const payload = {
    workflowName,
    carrierCode: fedexDocumentCarrierCode(shipment.serviceType),
    originCountryCode: (shipment.from.countryCode || "US").toUpperCase(),
    destinationCountryCode: (shipment.to.countryCode || "US").toUpperCase(),
    ...(postShipment
      ? {
          ...(extra.shipmentDate ? { shipmentDate: extra.shipmentDate } : {}),
          ...(extra.trackingNumber
            ? { trackingNumber: extra.trackingNumber }
            : {}),
        }
      : {}),
    metaData: uploads.map((upload: CustomsUpload, index: number) => ({
      fileReferenceId: `doc_${index + 1}`,
      shipDocumentType: upload.shipDocumentType,
      contentType: upload.contentType,
      fileContentBase64: upload.contentBase64,
      // USMCA upload document types require the USMCA form code.
      ...(USMCA_DOCUMENT_TYPES.has(upload.shipDocumentType)
        ? { formCode: "USMCA" }
        : {}),
      ...(postShipment && extra.originLocationCode
        ? { originLocationCode: extra.originLocationCode }
        : {}),
      ...(postShipment && extra.destinationLocationCode
        ? { destinationLocationCode: extra.destinationLocationCode }
        : {}),
    })),
  };
  const data = await documentRequest<{
    output?: {
      documentResponses?:
        FedexDocumentResponseEntry | FedexDocumentResponseEntry[];
      alerts?: Array<{ code?: string; message?: string }>;
    };
  }>(config, "documents/v1/etds/encodedmultiupload", payload);
  log("info", "fedex_document_upload", {
    workflowName,
    carrierCode: payload.carrierCode,
    documentCount: uploads.length,
    documentTypes: uploads.map((upload) => upload.shipDocumentType),
  });
  const documentResponses = data.output?.documentResponses;
  // FedEx's documented response is an array, but the live sandbox returns a
  // single object for a one-document upload. Accept both without guessing IDs.
  const responses = Array.isArray(documentResponses)
    ? documentResponses
    : documentResponses
      ? [documentResponses]
      : [];
  const topLevelAlert = (data.output?.alerts ?? [])
    .map((alert) => alert.message || alert.code)
    .filter((value): value is string => Boolean(value))
    .join("; ");
  return uploads.map((upload, index) => {
    const fileReferenceId = `doc_${index + 1}`;
    const response =
      responses.find((entry) => entry.fileReferenceId === fileReferenceId) ??
      responses[index];
    const documentId = response?.metaData?.docId;
    const entryAlert = (response?.alerts ?? [])
      .map((alert) => alert.message || alert.code)
      .filter((value): value is string => Boolean(value))
      .join("; ");
    const error =
      entryAlert || (documentId ? undefined : topLevelAlert || undefined);
    return {
      fileReferenceId,
      // Attach the ORIGINAL request type — the response abbreviates it.
      shipDocumentType: upload.shipDocumentType,
      ...(documentId ? { documentId } : {}),
      ...(response?.metaData?.documentType
        ? { responseDocumentType: response.metaData.documentType }
        : {}),
      ...(error ? { error } : {}),
    };
  });
}

/** MIME → short doc type used by the public document store. */
function mimeToDocType(contentType: string | undefined): string {
  const value = (contentType ?? "").toLowerCase();
  if (value.includes("pdf")) return "PDF";
  if (value.includes("plain")) return "TXT";
  if (value.includes("png")) return "PNG";
  if (value.includes("jpeg") || value.includes("jpg")) return "JPG";
  if (value.includes("tiff")) return "TIF";
  if (value.includes("word")) return "DOC";
  if (value.includes("sheet") || value.includes("excel")) return "XLS";
  if (value.includes("rtf") || value.includes("richtext")) return "RTF";
  if (value.includes("bmp")) return "BMP";
  if (value.includes("gif")) return "GIF";
  return "UNKNOWN";
}

function documentFileName(
  documentType: string,
  docType: string,
  trackingNumber: string | undefined,
): string {
  const safeType = (documentType || "document")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .toUpperCase();
  const extension =
    docType === "PDF"
      ? "pdf"
      : docType === "TXT"
        ? "txt"
        : docType === "UNKNOWN"
          ? "bin"
          : docType.toLowerCase();
  return `${safeType}${trackingNumber ? `-${trackingNumber}` : ""}.${extension}`;
}

function carrierErrorCode(error: CarrierApiError): string | undefined {
  const body = error.body as { errors?: Array<{ code?: string }> } | undefined;
  const first = Array.isArray(body?.errors) ? body.errors[0] : undefined;
  return typeof first?.code === "string" ? first.code : undefined;
}

/** FedEx address APIs cap stateOrProvinceCode at 30 characters. Longer
 * values (e.g. a full Chilean region name in BC's county field) are OMITTED
 * — never truncated — so FedEx resolves the state from city + postal code
 * while the original address data stays intact on our side. */
const FEDEX_STATE_MAX_LENGTH = 30;

function fedexStateOrProvince(state: string | undefined): string | undefined {
  const value = (state ?? "").trim();
  if (value.length === 0 || value.length > FEDEX_STATE_MAX_LENGTH) {
    return undefined;
  }
  return value;
}

function fedexAddressBlock(address: CarrierAddress): Record<string, unknown> {
  const state = fedexStateOrProvince(address.state);
  return {
    streetLines: [address.addressLine1, address.addressLine2].filter(
      (line): line is string => typeof line === "string" && line.length > 0,
    ),
    city: address.city,
    ...(state !== undefined ? { stateOrProvinceCode: state } : {}),
    postalCode: address.zipCode,
    countryCode: address.countryCode,
  };
}

function isInternationalShipment(shipment: ShipmentRequest): boolean {
  const from = (shipment.from.countryCode || "US").trim().toUpperCase();
  const to = (shipment.to.countryCode || "US").trim().toUpperCase();
  return from !== to;
}

// A form carrying a stale destination country (the SH051507 CL-on-NC case)
// pairs a domestic service with an international address; FedEx answers with
// the opaque SELECTED.DESTINATION.SERVICETYPE.INVALID round-trip. Reject
// early naming the conflict so the user corrects country or service.
const FEDEX_US_DOMESTIC = new Set(["US", "PR", "GU", "VI", "AS"]);
const FEDEX_DOMESTIC_ONLY = new Set([
  "FIRST_OVERNIGHT",
  "PRIORITY_OVERNIGHT",
  "STANDARD_OVERNIGHT",
  "FEDEX_2_DAY",
  "FEDEX_2_DAY_AM",
  "FEDEX_EXPRESS_SAVER",
]);

function assertFedexServiceAvailableForDestination(
  shipment: ShipmentRequest,
  international: boolean,
): void {
  const service = shipment.serviceType.trim().toUpperCase();
  const to = (shipment.to.countryCode || "US").trim().toUpperCase();
  const groundReach = new Set([...FEDEX_US_DOMESTIC, "CA"]);
  const domesticReach = new Set([...FEDEX_US_DOMESTIC, "CA", "MX"]);
  const mismatch =
    (service === "FEDEX_GROUND" && !groundReach.has(to)) ||
    (service === "FEDEX_GROUND_ECONOMY" && !domesticReach.has(to)) ||
    (FEDEX_DOMESTIC_ONLY.has(service) && !FEDEX_US_DOMESTIC.has(to)) ||
    (service.startsWith("INTERNATIONAL_") && !international);
  if (!mismatch) return;
  throw new CarrierValidationError(
    `${service || "The selected service"} is not available for destination ` +
      `country ${to || "(missing)"} — correct the destination country on the ` +
      `address form (it may be stale) or select a service that serves that ` +
      `country, then retry.`,
  );
}

/** Rounds to cents — FedEx rejects customs amounts with float dust. */
function moneyRound(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Builds requestedShipment.customsClearanceDetail from the REAL shipment
 * item data (packing items with quantity × unitPrice). Throws
 * CarrierValidationError BEFORE any FedEx call when an international
 * shipment lacks usable customs data — the alternative is FedEx's opaque
 * TOTALCUSTOMSVALUE.REQUIRED rejection after the round-trip.
 *
 * FedEx additionally rejects commodities missing countryOfManufacture and
 * per-commodity weight (COMMODITIES.COUNTRYOFMANUFACTURE.REQUIRED /
 * WEIGHT.NONNUMERIC.ERROR / PRODUCT.INFO.REQUIRED). BC packing items carry
 * no country-of-origin field, so absent an explicit item origin the
 * ship-from country stands in (goods are presumed manufactured where they
 * ship from); per-commodity weight is the shipment's real package weight
 * allocated pro-rata by quantity share, never an invented figure.
 */
function fedexCustomsClearanceDetail(
  shipment: ShipmentRequest,
): Record<string, unknown> {
  const items = (shipment.customsItems ?? []).filter(
    (item): item is CustomsItem =>
      typeof item.name === "string" &&
      item.name.trim().length > 0 &&
      Number.isFinite(item.quantity) &&
      item.quantity > 0 &&
      Number.isFinite(item.unitPrice),
  );
  const total = moneyRound(
    items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0),
  );
  if (items.length === 0 || total <= 0) {
    throw new CarrierValidationError(
      "Customs value is required for international shipments: no packed items " +
        "with a usable value (quantity × unit price) were found. Add unit " +
        "prices to the packing items for this shipment, then retry — a " +
        "customs value is never fabricated to bypass the FedEx check.",
    );
  }
  const fromCountry =
    (shipment.from.countryCode || "US").trim().toUpperCase() || "US";
  const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
  const totalWeight = shipment.packages.reduce(
    (sum, pkg) => sum + (Number.isFinite(pkg.weight) ? pkg.weight : 0),
    0,
  );
  const shareWeight = (item: CustomsItem): number | undefined =>
    totalWeight > 0 && totalQuantity > 0
      ? Math.max(0.1, moneyRound((totalWeight * item.quantity) / totalQuantity))
      : undefined;
  return {
    dutiesPayment: { paymentType: "SENDER" },
    totalCustomsValue: { amount: total, currency: "USD" },
    commodities: items.map((item) => ({
      numberOfPieces: Math.max(1, Math.ceil(item.quantity)),
      description: item.name,
      countryOfManufacture:
        item.countryOfOrigin?.trim().toUpperCase() || fromCountry,
      quantity: item.quantity,
      quantityUnits: "EA",
      ...(() => {
        const value = shareWeight(item);
        return value !== undefined ? { weight: { units: "LB", value } } : {};
      })(),
      unitPrice: { amount: moneyRound(item.unitPrice), currency: "USD" },
      customsValue: {
        amount: moneyRound(item.quantity * item.unitPrice),
        currency: "USD",
      },
    })),
  };
}

function oauthErrorDetail(error: CarrierApiError): string {
  const body = error.body as
    { errors?: Array<{ code?: string; message?: string }> } | undefined;
  const first = Array.isArray(body?.errors) ? body.errors[0] : undefined;
  const detail = [first?.code, first?.message].filter(Boolean).join(": ");
  return detail || error.message;
}

/**
 * OAuth 403 means the credentials do not belong to the effective
 * environment (probe evidence: FORBIDDEN.ERROR "Live credentials not
 * allowed in this environment" from apis-sandbox.fedex.com with live
 * keys). Surfaces as CarrierConfigError so shippingErrorHandler keeps the
 * UPSTREAM_HTTP_ERROR envelope with an actionable message.
 */
function oauthForbiddenError(
  config: FedexConfig,
  error: CarrierApiError,
): CarrierConfigError {
  const detail = oauthErrorDetail(error);
  const environment = environmentLabel(config);
  const fix =
    "Fix the mismatch: align CARRIER_SANDBOX with the credential type, correct the tliLocations fedExBaseURLRESTAPI/fedexURL override for this location, point FEDEX_BASE_URL at the matching host, or load FedEx-issued credentials matching this environment.";
  if (
    /live credentials not allowed/i.test(detail) ||
    /FORBIDDEN\.ERROR/i.test(detail)
  ) {
    return new CarrierConfigError(
      `FedEx OAuth rejected the configured credentials: 403 ${detail}. ` +
        `The effective FedEx environment is ${environment}, which means the API key/secret belong to the other environment ` +
        `(live keys are rejected on the sandbox host and vice versa). ${fix}`,
    );
  }
  return new CarrierConfigError(
    `FedEx OAuth rejected the configured credentials: 403 ${detail}. ` +
      `Effective FedEx environment: ${environment}. ` +
      `Verify the API key/secret are valid for this environment (check CARRIER_SANDBOX and any tliLocations fedExBaseURLRESTAPI/fedexURL override).`,
  );
}

/**
 * FedEx ship rejects an accountNumber the API credentials are not linked to
 * with SHIPMENT.ACCOUNTNUMBER.UNAUTHORIZED (probe evidence 2026-10-01: same
 * credentials, account …1073 → 400 UNAUTHORIZED, account …5286 → authorized).
 * Surfaces as CarrierConfigError with the account provenance so the operator
 * knows which knob to fix (shipment account, tliLocations fedExAccount, or
 * the FedEx-side credential↔account link).
 */
function accountUnauthorizedError(error: CarrierApiError): CarrierConfigError {
  const detail = oauthErrorDetail(error);
  return new CarrierConfigError(
    `FedEx rejected the shipping account as unauthorized for these API credentials (${detail}). ` +
      `The account used on a shipment comes from the shipment (carrier_account_no / account_no), ` +
      `the location (tliLocations fedExAccount), or the FEDEX_ACCOUNT_NUMBER fallback. ` +
      `Link the account to these API credentials in FedEx admin, or correct the account on the shipment/location, then retry.`,
  );
}

async function getAccessToken(
  config: FedexConfig,
  forceRefresh = false,
): Promise<string> {
  const key = configFingerprint(config);
  let getter = tokenCaches.get(key);
  if (!getter) {
    getter = createTokenCache(() => fetchAccessToken(config));
    tokenCaches.set(key, getter);
  }
  return getter(forceRefresh);
}

async function fetchAccessToken(config: FedexConfig): Promise<{
  accessToken: string;
  expiresIn: number;
}> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.apiKey,
    client_secret: config.apiSecret,
    scope: "CXP",
  });
  let response: Response;
  let data: { access_token?: string; expires_in?: number };
  try {
    response = await transport(`${baseUrl(config)}oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(CARRIER_DEFAULT_TIMEOUT_MS),
    });
    data = await readCarrierJson<{
      access_token?: string;
      expires_in?: number;
    }>(response, "FedEx OAuth");
  } catch (error) {
    if (error instanceof CarrierAuthError) throw error;
    if (error instanceof CarrierApiError && error.status === 403) {
      throw oauthForbiddenError(config, error);
    }
    if (isAbortError(error)) {
      throw new CarrierUnavailableError(
        error,
        `FedEx token request timed out after ${CARRIER_DEFAULT_TIMEOUT_MS}ms`,
      );
    }
    throw new CarrierAuthError(
      `Failed to authenticate with FedEx OAuth API: ${String(error)}`,
    );
  }
  if (!data.access_token || typeof data.expires_in !== "number") {
    throw new CarrierAuthError(
      "FedEx OAuth response did not include access_token/expires_in",
    );
  }
  return { accessToken: data.access_token, expiresIn: data.expires_in };
}

async function request<T>(
  config: FedexConfig,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs?: number,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const url = `${baseUrl(config)}${path}`;
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await bearerRequest(
      transport,
      (force) => getAccessToken(config, force ?? false),
      () => ({ ...(extraHeaders ?? {}) }),
      url,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      timeoutMs,
    );
  } catch (error) {
    if (
      error instanceof CarrierApiError ||
      error instanceof CarrierAuthError ||
      error instanceof CarrierConfigError
    ) {
      throw error;
    }
    throw new CarrierUnavailableError(error);
  }
  logFedexCall(method, path, response.status, startedAt);
  try {
    return await readCarrierJson<T>(response, `FedEx ${method} ${path}`);
  } catch (error) {
    if (
      error instanceof CarrierApiError &&
      carrierErrorCode(error) === "SHIPMENT.ACCOUNTNUMBER.UNAUTHORIZED"
    ) {
      throw accountUnauthorizedError(error);
    }
    if (error instanceof CarrierApiError) {
      log("warn", "fedex_api_error", {
        method,
        path,
        status: error.status,
        code: carrierErrorCode(error),
        detail: carrierErrorSummary(error.body),
      });
    }
    throw error;
  }
}

/**
 * Structured FedEx call log — method/path/status/duration only. Request
 * bodies (addresses are PII) and OAuth tokens never appear here.
 */
function logFedexCall(
  method: string,
  path: string,
  status: number,
  startedAt: number,
): void {
  log("info", "fedex_api_request", {
    method,
    path,
    status,
    durationMs: Date.now() - startedAt,
  });
}

function carrierErrorSummary(body: unknown): string | undefined {
  const errors = (body as { errors?: Array<{ message?: string }> } | undefined)
    ?.errors;
  const first = Array.isArray(errors) ? errors[0] : undefined;
  return typeof first?.message === "string"
    ? first.message.slice(0, 300)
    : undefined;
}

interface FedexRateResponse {
  output?: {
    rateReplyDetails?: Array<{
      serviceName?: string;
      serviceType?: string;
      deliveryTimestamp?: string;
      commit?: {
        dateDetail?: {
          dayFormat?: string;
          dayOfWeek?: string;
        };
      };
      ratedShipmentDetails?: FedexRatedShipmentDetail[];
    }>;
  };
}

interface FedexShipResponse {
  output?: {
    transactionShipments?: Array<{
      masterTrackingNumber?: string;
      shipDatestamp?: string;
      originLocationCode?: string;
      destinationLocationCode?: string;
      completedShipmentDetail?: {
        operationalDetail?: {
          originLocationCode?: string;
          destinationLocationCode?: string;
        };
      };
      shipmentDocuments?: FedexLabelResponseDoc[];
      pieceResponses?: Array<{
        packageDocuments?: FedexLabelResponseDoc[];
      }>;
    }>;
  };
}

interface FedexRateCharge {
  amount?: number;
  currency?: string;
}

interface FedexRatedShipmentDetail {
  rateType?: string;
  totalNetCharge?: number | FedexRateCharge;
  currency?: string;
}

function normalizedFedexRateType(
  value: string | undefined,
): "ACCOUNT" | "LIST" | undefined {
  const normalized = value?.trim().toUpperCase();
  if (!normalized) return undefined;
  if (normalized === "ACCOUNT" || /(^|_)ACCOUNT($|_)/.test(normalized)) {
    return "ACCOUNT";
  }
  if (normalized === "LIST" || /(^|_)LIST($|_)/.test(normalized)) {
    return "LIST";
  }
  return undefined;
}

function fedexCharge(details: FedexRatedShipmentDetail[] | undefined): {
  cost: number;
  currency: string;
  rateType?: "ACCOUNT" | "LIST";
} {
  return selectFedexCharge(details, "ACCOUNT", false);
}

function selectFedexCharge(
  details: FedexRatedShipmentDetail[] | undefined,
  preferredRateType: "ACCOUNT" | "LIST",
  strict: boolean,
): {
  cost: number;
  currency: string;
  rateType?: "ACCOUNT" | "LIST";
} {
  const entry =
    details?.find(
      (detail) =>
        normalizedFedexRateType(detail.rateType) === preferredRateType,
    ) ?? (strict ? undefined : details?.[0]);
  if (!entry) {
    throw new CarrierApiError({
      status: 200,
      message: `FedEx did not return the configured ${preferredRateType} rate. The checkout price basis will not fall back to another rate type.`,
    });
  }
  const charge = entry.totalNetCharge;
  const rateType = normalizedFedexRateType(entry.rateType);
  if (typeof charge === "number") {
    return { cost: charge, currency: entry.currency ?? "USD", rateType };
  }
  return {
    cost: Number(charge?.amount ?? 0),
    currency: charge?.currency ?? entry.currency ?? "USD",
    rateType,
  };
}

export async function rateShop(
  args: RateShopArgs,
  cfg?: FedexCredentialOverride,
): Promise<RateQuote[]> {
  const production = fedexProductionRateQuoteOverride();
  const config = effectiveConfig(production ?? cfg);
  const payload = {
    accountNumber: {
      value: production
        ? config.accountNumber
        : (args.accountNumber ?? config.accountNumber),
    },
    requestedShipment: {
      shipper: {
        address: {
          postalCode: args.fromZip,
          countryCode: args.fromAddress?.countryCode ?? "US",
        },
      },
      recipient: {
        address: {
          postalCode: args.toZip,
          countryCode: args.toAddress?.countryCode ?? "US",
        },
      },
      pickupType: args.pickupType ?? "DROPOFF_AT_FEDEX_LOCATION",
      // Legacy parity (shippingCreateController.php): FedEx requires the
      // explicit rate request types.
      rateRequestType: args.rateTypes ?? ["LIST", "ACCOUNT"],
      ...(args.serviceType ? { serviceType: args.serviceType } : {}),
      ...(args.packagingType ? { packagingType: args.packagingType } : {}),
      ...(args.shipDate ? { shipDatestamp: args.shipDate } : {}),
      requestedPackageLineItems: args.packages.map((pkg) => ({
        weight: { units: "LB", value: pkg.weight },
      })),
    },
  };
  const data = await request<FedexRateResponse>(
    config,
    "POST",
    "rate/v1/rates/quotes",
    payload,
    CARRIER_DEFAULT_TIMEOUT_MS,
  );
  const details = data.output?.rateReplyDetails ?? [];
  if (details.length === 0) {
    throw new CarrierApiError({
      status: 200,
      message:
        "FedEx returned no rates for this shipment (HTTP 200 with an empty rateReplyDetails). " +
        "Check the shipper/recipient postal codes, package weights, and that the FedEx account is rate-enabled for these services.",
    });
  }
  return details.map((detail) => {
    const charge = args.preferredRateType
      ? selectFedexCharge(
          detail.ratedShipmentDetails,
          args.preferredRateType,
          args.strictRateType === true,
        )
      : fedexCharge(detail.ratedShipmentDetails);
    // Carrier-reported commit date, verbatim: deliveryTimestamp wins, then
    // the commit dateDetail day stamp. Never computed locally.
    const deliveryDate =
      typeof detail.deliveryTimestamp === "string" &&
      detail.deliveryTimestamp.trim()
        ? detail.deliveryTimestamp.trim()
        : typeof detail.commit?.dateDetail?.dayFormat === "string" &&
            detail.commit.dateDetail.dayFormat.trim()
          ? detail.commit.dateDetail.dayFormat.trim()
          : undefined;
    return {
      carrier: "fedex" as const,
      service: detail.serviceType ?? detail.serviceName ?? "UNKNOWN",
      cost: charge.cost,
      currency: charge.currency,
      ...(detail.serviceName
        ? { serviceDescription: detail.serviceName }
        : detail.serviceType
          ? { serviceDescription: detail.serviceType }
          : {}),
      ...(args.preferredRateType && charge.rateType
        ? { rateType: charge.rateType }
        : {}),
      ...(deliveryDate ? { deliveryDate } : {}),
    };
  });
}

interface FedexResolvedAddress {
  streetLinesToken?: string[];
  streetLines?: string[];
  city?: string;
  stateOrProvinceCode?: string;
  postalCode?: string;
  countryCode?: string;
  classification?: string | { name?: string; code?: string };
}

function fedexClassification(
  classification: FedexResolvedAddress["classification"],
): string {
  if (typeof classification === "string") return classification;
  return classification?.name ?? classification?.code ?? "";
}

function fedexCandidates(
  resolved: FedexResolvedAddress[],
  requested?: CarrierAddress,
): AddressCandidate[] {
  return resolved.map((entry) => {
    const lines = entry.streetLinesToken ?? entry.streetLines ?? [];
    // Sandbox virtual-data guard: the sandbox resolve API rewrites state and
    // country to canned localized placeholders ("Región Metropolitana…" / CL)
    // regardless of the input address. Adopting that through the FE's Update
    // button corrupts the BC ship-to with a contradictory country (the
    // SH051507 CL-on-a-North-Carolina-address case that blocks labels). A
    // carrier country flip the user did not request is never adopted: the
    // requested country (and state) stand; production corrections match the
    // requested country and pass through untouched.
    const requestedCountry = requested?.countryCode?.trim().toUpperCase() ?? "";
    const candidateCountry = String(entry.countryCode ?? "")
      .trim()
      .toUpperCase();
    const countryContradicted =
      requestedCountry.length > 0 &&
      candidateCountry.length > 0 &&
      candidateCountry !== requestedCountry;
    // Sparse-echo backfill (live-observed sandbox 2026-10-02): when resolve
    // cannot complete an address it echoes it back sparse — street lines and
    // country only, no city, no state, postalCode "". Mapping those gaps as
    // empty strings would flow through the FE's Update button into BC's
    // full-replace PATCH and blank the stored values (the empty
    // city/state/post-code Ship To regression). Any field the carrier did
    // not resolve falls back to the requested value instead.
    const carrierState = String(entry.stateOrProvinceCode ?? "").trim();
    const carrierPostal = String(entry.postalCode ?? "").trim();
    const postal =
      carrierPostal.length > 0 ? carrierPostal : (requested?.zipCode ?? "");
    const [zipCode, zipPlus4] = postal.split("-");
    return {
      addressLine1:
        String(lines[0] ?? "").trim() || requested?.addressLine1 || "",
      addressLine2:
        String(lines[1] ?? "").trim() || requested?.addressLine2 || "",
      city: String(entry.city ?? "").trim() || requested?.city || "",
      state:
        countryContradicted || carrierState.length === 0
          ? String(requested?.state ?? "")
          : carrierState,
      zipCode,
      countryCode:
        countryContradicted || candidateCountry.length === 0
          ? requestedCountry
          : String(entry.countryCode ?? "").trim(),
      classification: fedexClassification(entry.classification),
      ZIPPlus4: zipPlus4 ?? "",
    };
  });
}

export async function validateAddress(
  address: CarrierAddress,
  cfg?: FedexCredentialOverride,
): Promise<AddressValidationResult> {
  const config = effectiveConfig(cfg);
  const payload = {
    addressesToValidate: [{ address: fedexAddressBlock(address) }],
  };
  const data = await request<{
    output?: { resolvedAddresses?: FedexResolvedAddress[] };
  }>(
    config,
    "POST",
    "address/v1/addresses/resolve",
    payload,
    CARRIER_DEFAULT_TIMEOUT_MS,
    // Legacy parity (shippingAddressValidationController.php): the resolve
    // call carries X-locale so FedEx localizes returned address names.
    { "X-locale": "en_US" },
  );
  const resolved = data.output?.resolvedAddresses ?? [];
  const candidates = fedexCandidates(resolved, address);
  const requestedCountry = address.countryCode?.trim().toUpperCase() ?? "";
  const countryContradicted = resolved.some((entry) => {
    const candidate = String(entry.countryCode ?? "")
      .trim()
      .toUpperCase();
    return (
      requestedCountry.length > 0 &&
      candidate.length > 0 &&
      candidate !== requestedCountry
    );
  });
  if (countryContradicted) {
    log("warn", "fedex_address_validation_country_guard", {
      requestedCountry,
      resolvedCountries: resolved
        .map((entry) => entry.countryCode)
        .filter(Boolean),
      note: "carrier resolved a country the request did not ask for; kept the requested country/state on candidates",
    });
  }
  return {
    carrier: "fedex",
    valid: resolved.length > 0,
    response: data,
    candidates,
  };
}

// Label stock per shipping-form label size (ZPL only). PDF labels carry no
// labelStockType: FedEx REJECTS the doc-tab stock on imageType PDF
// (INVALID.STOCK.TYPE, live sandbox probe 2026-10-05) and PAPER_* stocks
// made FedEx return letter-size labels for 4x6 requests (T1 live probe).
const DOC_TAB_STOCK = "STOCK_4X675_LEADING_DOC_TAB";
const LABEL_STOCK_TYPES: Record<string, string> = {
  "8/5 X 11": "PAPER_85X11_TOP_HALF_LABEL",
  "4/8 X 9/2": "PAPER_LETTER",
  "4 X 6": "STOCK_4X6",
  "4 X 675": DOC_TAB_STOCK,
};

function labelStockType(labelSize: string | undefined): string {
  return (labelSize && LABEL_STOCK_TYPES[labelSize]) || "STOCK_4X6";
}

/** Doc-tab zone definition — BC shippingCreateController ZONE001 layout. */
interface DocTabZone {
  zoneNumber: number;
  header: string;
  justification: "LEFT";
  /** FedEx-filled zone — serialized on the wire as dataField only. */
  dataField?: string;
  /** Literal value — wire form for literal zones; PDF compositor feed for all. */
  literalValue?: string;
}

/** BC date("dM-y") month table — e.g. 2026-10-05 → "05Oct-26". */
const DOC_TAB_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** BC date("dM-y") port: ISO date → "05Oct-26" form used on the doc tab. */
function formatDocTabDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!match) return isoDate;
  const monthName = DOC_TAB_MONTHS[Number(match[2]) - 1] ?? "";
  return `${match[3]}${monthName}-${match[1].slice(2)}`;
}

/**
 * BC formatPhoneNumber port (shippingCreateController.php:1392-1430).
 * Divergence: BC throws below 6 digits; the carrier client logs and falls
 * back to the raw value so a malformed phone never fails the create.
 */
function formatDocTabPhoneNumber(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (value.length === 0) return "";
  if (/^\(\d{3}\)\s\d{3}(-\d{4})*$/.test(value)) return value;
  const digits = value.replace(/\D/g, "");
  if (digits.length < 6) {
    log("warn", "fedex_doctab_phone_unformattable", {
      digitCount: digits.length,
    });
    return value;
  }
  const areaCode = digits.slice(0, 3);
  const prefix = digits.slice(3, 6);
  const suffix = digits.slice(6);
  if (suffix.length === 0) return `(${areaCode}) ${prefix}`;
  const suffixGroups = suffix.match(/.{1,4}/g) ?? [];
  return `(${areaCode}) ${prefix}-${suffixGroups.join("-")}`;
}

/**
 * ZONE001 doc-tab content — BC parity (shippingCreateController.php:95-188):
 * all 12 zones verbatim, no empty-zone filtering. FedEx-filled zones
 * (Weight/DV) serialize dataField only; literal zones serialize
 * literalValue ("" when empty). Emitted only for the doc-tab label stock.
 */
function fedexDocTabContent(
  shipment: ShipmentRequest,
  resolvedPackagingType: string,
  resolvedShipDate: string,
): Record<string, unknown> | undefined {
  if (labelStockType(shipment.labelSize) !== DOC_TAB_STOCK) {
    return undefined;
  }
  const zones = docTabZones(shipment, resolvedPackagingType, resolvedShipDate);
  return {
    docTabContentType: "ZONE001",
    zone001: {
      docTabZoneSpecifications: zones.map((zone) =>
        zone.dataField
          ? {
              zoneNumber: zone.zoneNumber,
              header: zone.header,
              dataField: zone.dataField,
              justification: zone.justification,
            }
          : {
              zoneNumber: zone.zoneNumber,
              header: zone.header,
              literalValue: zone.literalValue ?? "",
              justification: zone.justification,
            },
      ),
    },
  };
}

/**
 * Doc-tab strip zones — BC parity (shippingCreateController.php:81-188):
 * exactly 12 zones in BC order (REF, Phone, P.O, PckgTyp, Date, Weight,
 * COD, DV, Shipping, Special, Handling, Total), empties included — BC
 * never filters. Weight/DV are FedEx-filled on the wire (dataField) and
 * carry a computed literalValue for the locally composed PDF tab.
 */
function docTabZones(
  shipment: ShipmentRequest,
  resolvedPackagingType: string,
  resolvedShipDate: string,
): DocTabZone[] {
  const totalWeight = shipment.packages.reduce(
    (sum, pkg) => sum + Number(pkg.weight ?? 0),
    0,
  );
  const totalInsured = shipment.packages.reduce(
    (sum, pkg) => sum + Number(pkg.insuredValue ?? 0),
    0,
  );
  const dvLiteral =
    totalInsured > 0
      ? String(Math.round(totalInsured * 100) / 100)
      : shipment.declaredValue !== undefined &&
          Number.isFinite(shipment.declaredValue) &&
          shipment.declaredValue > 0
        ? String(shipment.declaredValue)
        : "";
  const zones: Array<{
    header: string;
    dataField?: string;
    literalValue: string;
  }> = [
    { header: "REF", literalValue: shipment.yourReference ?? "" },
    {
      header: "Phone",
      literalValue: formatDocTabPhoneNumber(shipment.to.contactPhone),
    },
    { header: "P.O", literalValue: shipment.poNo ?? "" },
    { header: "PckgTyp", literalValue: resolvedPackagingType },
    { header: "Date", literalValue: formatDocTabDate(resolvedShipDate) },
    {
      header: "Weight",
      dataField: "REQUEST/PACKAGE/weight/Value",
      literalValue:
        totalWeight > 0 ? `${Math.round(totalWeight * 100) / 100} LB` : "",
    },
    { header: "COD", literalValue: "" },
    {
      header: "DV",
      dataField: "REQUEST/PACKAGE/InsuredValue/Amount",
      literalValue: dvLiteral,
    },
    { header: "Shipping", literalValue: "" },
    { header: "Special", literalValue: "" },
    { header: "Handling", literalValue: "" },
    { header: "Total", literalValue: "" },
  ];
  return zones.map((zone, index) => ({
    zoneNumber: index + 1,
    header: zone.header,
    justification: "LEFT" as const,
    dataField: zone.dataField,
    literalValue: zone.literalValue,
  }));
}

/** ZPL label spec per the Postman collection sample: COMMON2D format,
 * top-edge-first printing, and the data-driven doc tab on doc-tab stock. */
function fedexZplLabelSpecification(
  shipment: ShipmentRequest,
  resolvedPackagingType: string,
  resolvedShipDate: string,
): Record<string, unknown> {
  const docTabContent = fedexDocTabContent(
    shipment,
    resolvedPackagingType,
    resolvedShipDate,
  );
  return {
    labelFormatType: "COMMON2D",
    labelStockType: labelStockType(shipment.labelSize),
    imageType: "ZPLII",
    labelPrintingOrientation: "TOP_EDGE_OF_TEXT_FIRST",
    ...(docTabContent ? { customerSpecifiedDetail: { docTabContent } } : {}),
  };
}

function fedexShipmentSpecialServices(
  shipment: ShipmentRequest,
): Record<string, unknown> | undefined {
  const specialServiceTypes: string[] = [];
  if (shipment.fedexOneRate) {
    specialServiceTypes.push("FEDEX_ONE_RATE");
  }
  const codAmount = Number(shipment.codAmount ?? 0);
  if (codAmount > 0) {
    specialServiceTypes.push("COD");
  }
  if (specialServiceTypes.length === 0) {
    return undefined;
  }
  return {
    specialServiceTypes,
    ...(codAmount > 0
      ? {
          shipmentCODDetail: {
            codCollectionAmount: { amount: codAmount, currency: "USD" },
            codCollectionType: "ANY",
          },
        }
      : {}),
  };
}

/** FedEx `LabelResponseVO.contentType` values that are NOT shipping labels. */
const CUSTOMS_OUTPUT_DOC_TYPES = new Set([
  "COMMERCIAL_INVOICE",
  "PROFORMA_INVOICE",
  "PRO_FORMA_INVOICE",
  "CERTIFICATE_OF_ORIGIN",
  "USMCA_CERTIFICATION_OF_ORIGIN",
  "USMCA_COMMERCIAL_INVOICE_CERTIFICATION_OF_ORIGIN",
  "RETURN_INSTRUCTIONS",
  "GAA_FORM",
  "OP_900",
  "EXPORT_DECLARATION",
  "PENDING_SHIPMENT_EMAIL_NOTIFICATION",
]);

interface FedexLabelResponseDoc {
  /** Semantic type (LABEL / COMMERCIAL_INVOICE / …). */
  contentType?: string;
  /** File format (PDF / ZPL / PNG / …) — never a semantic type. */
  docType?: string;
  encodedLabel?: string;
  url?: string;
}

/** `docType` is the file format; normalise it without losing known values. */
function documentFormat(doc: FedexLabelResponseDoc): string {
  const format = (doc.docType ?? "").trim().toUpperCase();
  if (
    /^(PDF|ZPL|PNG|JPG|JPEG|TIF|TIFF|TXT|BMP|GIF|DOC|XLS|RTF)$/.test(format)
  ) {
    return format === "JPEG" ? "JPG" : format === "TIFF" ? "TIF" : format;
  }
  return mimeToDocType(doc.contentType ?? doc.docType);
}

function selectFedexLabelDoc(
  docs: FedexLabelResponseDoc[] | undefined,
): FedexLabelResponseDoc | undefined {
  const withBytes = (docs ?? []).filter((doc) => Boolean(doc.encodedLabel));
  const semantic = (doc: FedexLabelResponseDoc) =>
    (doc.contentType ?? "").toUpperCase();
  return (
    withBytes.find((doc) => semantic(doc) === "LABEL") ??
    withBytes.find((doc) => !CUSTOMS_OUTPUT_DOC_TYPES.has(semantic(doc))) ??
    withBytes[0]
  );
}

/**
 * Builds the ETD special-service block. Pre-shipment uploads attach FedEx
 * `documentId`s; post-shipment requests the upload after the label exists.
 */
function fedexEtdDetail(
  shipment: ShipmentRequest,
  uploaded: FedexUploadedDocument[],
  requestedDocumentTypes: string[] | undefined,
): Record<string, unknown> | undefined {
  const set = shipment.customs?.customsDocuments;
  const attachedDocuments =
    set?.mode === "PRE_SHIPMENT"
      ? uploaded
          .filter((entry) => Boolean(entry.documentId))
          .map((entry) => ({
            documentId: entry.documentId,
            // Original request type — never the abbreviated response one.
            documentType: entry.shipDocumentType,
            ...(shipment.yourReference
              ? { documentReference: shipment.yourReference }
              : {}),
          }))
      : [];
  const postShipment = set?.mode === "POST_SHIPMENT";
  if (
    attachedDocuments.length === 0 &&
    !postShipment &&
    (!requestedDocumentTypes || requestedDocumentTypes.length === 0)
  ) {
    return undefined;
  }
  return {
    ...(postShipment ? { attributes: ["POST_SHIPMENT_UPLOAD_REQUESTED"] } : {}),
    ...(attachedDocuments.length > 0 ? { attachedDocuments } : {}),
    ...(requestedDocumentTypes && requestedDocumentTypes.length > 0
      ? { requestedDocumentTypes }
      : {}),
  };
}

export async function createShipment(
  shipment: ShipmentRequest,
  cfg?: FedexCredentialOverride,
): Promise<CarrierLabel[]> {
  const config = effectiveConfig(cfg);
  const labelResponseOptions =
    shipment.labelFormat === "ZPL" ? "LABEL" : "LABEL";
  const codAmount = Number(shipment.codAmount ?? 0);
  const international = isInternationalShipment(shipment);
  assertFedexServiceAvailableForDestination(shipment, international);
  if (shipment.customs && !international) {
    throw new CarrierValidationError(
      "Customs details were supplied for a domestic shipment — remove them or correct the destination country.",
    );
  }
  if (
    shipment.customs?.isDocumentOnly &&
    shipment.serviceType.trim().toUpperCase().startsWith("FEDEX_GROUND")
  ) {
    throw new CarrierValidationError(
      "Documents-only shipments require a FedEx Express service — FedEx Ground does not accept documents-only customs.",
    );
  }
  const customsMapping = shipment.customs
    ? toFedexCustomsMapping(shipment.customs, {
        fromCountryCode: shipment.from.countryCode,
      })
    : undefined;
  const customsClearanceDetail = customsMapping
    ? customsMapping.customsClearanceDetail
    : international
      ? fedexCustomsClearanceDetail(shipment)
      : undefined;
  const documentSet = shipment.customs?.customsDocuments;
  let preShipmentUploads: FedexUploadedDocument[] = [];
  if (documentSet?.mode === "PRE_SHIPMENT" && documentSet.uploads.length > 0) {
    try {
      preShipmentUploads = await uploadCustomsDocuments(
        config,
        shipment,
        "ETDPreshipment",
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new CarrierValidationError(
        `FedEx electronic trade document upload failed before the label was created: ${detail}. ` +
          `Correct the documents or remove them and resubmit — no label was requested.`,
      );
    }
    const failed = preShipmentUploads.filter((entry) => !entry.documentId);
    if (failed.length > 0) {
      const detail = failed
        .map(
          (entry) =>
            `${entry.shipDocumentType}: ${entry.error ?? "no document ID returned"}`,
        )
        .join("; ");
      throw new CarrierValidationError(
        `FedEx did not accept all uploaded customs documents (${detail}). ` +
          "The shipment was not submitted — no label was created.",
      );
    }
  }
  const generatedDocuments = shipment.customs?.generatedDocuments;
  const requestedDocumentTypes =
    fedexRequestedDocumentTypes(generatedDocuments);
  const etdDetail = fedexEtdDetail(
    shipment,
    preShipmentUploads,
    requestedDocumentTypes,
  );
  const shippingDocumentSpecification =
    fedexShippingDocumentSpecification(generatedDocuments);
  const baseSpecialServices = fedexShipmentSpecialServices(shipment);
  const specialServiceTypes = [
    ...((baseSpecialServices?.specialServiceTypes as string[] | undefined) ??
      []),
    ...(etdDetail ? ["ELECTRONIC_TRADE_DOCUMENTS"] : []),
  ];
  const specialServices =
    specialServiceTypes.length > 0 || etdDetail
      ? {
          ...(baseSpecialServices ?? {}),
          specialServiceTypes,
          ...(etdDetail ? { etdDetail } : {}),
        }
      : undefined;
  const resolvedPackagingType = shipment.packagingType ?? "YOUR_PACKAGING";
  const resolvedShipDate =
    shipment.shipDate ?? new Date().toISOString().slice(0, 10);
  // Pickup/drop-off selection: drop-off routes the label to a staffed FedEx
  // location; an absent pickup keeps the legacy scheduled-pickup behavior.
  const pickup = shipment.pickup;
  const pickupType =
    pickup?.type === "dropoff"
      ? "DROPOFF_AT_FEDEX_LOCATION"
      : "USE_SCHEDULED_PICKUP";
  // Exporter contact/address (when supplied) becomes the shipper of record;
  // configured account credentials and tins stay unchanged. Domestic
  // shipments never carry customs, so their shipper block remains `from`.
  const exporterParty = shipment.customs?.exporter;
  const exporterContact = exporterParty
    ? {
        personName:
          exporterParty.contactName ?? shipment.from.contactName ?? "Shipper",
        companyName: exporterParty.companyName ?? shipment.from.companyName,
        phoneNumber:
          exporterParty.contactPhone ??
          shipment.from.contactPhone ??
          "0000000000",
        ...((exporterParty.contactEmail ?? shipment.from.contactEmail)
          ? {
              emailAddress:
                exporterParty.contactEmail ?? shipment.from.contactEmail,
            }
          : {}),
      }
    : undefined;
  const payload = {
    labelResponseOptions,
    accountNumber: { value: shipment.accountNumber ?? config.accountNumber },
    requestedShipment: {
      // ZPL mirrors the Postman collection label spec (COMMON2D + doc tab
      // on doc-tab stock); PDF sends imageType only — FedEx rejects the
      // doc-tab stock on PDF labels (INVALID.STOCK.TYPE), so the 4x6.75
      // page + doc-tab strip are composed locally after the create.
      ...(shipment.labelFormat === "ZPL"
        ? {
            labelSpecification: fedexZplLabelSpecification(
              shipment,
              resolvedPackagingType,
              resolvedShipDate,
            ),
          }
        : { labelSpecification: { imageType: "PDF" } }),
      shipDatestamp: resolvedShipDate,
      pickupType,
      ...(pickup?.type === "pickup"
        ? {
            pickupDetail: {
              ...(pickup.date
                ? {
                    // FedEx Ship API pickupDetail expects date-only
                    // YYYY-MM-DD values (readyPickupDateTime /
                    // latestPickupDateTime); time windows belong to the
                    // separate Pickup Request API. Sending a timestamp or a
                    // wrong field name fails with NotNull/format 422s.
                    readyPickupDateTime: pickup.date,
                    latestPickupDateTime: pickup.date,
                  }
                : {}),
              ...(pickup.instructions
                ? {
                    courierInstructions: pickup.instructions.slice(0, 500),
                  }
                : {}),
            },
          }
        : {}),
      serviceType: shipment.serviceType,
      packagingType: resolvedPackagingType,
      ...(specialServices ? { shipmentSpecialServices: specialServices } : {}),
      ...(customsClearanceDetail ? { customsClearanceDetail } : {}),
      ...(shippingDocumentSpecification
        ? { shippingDocumentSpecification }
        : {}),
      ...(shipment.declaredValue !== undefined &&
      Number.isFinite(shipment.declaredValue)
        ? {
            totalDeclaredValue: {
              amount: shipment.declaredValue,
              currency: "USD",
            },
          }
        : {}),
      // Payment shape per the Postman collection: both payment types carry
      // a payor responsibleParty account (receiver billing uses the ship-to
      // account, sender billing the shipment/location account).
      ...(shipment.billTransportationTo === "RECEIVER"
        ? {
            shippingChargesPayment: {
              paymentType: "RECIPIENT",
              payor: {
                responsibleParty: {
                  accountNumber: {
                    value: shipment.payorAccountNumber ?? config.accountNumber,
                  },
                  contact: {
                    personName: shipment.to.contactName ?? "Recipient",
                    companyName: shipment.to.companyName,
                    phoneNumber: shipment.to.contactPhone ?? "0000000000",
                  },
                  address: fedexAddressBlock(shipment.to),
                },
              },
            },
          }
        : {
            shippingChargesPayment: {
              paymentType: "SENDER",
              payor: {
                responsibleParty: {
                  accountNumber: {
                    value: shipment.accountNumber ?? config.accountNumber,
                  },
                },
              },
            },
          }),
      shipper: {
        contact: exporterContact ?? {
          personName: shipment.from.contactName ?? "Shipper",
          companyName: shipment.from.companyName,
          phoneNumber: shipment.from.contactPhone ?? "0000000000",
          ...(shipment.from.contactEmail
            ? { emailAddress: shipment.from.contactEmail }
            : {}),
        },
        address: exporterParty?.address
          ? fedexAddressBlock(exporterParty.address)
          : fedexAddressBlock(shipment.from),
        ...(customsMapping?.shipperTins
          ? { tins: customsMapping.shipperTins }
          : {}),
      },
      recipients: [
        {
          contact: {
            personName: shipment.to.contactName ?? "Recipient",
            companyName: shipment.to.companyName,
            phoneNumber: shipment.to.contactPhone ?? "0000000000",
          },
          address: fedexAddressBlock(shipment.to),
          ...(customsMapping?.recipientTins
            ? { tins: customsMapping.recipientTins }
            : {}),
        },
      ],
      requestedPackageLineItems: shipment.packages.map((pkg, index) => ({
        sequenceNumber: String(index + 1),
        declaredValue: {
          currency: "USD",
          amount: Number(pkg.insuredValue ?? 0),
        },
        ...(codAmount > 0
          ? {
              specialServices: {
                specialServiceTypes: "COD",
                codDetail: {
                  codCollectionAmount: {
                    currency: "USD",
                    amount: codAmount,
                  },
                  collectionType: "ANY",
                },
              },
            }
          : {}),
        weight: { units: "LB", value: pkg.weight },
        ...(pkg.length !== undefined &&
        pkg.width !== undefined &&
        pkg.height !== undefined
          ? {
              dimensions: {
                length: pkg.length,
                width: pkg.width,
                height: pkg.height,
                units: "IN",
              },
            }
          : {}),
        // BC parity (shippingCreateController.php:280-322): exactly two
        // references, built unconditionally. invoice_no / department /
        // customer_reference stay on the request surface but never ride
        // the FedEx wire (BC does not send them).
        customerReferences: [
          {
            customerReferenceType: "CUSTOMER_REFERENCE",
            value: shipment.yourReference ?? "",
          },
          {
            customerReferenceType: "P_O_NUMBER",
            value: shipment.poNo ?? "",
          },
          ...(shipment.customs
            ? [
                {
                  customerReferenceType: "INVOICE_NUMBER",
                  value: shipment.customs.invoiceNumber,
                },
              ]
            : []),
        ],
      })),
    },
  };
  const data = await request<FedexShipResponse>(
    config,
    "POST",
    "ship/v1/shipments",
    payload,
    CARRIER_SHIPMENT_TIMEOUT_MS,
  );
  const shipmentResult = data.output?.transactionShipments?.[0];
  const masterTrackingNumber = shipmentResult?.masterTrackingNumber;
  const pieces = shipmentResult?.pieceResponses ?? [];
  const labels: CarrierLabel[] = (pieces.length > 0 ? pieces : [undefined]).map(
    (piece) => {
      // Never mistake a customs/commercial-invoice document for the label.
      const labelDoc = selectFedexLabelDoc(piece?.packageDocuments);
      return {
        carrier: "fedex" as const,
        environment: fedexEnvironment({ baseUrl: baseUrl(config) }),
        trackingNumber: masterTrackingNumber ?? "UNKNOWN",
        labelData: labelDoc?.encodedLabel ?? "",
        format: shipment.labelFormat,
      };
    },
  );

  // Shipment-level generated customs documents (separate from piece labels).
  const documentWarnings: string[] = [];
  const generatedDocs: ShipmentDocument[] = [];
  const seenGeneratedTypes = new Set<string>();
  const collectGenerated = (
    docs: FedexLabelResponseDoc[] | undefined,
    allowLabels: boolean,
  ): void => {
    for (const doc of docs ?? []) {
      // contentType is the semantic type; docType is only the file format.
      const semantic = (doc.contentType ?? "").toUpperCase();
      if (allowLabels && (!semantic || semantic === "LABEL")) continue;
      if (!allowLabels && !CUSTOMS_OUTPUT_DOC_TYPES.has(semantic)) continue;
      // Shipment-level documents win; package-level duplicates are skipped.
      if (seenGeneratedTypes.has(semantic)) continue;
      if (!doc.encodedLabel) {
        if (doc.url) {
          documentWarnings.push(
            `FedEx returned only a document URL for ${semantic || "document"}; ` +
              `the document bytes were not persisted (URLs expire after 24 hours).`,
          );
        }
        continue;
      }
      seenGeneratedTypes.add(semantic);
      const format = documentFormat(doc);
      generatedDocs.push({
        documentType: semantic,
        docType: format,
        fileName: documentFileName(semantic, format, masterTrackingNumber),
        contentBase64: doc.encodedLabel,
        source: "FEDEX_GENERATED",
      });
    }
  };
  collectGenerated(shipmentResult?.shipmentDocuments, false);
  for (const piece of pieces) {
    collectGenerated(piece?.packageDocuments, false);
  }

  // Uploaded customs documents (pre-shipment already attached; post-shipment
  // attempts the upload now and never invites a duplicate shipment retry).
  const uploadedDocs: ShipmentDocument[] = [];
  if (documentSet?.uploads.length) {
    const uploadDocs: ShipmentDocument[] = documentSet.uploads.map(
      (upload) => ({
        documentType: upload.shipDocumentType,
        docType: mimeToDocType(upload.contentType),
        fileName: upload.fileName,
        contentBase64: upload.contentBase64,
        source: "UPLOADED" as const,
        uploadStatus:
          documentSet.mode === "PRE_SHIPMENT"
            ? ("ATTACHED" as const)
            : ("UPLOADED" as const),
      }),
    );
    if (documentSet.mode === "POST_SHIPMENT") {
      try {
        const uploaded = await uploadCustomsDocuments(
          config,
          shipment,
          "ETDPostshipment",
          {
            trackingNumber: masterTrackingNumber,
            // Prefer the carrier-issued ship date; fall back to the request.
            shipmentDate: `${shipmentResult?.shipDatestamp ?? resolvedShipDate}T00:00:00`,
            originLocationCode:
              shipmentResult?.originLocationCode ??
              shipmentResult?.completedShipmentDetail?.operationalDetail
                ?.originLocationCode,
            destinationLocationCode:
              shipmentResult?.destinationLocationCode ??
              shipmentResult?.completedShipmentDetail?.operationalDetail
                ?.destinationLocationCode,
          },
        );
        const failed = uploaded.filter((entry) => !entry.documentId);
        if (failed.length > 0) {
          throw new Error(
            failed
              .map(
                (entry) =>
                  `${entry.shipDocumentType}: ${entry.error ?? "no document ID returned"}`,
              )
              .join("; "),
          );
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        documentWarnings.push(
          `The label was created successfully, but the post-shipment document upload failed: ${detail}. ` +
            `Do not create another shipment for this order — retry the document upload for tracking number ${masterTrackingNumber ?? "(unknown)"}.`,
        );
        uploadDocs.forEach((doc) => {
          doc.uploadStatus = "FAILED";
        });
      }
    }
    uploadedDocs.push(...uploadDocs);
  }

  const documents = [...uploadedDocs, ...generatedDocs];
  if (documents.length > 0 && labels[0]) {
    labels[0].documents = documents;
  }
  if (documentWarnings.length > 0 && labels[0]) {
    labels[0].documentWarnings = [...documentWarnings];
  }
  if (labelStockType(shipment.labelSize) === DOC_TAB_STOCK) {
    // Doc-tab stock: normalize BOTH label surfaces to the exact BC 3×4
    // grid (REF/Phone/P.O/PckgTyp | Date/Weight/COD/DV | Shipping/
    // Special/Handling/Total at X 10/270/540, Y 8/30/52/73). ZPL: FedEx's
    // ZONE001 rendering is data-driven and lays zones out at its own
    // discretion, so the returned label is rewritten to the canonical
    // grid. PDF: FedEx rejects the doc-tab stock (INVALID.STOCK.TYPE),
    // so the 4x6.75 page + strip are composed locally after the create.
    const zones = docTabZones(
      shipment,
      resolvedPackagingType,
      resolvedShipDate,
    );
    const stripZones = zones.map((zone) => ({
      header: zone.header,
      value: zone.literalValue ?? "",
    }));
    for (const label of labels) {
      if (!label.labelData) continue;
      if (shipment.labelFormat === "ZPL") {
        const zpl = Buffer.from(label.labelData, "base64").toString("latin1");
        const normalized = applyDocTabZones(zpl, stripZones);
        if (normalized !== zpl) {
          label.labelData = Buffer.from(normalized, "latin1").toString(
            "base64",
          );
        }
      } else {
        const composed = await composeDocTabLabelPdf(
          Buffer.from(label.labelData, "base64"),
          stripZones,
        );
        label.labelData = composed.toString("base64");
      }
    }
  }
  return labels;
}

/**
 * Non-guaranteed estimated duties & taxes (`POST /dutytax/v1/estimate`).
 * Only FedEx exposes this API; callers must surface `nonGuaranteed: true`.
 */
export async function estimateDutyTax(
  input: DutyTaxEstimateInput,
  cfg?: FedexCredentialOverride,
): Promise<DutyTaxEstimate> {
  const built = buildDutyTaxEstimateRequest(input);
  if (!built.ok) {
    throw new CarrierValidationError(
      built.errors
        .map((entry) => `${entry.field}: ${entry.message}`)
        .join("; "),
    );
  }
  const config = effectiveConfig(cfg);
  const data = await request<unknown>(
    config,
    "POST",
    "dutytax/v1/estimate",
    built.request,
    CARRIER_DEFAULT_TIMEOUT_MS,
    // Official Estimated Duty & Tax API requires this header.
    { "x-content-type": "application/json" },
  );
  return mapDutyTaxEstimateResponse(data);
}

export async function voidShipment(
  trackingNumber: string,
  cfg?: FedexCredentialOverride,
): Promise<VoidShipmentResult> {
  const config = effectiveConfig(cfg);
  const payload = {
    accountNumber: { value: config.accountNumber },
    trackingNumber,
    deletionControl: "DELETE_ALL_PACKAGES",
  };
  const data = await request<unknown>(
    config,
    "PUT",
    "ship/v1/shipments/cancel",
    payload,
  );
  return {
    carrier: "fedex",
    voided: true,
    trackingNumber,
    response: data,
  };
}

export async function track(
  trackingNumber: string,
  cfg?: FedexCredentialOverride,
): Promise<TrackingInfo> {
  const config = effectiveConfig(cfg);
  const payload = {
    includeDetailedScans: true,
    trackingInfo: [{ trackingNumberInfo: { trackingNumber } }],
  };
  const data = await request<{
    output?: {
      completeTrackResults?: Array<{
        trackResults?: Array<{
          latestStatusDetail?: { statusByLocale?: string };
          scanEvents?: Array<{
            date?: string;
            dateTime?: string;
            eventDescription?: string;
            derivedStatus?: string;
            scanLocation?: { city?: string };
          }>;
        }>;
      }>;
    };
  }>(
    config,
    "POST",
    "track/v1/trackingnumbers",
    payload,
    CARRIER_DEFAULT_TIMEOUT_MS,
  );
  const result = data.output?.completeTrackResults?.[0]?.trackResults?.[0];
  const status = result?.latestStatusDetail?.statusByLocale ?? "UNKNOWN";
  const events = (result?.scanEvents ?? []).map((scan) => ({
    timestamp: scan.date ?? scan.dateTime ?? new Date().toISOString(),
    status: scan.eventDescription ?? "UNKNOWN",
    location: scan.scanLocation?.city,
    description: scan.derivedStatus,
  }));
  return { carrier: "fedex", trackingNumber, status, events };
}

// Verbatim port of shipping-cli fedex schedule_pickup: POST pickup/v1/pickups
// with associatedAccountNumber + originDetail.pickupDate; the time window is
// hardcoded "09:00-17:00" in the CLI reference.
export async function schedulePickup(
  pickupDate: string,
  cfg?: FedexCredentialOverride,
): Promise<PickupResult> {
  const config = effectiveConfig(cfg);
  const payload = {
    associatedAccountNumber: { value: config.accountNumber },
    originDetail: { pickupDate },
  };
  const data = await request<{
    output?: { pickupConfirmationCode?: string };
  }>(config, "POST", "pickup/v1/pickups", payload, CARRIER_DEFAULT_TIMEOUT_MS);
  return {
    carrier: "fedex",
    confirmationNumber: data.output?.pickupConfirmationCode ?? "UNKNOWN",
    date: pickupDate,
    timeWindow: "09:00-17:00",
  };
}

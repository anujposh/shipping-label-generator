import {
  CarrierApiError,
  CarrierAuthError,
  CarrierConfigError,
  CarrierUnavailableError,
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
import type {
  AddressValidationResult,
  CarrierAddress,
  CarrierLabel,
  PickupResult,
  RateQuote,
  RateShopArgs,
  ShipmentRequest,
  TrackingInfo,
  UspsCredentialOverride,
  VoidShipmentResult,
} from "./carrier-types";

type FetchLike = typeof fetch;

let transport: FetchLike = fetch;

/** Test-only fetch seam — production code never calls this. */
export function __setUspsTransportForTests(
  next: CarrierTransport | null,
): void {
  transport = next ?? fetch;
}

interface UspsConfig {
  clientId: string;
  clientSecret: string;
  accountNumber?: string;
  useSandbox: boolean;
  /** Explicit API base URL (BC tliLocation override); wins over useSandbox. */
  baseUrl?: string;
}

/** Token caches keyed by fingerprint of the full effective config. */
const tokenCaches = new Map<
  string,
  (forceRefresh?: boolean) => Promise<string>
>();

/** Test-only: clears per-credential token caches. */
export function __resetForTests(): void {
  tokenCaches.clear();
}

function effectiveConfig(cfg?: UspsCredentialOverride): UspsConfig {
  const clientId = cfg?.clientId || process.env.USPS_CLIENT_ID;
  const clientSecret = cfg?.clientSecret || process.env.USPS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new CarrierConfigError(
      "USPS is not configured: set USPS_CLIENT_ID, USPS_CLIENT_SECRET",
    );
  }
  return {
    clientId,
    clientSecret,
    accountNumber:
      cfg?.accountNumber || process.env.USPS_ACCOUNT_NUMBER || undefined,
    useSandbox: process.env.CARRIER_SANDBOX === "true",
    baseUrl: cfg?.baseUrl || undefined,
  };
}

/**
 * Rate quotes always resolve the PRODUCTION host — the CIE test environment
 * (apis-tem) returns empty rate lists for every mail class (2026-11-02 live
 * probe), the same rationale as FedEx production rate quotes. Credentials
 * are shared: the registration authenticates on both hosts. Set
 * USPS_RATE_BASE_URL to pin a different host (e.g. restore CIE testing).
 */
function rateQuoteBaseUrl(): string {
  const override = process.env.USPS_RATE_BASE_URL;
  if (override) {
    return override.endsWith("/") ? override : `${override}/`;
  }
  return "https://apis.usps.com/";
}

function baseUrl(config: UspsConfig): string {
  if (config.baseUrl) {
    return config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`;
  }
  return config.useSandbox
    ? "https://apis-tem.usps.com/"
    : "https://apis.usps.com/";
}

/** Per-API OAuth scope — USPS issues tokens scoped per product. Names as
 * granted by USPS OAuth (2026-11-02 live probe: the client's authorized
 * scope list contains "domestic-prices"/"international-prices" — the legacy
 * Laravel-era "prices" now answers 400 invalid_scope — plus "addresses",
 * "labels", "tracking", "carrier-pickup"). */
type UspsScope =
  | "addresses"
  | "domestic-prices"
  | "international-prices"
  | "labels"
  | "payments"
  | "tracking"
  | "carrier-pickup";

async function getAccessToken(
  config: UspsConfig,
  scope: UspsScope,
  forceRefresh = false,
): Promise<string> {
  const key = `${configFingerprint(config)}#${scope}`;
  let getter = tokenCaches.get(key);
  if (!getter) {
    getter = createTokenCache(() => fetchAccessToken(config, scope));
    tokenCaches.set(key, getter);
  }
  return getter(forceRefresh);
}

async function fetchAccessToken(
  config: UspsConfig,
  scope: UspsScope,
): Promise<{
  accessToken: string;
  expiresIn: number;
}> {
  let response: Response;
  let data: { access_token?: string; expires_in?: number | string };
  try {
    response = await transport(`${baseUrl(config)}oauth2/v3/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        scope,
      }),
      signal: AbortSignal.timeout(CARRIER_DEFAULT_TIMEOUT_MS),
    });
    data = await readCarrierJson<{
      access_token?: string;
      expires_in?: number | string;
    }>(response, "USPS OAuth");
  } catch (error) {
    if (error instanceof CarrierAuthError) throw error;
    if (isAbortError(error)) {
      throw new CarrierUnavailableError(
        error,
        `USPS token request timed out after ${CARRIER_DEFAULT_TIMEOUT_MS}ms`,
      );
    }
    throw new CarrierAuthError(
      `Failed to authenticate with USPS OAuth API: ${String(error)}`,
    );
  }
  const expiresIn = Number(data.expires_in);
  if (!data.access_token || !Number.isFinite(expiresIn)) {
    throw new CarrierAuthError(
      "USPS OAuth response did not include access_token/expires_in",
    );
  }
  return { accessToken: data.access_token, expiresIn };
}

function uspsAuthHeaders(): Record<string, string> {
  return { "X-Request-Id": String(Date.now()) };
}

async function request<T>(
  config: UspsConfig,
  method: string,
  path: string,
  options: {
    body?: unknown;
    query?: Record<string, string>;
    timeoutMs?: number;
    scope: UspsScope;
    accept?: string;
    headers?: Record<string, string>;
  },
): Promise<T> {
  const query = options.query
    ? `?${new URLSearchParams(options.query).toString()}`
    : "";
  const url = `${baseUrl(config)}${path}${query}`;
  let response: Response;
  try {
    response = await bearerRequest(
      transport,
      (force) => getAccessToken(config, options.scope, force ?? false),
      uspsAuthHeaders,
      url,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          Accept: options.accept ?? "application/json",
          ...options.headers,
        },
        ...(options.body !== undefined
          ? { body: JSON.stringify(options.body) }
          : {}),
      },
      options.timeoutMs,
    );
  } catch (error) {
    if (error instanceof CarrierApiError || error instanceof CarrierAuthError) {
      throw error;
    }
    throw new CarrierUnavailableError(error);
  }
  return readCarrierJson<T>(response, `USPS ${method} ${path}`);
}

interface UspsLabelResponse {
  trackingNumber?: string;
  labelImage?: string;
  postage?: number;
}

interface UspsAddressResponse {
  dpvConfirmation?: string;
  address?: {
    streetAddress?: string;
    secondaryAddress?: string;
    city?: string;
    state?: string;
    ZIPCode?: string;
    ZIPPlus4?: string;
  };
}

interface UspsTrackResponse {
  status?: string;
  events?: Array<{
    eventTime?: string;
    eventType?: string;
    eventCity?: string;
    eventDescription?: string;
  }>;
}

interface UspsRateRow {
  SKU?: string;
  description?: string;
  priceType?: string;
  price?: number;
  weight?: number;
  fees?: Array<{ name?: string; price?: number }>;
  mailClass?: string;
  zone?: string;
}

/**
 * Domestic Prices v3 total-rates response: one rateOption per eligible
 * product/packaging variant, each carrying its rate rows (official sample:
 * developers.usps.com/domesticpricesv3 → post-total-rates-search).
 */
interface UspsTotalRatesResponse {
  rateOptions?: Array<{
    totalBasePrice?: number;
    totalPrice?: number;
    rates?: UspsRateRow[];
  }>;
}

export async function rateShop(
  args: RateShopArgs,
  cfg?: UspsCredentialOverride,
): Promise<RateQuote[]> {
  const config = effectiveConfig(cfg);
  // Rate quotes pin the production host even when the deployment is
  // sandbox-pinned (labels/address validation keep the CIE host).
  const rateConfig = { ...config, baseUrl: rateQuoteBaseUrl() };
  const accountNumber = args.accountNumber ?? config.accountNumber;
  const totalWeight = args.packages.reduce(
    (sum, pkg) => sum + (Number(pkg.weight) || 0),
    0,
  );
  const first = args.packages[0];
  // total-rates/search REQUIRES numeric dimensions (live probe 2026-11-02 on
  // base-rates: a payload without length/width/height fails OAS validation —
  // FedEx/UPS tolerate missing dims, USPS does not). Boxes without dimension
  // data fall back to a 1-inch minimal surrogate so the quote is weight-based
  // rather than empty.
  const dims =
    first?.length !== undefined &&
    first?.width !== undefined &&
    first?.height !== undefined
      ? {
          length: Number(first.length),
          width: Number(first.width),
          height: Number(first.height),
        }
      : { length: 1, width: 1, height: 1 };
  // USPS OAS: "The maximum dimension is always length … the second longest
  // dimension is always width" — sort the raw box dims into that order.
  const sorted = [dims.length, dims.width, dims.height].sort((a, b) => b - a);
  const length = sorted[0];
  const width = sorted[1];
  const height = sorted[2];
  // mailingDate must be a plain YYYY-MM-DD; the shipping-details shipDate
  // can arrive as a full ISO timestamp which fails OAS validation.
  const rawDate = args.shipDate ?? "";
  const mailingDate = /^\d{4}-\d{2}-\d{2}/.test(rawDate)
    ? rawDate.slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  // USPS recommends /prices/v3/total-rates/search when ALL mail classes are
  // needed: one request returns every eligible product/packaging option
  // (Ground Advantage, Priority Mail + flat-rate variants, Priority Mail
  // Express, Media Mail, Library Mail, Parcel Select, …) with eligibility
  // applied by USPS itself — unlike base-rates/search, which takes a single
  // mailClass and returns only its base product (the cause of the old
  // three-rate display). No processingCategory/rateIndicator here; the
  // endpoint derives every valid rate combination for the ingredients.
  const payload = {
    originZIPCode: args.fromZip,
    destinationZIPCode: args.toZip,
    weight: totalWeight,
    length,
    width,
    height,
    mailClasses: ["ALL"],
    priceType: "COMMERCIAL",
    mailingDate,
    accountType: "EPS",
    ...(accountNumber ? { accountNumber } : {}),
  };
  const data = await request<UspsTotalRatesResponse>(
    rateConfig,
    "POST",
    "prices/v3/total-rates/search",
    {
      body: payload,
      timeoutMs: CARRIER_DEFAULT_TIMEOUT_MS,
      scope: "domestic-prices",
    },
  );
  const quotes: RateQuote[] = [];
  const seen = new Set<string>();
  for (const option of data.rateOptions ?? []) {
    for (const rate of option.rates ?? []) {
      // Dedupe identical products (same SKU+priceType+price) so a repeated
      // option never renders twice; distinct products always stay.
      const key = [
        rate.SKU ?? "",
        rate.priceType ?? "",
        String(rate.price ?? option.totalBasePrice ?? ""),
        rate.description ?? "",
      ].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      quotes.push({
        carrier: "usps" as const,
        service: rate.mailClass ?? "USPS_GROUND_ADVANTAGE",
        ...(rate.description ? { serviceDescription: rate.description } : {}),
        cost: Number(rate.price ?? option.totalBasePrice ?? 0),
        currency: "USD",
        ...(rate.SKU ? { sku: rate.SKU } : {}),
        ...(rate.priceType ? { priceType: rate.priceType } : {}),
      });
    }
  }
  return quotes;
}

export async function validateAddress(
  address: CarrierAddress,
  cfg?: UspsCredentialOverride,
): Promise<AddressValidationResult> {
  const config = effectiveConfig(cfg);
  // Laravel parity: Address 3.0 is a GET with query parameters — the API
  // answers 405 Method Not Allowed on POST.
  const streetAddress = [address.addressLine1, address.addressLine2]
    .filter(
      (line): line is string => typeof line === "string" && line.length > 0,
    )
    .join(" ");
  const data = await request<UspsAddressResponse>(
    config,
    "GET",
    "addresses/v3/address",
    {
      query: {
        streetAddress,
        city: address.city,
        state: address.state,
        ZIPCode: address.zipCode,
      },
      timeoutMs: CARRIER_DEFAULT_TIMEOUT_MS,
      scope: "addresses",
    },
  );
  const standardized = data.address;
  // DPV codes (USPS Addresses 3.0): "Y" confirmed primary AND secondary,
  // "D" confirmed primary only (secondary missing), "S" confirmed primary
  // only (secondary present but unconfirmed) — the deliverable outcomes.
  // "N" (no match) and blank (not presented) are not.
  const dpv = data.dpvConfirmation ?? "";
  return {
    carrier: "usps",
    valid: dpv === "Y" || dpv === "D" || dpv === "S",
    response: data,
    ...(standardized?.streetAddress
      ? {
          candidates: [
            {
              addressLine1: standardized.streetAddress,
              addressLine2: standardized.secondaryAddress ?? "",
              city: standardized.city ?? "",
              state: standardized.state ?? "",
              zipCode: standardized.ZIPCode ?? "",
              countryCode: "US",
              classification: "UNKNOWN",
              ZIPPlus4: standardized.ZIPPlus4 ?? "",
            },
          ],
        }
      : {}),
  };
}

/**
 * Current Domestic Labels v3 flow (official payments + labels APIs):
 * a payments-scoped OAuth token supplies the CRID/MID claims needed for an
 * EPS payment-authorization token; a labels-scoped OAuth token plus that
 * payment token authorizes POST /labels/v3/label. Secrets and tokens stay in
 * memory and are never included in returned labels or application logs.
 */
interface UspsPaymentTokenClaims {
  crid?: unknown;
  mail_owners?: Array<{ crid?: unknown; mids?: unknown }>;
}

function paymentIdentityFromToken(token: string): {
  crid: string;
  mid: string;
} {
  try {
    const segments = token.split(".");
    if (segments.length !== 3) throw new Error("not a JWT");
    const claims = JSON.parse(
      Buffer.from(segments[1], "base64url").toString("utf8"),
    ) as UspsPaymentTokenClaims;
    const crid = typeof claims.crid === "string" ? claims.crid : "";
    const owners = Array.isArray(claims.mail_owners) ? claims.mail_owners : [];
    const owner = owners.find((entry) => entry.crid === crid) ?? owners[0];
    const mid =
      typeof owner?.mids === "string"
        ? (owner.mids.split(/[,\s]+/).find(Boolean) ?? "")
        : "";
    if (!crid || !mid) throw new Error("claims missing");
    return { crid, mid };
  } catch {
    throw new CarrierAuthError(
      "USPS payments OAuth token did not contain the CRID/MID claims required for label payment authorization",
    );
  }
}

async function fetchPaymentAuthorizationToken(
  config: UspsConfig,
  accountNumber: string,
): Promise<string> {
  const paymentsToken = await getAccessToken(config, "payments");
  const { crid, mid } = paymentIdentityFromToken(paymentsToken);
  const role = {
    CRID: crid,
    MID: mid,
    manifestMID: mid,
    accountType: "EPS",
    accountNumber,
  };
  const data = await request<{ paymentAuthorizationToken?: string }>(
    config,
    "POST",
    "payments/v3/payment-authorization",
    {
      body: {
        roles: [
          { roleName: "PAYER", ...role },
          { roleName: "LABEL_OWNER", ...role },
        ],
      },
      timeoutMs: CARRIER_DEFAULT_TIMEOUT_MS,
      scope: "payments",
    },
  );
  if (!data.paymentAuthorizationToken) {
    throw new CarrierAuthError(
      "USPS payment authorization response had no paymentAuthorizationToken",
    );
  }
  return data.paymentAuthorizationToken;
}

function uspsLabelAddress(address: CarrierAddress): Record<string, unknown> {
  const fullName = (
    address.contactName ??
    address.companyName ??
    "Shipping Contact"
  )
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const firstName = fullName.shift() ?? "Shipping";
  const lastName = fullName.join(" ") || "Contact";
  return {
    firstName,
    lastName,
    ...(address.companyName ? { firm: address.companyName } : {}),
    streetAddress: address.addressLine1,
    ...(address.addressLine2 ? { secondaryAddress: address.addressLine2 } : {}),
    city: address.city,
    state: address.state,
    ZIPCode: address.zipCode,
  };
}

function uspsPackageDescription(
  shipment: ShipmentRequest,
  pkg: ShipmentRequest["packages"][number],
): Record<string, unknown> {
  const dimensions = [pkg.length, pkg.width, pkg.height].every(
    (value) => typeof value === "number" && value > 0,
  )
    ? [Number(pkg.length), Number(pkg.width), Number(pkg.height)].sort(
        (a, b) => b - a,
      )
    : undefined;
  return {
    mailClass: shipment.serviceType || "USPS_GROUND_ADVANTAGE",
    rateIndicator: "SP",
    weightUOM: "lb",
    weight: pkg.weight,
    ...(dimensions
      ? {
          dimensionsUOM: "in",
          length: dimensions[0],
          width: dimensions[1],
          height: dimensions[2],
        }
      : {}),
    processingCategory: "MACHINABLE",
    mailingDate: shipment.shipDate ?? new Date().toISOString().slice(0, 10),
    extraServices: [920],
    destinationEntryFacilityType: "NONE",
    ...(Number(pkg.insuredValue ?? 0) > 0
      ? { packageOptions: { packageValue: Number(pkg.insuredValue) } }
      : {}),
  };
}

export async function createShipment(
  shipment: ShipmentRequest,
  cfg?: UspsCredentialOverride,
): Promise<CarrierLabel[]> {
  const config = effectiveConfig(cfg);
  const accountNumber = shipment.accountNumber ?? config.accountNumber;
  if (!accountNumber) {
    throw new CarrierConfigError(
      "USPS label creation requires USPS_ACCOUNT_NUMBER for EPS payment authorization",
    );
  }
  const paymentToken = await fetchPaymentAuthorizationToken(
    config,
    accountNumber,
  );
  const labels: CarrierLabel[] = [];
  for (const pkg of shipment.packages) {
    const data = await request<UspsLabelResponse>(
      config,
      "POST",
      "labels/v3/label",
      {
        body: {
          imageInfo: {
            imageType: shipment.labelFormat === "ZPL" ? "ZPL203DPI" : "PDF",
            labelType: "4X6LABEL",
            receiptOption: "NONE",
            suppressPostage: false,
            suppressMailDate: false,
            returnLabel: false,
          },
          toAddress: uspsLabelAddress(shipment.to),
          fromAddress: uspsLabelAddress(shipment.from),
          packageDescription: uspsPackageDescription(shipment, pkg),
        },
        timeoutMs: CARRIER_SHIPMENT_TIMEOUT_MS,
        scope: "labels",
        accept: "application/vnd.usps.labels+json",
        headers: { "X-Payment-Authorization-Token": paymentToken },
      },
    );
    if (!data.labelImage) {
      throw new CarrierApiError({
        status: 502,
        message: "USPS create returned no label image",
      });
    }
    labels.push({
      carrier: "usps",
      environment:
        new URL(baseUrl(config)).hostname === "apis-tem.usps.com"
          ? "sandbox"
          : "production",
      trackingNumber: data.trackingNumber ?? "UNKNOWN",
      labelData: data.labelImage,
      format: shipment.labelFormat,
      ...(typeof data.postage === "number" ? { cost: data.postage } : {}),
    });
  }
  return labels;
}

export async function voidShipment(
  trackingNumber: string,
  cfg?: UspsCredentialOverride,
): Promise<VoidShipmentResult> {
  const config = effectiveConfig(cfg);
  const accountNumber = config.accountNumber;
  if (!accountNumber) {
    throw new CarrierConfigError(
      "USPS label void requires USPS_ACCOUNT_NUMBER for EPS payment authorization",
    );
  }
  const paymentToken = await fetchPaymentAuthorizationToken(
    config,
    accountNumber,
  );
  const data = await request<unknown>(
    config,
    "DELETE",
    `labels/v3/label/${trackingNumber}`,
    {
      scope: "labels",
      headers: { "X-Payment-Authorization-Token": paymentToken },
    },
  );
  return { carrier: "usps", voided: true, trackingNumber, response: data };
}

export async function track(
  trackingNumber: string,
  cfg?: UspsCredentialOverride,
): Promise<TrackingInfo> {
  const config = effectiveConfig(cfg);
  const data = await request<UspsTrackResponse>(config, "GET", "tracking/v3", {
    query: { trackingNumber },
    timeoutMs: CARRIER_DEFAULT_TIMEOUT_MS,
    scope: "tracking",
  });
  const status = data.status ?? "UNKNOWN";
  const events = (data.events ?? []).map((event) => ({
    timestamp: event.eventTime ?? new Date().toISOString(),
    status: event.eventType ?? "UNKNOWN",
    location: event.eventCity,
    description: event.eventDescription,
  }));
  return { carrier: "usps", trackingNumber, status, events };
}

// Verbatim port of shipping-cli usps schedule_pickup: POST
// carrierpickup/v3/schedule-pickup with pickupDate + serviceType
// "REGULAR_PICKUP"; USPS is the one carrier that returns its pickup window.
export async function schedulePickup(
  pickupDate: string,
  cfg?: UspsCredentialOverride,
): Promise<PickupResult> {
  const config = effectiveConfig(cfg);
  const payload = { pickupDate, serviceType: "REGULAR_PICKUP" };
  const data = await request<{
    confirmationNumber?: string;
    pickupWindow?: string;
  }>(config, "POST", "carrierpickup/v3/schedule-pickup", {
    body: payload,
    timeoutMs: CARRIER_DEFAULT_TIMEOUT_MS,
    scope: "carrier-pickup",
  });
  return {
    carrier: "usps",
    confirmationNumber: data.confirmationNumber ?? "UNKNOWN",
    date: pickupDate,
    timeWindow: data.pickupWindow ?? "09:00-17:00",
  };
}

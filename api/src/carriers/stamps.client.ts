import {
  CarrierApiError,
  CarrierAuthError,
  CarrierConfigError,
  CarrierUnavailableError,
} from "./carrier-errors";
import {
  CARRIER_DEFAULT_TIMEOUT_MS,
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
  StampsCredentialOverride,
  TrackingInfo,
  VoidShipmentResult,
} from "./carrier-types";

/**
 * Stamps.com/Endicia REST API (SERA) client — rate quotes.
 *
 * Contract from the SERA v1 OpenAPI spec (developer.stamps.com/rest-api,
 * embedded in the Redoc reference page, extracted 2026-11-02):
 *   POST {base}v1/rates  { from_address, to_address, package, ship_date }
 *   → [ { carrier, service_type, estimated_delivery_days,
 *         estimated_delivery_date, shipment_cost: { total_amount, currency } } ]
 * Legacy Laravel reference: shippingQouteRatingController::stampsRating
 * (refresh-token OAuth at the signin host, rates at STAMPS_BASE_URL; the
 * legacy ALL fan-out had Stamps commented out — this client re-enables it).
 *
 * Auth differs from the other carriers: SERA uses a refresh_token grant
 * (no client-credentials), mirroring Laravel
 * Controller::getOrRefereshStampsToken.
 */

type FetchLike = typeof fetch;

let transport: FetchLike = fetch;

/** Test-only fetch seam — production code never calls this. */
export function __setStampsTransportForTests(
  next: CarrierTransport | null,
): void {
  transport = next ?? fetch;
}

interface StampsConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** API host (rates). Defaults per CARRIER_SANDBOX below. */
  baseUrl?: string;
  /** Signin host override; defaults per CARRIER_SANDBOX. */
  signinUrl?: string;
  useSandbox: boolean;
}

export function __resetForTests(): void {
  tokenCaches.clear();
}

const tokenCaches = new Map<string, ReturnType<typeof createTokenCache>>();

function effectiveConfig(cfg?: StampsCredentialOverride): StampsConfig {
  const clientId = cfg?.clientId || process.env.STAMPS_CLIENT_ID;
  const clientSecret = cfg?.clientSecret || process.env.STAMPS_CLIENT_SECRET;
  const refreshToken = cfg?.refreshToken || process.env.STAMPS_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new CarrierConfigError(
      "Stamps is not configured: set STAMPS_CLIENT_ID, STAMPS_CLIENT_SECRET, STAMPS_REFRESH_TOKEN",
    );
  }
  return {
    clientId,
    clientSecret,
    refreshToken,
    useSandbox: process.env.CARRIER_SANDBOX === "true",
    baseUrl: cfg?.baseUrl || process.env.STAMPS_BASE_URL || undefined,
    signinUrl: process.env.STAMPS_SIGNIN_URL || undefined,
  };
}

function baseUrl(config: StampsConfig): string {
  if (config.baseUrl) {
    return config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`;
  }
  return config.useSandbox
    ? "https://api.testing.stampsendicia.com/"
    : "https://api.stampsendicia.com/";
}

function signinUrl(config: StampsConfig): string {
  if (config.signinUrl) return config.signinUrl;
  return config.useSandbox
    ? "https://signin.testing.stampsendicia.com/oauth/token"
    : "https://signin.stampsendicia.com/oauth/token";
}

async function getAccessToken(
  config: StampsConfig,
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

async function fetchAccessToken(
  config: StampsConfig,
): Promise<{ accessToken: string; expiresIn: number }> {
  let response: Response;
  let data: { access_token?: string; expires_in?: number | string };
  try {
    response = await transport(signinUrl(config), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
      }),
      signal: AbortSignal.timeout(CARRIER_DEFAULT_TIMEOUT_MS),
    });
    data =
      (await readCarrierJson<{
        access_token?: string;
        expires_in?: number | string;
      }>(response, "Stamps OAuth")) ?? {};
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new CarrierUnavailableError(
      `Failed to reach Stamps OAuth API: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new CarrierAuthError(
      `Failed to authenticate with Stamps OAuth API: ${response.status} ${response.statusText}`,
    );
  }
  const accessToken = data.access_token;
  if (!accessToken) {
    throw new CarrierAuthError("Stamps OAuth response had no access_token");
  }
  return {
    accessToken,
    expiresIn: Number(data.expires_in) || 3600,
  };
}

/** SERA /v1/rates response row (OpenAPI `POST /v1/rates` 200 items). */
interface SerasRate {
  carrier?: string;
  service_type?: string;
  packaging_type?: string;
  estimated_delivery_days?: string;
  estimated_delivery_date?: string | null;
  is_guaranteed_service?: boolean;
  shipment_cost?: { total_amount?: number; currency?: string };
}

/** USPS domestic packaging types we fan out across for SERA rate quotes.
 * Letters/postcards/thick_envelopes are excluded from this parcel flow.
 * Express/international-only packaging variants are excluded. */
const SERA_USPS_RATE_PACKAGING_TYPES: readonly string[] = [
  "package",
  "large_envelope",
  "usps_flat_rate_envelope",
  "usps_legal_flat_rate_envelope",
  "usps_padded_flat_rate_envelope",
  "usps_small_flat_rate_box",
  "usps_medium_flat_rate_box",
  "usps_large_flat_rate_box",
  "usps_regional_rate_box_a",
  "usps_regional_rate_box_b",
];

function addressPayload(address?: CarrierAddress): Record<string, unknown> {
  return {
    address_line1: address?.addressLine1 ?? "",
    address_line2: address?.addressLine2 ?? "",
    city: address?.city ?? "",
    state_province: address?.state ?? "",
    postal_code: address?.zipCode ?? "",
    country_code: address?.countryCode ?? "US",
    phone: address?.contactPhone ?? "",
  };
}

/** Human-readable label for a SERA service_type ("usps_ground_advantage"
 * → "USPS Ground Advantage"). */
function serviceLabel(serviceType: string): string {
  return serviceType
    .split("_")
    .map((word) =>
      word === "usps" || word === "ups" || word === "fedex"
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}

/** Human-readable label for a SERA packaging_type. */
function packagingLabel(packagingType: string): string {
  const labels: Record<string, string> = {
    package: "Package",
    large_envelope: "Large Envelope/Flat",
    usps_flat_rate_envelope: "Flat Rate Envelope",
    usps_legal_flat_rate_envelope: "Legal Flat Rate Envelope",
    usps_padded_flat_rate_envelope: "Padded Flat Rate Envelope",
    usps_small_flat_rate_box: "Small Flat Rate Box",
    usps_medium_flat_rate_box: "Medium Flat Rate Box",
    usps_large_flat_rate_box: "Large Flat Rate Box",
    usps_regional_rate_box_a: "Regional Rate Box A",
    usps_regional_rate_box_b: "Regional Rate Box B",
  };
  if (labels[packagingType]) return labels[packagingType];
  return packagingType
    .split("_")
    .map((word) =>
      word === "usps" || word === "ups" || word === "fedex"
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}

function buildBasePayload(args: RateShopArgs): Record<string, unknown> {
  const first = args.packages[0];
  return {
    from_address: addressPayload(args.fromAddress),
    to_address: addressPayload(args.toAddress),
    // SERA `package` (singular): rating uses the first package's profile;
    // total weight rides on it when the shipment spans multiple boxes.
    package: {
      weight: Number(first?.weight) || 0,
      weight_unit: "pound",
      ...(first?.length !== undefined &&
      first?.width !== undefined &&
      first?.height !== undefined
        ? {
            length: Number(first.length),
            width: Number(first.width),
            height: Number(first.height),
          }
        : {}),
      dimension_unit: "inch",
    },
    ship_date: args.shipDate ?? new Date().toISOString().slice(0, 10),
  };
}

async function fetchRatesForPackaging(
  args: RateShopArgs,
  config: StampsConfig,
  token: string,
  packagingType: string,
): Promise<SerasRate[]> {
  const base = buildBasePayload(args);
  const payload = {
    ...base,
    package: {
      ...(base.package as Record<string, unknown>),
      packaging_type: packagingType,
    },
  };
  let response: Response;
  try {
    // Path carries the /sera prefix (Laravel parity: STAMPS_BASE_URL +
    // "sera/v1/rates"; the SERA OpenAPI server URL embeds the prefix).
    response = await transport(`${baseUrl(config)}sera/v1/rates`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(CARRIER_DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new CarrierUnavailableError(
      `Failed to reach Stamps rates API: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new CarrierApiError({
      status: response.status,
      message: detail.slice(0, 200) || response.statusText,
    });
  }
  return (await readCarrierJson<SerasRate[]>(response, "Stamps rates")) ?? [];
}

/** Canonical USPS service ordering; unknown services sort alphabetically
 * after these, and UPS services sort after USPS. */
const USPS_SERVICE_ORDER: readonly string[] = [
  "usps_first_class_mail",
  "usps_ground_advantage",
  "usps_priority_mail",
  "usps_priority_mail_express",
  "usps_parcel_select",
  "usps_media_mail",
];

function serviceSortKey(serviceType: string): number {
  const idx = USPS_SERVICE_ORDER.indexOf(serviceType);
  if (idx >= 0) return idx;
  // Unknown USPS / other carriers: bucket after the canonical USPS list.
  // UPS after everything else so the matrix stays USPS-first.
  const upsOffset = 100_000;
  if (serviceType.startsWith("ups_")) return upsOffset + 1;
  return upsOffset - 1;
}

export async function rateShop(
  args: RateShopArgs,
  cfg?: StampsCredentialOverride,
): Promise<RateQuote[]> {
  const config = effectiveConfig(cfg);
  const token = await getAccessToken(config);

  const results = await Promise.allSettled(
    SERA_USPS_RATE_PACKAGING_TYPES.map((packagingType) =>
      fetchRatesForPackaging(args, config, token, packagingType),
    ),
  );

  const errors: Error[] = [];
  const seen = new Map<string, RateQuote>();

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const packagingType = SERA_USPS_RATE_PACKAGING_TYPES[i];
    if (result.status === "rejected") {
      const error =
        result.reason instanceof Error
          ? result.reason
          : new CarrierApiError({
              status: 0,
              message: String(result.reason),
            });
      console.warn(
        `Stamps rate request failed for packaging ${packagingType}: ${error.message}`,
      );
      errors.push(error);
      continue;
    }

    for (const rate of result.value) {
      if (rate.shipment_cost?.total_amount === undefined) continue;
      const service = rate.service_type ?? "UNKNOWN";
      const packaging = rate.packaging_type ?? packagingType;
      const key = `${service}:${packaging}`;
      const cost = Number(rate.shipment_cost?.total_amount ?? 0);
      const existing = seen.get(key);
      if (existing && existing.cost <= cost) continue;
      const serviceDesc = packaging
        ? `${serviceLabel(service)} — ${packagingLabel(packaging)}`
        : serviceLabel(service);
      seen.set(key, {
        carrier: "stamps" as const,
        service,
        serviceDescription: serviceDesc,
        cost,
        currency: (rate.shipment_cost?.currency ?? "usd").toUpperCase(),
        deliveryDays: rate.estimated_delivery_days ?? "",
        ...(typeof rate.estimated_delivery_date === "string" &&
        rate.estimated_delivery_date
          ? { deliveryDate: rate.estimated_delivery_date }
          : {}),
        packagingType: packaging,
      });
    }
  }

  if (seen.size === 0 && errors.length > 0) {
    throw errors[0];
  }

  return Array.from(seen.values()).sort((a, b) => {
    const ka = serviceSortKey(a.service);
    const kb = serviceSortKey(b.service);
    if (ka !== kb) return ka - kb;
    return a.cost - b.cost;
  });
}

// ---------------------------------------------------------------------------
// Unsupported SERA surfaces (rate quotes only for now)
// ---------------------------------------------------------------------------

function unsupported(operation: string): never {
  throw new CarrierConfigError(
    `Stamps does not support ${operation} through this client yet`,
  );
}

export async function validateAddress(): Promise<AddressValidationResult> {
  unsupported("address validation");
}

export async function createShipment(): Promise<CarrierLabel[]> {
  unsupported("label creation");
}

export async function voidShipment(): Promise<VoidShipmentResult> {
  unsupported("label void");
}

export async function track(): Promise<TrackingInfo> {
  unsupported("tracking");
}

export async function schedulePickup(): Promise<PickupResult> {
  unsupported("pickup scheduling");
}

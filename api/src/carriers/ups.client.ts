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
  UpsCredentialOverride,
  VoidShipmentResult,
} from "./carrier-types";

type FetchLike = typeof fetch;

let transport: FetchLike = fetch;

/** Test-only fetch seam — production code never calls this. */
export function __setUpsTransportForTests(next: CarrierTransport | null): void {
  transport = next ?? fetch;
}

interface UpsConfig {
  clientId: string;
  clientSecret: string;
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

/** Test-only: clears per-credential token caches. */
export function __resetForTests(): void {
  tokenCaches.clear();
}

function effectiveConfig(cfg?: UpsCredentialOverride): UpsConfig {
  const clientId = cfg?.clientId || process.env.UPS_CLIENT_ID;
  const clientSecret = cfg?.clientSecret || process.env.UPS_CLIENT_SECRET;
  const accountNumber = cfg?.accountNumber || process.env.UPS_ACCOUNT_NUMBER;
  if (!clientId || !clientSecret || !accountNumber) {
    throw new CarrierConfigError(
      "UPS is not configured: set UPS_CLIENT_ID, UPS_CLIENT_SECRET, UPS_ACCOUNT_NUMBER",
    );
  }
  return {
    clientId,
    clientSecret,
    accountNumber,
    useSandbox: process.env.CARRIER_SANDBOX === "true",
    baseUrl: cfg?.baseUrl || undefined,
  };
}
function baseUrl(config: UpsConfig): string {
  if (config.baseUrl) {
    // BC tliLocation upsBaseURL values carry a trailing "/api" segment from
    // the legacy client (paths there started "api/..."), while this client
    // owns the full path shape itself — strip the duplicate prefix.
    const trimmed = config.baseUrl.endsWith("/")
      ? config.baseUrl.slice(0, -1)
      : config.baseUrl;
    const withoutApi = trimmed.endsWith("/api")
      ? trimmed.slice(0, -4)
      : trimmed;
    return `${withoutApi}/`;
  }
  return config.useSandbox
    ? "https://wwwcie.ups.com/"
    : "https://onlinetools.ups.com/";
}
async function getAccessToken(
  config: UpsConfig,
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

async function fetchAccessToken(config: UpsConfig): Promise<{
  accessToken: string;
  expiresIn: number;
}> {
  const rawCredentials = `${config.clientId}:${config.clientSecret}`;
  const basicToken = Buffer.from(rawCredentials, "utf8").toString("base64");
  let response: Response;
  let data: { access_token?: string; expires_in?: number | string };
  try {
    response = await transport(`${baseUrl(config)}security/v1/oauth/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
      signal: AbortSignal.timeout(CARRIER_DEFAULT_TIMEOUT_MS),
    });
    data = await readCarrierJson<{
      access_token?: string;
      expires_in?: number | string;
    }>(response, "UPS OAuth");
  } catch (error) {
    if (error instanceof CarrierAuthError) throw error;
    if (isAbortError(error)) {
      throw new CarrierUnavailableError(
        error,
        `UPS token request timed out after ${CARRIER_DEFAULT_TIMEOUT_MS}ms`,
      );
    }
    throw new CarrierAuthError(
      `Failed to authenticate with UPS OAuth API: ${String(error)}`,
    );
  }
  const expiresIn = Number(data.expires_in);
  if (!data.access_token || !Number.isFinite(expiresIn)) {
    throw new CarrierAuthError(
      "UPS OAuth response did not include access_token/expires_in",
    );
  }
  return { accessToken: data.access_token, expiresIn };
}

function upsAuthHeaders(): Record<string, string> {
  return {
    transId: String(Date.now()),
    transactionSrc: "posh-web-nodejs",
  };
}

async function request<T>(
  config: UpsConfig,
  method: string,
  path: string,
  options: {
    body?: unknown;
    query?: Record<string, string>;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const query = options.query
    ? `?${new URLSearchParams(options.query).toString()}`
    : "";
  const url = `${baseUrl(config)}${path}${query}`;
  let response: Response;
  try {
    response = await bearerRequest(
      transport,
      (force) => getAccessToken(config, force ?? false),
      upsAuthHeaders,
      url,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
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
  return readCarrierJson<T>(response, `UPS ${method} ${path}`);
}

interface UpsRateResponse {
  RateResponse?: {
    RatedShipment?:
      | unknown[]
      | {
          Service?: { Code?: string };
          TotalCharges?: { MonetaryValue?: string; CurrencyCode?: string };
        };
  };
}

interface UpsShipResponse {
  ShipmentResponse?: {
    ShipmentResults?: {
      PackageResults?: {
        TrackingNumber?: string;
        ShippingLabel?: { GraphicImage?: string };
      };
    };
  };
}

interface UpsTrackResponse {
  trackResponse?: {
    shipment?: Array<{
      package?: Array<{
        currentStatus?: { description?: string };
        activity?: Array<{
          date?: string;
          time?: string;
          status?: { description?: string };
          location?: { address?: { city?: string } };
        }>;
      }>;
    }>;
  };
}

function upsRateAddress(
  zip: string,
  address?: CarrierAddress,
): Record<string, unknown> {
  if (!address) {
    return { PostalCode: zip, CountryCode: "US" };
  }
  return {
    AddressLine: [address.addressLine1 ?? "", address.addressLine2 ?? "", ""],
    City: address.city ?? "",
    StateProvinceCode: address.state ?? "",
    PostalCode: address.zipCode || zip,
    CountryCode: address.countryCode || "US",
  };
}

export async function rateShop(
  args: RateShopArgs,
  cfg?: UpsCredentialOverride,
): Promise<RateQuote[]> {
  const config = effectiveConfig(cfg);
  const totalWeight = args.packages.reduce(
    (sum, pkg) => sum + (Number(pkg.weight) || 0),
    0,
  );
  const payload = {
    RateRequest: {
      Request: {
        TransactionReference: { CustomerContext: "CustomerContext" },
      },
      Shipment: {
        Shipper: {
          // ShipperNumber must be the account linked to these credentials.
          // The body's carrier_account_no is resolved for the BC shipment's
          // agent carrier and can carry another carrier's number (UPS 120100);
          // config.accountNumber (tliLocation → env) is always this shipper's.
          ShipperNumber: config.accountNumber,
          Address: upsRateAddress(args.fromZip, args.fromAddress),
        },
        ShipTo: { Address: upsRateAddress(args.toZip, args.toAddress) },
        ShipFrom: {
          Address: upsRateAddress(args.fromZip, args.fromAddress),
        },
        ...(args.packages.length > 0
          ? {
              ShipmentTotalWeight: {
                UnitOfMeasurement: { Code: "LBS", Description: "Pounds" },
                Weight: String(totalWeight),
              },
              NumOfPieces: String(args.packages.length),
            }
          : {}),
        Package: args.packages.map((pkg) => ({
          PackagingType: { Code: "02", Description: "Packaging" },
          ...(pkg.length !== undefined &&
          pkg.width !== undefined &&
          pkg.height !== undefined
            ? {
                Dimensions: {
                  UnitOfMeasurement: { Code: "IN", Description: "Inches" },
                  Length: String(pkg.length),
                  Width: String(pkg.width),
                  Height: String(pkg.height),
                },
              }
            : {}),
          PackageWeight: {
            UnitOfMeasurement: { Code: "LBS", Description: "Pounds" },
            Weight: String(pkg.weight),
          },
        })),
      },
    },
  };
  const data = await request<UpsRateResponse>(
    config,
    "POST",
    "api/rating/v2403/shop",
    {
      body: payload,
      timeoutMs: CARRIER_DEFAULT_TIMEOUT_MS,
    },
  );
  let rated = data.RateResponse?.RatedShipment ?? [];
  if (!Array.isArray(rated)) rated = [rated];
  return rated
    .filter(
      (shipment): shipment is Record<string, unknown> =>
        shipment !== null && typeof shipment === "object",
    )
    .map((shipment) => {
      const totalCharges = (shipment.TotalCharges ?? {}) as {
        MonetaryValue?: string;
        CurrencyCode?: string;
      };
      const service = (shipment.Service ?? {}) as {
        Code?: string;
        Description?: string;
      };
      const transit = (shipment.TimeInTransit ?? {}) as {
        BusinessDaysInTransit?: string;
        ServiceSummary?: {
          EstimatedArrival?: {
            Arrival?: { Date?: string; Time?: string };
          };
        };
      };
      const description = service.Description
        ? String(service.Description)
        : undefined;
      const deliveryDays = transit.BusinessDaysInTransit
        ? String(transit.BusinessDaysInTransit)
        : undefined;
      // Carrier-reported commit datetime, verbatim from TimeInTransit —
      // never computed locally. Date is YYYYMMDD; Time (optional) HHMMSS.
      const arrival = transit.ServiceSummary?.EstimatedArrival?.Arrival;
      const arrivalDate =
        typeof arrival?.Date === "string" && /^\d{8}$/.test(arrival.Date)
          ? arrival.Date
          : undefined;
      const arrivalTime =
        typeof arrival?.Time === "string" && /^\d{6}$/.test(arrival.Time)
          ? arrival.Time
          : undefined;
      const deliveryDate =
        arrivalDate !== undefined
          ? `${arrivalDate.slice(0, 4)}-${arrivalDate.slice(4, 6)}-${arrivalDate.slice(6, 8)}` +
            (arrivalTime !== undefined
              ? `T${arrivalTime.slice(0, 2)}:${arrivalTime.slice(2, 4)}:${arrivalTime.slice(4, 6)}`
              : "")
          : undefined;
      return {
        carrier: "ups" as const,
        service: String(service.Code ?? "UNKNOWN"),
        cost: Number(totalCharges.MonetaryValue ?? "0"),
        currency: totalCharges.CurrencyCode ?? "USD",
        ...(description !== undefined
          ? { serviceDescription: description }
          : {}),
        ...(deliveryDays !== undefined ? { deliveryDays } : {}),
        ...(deliveryDate !== undefined ? { deliveryDate } : {}),
      };
    });
}

interface UpsXavAddressKeyFormat {
  AddressLine?: string | string[];
  PoliticalDivision2?: string;
  PoliticalDivision1?: string;
  PostcodePrimaryLow?: string;
  PostcodeExtendedLow?: string;
  CountryCode?: string;
}

interface UpsXavCandidate {
  AddressClassification?: { Description?: string };
  AddressKeyFormat?: UpsXavAddressKeyFormat;
}

interface UpsXavResponse {
  XAVResponse?: {
    Response?: { ResponseStatus?: { Code?: string } };
    /** Presence-style: key present (empty string) when the address is valid. */
    ValidAddressIndicator?: string;
    NoCandidatesIndicator?: string;
    AddressClassification?: { Description?: string };
    Candidate?: UpsXavCandidate | UpsXavCandidate[];
  };
}

function xavCandidateLines(format: UpsXavAddressKeyFormat): [string, string] {
  const raw = format.AddressLine;
  if (Array.isArray(raw)) {
    return [String(raw[0] ?? ""), String(raw[1] ?? "")];
  }
  return [typeof raw === "string" ? raw : "", ""];
}

export async function validateAddress(
  address: CarrierAddress,
  cfg?: UpsCredentialOverride,
): Promise<AddressValidationResult> {
  const config = effectiveConfig(cfg);
  const payload = {
    XAVRequest: {
      AddressKeyFormat: {
        AddressLine: [address.addressLine1, address.addressLine2 ?? "", ""],
        Region: `${address.city},${address.state},${address.zipCode}`,
        CountryCode: address.countryCode,
      },
    },
  };
  const data = await request<UpsXavResponse>(
    config,
    "POST",
    "api/addressvalidation/v1/3",
    { body: payload, timeoutMs: CARRIER_DEFAULT_TIMEOUT_MS },
  );
  const xav = data.XAVResponse ?? {};
  const rawCandidates = xav.Candidate;
  const candidateList =
    rawCandidates === undefined
      ? []
      : Array.isArray(rawCandidates)
        ? rawCandidates
        : [rawCandidates];
  const valid =
    xav.ValidAddressIndicator !== undefined || candidateList.length > 0;
  const candidates = candidateList.map((candidate) => {
    const format = candidate.AddressKeyFormat ?? {};
    const [addressLine1, addressLine2] = xavCandidateLines(format);
    return {
      addressLine1,
      addressLine2,
      city: String(format.PoliticalDivision2 ?? ""),
      state: String(format.PoliticalDivision1 ?? ""),
      zipCode: String(format.PostcodePrimaryLow ?? ""),
      countryCode: String(format.CountryCode ?? ""),
      classification:
        candidate.AddressClassification?.Description ??
        xav.AddressClassification?.Description ??
        "",
      ZIPPlus4: String(format.PostcodeExtendedLow ?? ""),
    };
  });
  return { carrier: "ups", valid, response: data, candidates };
}

/** UPS CIE sandbox base URL (UPS docs: SANDBOX_BASE_URL). */
const UPS_SANDBOX_BASE_URL = "https://wwwcie.ups.com/";

export async function createShipment(
  shipment: ShipmentRequest,
  cfg?: UpsCredentialOverride,
): Promise<CarrierLabel[]> {
  const resolved = effectiveConfig(cfg);
  // Label generation always targets the sandbox host on a sandbox deployment:
  // sandbox-issued credentials only authorize against CIE, so a tliLocation
  // upsBaseURL override (stale or pointing elsewhere) must never reroute the
  // label create. Token + ship both resolve from this config.
  const config: UpsConfig = resolved.useSandbox
    ? { ...resolved, baseUrl: UPS_SANDBOX_BASE_URL }
    : resolved;
  const payload = {
    ShipmentRequest: {
      // BC parity (shippingCreateController.php): nonvalidate — CIE/sandbox
      // and manual-entry addresses regularly fail UPS address validation,
      // and BC never asked UPS to validate.
      Request: { RequestOption: "nonvalidate" },
      Shipment: {
        Shipper: {
          Name:
            shipment.from.companyName ?? shipment.from.contactName ?? "Shipper",
          AttentionName: shipment.from.contactName ?? "Shipper",
          Phone: { Number: shipment.from.contactPhone ?? "0000000000" },
          // Laravel parity sends carrier_account_no here, but that field is
          // resolved for the BC shipment's agent carrier and can carry
          // another carrier's number when the form's carrier differs —
          // UPS rejects it with 120100. config.accountNumber (tliLocation
          // upsAccount → env) is always this shipper's own account.
          ShipperNumber: config.accountNumber,
          Address: {
            AddressLine: [
              shipment.from.addressLine1,
              shipment.from.addressLine2,
            ].filter(
              (line): line is string =>
                typeof line === "string" && line.length > 0,
            ),
            City: shipment.from.city,
            StateProvinceCode: shipment.from.state,
            PostalCode: shipment.from.zipCode,
            CountryCode: shipment.from.countryCode,
          },
        },
        ShipTo: {
          Name:
            shipment.to.companyName ?? shipment.to.contactName ?? "Recipient",
          AttentionName: shipment.to.contactName ?? "Recipient",
          Phone: { Number: shipment.to.contactPhone ?? "0000000000" },
          Address: {
            AddressLine: [
              shipment.to.addressLine1,
              shipment.to.addressLine2,
            ].filter(
              (line): line is string =>
                typeof line === "string" && line.length > 0,
            ),
            City: shipment.to.city,
            StateProvinceCode: shipment.to.state,
            PostalCode: shipment.to.zipCode,
            CountryCode: shipment.to.countryCode,
          },
        },
        Service: { Code: shipment.serviceType },
        // UPS requires exactly one billing option (legacy parity:
        // PaymentInformation.ShipmentCharge with BillShipper or BillReceiver).
        ...(shipment.billTransportationTo === "RECEIVER"
          ? {
              PaymentInformation: {
                ShipmentCharge: {
                  Type: "01",
                  // Sender account only — the body's account_no is a
                  // customer/receiver value unlinked to these credentials;
                  // every account slot carries the shipper's own number.
                  BillReceiver: {
                    AccountNumber: config.accountNumber,
                    Address: { PostalCode: shipment.to.zipCode },
                  },
                },
              },
            }
          : {
              PaymentInformation: {
                ShipmentCharge: {
                  Type: "01",
                  // Shipper-billed charges must bill the account linked to
                  // these credentials — see Shipper.ShipperNumber above.
                  BillShipper: {
                    AccountNumber: config.accountNumber,
                  },
                },
              },
            }),
        Package: shipment.packages.map((pkg) => ({
          Packaging: { Code: "02" },
          ...(pkg.length !== undefined &&
          pkg.width !== undefined &&
          pkg.height !== undefined
            ? {
                Dimensions: {
                  UnitOfMeasurement: { Code: "IN" },
                  Length: String(pkg.length),
                  Width: String(pkg.width),
                  Height: String(pkg.height),
                },
              }
            : {}),
          ...(Number(pkg.insuredValue ?? 0) > 0
            ? {
                PackageServiceOptions: {
                  DeclaredValue: {
                    Code: "01",
                    Description: "Declared Value",
                    CurrencyCode: "USD",
                    MonetaryValue: String(pkg.insuredValue),
                  },
                },
              }
            : {}),
          PackageWeight: {
            UnitOfMeasurement: { Code: "LBS" },
            Weight: String(pkg.weight),
          },
        })),
      },
      LabelSpecification: buildUpsLabelSpecification(shipment),
    },
  };
  const data = await request<UpsShipResponse>(
    config,
    "POST",
    "api/shipments/v2409/ship",
    { body: payload, timeoutMs: CARRIER_SHIPMENT_TIMEOUT_MS },
  );
  // UPS returns PackageResults as a single object OR an array (live-probed:
  // array for multi-piece, object sometimes for single-piece).
  const rawResults = data.ShipmentResponse?.ShipmentResults?.PackageResults;
  const packageResults = Array.isArray(rawResults) ? rawResults : [rawResults];
  const labels = packageResults
    .filter((result): result is NonNullable<typeof result> => result != null)
    .map((result, index) => {
      const graphicImage = result.ShippingLabel?.GraphicImage;
      if (!graphicImage) {
        // Loud failure: a create that returns no printable label bytes is a
        // broken shipment — surfacing it as "" would store an empty label
        // and show a blank preview with no actionable signal.
        throw new CarrierApiError({
          status: 502,
          message:
            `UPS create returned no label image for package ${index + 1}` +
            (result.TrackingNumber
              ? ` (tracking ${result.TrackingNumber})`
              : ""),
        });
      }
      return {
        carrier: "ups" as const,
        trackingNumber: result.TrackingNumber ?? "UNKNOWN",
        labelData: graphicImage,
        format: shipment.labelFormat,
      };
    });
  return labels;
}

/**
 * BC parity (shippingCreateController.php LabelSpecification):
 * - ZPL requests ask for ZPL bytes on the BC-mapped inch stock
 *   ("4 X 6" -> H6/W4, "8/5 X 11" -> H11/W8.5).
 * - PDF requests send LabelImageFormat only, no LabelStockSize: the BC
 *   #10-envelope stock value (297/210 millimetres — a BC bug) rendered a
 *   21-ft-page PDF, and omitting stock yields UPS's default label stock
 *   (verified live 2026-10-01, all sizes consistent 612x792pt).
 * - "4 X 675" and unknown sizes fall to the UPS default stock, matching
 *   the BC size map (no 4x6.75 entry).
 */
function buildUpsLabelSpecification(shipment: ShipmentRequest): {
  LabelImageFormat: { Code: string };
  LabelStockSize?: { Height: string; Width: string };
} {
  if (shipment.labelFormat !== "ZPL") {
    return { LabelImageFormat: { Code: "PDF" } };
  }
  const stockBySize: Record<string, { Height: string; Width: string }> = {
    "4 X 6": { Height: "6", Width: "4" },
    "8/5 X 11": { Height: "11", Width: "8.5" },
  };
  const stock = shipment.labelSize
    ? stockBySize[shipment.labelSize]
    : undefined;
  return {
    LabelImageFormat: { Code: "ZPL" },
    ...(stock ? { LabelStockSize: stock } : {}),
  };
}

export async function voidShipment(
  trackingNumber: string,
  cfg?: UpsCredentialOverride,
): Promise<VoidShipmentResult> {
  const config = effectiveConfig(cfg);
  // Legacy parity (shippingVoidLabelController.php): the void id rides the
  // PATH, not a query parameter.
  const data = await request<unknown>(
    config,
    "DELETE",
    `api/shipments/v2409/void/cancel/${trackingNumber}`,
  );
  return { carrier: "ups", voided: true, trackingNumber, response: data };
}

export async function track(
  trackingNumber: string,
  cfg?: UpsCredentialOverride,
): Promise<TrackingInfo> {
  const config = effectiveConfig(cfg);
  const data = await request<UpsTrackResponse>(
    config,
    "GET",
    "api/track/v1/details",
    {
      query: { trackingNumber },
      timeoutMs: CARRIER_DEFAULT_TIMEOUT_MS,
    },
  );
  const shipment = data.trackResponse?.shipment?.[0];
  const pkg = shipment?.package?.[0];
  const status = pkg?.currentStatus?.description ?? "UNKNOWN";
  const events = (pkg?.activity ?? []).map((activity) => {
    const dateText = activity.date;
    const timeText = activity.time ?? "00:00:00";
    return {
      timestamp: dateText
        ? `${dateText}T${timeText}`
        : new Date().toISOString(),
      status: activity.status?.description ?? "UNKNOWN",
      location: activity.location?.address?.city,
    };
  });
  return { carrier: "ups", trackingNumber, status, events };
}

// Verbatim port of shipping-cli ups schedule_pickup: POST
// api/pickupcreation/v1/pickup with PickupCreationRequest (RatePickupIndicator
// "N", Shipper.Account.AccountNumber, PickupDateInfo CloseTime "170000" +
// PickupDate as YYYYMMDD — the CLI's strftime("%Y%m%d") of the ISO date); the
// time window is hardcoded "09:00-17:00" in the CLI reference.
export async function schedulePickup(
  pickupDate: string,
  cfg?: UpsCredentialOverride,
): Promise<PickupResult> {
  const config = effectiveConfig(cfg);
  const payload = {
    PickupCreationRequest: {
      RatePickupIndicator: "N",
      Shipper: { Account: { AccountNumber: config.accountNumber } },
      PickupDateInfo: {
        CloseTime: "170000",
        PickupDate: pickupDate.replaceAll("-", ""),
      },
    },
  };
  const data = await request<{ PickupCreationResponse?: { PRN?: string } }>(
    config,
    "POST",
    "api/pickupcreation/v1/pickup",
    { body: payload, timeoutMs: CARRIER_DEFAULT_TIMEOUT_MS },
  );
  return {
    carrier: "ups",
    confirmationNumber: data.PickupCreationResponse?.PRN ?? "UNKNOWN",
    date: pickupDate,
    timeWindow: "09:00-17:00",
  };
}

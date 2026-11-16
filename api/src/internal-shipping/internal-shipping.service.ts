/**
 * Internal shipping seam service — calls the carriers module directly
 * (env-resolved credentials, no LogisticsSession / Business Central reads),
 * and returns sanitized DTOs only.
 *
 * Historical plan: docs/original-implementation-plan.md §4 Decision 1 / Session-BC
 * strategy — the seam must NOT call shipping.service.createShipment (which
 * requires a LogisticsSession and BC reads); it calls carrier.service clients
 * directly with per-field env fallback credentials (CARRIER_ENV_CREDENTIALS
 * path).
 */
import {
  CarrierApiError,
  CarrierAuthError,
  CarrierConfigError,
  CarrierRateLimitError,
  CarrierUnavailableError,
  CarrierValidationError,
} from "../carriers/carrier-errors";
import * as carrierService from "../carriers/carrier.service";
import type {
  Carrier,
  CarrierAddress,
  CarrierLabel,
  CarrierPackage,
  RateQuote,
  ShipmentPickup,
} from "../carriers/carrier-types";
import type {
  InternalCreateShipmentRequest,
  InternalRateQuote,
  InternalRateQuoteRequest,
  InternalServiceCatalogEntry,
  InternalShipmentLabel,
} from "./internal-shipping.types";

/** Static per-carrier service-type catalog — NOT BC lookups (plan §4).
 * Env-overridable via SLG_INTERNAL_API_SERVICE_CATALOG_<CARRIER> (JSON array
 * of {code, description}). */
const DEFAULT_SERVICE_CATALOG: Record<Carrier, InternalServiceCatalogEntry[]> =
  {
    fedex: [
      { code: "FEDEX_GROUND", description: "FedEx Ground" },
      { code: "FEDEX_2_DAY", description: "FedEx 2Day" },
      { code: "FEDEX_2_DAY_AM", description: "FedEx 2Day AM" },
      { code: "FEDEX_EXPRESS_SAVER", description: "FedEx Express Saver" },
      { code: "STANDARD_OVERNIGHT", description: "FedEx Standard Overnight" },
      { code: "PRIORITY_OVERNIGHT", description: "FedEx Priority Overnight" },
      { code: "FIRST_OVERNIGHT", description: "FedEx First Overnight" },
    ],
    ups: [
      { code: "03", description: "UPS Ground" },
      { code: "12", description: "UPS 3 Day Select" },
      { code: "02", description: "UPS 2nd Day Air" },
      { code: "59", description: "UPS 2nd Day Air AM" },
      { code: "01", description: "UPS Next Day Air" },
      { code: "13", description: "UPS Next Day Air Saver" },
      { code: "14", description: "UPS Next Day Air Early" },
    ],
    usps: [
      { code: "USPS_GROUND_ADVANTAGE", description: "USPS Ground Advantage" },
      { code: "PRIORITY_MAIL", description: "USPS Priority Mail" },
      {
        code: "PRIORITY_MAIL_EXPRESS",
        description: "USPS Priority Mail Express",
      },
      { code: "MEDIA_MAIL", description: "USPS Media Mail" },
    ],
    stamps: [
      {
        code: "USPS_GROUND_ADVANTAGE",
        description: "Stamps.com Ground Advantage",
      },
      { code: "PRIORITY_MAIL", description: "Stamps.com Priority Mail" },
      {
        code: "PRIORITY_MAIL_EXPRESS",
        description: "Stamps.com Priority Mail Express",
      },
      { code: "MEDIA_MAIL", description: "Stamps.com Media Mail" },
    ],
  };

function envServiceCatalog(
  carrier: Carrier,
): InternalServiceCatalogEntry[] | undefined {
  const raw =
    process.env[`SLG_INTERNAL_API_SERVICE_CATALOG_${carrier.toUpperCase()}`];
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const entries: InternalServiceCatalogEntry[] = [];
    for (const entry of parsed) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as { code?: unknown }).code === "string" &&
        typeof (entry as { description?: unknown }).description === "string"
      ) {
        entries.push({
          code: (entry as { code: string }).code,
          description: (entry as { description: string }).description,
        });
      }
    }
    return entries.length ? entries : undefined;
  } catch {
    return undefined;
  }
}

export function serviceCatalog(
  carrier: Carrier,
): InternalServiceCatalogEntry[] {
  return envServiceCatalog(carrier) ?? DEFAULT_SERVICE_CATALOG[carrier];
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

function sanitizeRateQuote(quote: RateQuote): InternalRateQuote {
  const sanitized: InternalRateQuote = {
    carrier: quote.carrier,
    service: quote.service,
    cost: quote.cost,
    currency: quote.currency,
  };
  if (typeof quote.serviceDescription === "string") {
    sanitized.serviceDescription = quote.serviceDescription;
  }
  if (typeof quote.deliveryDays === "string") {
    sanitized.deliveryDays = quote.deliveryDays;
  }
  if (typeof quote.deliveryDate === "string") {
    sanitized.deliveryDate = quote.deliveryDate;
  }
  if (quote.rateType === "ACCOUNT" || quote.rateType === "LIST") {
    sanitized.rateType = quote.rateType;
  }
  if (typeof quote.packagingType === "string") {
    sanitized.packagingType = quote.packagingType;
  }
  if (typeof quote.sku === "string") {
    sanitized.sku = quote.sku;
  }
  if (typeof quote.priceType === "string") {
    sanitized.priceType = quote.priceType;
  }
  return sanitized;
}

function sanitizeLabel(label: CarrierLabel): InternalShipmentLabel {
  const sanitized: InternalShipmentLabel = {
    carrier: label.carrier,
    trackingNumber: label.trackingNumber,
    labelData: label.labelData,
    format: label.format,
  };
  if (typeof label.cost === "number" && Number.isFinite(label.cost)) {
    sanitized.cost = label.cost;
  }
  // `environment` is intentionally omitted — internal deployment detail.
  return sanitized;
}

// ---------------------------------------------------------------------------
// DTO validation
// ---------------------------------------------------------------------------

const MAX_PACKAGES = 25;
const MAX_PACKAGE_WEIGHT_LB = 150;
const MAX_INSURED_VALUE = 50_000;
const MAX_STRING_LENGTH = 200;
const MAX_PACKAGES_COUNT = MAX_PACKAGES;

function isCarrier(value: unknown): value is Carrier {
  return (
    value === "fedex" ||
    value === "ups" ||
    value === "usps" ||
    value === "stamps"
  );
}

function boundedString(
  value: unknown,
  field: string,
  errors: string[],
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    errors.push(`${field} must be a string`);
    return undefined;
  }
  if (value.length > MAX_STRING_LENGTH) {
    errors.push(`${field} exceeds ${MAX_STRING_LENGTH} characters`);
    return undefined;
  }
  return value;
}

function validateAddress(
  address: unknown,
  field: string,
  errors: string[],
): CarrierAddress | null {
  if (!address || typeof address !== "object") {
    errors.push(`${field} is required`);
    return null;
  }
  const record = address as Record<string, unknown>;
  const addressLine1 = boundedString(
    record.addressLine1,
    `${field}.addressLine1`,
    errors,
  );
  if (!addressLine1) {
    errors.push(`${field}.addressLine1 is required`);
  }
  const city = boundedString(record.city, `${field}.city`, errors);
  if (!city) errors.push(`${field}.city is required`);
  const state = boundedString(record.state, `${field}.state`, errors);
  if (!state) errors.push(`${field}.state is required`);
  const zipCode = boundedString(record.zipCode, `${field}.zipCode`, errors);
  if (!zipCode) errors.push(`${field}.zipCode is required`);
  const countryCode =
    boundedString(record.countryCode, `${field}.countryCode`, errors) ?? "US";
  if (errors.length) return null;
  const validated: CarrierAddress = {
    addressLine1: addressLine1!,
    city: city!,
    state: state!,
    zipCode: zipCode!,
    countryCode,
  };
  const optional = [
    "addressLine2",
    "contactName",
    "contactPhone",
    "companyName",
    "contactEmail",
  ] as const;
  for (const key of optional) {
    const value = boundedString(record[key], `${field}.${key}`, errors);
    if (value !== undefined) validated[key] = value;
  }
  return validated;
}

function validatePackages(
  packages: unknown,
  errors: string[],
): CarrierPackage[] | null {
  if (!Array.isArray(packages) || packages.length === 0) {
    errors.push("packages must be a non-empty array");
    return null;
  }
  if (packages.length > MAX_PACKAGES_COUNT) {
    errors.push(`packages exceeds the maximum of ${MAX_PACKAGES}`);
    return null;
  }
  const validated: CarrierPackage[] = [];
  packages.forEach((entry, index) => {
    const prefix = `packages[${index}]`;
    if (!entry || typeof entry !== "object") {
      errors.push(`${prefix} must be an object`);
      return;
    }
    const record = entry as Record<string, unknown>;
    const weight = Number(record.weight);
    if (!Number.isFinite(weight) || weight <= 0) {
      errors.push(`${prefix}.weight must be a positive number`);
      return;
    }
    if (weight > MAX_PACKAGE_WEIGHT_LB) {
      errors.push(`${prefix}.weight exceeds ${MAX_PACKAGE_WEIGHT_LB} lb`);
      return;
    }
    const pkg: CarrierPackage = { weight };
    for (const dim of ["length", "width", "height"] as const) {
      const value = Number(record[dim]);
      if (
        record[dim] === undefined ||
        record[dim] === null ||
        record[dim] === ""
      ) {
        continue;
      }
      if (!Number.isFinite(value) || value <= 0) {
        errors.push(`${prefix}.${dim} must be a positive number`);
        return;
      }
      pkg[dim] = value;
    }
    if (
      record.insuredValue !== undefined &&
      record.insuredValue !== null &&
      record.insuredValue !== ""
    ) {
      const insured = Number(record.insuredValue);
      if (!Number.isFinite(insured) || insured < 0) {
        errors.push(`${prefix}.insuredValue must be a non-negative number`);
        return;
      }
      if (insured > MAX_INSURED_VALUE) {
        errors.push(`${prefix}.insuredValue exceeds ${MAX_INSURED_VALUE}`);
        return;
      }
      pkg.insuredValue = insured;
    }
    validated.push(pkg);
  });
  if (errors.length) return null;
  return validated;
}

export interface DtoValidationResult<T> {
  ok: boolean;
  errors: string[];
  value?: T;
}

export function validateRateQuoteRequest(
  body: unknown,
): DtoValidationResult<InternalRateQuoteRequest> {
  const errors: string[] = [];
  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (record.carrier !== "all" && !isCarrier(record.carrier)) {
    errors.push("carrier must be one of fedex|ups|usps|stamps|all");
  }
  const from = validateAddress(record.from, "from", errors);
  const to = validateAddress(record.to, "to", errors);
  const packages = validatePackages(record.packages, errors);
  const shipDate = boundedString(record.shipDate, "shipDate", errors);
  const serviceType = boundedString(record.serviceType, "serviceType", errors);
  const packagingType = boundedString(
    record.packagingType,
    "packagingType",
    errors,
  );
  const preferredRateType =
    record.preferredRateType === "ACCOUNT" ||
    record.preferredRateType === "LIST"
      ? record.preferredRateType
      : undefined;
  if (
    record.preferredRateType !== undefined &&
    preferredRateType === undefined
  ) {
    errors.push("preferredRateType must be ACCOUNT or LIST");
  }
  const strictRateType = record.strictRateType === true ? true : undefined;
  if (errors.length || !from || !to || !packages) {
    return { ok: false, errors, value: undefined };
  }
  return {
    ok: true,
    errors,
    value: {
      carrier: record.carrier as Carrier | "all",
      from,
      to,
      packages,
      ...(shipDate ? { shipDate } : {}),
      ...(serviceType ? { serviceType } : {}),
      ...(packagingType ? { packagingType } : {}),
      ...(preferredRateType ? { preferredRateType } : {}),
      ...(strictRateType ? { strictRateType } : {}),
    },
  };
}

export function validateCreateShipmentRequest(
  body: unknown,
): DtoValidationResult<InternalCreateShipmentRequest> {
  const errors: string[] = [];
  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (!isCarrier(record.carrier)) {
    errors.push("carrier must be one of fedex|ups|usps|stamps");
  }
  const serviceType = boundedString(record.serviceType, "serviceType", errors);
  if (!serviceType) {
    errors.push(
      "serviceType is required (explicit service code, not BC-resolved)",
    );
  }
  const from = validateAddress(record.from, "from", errors);
  const to = validateAddress(record.to, "to", errors);
  const packages = validatePackages(record.packages, errors);
  const shipDate = boundedString(record.shipDate, "shipDate", errors);
  const labelFormat =
    record.labelFormat === "PDF" || record.labelFormat === "ZPL"
      ? record.labelFormat
      : undefined;
  if (record.labelFormat !== undefined && labelFormat === undefined) {
    errors.push("labelFormat must be PDF or ZPL");
  }
  const billTransportationTo =
    record.billTransportationTo === "SENDER" ||
    record.billTransportationTo === "RECEIVER"
      ? record.billTransportationTo
      : undefined;
  if (
    record.billTransportationTo !== undefined &&
    billTransportationTo === undefined
  ) {
    errors.push("billTransportationTo must be SENDER or RECEIVER");
  }
  if (
    billTransportationTo === "RECEIVER" &&
    !boundedStringCheck(record.payorAccountNumber)
  ) {
    errors.push(
      "payorAccountNumber is required when billTransportationTo is RECEIVER",
    );
  }
  const payorAccountNumber = boundedString(
    record.payorAccountNumber,
    "payorAccountNumber",
    errors,
  );
  const accountNumber = boundedString(
    record.accountNumber,
    "accountNumber",
    errors,
  );
  const packagingType = boundedString(
    record.packagingType,
    "packagingType",
    errors,
  );
  const yourReference = boundedString(
    record.yourReference,
    "yourReference",
    errors,
  );
  const poNo = boundedString(record.poNo, "poNo", errors);
  const invoiceNo = boundedString(record.invoiceNo, "invoiceNo", errors);
  const department = boundedString(record.department, "department", errors);
  const customerReference = boundedString(
    record.customerReference,
    "customerReference",
    errors,
  );
  const declaredValue = Number(record.declaredValue);
  if (
    record.declaredValue !== undefined &&
    record.declaredValue !== null &&
    (!Number.isFinite(declaredValue) || declaredValue < 0)
  ) {
    errors.push("declaredValue must be a non-negative number");
  }
  if (errors.length || !from || !to || !packages || !serviceType) {
    return { ok: false, errors, value: undefined };
  }
  return {
    ok: true,
    errors,
    value: {
      carrier: record.carrier as Carrier,
      serviceType,
      from,
      to,
      packages,
      ...(shipDate ? { shipDate } : {}),
      ...(labelFormat ? { labelFormat } : {}),
      ...(billTransportationTo ? { billTransportationTo } : {}),
      ...(payorAccountNumber ? { payorAccountNumber } : {}),
      ...(accountNumber ? { accountNumber } : {}),
      ...(packagingType ? { packagingType } : {}),
      ...(yourReference ? { yourReference } : {}),
      ...(poNo ? { poNo } : {}),
      ...(invoiceNo ? { invoiceNo } : {}),
      ...(department ? { department } : {}),
      ...(customerReference ? { customerReference } : {}),
      ...(Number.isFinite(declaredValue) &&
      record.declaredValue !== undefined &&
      record.declaredValue !== null
        ? { declaredValue }
        : {}),
    },
  };
}

function boundedStringCheck(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_STRING_LENGTH
  );
}

// ---------------------------------------------------------------------------
// Seam operations — direct carrier.service calls, env credentials only
// ---------------------------------------------------------------------------

export async function rateQuote(
  request: InternalRateQuoteRequest,
): Promise<InternalRateQuote[]> {
  const quotes = await carrierService.rateShop(request.carrier, {
    fromZip: request.from.zipCode,
    toZip: request.to.zipCode,
    packages: request.packages,
    fromAddress: request.from,
    toAddress: request.to,
    ...(request.shipDate ? { shipDate: request.shipDate } : {}),
    ...(request.serviceType ? { serviceType: request.serviceType } : {}),
    ...(request.packagingType ? { packagingType: request.packagingType } : {}),
    ...(request.preferredRateType
      ? { preferredRateType: request.preferredRateType }
      : {}),
    ...(request.strictRateType
      ? { strictRateType: request.strictRateType }
      : {}),
    // Env-resolved credentials only — no cfg override (Decision 1: seam must
    // not read BC / LogisticsSession; carrier clients fall back per-field to
    // process.env when cfg is undefined).
  });
  return quotes.map(sanitizeRateQuote);
}

export async function createShipment(
  request: InternalCreateShipmentRequest,
): Promise<InternalShipmentLabel[]> {
  const labels = await carrierService.createShipment(
    request.carrier,
    {
      from: request.from,
      to: request.to,
      packages: request.packages,
      serviceType: request.serviceType,
      labelFormat: request.labelFormat ?? "PDF",
      ...(request.shipDate ? { shipDate: request.shipDate } : {}),
      ...(request.billTransportationTo
        ? { billTransportationTo: request.billTransportationTo }
        : {}),
      ...(request.payorAccountNumber
        ? { payorAccountNumber: request.payorAccountNumber }
        : {}),
      ...(request.accountNumber
        ? { accountNumber: request.accountNumber }
        : {}),
      ...(request.packagingType
        ? { packagingType: request.packagingType }
        : {}),
      ...(request.pickup ? { pickup: request.pickup } : {}),
      ...(request.yourReference
        ? { yourReference: request.yourReference }
        : {}),
      ...(request.poNo ? { poNo: request.poNo } : {}),
      ...(request.invoiceNo ? { invoiceNo: request.invoiceNo } : {}),
      ...(request.department ? { department: request.department } : {}),
      ...(request.customerReference
        ? { customerReference: request.customerReference }
        : {}),
      ...(request.declaredValue !== undefined
        ? { declaredValue: request.declaredValue }
        : {}),
    },
    // Env-resolved credentials only (Decision 1).
  );
  return labels.map(sanitizeLabel);
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

export type SeamErrorStatus = 400 | 402 | 403 | 429 | 500 | 502 | 503;

export class SeamError extends Error {
  readonly status: SeamErrorStatus;
  readonly code: string;

  constructor(status: SeamErrorStatus, code: string, message: string) {
    super(message);
    this.name = "SeamError";
    this.status = status;
    this.code = code;
  }
}

export function mapCarrierError(error: unknown): SeamError {
  if (error instanceof CarrierConfigError) {
    return new SeamError(
      503,
      "CARRIER_NOT_CONFIGURED",
      "Carrier is not configured",
    );
  }
  if (error instanceof CarrierValidationError) {
    return new SeamError(400, "CARRIER_VALIDATION_ERROR", error.message);
  }
  if (error instanceof CarrierRateLimitError) {
    return new SeamError(
      429,
      "CARRIER_RATE_LIMITED",
      "Carrier rate limit exceeded",
    );
  }
  if (error instanceof CarrierAuthError) {
    return new SeamError(
      502,
      "CARRIER_AUTH_FAILED",
      "Carrier authentication failed",
    );
  }
  if (error instanceof CarrierApiError) {
    const status: SeamErrorStatus =
      error.status === 400 || error.status === 402 || error.status === 403
        ? error.status
        : 502;
    return new SeamError(status, "CARRIER_API_ERROR", error.message);
  }
  if (error instanceof CarrierUnavailableError) {
    return new SeamError(503, "CARRIER_UNAVAILABLE", "Carrier is unavailable");
  }
  return new SeamError(502, "CARRIER_ERROR", "Carrier request failed");
}

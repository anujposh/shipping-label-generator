/**
 * Internal shipping seam DTOs — strict validation + sanitized outputs.
 *
 * The seam (routes/internal-shipping.routes.ts) is consumed by the isolated
 * shipping-label-generator api service over the LAN. Every request field is
 * validated and length-capped here before it is mapped onto the carrier-native
 * inputs (RateShopArgs / ShipmentRequest), and every response is rebuilt from
 * a field whitelist so raw carrier payloads never reach the caller.
 *
 * Deliberately stateless w.r.t. sessions and Business Central: no
 * LogisticsSession, no tliLocations read, no tliShippingAgentServices service
 * lookup. Service codes are supplied explicitly by the caller (see the static
 * per-carrier catalog in services/service-catalog.ts) and carrier credentials
 * resolve per-field from process.env inside the carrier clients.
 */

import type {
  Carrier,
  CarrierAddress,
  CarrierPackage,
  CustomsDetails,
  CustomsItem,
  CustomsMoney,
  LabelFormat,
  RateShopArgs,
  ShipmentDocument,
  ShipmentPickup,
  ShipmentRequest,
} from "../carriers/carrier-types";
import {
  buildDutyTaxEstimateRequest,
  validateCustomsDetails,
  type FieldError,
} from "../carriers/customs";

/** Carrier ids accepted on the seam. "all" is rate-quote-only fan-out. */
export const SEAM_CARRIERS = ["fedex", "ups", "usps", "stamps"] as const;
export type SeamCarrier = (typeof SEAM_CARRIERS)[number];

export function isSeamCarrier(value: string): value is SeamCarrier {
  return (SEAM_CARRIERS as readonly string[]).includes(value);
}

/** Request sanity caps (mirrors the §5 "package-count/value sanity caps"). */
export const SEAM_LIMITS = {
  maxPackages: 20,
  minWeightLbs: 0.01,
  maxWeightLbs: 500,
  minDimensionIn: 0.1,
  maxDimensionIn: 120,
  maxInsuredValueUsd: 50_000,
  maxCustomsUnitPriceUsd: 100_000,
  maxCustomsQuantity: 1_000,
  maxStringChars: 100,
  maxCityChars: 60,
  maxStateChars: 40,
  maxZipChars: 12,
  maxPhoneChars: 20,
  maxEmailChars: 120,
  maxCodeChars: 50,
  maxReferenceChars: 50,
  maxLabelSizeChars: 20,
} as const;

export type SanitizeResult<T> =
  { ok: true; value: T } | { ok: false; error: string; details?: FieldError[] };

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Carrier service/packaging codes: alphanumeric plus separator characters. */
const CODE_RE = /^[A-Za-z0-9 _.\-/]{1,50}$/;
const ZIP_RE = /^[A-Za-z0-9][A-Za-z0-9\- ]{1,11}$/;
const PHONE_RE = /^[0-9+\-() .]{1,20}$/;

function fail(
  error: string,
  details?: FieldError[],
): { ok: false; error: string; details?: FieldError[] } {
  return { ok: false, error, ...(details ? { details } : {}) };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function cleanString(
  value: unknown,
  field: string,
  max: number,
): SanitizeResult<string> {
  if (typeof value !== "string") return fail(`${field} must be a string`);
  const cleaned = value.replace(CONTROL_CHARS, " ").trim();
  if (!cleaned) return fail(`${field} must not be empty`);
  if (cleaned.length > max)
    return fail(`${field} must be at most ${max} characters`);
  return { ok: true, value: cleaned };
}

/** Optional string: absent/empty drops to undefined; present must be valid. */
function optionalString(
  value: unknown,
  field: string,
  max: number,
): SanitizeResult<string | undefined> {
  if (value === undefined || value === null)
    return { ok: true, value: undefined };
  if (typeof value !== "string") return fail(`${field} must be a string`);
  const cleaned = value.replace(CONTROL_CHARS, " ").trim();
  if (!cleaned) return { ok: true, value: undefined };
  if (cleaned.length > max)
    return fail(`${field} must be at most ${max} characters`);
  return { ok: true, value: cleaned };
}

function optionalNumber(
  value: unknown,
  field: string,
  min: number,
  max: number,
): SanitizeResult<number | undefined> {
  if (value === undefined || value === null)
    return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isFinite(value))
    return fail(`${field} must be a number`);
  if (value < min || value > max)
    return fail(`${field} must be between ${min} and ${max}`);
  return { ok: true, value: value };
}

/** Validates one address block onto the carrier-native CarrierAddress shape. */
export function sanitizeAddress(
  input: unknown,
  field: string,
): SanitizeResult<CarrierAddress> {
  const record = asRecord(input);
  if (!record) return fail(`${field} must be an object`);

  const addressLine1 = cleanString(
    record.addressLine1,
    `${field}.addressLine1`,
    SEAM_LIMITS.maxStringChars,
  );
  if (!addressLine1.ok) return addressLine1;
  const addressLine2 = optionalString(
    record.addressLine2,
    `${field}.addressLine2`,
    SEAM_LIMITS.maxStringChars,
  );
  if (!addressLine2.ok) return addressLine2;
  const city = cleanString(
    record.city,
    `${field}.city`,
    SEAM_LIMITS.maxCityChars,
  );
  if (!city.ok) return city;
  const state = cleanString(
    record.state,
    `${field}.state`,
    SEAM_LIMITS.maxStateChars,
  );
  if (!state.ok) return state;

  if (typeof record.zipCode !== "string")
    return fail(`${field}.zipCode must be a string`);
  const zipCode = record.zipCode.trim();
  if (!ZIP_RE.test(zipCode))
    return fail(`${field}.zipCode must be 2-12 letters/digits`);

  if (typeof record.countryCode !== "string")
    return fail(`${field}.countryCode must be a string`);
  const countryCode = record.countryCode.trim().toUpperCase();
  if (!/^[A-Za-z]{2}$/.test(countryCode))
    return fail(`${field}.countryCode must be a 2-letter ISO code`);

  const contactName = optionalString(
    record.contactName,
    `${field}.contactName`,
    SEAM_LIMITS.maxStringChars,
  );
  if (!contactName.ok) return contactName;
  const companyName = optionalString(
    record.companyName,
    `${field}.companyName`,
    SEAM_LIMITS.maxStringChars,
  );
  if (!companyName.ok) return companyName;
  const contactEmail = optionalString(
    record.contactEmail,
    `${field}.contactEmail`,
    SEAM_LIMITS.maxEmailChars,
  );
  if (!contactEmail.ok) return contactEmail;

  let contactPhone: string | undefined;
  if (record.contactPhone !== undefined && record.contactPhone !== null) {
    if (typeof record.contactPhone !== "string")
      return fail(`${field}.contactPhone must be a string`);
    contactPhone = record.contactPhone.trim();
    if (contactPhone && !PHONE_RE.test(contactPhone))
      return fail(
        `${field}.contactPhone must contain only digits and +()- . characters`,
      );
    if (contactPhone.length > SEAM_LIMITS.maxPhoneChars)
      return fail(`${field}.contactPhone is too long`);
    if (!contactPhone) contactPhone = undefined;
  }

  const address: CarrierAddress = {
    addressLine1: addressLine1.value,
    city: city.value,
    state: state.value,
    zipCode,
    countryCode,
  };
  if (addressLine2.value) address.addressLine2 = addressLine2.value;
  if (contactName.value) address.contactName = contactName.value;
  if (companyName.value) address.companyName = companyName.value;
  if (contactEmail.value) address.contactEmail = contactEmail.value;
  if (contactPhone) address.contactPhone = contactPhone;
  return { ok: true, value: address };
}

function sanitizePackage(
  input: unknown,
  index: number,
): SanitizeResult<CarrierPackage> {
  const field = `packages[${index}]`;
  const record = asRecord(input);
  if (!record) return fail(`${field} must be an object`);
  const weight = optionalNumber(
    record.weight,
    `${field}.weight`,
    SEAM_LIMITS.minWeightLbs,
    SEAM_LIMITS.maxWeightLbs,
  );
  if (!weight.ok) return weight;
  if (weight.value === undefined)
    return fail(`${field}.weight is required (lbs)`);
  const length = optionalNumber(
    record.length,
    `${field}.length`,
    SEAM_LIMITS.minDimensionIn,
    SEAM_LIMITS.maxDimensionIn,
  );
  if (!length.ok) return length;
  const width = optionalNumber(
    record.width,
    `${field}.width`,
    SEAM_LIMITS.minDimensionIn,
    SEAM_LIMITS.maxDimensionIn,
  );
  if (!width.ok) return width;
  const height = optionalNumber(
    record.height,
    `${field}.height`,
    SEAM_LIMITS.minDimensionIn,
    SEAM_LIMITS.maxDimensionIn,
  );
  if (!height.ok) return height;
  const insuredValue = optionalNumber(
    record.insuredValue,
    `${field}.insuredValue`,
    0,
    SEAM_LIMITS.maxInsuredValueUsd,
  );
  if (!insuredValue.ok) return insuredValue;

  const pkg: CarrierPackage = { weight: weight.value };
  if (length.value !== undefined) pkg.length = length.value;
  if (width.value !== undefined) pkg.width = width.value;
  if (height.value !== undefined) pkg.height = height.value;
  if (insuredValue.value !== undefined) pkg.insuredValue = insuredValue.value;
  return { ok: true, value: pkg };
}

function sanitizePackages(input: unknown): SanitizeResult<CarrierPackage[]> {
  if (!Array.isArray(input) || input.length === 0)
    return fail("packages must be a non-empty array");
  if (input.length > SEAM_LIMITS.maxPackages)
    return fail(
      `packages must contain at most ${SEAM_LIMITS.maxPackages} entries`,
    );
  const packages: CarrierPackage[] = [];
  for (let i = 0; i < input.length; i++) {
    const pkg = sanitizePackage(input[i], i);
    if (!pkg.ok) return pkg;
    packages.push(pkg.value);
  }
  return { ok: true, value: packages };
}

function sanitizeCode(
  value: unknown,
  field: string,
): SanitizeResult<string | undefined> {
  if (value === undefined || value === null)
    return { ok: true, value: undefined };
  if (typeof value !== "string") return fail(`${field} must be a string`);
  const cleaned = value.trim();
  if (!cleaned) return { ok: true, value: undefined };
  if (cleaned.length > SEAM_LIMITS.maxCodeChars || !CODE_RE.test(cleaned))
    return fail(`${field} must be 1-50 alphanumeric/carrier code characters`);
  return { ok: true, value: cleaned };
}

function sanitizeShipDate(value: unknown): SanitizeResult<string | undefined> {
  if (value === undefined || value === null)
    return { ok: true, value: undefined };
  if (typeof value !== "string" || !DATE_RE.test(value.trim()))
    return fail("shipDate must be an ISO date string (YYYY-MM-DD)");
  return { ok: true, value: value.trim() };
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function sanitizePickup(input: unknown): SanitizeResult<ShipmentPickup | undefined> {
  if (input === undefined || input === null)
    return { ok: true, value: undefined };
  const record = asRecord(input);
  if (!record) return fail("pickup must be an object");

  if (record.type !== "pickup" && record.type !== "dropoff")
    return fail("pickup.type must be pickup or dropoff");
  const type = record.type;

  const date = sanitizeShipDate(record.date);
  if (!date.ok) return date;
  if (type === "pickup" && date.value === undefined)
    return fail("pickup.date is required when type is pickup");

  const readyTime: string | undefined =
    typeof record.readyTime === "string" ? record.readyTime.trim() : undefined;
  if (readyTime !== undefined && !TIME_RE.test(readyTime))
    return fail("pickup.readyTime must be HH:MM 24-hour");

  const closeTime: string | undefined =
    typeof record.closeTime === "string" ? record.closeTime.trim() : undefined;
  if (closeTime !== undefined && !TIME_RE.test(closeTime))
    return fail("pickup.closeTime must be HH:MM 24-hour");

  const instructions = optionalString(
    record.instructions,
    "pickup.instructions",
    300,
  );
  if (!instructions.ok) return instructions;

  const address: SanitizeResult<CarrierAddress | undefined> =
    record.address === undefined || record.address === null
      ? { ok: true, value: undefined }
      : sanitizeAddress(record.address, "pickup.address");
  if (!address.ok) return address;

  const pickup: ShipmentPickup = { type };
  if (date.value !== undefined) pickup.date = date.value;
  if (readyTime !== undefined) pickup.readyTime = readyTime;
  if (closeTime !== undefined) pickup.closeTime = closeTime;
  if (instructions.value !== undefined) pickup.instructions = instructions.value;
  if (address.value !== undefined) pickup.address = address.value;

  return { ok: true, value: pickup };
}

function sanitizeCustomsItem(
  input: unknown,
  index: number,
): SanitizeResult<CustomsItem> {
  const field = `customsItems[${index}]`;
  const record = asRecord(input);
  if (!record) return fail(`${field} must be an object`);
  const name = cleanString(
    record.name,
    `${field}.name`,
    SEAM_LIMITS.maxStringChars,
  );
  if (!name.ok) return name;
  if (
    typeof record.quantity !== "number" ||
    !Number.isInteger(record.quantity) ||
    record.quantity < 1 ||
    record.quantity > SEAM_LIMITS.maxCustomsQuantity
  )
    return fail(
      `${field}.quantity must be an integer 1-${SEAM_LIMITS.maxCustomsQuantity}`,
    );
  const unitPrice = optionalNumber(
    record.unitPrice,
    `${field}.unitPrice`,
    0,
    SEAM_LIMITS.maxCustomsUnitPriceUsd,
  );
  if (!unitPrice.ok) return unitPrice;
  if (unitPrice.value === undefined)
    return fail(`${field}.unitPrice is required`);
  const countryOfOrigin = optionalString(
    record.countryOfOrigin,
    `${field}.countryOfOrigin`,
    2,
  );
  if (!countryOfOrigin.ok) return countryOfOrigin;

  const item: CustomsItem = {
    name: name.value,
    quantity: record.quantity,
    unitPrice: unitPrice.value,
  };
  if (countryOfOrigin.value)
    item.countryOfOrigin = countryOfOrigin.value.toUpperCase();
  return { ok: true, value: item };
}

/** Parsed POST /internal/shipping/rate-quote body. */
export interface SeamRateQuoteRequest {
  carrier: Carrier | "all";
  args: RateShopArgs;
}

export function sanitizeRateQuoteRequest(
  body: unknown,
): SanitizeResult<SeamRateQuoteRequest> {
  const record = asRecord(body);
  if (!record) return fail("request body must be a JSON object");

  if (typeof record.carrier !== "string")
    return fail("carrier must be a string");
  const carrier = record.carrier.trim().toLowerCase();
  if (carrier !== "all" && !isSeamCarrier(carrier))
    return fail("carrier must be one of fedex, ups, usps, stamps, all");

  const from = sanitizeAddress(record.from, "from");
  if (!from.ok) return from;
  const to = sanitizeAddress(record.to, "to");
  if (!to.ok) return to;
  const packages = sanitizePackages(record.packages);
  if (!packages.ok) return packages;

  const shipDate = sanitizeShipDate(record.shipDate);
  if (!shipDate.ok) return shipDate;
  const serviceType = sanitizeCode(record.serviceType, "serviceType");
  if (!serviceType.ok) return serviceType;
  const packagingType = sanitizeCode(record.packagingType, "packagingType");
  if (!packagingType.ok) return packagingType;

  let rateTypes: Array<"ACCOUNT" | "LIST"> | undefined;
  if (record.rateTypes !== undefined && record.rateTypes !== null) {
    if (
      !Array.isArray(record.rateTypes) ||
      record.rateTypes.length === 0 ||
      record.rateTypes.length > 2 ||
      !record.rateTypes.every(
        (entry) => entry === "ACCOUNT" || entry === "LIST",
      )
    )
      return fail("rateTypes must be an array containing ACCOUNT and/or LIST");
    rateTypes = record.rateTypes;
  }

  let preferredRateType: "ACCOUNT" | "LIST" | undefined;
  if (
    record.preferredRateType !== undefined &&
    record.preferredRateType !== null
  ) {
    if (
      record.preferredRateType !== "ACCOUNT" &&
      record.preferredRateType !== "LIST"
    )
      return fail("preferredRateType must be ACCOUNT or LIST");
    preferredRateType = record.preferredRateType;
  }

  let strictRateType: boolean | undefined;
  if (record.strictRateType !== undefined && record.strictRateType !== null) {
    if (typeof record.strictRateType !== "boolean")
      return fail("strictRateType must be a boolean");
    strictRateType = record.strictRateType;
  }

  const args: RateShopArgs = {
    fromZip: from.value.zipCode,
    toZip: to.value.zipCode,
    packages: packages.value,
    fromAddress: from.value,
    toAddress: to.value,
  };
  if (shipDate.value) args.shipDate = shipDate.value;
  if (serviceType.value) args.serviceType = serviceType.value;
  if (packagingType.value) args.packagingType = packagingType.value;
  if (rateTypes) args.rateTypes = rateTypes;
  if (preferredRateType) args.preferredRateType = preferredRateType;
  if (strictRateType !== undefined) args.strictRateType = strictRateType;
  return { ok: true, value: { carrier, args } };
}

/** Parsed POST /internal/shipping/create-shipment body. */
export interface SeamCreateShipmentRequest {
  carrier: Carrier;
  shipment: ShipmentRequest;
}

export function sanitizeCreateShipmentRequest(
  body: unknown,
): SanitizeResult<SeamCreateShipmentRequest> {
  const record = asRecord(body);
  if (!record) return fail("request body must be a JSON object");

  if (typeof record.carrier !== "string")
    return fail("carrier must be a string");
  const carrier = record.carrier.trim().toLowerCase();
  if (!isSeamCarrier(carrier))
    return fail("carrier must be one of fedex, ups, usps, stamps");

  const from = sanitizeAddress(record.from, "from");
  if (!from.ok) return from;
  const to = sanitizeAddress(record.to, "to");
  if (!to.ok) return to;
  const packages = sanitizePackages(record.packages);
  if (!packages.ok) return packages;

  if (typeof record.serviceType !== "string" || !record.serviceType.trim())
    return fail("serviceType is required (explicit carrier service code)");
  const serviceType = sanitizeCode(record.serviceType, "serviceType");
  if (!serviceType.ok) return serviceType;
  if (!serviceType.value)
    return fail("serviceType is required (explicit carrier service code)");

  if (record.labelFormat !== "PDF" && record.labelFormat !== "ZPL")
    return fail("labelFormat must be PDF or ZPL");

  const shipDate = sanitizeShipDate(record.shipDate);
  if (!shipDate.ok) return shipDate;
  const packagingType = sanitizeCode(record.packagingType, "packagingType");
  if (!packagingType.ok) return packagingType;
  const labelSize = optionalString(
    record.labelSize,
    "labelSize",
    SEAM_LIMITS.maxLabelSizeChars,
  );
  if (!labelSize.ok) return labelSize;
  const reference = optionalString(
    record.reference,
    "reference",
    SEAM_LIMITS.maxReferenceChars,
  );
  if (!reference.ok) return reference;

  const pickup = sanitizePickup(record.pickup);
  if (!pickup.ok) return pickup;

  let customsItems: CustomsItem[] | undefined;
  if (record.customsItems !== undefined && record.customsItems !== null) {
    if (!Array.isArray(record.customsItems) || record.customsItems.length === 0)
      return fail("customsItems must be a non-empty array when provided");
    if (record.customsItems.length > SEAM_LIMITS.maxPackages)
      return fail(
        `customsItems must contain at most ${SEAM_LIMITS.maxPackages} entries`,
      );
    customsItems = [];
    for (let i = 0; i < record.customsItems.length; i++) {
      const item = sanitizeCustomsItem(record.customsItems[i], i);
      if (!item.ok) return item;
      customsItems.push(item.value);
    }
  }

  let customs: CustomsDetails | undefined;
  if (record.customs !== undefined && record.customs !== null) {
    const packageWeightLb = packages.value.reduce(
      (sum, pkg) => sum + pkg.weight,
      0,
    );
    const validation = validateCustomsDetails(record.customs, {
      fromCountryCode: from.value.countryCode,
      toCountryCode: to.value.countryCode,
      packageWeightLb,
      carrier,
    });
    if (!validation.ok) {
      return fail("Invalid customs details", validation.errors);
    }
    customs = validation.value;
  } else if (
    carrier === "fedex" &&
    from.value.countryCode.trim().toUpperCase() !==
      to.value.countryCode.trim().toUpperCase()
  ) {
    return fail("Invalid customs details", [
      {
        field: "customs",
        message:
          "customs details are required for FedEx international shipments",
      },
    ]);
  }

  const shipment: ShipmentRequest = {
    from: from.value,
    to: to.value,
    packages: packages.value,
    serviceType: serviceType.value,
    labelFormat: record.labelFormat,
  };
  if (shipDate.value) shipment.shipDate = shipDate.value;
  if (packagingType.value) shipment.packagingType = packagingType.value;
  if (labelSize.value) shipment.labelSize = labelSize.value;
  if (reference.value) shipment.yourReference = reference.value;
  if (customsItems) shipment.customsItems = customsItems;
  if (customs) shipment.customs = customs;
  if (pickup.value) shipment.pickup = pickup.value;
  return { ok: true, value: { carrier, shipment } };
}

/** Parsed POST /internal/shipping/duty-tax-estimate body. */
export interface SeamDutyTaxEstimateRequest {
  carrier: "fedex";
  from: CarrierAddress;
  to: CarrierAddress;
  serviceType?: string;
  shippingCost?: CustomsMoney;
  customs: CustomsDetails;
}

export function sanitizeDutyTaxEstimateRequest(
  body: unknown,
): SanitizeResult<SeamDutyTaxEstimateRequest> {
  const record = asRecord(body);
  if (!record) return fail("request body must be a JSON object");

  if (record.carrier !== undefined && record.carrier !== "fedex") {
    return fail(
      "Duty & tax estimates are only available for FedEx international shipments",
      [
        {
          field: "carrier",
          message:
            "Duty & tax estimates are only available for FedEx international shipments",
        },
      ],
    );
  }
  const from = sanitizeAddress(record.from, "from");
  if (!from.ok) return from;
  const to = sanitizeAddress(record.to, "to");
  if (!to.ok) return to;
  const serviceType = sanitizeCode(record.serviceType, "serviceType");
  if (!serviceType.ok) return serviceType;

  let shippingCost: CustomsMoney | undefined;
  if (record.shippingCost !== undefined && record.shippingCost !== null) {
    const costRecord = asRecord(record.shippingCost);
    const amount = Number(costRecord?.amount);
    const currency =
      typeof costRecord?.currency === "string"
        ? costRecord.currency.trim().toUpperCase()
        : "";
    if (
      !costRecord ||
      !Number.isFinite(amount) ||
      amount < 0 ||
      !/^[A-Z]{3}$/.test(currency)
    ) {
      return fail("Invalid shippingCost", [
        {
          field: "shippingCost",
          message:
            "shippingCost must be an object {amount: non-negative number, currency: ISO 4217}",
        },
      ]);
    }
    shippingCost = { amount, currency };
  }

  if (record.customs === undefined || record.customs === null) {
    return fail("Invalid customs details", [
      { field: "customs", message: "customs is required" },
    ]);
  }
  const validation = validateCustomsDetails(record.customs, {
    fromCountryCode: from.value.countryCode,
    toCountryCode: to.value.countryCode,
    packageWeightLb: 0,
    carrier: "fedex",
  });
  if (!validation.ok) {
    return fail("Invalid customs details", validation.errors);
  }
  const estimate = buildDutyTaxEstimateRequest({
    from: from.value,
    to: to.value,
    ...(serviceType.value ? { serviceType: serviceType.value } : {}),
    ...(shippingCost ? { shippingCost } : {}),
    customs: validation.value,
  });
  if (!estimate.ok) {
    return fail("Invalid duty & tax estimate request", estimate.errors);
  }
  return {
    ok: true,
    value: {
      carrier: "fedex",
      from: from.value,
      to: to.value,
      ...(serviceType.value ? { serviceType: serviceType.value } : {}),
      ...(shippingCost ? { shippingCost } : {}),
      customs: validation.value,
    },
  };
}

// ---------------------------------------------------------------------------
// Sanitized response DTOs (field whitelists — raw carrier payloads never leak)
// ---------------------------------------------------------------------------

export interface SeamRate {
  carrier: Carrier;
  service: string;
  cost: number;
  currency: string;
  serviceDescription?: string;
  deliveryDays?: string;
  deliveryDate?: string;
  rateType?: "ACCOUNT" | "LIST";
  packagingType?: string;
  sku?: string;
  priceType?: string;
}

/** Whitelist-picks a RateQuote onto the wire DTO (drops any extra fields). */
export function sanitizeRateQuote(input: {
  carrier: Carrier;
  service: string;
  cost: number;
  currency: string;
  serviceDescription?: string;
  deliveryDays?: string;
  deliveryDate?: string;
  rateType?: "ACCOUNT" | "LIST";
  packagingType?: string;
  sku?: string;
  priceType?: string;
}): SeamRate {
  const rate: SeamRate = {
    carrier: input.carrier,
    service: input.service,
    cost: input.cost,
    currency: input.currency,
  };
  if (input.serviceDescription !== undefined)
    rate.serviceDescription = input.serviceDescription;
  if (input.deliveryDays !== undefined) rate.deliveryDays = input.deliveryDays;
  if (input.deliveryDate !== undefined) rate.deliveryDate = input.deliveryDate;
  if (input.rateType !== undefined) rate.rateType = input.rateType;
  if (input.packagingType !== undefined)
    rate.packagingType = input.packagingType;
  if (input.sku !== undefined) rate.sku = input.sku;
  if (input.priceType !== undefined) rate.priceType = input.priceType;
  return rate;
}

export interface SeamLabel {
  carrier: Carrier;
  trackingNumber: string;
  labelData: string;
  format: LabelFormat;
  environment?: "sandbox" | "production";
  cost?: number;
  documents?: ShipmentDocument[];
  documentWarnings?: string[];
}

function sanitizeShipmentDocument(input: ShipmentDocument): ShipmentDocument {
  const document: ShipmentDocument = {
    documentType: input.documentType,
    docType: input.docType,
    fileName: input.fileName,
    contentBase64: input.contentBase64,
    source: input.source,
  };
  if (input.uploadStatus !== undefined) {
    document.uploadStatus = input.uploadStatus;
  }
  return document;
}

/** Whitelist-picks a CarrierLabel onto the wire DTO (drops any extra fields). */
export function sanitizeCarrierLabel(input: {
  carrier: Carrier;
  trackingNumber: string;
  labelData: string;
  format: LabelFormat;
  environment?: "sandbox" | "production";
  cost?: number;
  documents?: ShipmentDocument[];
  documentWarnings?: string[];
}): SeamLabel {
  const label: SeamLabel = {
    carrier: input.carrier,
    trackingNumber: input.trackingNumber,
    labelData: input.labelData,
    format: input.format,
  };
  if (input.environment !== undefined) label.environment = input.environment;
  if (input.cost !== undefined) label.cost = input.cost;
  if (input.documents?.length) {
    label.documents = input.documents.map(sanitizeShipmentDocument);
  }
  if (input.documentWarnings?.length) {
    label.documentWarnings = [...input.documentWarnings];
  }
  return label;
}

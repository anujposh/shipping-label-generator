import { z } from "zod";
import type { ShipFromAddress } from "../types";

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function cleanString(value: string, max: number): string {
  const trimmed = value.replace(CONTROL_CHARS, " ").trim();
  if (trimmed.length > max) {
    throw new Error(`String exceeds maximum length of ${max}`);
  }
  return trimmed;
}

export const SEAM_LIMITS = {
  maxPackages: 20,
  minWeightLbs: 0.01,
  maxWeightLbs: 500,
  minDimensionIn: 0.1,
  maxDimensionIn: 120,
  maxInsuredValueUsd: 50_000,
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

const ZipSchema = z
  .string()
  .min(2)
  .max(SEAM_LIMITS.maxZipChars)
  .regex(/^[A-Za-z0-9][A-Za-z0-9\- ]{1,11}$/);

const CountrySchema = z
  .string()
  .length(2)
  .regex(/^[A-Za-z]{2}$/)
  .transform((v) => v.toUpperCase());

export const VendorAddressSchema = z.object({
  addressLine1: z.string().min(1).max(SEAM_LIMITS.maxStringChars),
  addressLine2: z.string().max(SEAM_LIMITS.maxStringChars).optional(),
  city: z.string().min(1).max(SEAM_LIMITS.maxCityChars),
  state: z.string().min(1).max(SEAM_LIMITS.maxStateChars),
  zipCode: ZipSchema,
  countryCode: CountrySchema.default("US"),
  contactName: z.string().max(SEAM_LIMITS.maxStringChars).optional(),
  contactPhone: z
    .string()
    .max(SEAM_LIMITS.maxPhoneChars)
    .regex(/^[0-9+\-() .]*$/, "Invalid phone number")
    .optional(),
  companyName: z.string().max(SEAM_LIMITS.maxStringChars).optional(),
  contactEmail: z.string().max(SEAM_LIMITS.maxEmailChars).email().optional(),
});

export const CUSTOMS_TAX_ID_TYPES = [
  "PERSONAL_NATIONAL",
  "PERSONAL_STATE",
  "FEDERAL",
  "BUSINESS_NATIONAL",
  "BUSINESS_STATE",
  "BUSINESS_UNION",
] as const;

/**
 * Public shared-link vendor identity contract. Every string is trimmed and
 * bounded by the existing seam limits; all fields except `addressLine2` are
 * mandatory. `countryCode` is a two-letter uppercase ISO code, `taxIds`
 * defaults to `[]` and each entry must use the official FedEx tinType enum
 * (max 18 chars, matching FedEx TaxpayerIdentification.number).
 */
export const VendorTaxIdSchema = z.object({
  number: z.string().trim().min(1).max(18),
  tinType: z.enum(CUSTOMS_TAX_ID_TYPES),
});

export const VendorDetailsSchema = z.object({
  companyName: z.string().trim().min(1).max(SEAM_LIMITS.maxStringChars),
  contactName: z.string().trim().min(1).max(SEAM_LIMITS.maxStringChars),
  contactEmail: z.string().trim().min(1).max(SEAM_LIMITS.maxEmailChars).email(),
  contactPhone: z
    .string()
    .trim()
    .min(1)
    .max(SEAM_LIMITS.maxPhoneChars)
    .regex(/^[0-9+\-() .]+$/, "Invalid phone number"),
  addressLine1: z.string().trim().min(1).max(SEAM_LIMITS.maxStringChars),
  addressLine2: z.string().trim().max(SEAM_LIMITS.maxStringChars).optional(),
  city: z.string().trim().min(1).max(SEAM_LIMITS.maxCityChars),
  state: z.string().trim().min(1).max(SEAM_LIMITS.maxStateChars),
  zipCode: ZipSchema,
  countryCode: CountrySchema,
  taxIds: z.array(VendorTaxIdSchema).max(5).default([]),
});

export const PackageSchema = z.object({
  weight: z
    .number()
    .min(SEAM_LIMITS.minWeightLbs)
    .max(SEAM_LIMITS.maxWeightLbs),
  length: z
    .number()
    .min(SEAM_LIMITS.minDimensionIn)
    .max(SEAM_LIMITS.maxDimensionIn)
    .optional(),
  width: z
    .number()
    .min(SEAM_LIMITS.minDimensionIn)
    .max(SEAM_LIMITS.maxDimensionIn)
    .optional(),
  height: z
    .number()
    .min(SEAM_LIMITS.minDimensionIn)
    .max(SEAM_LIMITS.maxDimensionIn)
    .optional(),
  insuredValue: z
    .number()
    .min(0)
    .max(SEAM_LIMITS.maxInsuredValueUsd)
    .optional(),
});

export const FEDEX_PACKAGING_TYPES = [
  "YOUR_PACKAGING",
  "FEDEX_ENVELOPE",
  "FEDEX_PAK",
  "FEDEX_BOX",
  "FEDEX_EXTRA_SMALL_BOX",
  "FEDEX_SMALL_BOX",
  "FEDEX_MEDIUM_BOX",
  "FEDEX_LARGE_BOX",
  "FEDEX_EXTRA_LARGE_BOX",
  "FEDEX_TUBE",
  "FEDEX_10KG_BOX",
  "FEDEX_25KG_BOX",
] as const;
const FedexPackagingTypeSchema = z.enum(FEDEX_PACKAGING_TYPES);

export const ShipDateSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}$/,
    "shipDate must be an ISO date string (YYYY-MM-DD)",
  );

const TimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be in 24-hour HH:MM format");

export const PickupSchema = z.object({
  type: z.enum(["pickup", "dropoff"]),
  date: ShipDateSchema.optional(),
  readyTime: TimeSchema.optional(),
  closeTime: TimeSchema.optional(),
  instructions: z.string().max(300).optional(),
  address: VendorAddressSchema.optional(),
});

export const RateRequestSchema = z.object({
  shipTo: VendorAddressSchema,
  packages: z.array(PackageSchema).min(1).max(SEAM_LIMITS.maxPackages),
  carrier: z.enum(["fedex", "ups", "usps", "stamps", "all"]).default("all"),
  serviceType: z.string().max(SEAM_LIMITS.maxCodeChars).optional(),
  packagingType: FedexPackagingTypeSchema.optional(),
  shipDate: ShipDateSchema.optional(),
  vendorDetails: VendorDetailsSchema,
});

export const ShipmentCreateSchema = z
  .object({
    shipTo: VendorAddressSchema,
    packages: z.array(PackageSchema).min(1).max(SEAM_LIMITS.maxPackages),
    carrier: z.enum(["fedex", "ups", "usps", "stamps"]),
    serviceType: z.string().min(1).max(SEAM_LIMITS.maxCodeChars),
    packagingType: FedexPackagingTypeSchema.optional(),
    labelFormat: z.enum(["PDF", "ZPL"]).default("PDF"),
    labelSize: z.string().max(SEAM_LIMITS.maxLabelSizeChars).optional(),
    reference: z.string().max(SEAM_LIMITS.maxReferenceChars).optional(),
    shipDate: ShipDateSchema.optional(),
    pickup: PickupSchema.optional(),
    // Cross-field validation (types, enums, totals, export rules) is performed
    // by validateCustomsDetails so public and seam errors share one shape.
    customs: z.unknown().optional(),
    vendorDetails: VendorDetailsSchema,
    notification: z
      .object({
        enabled: z.boolean(),
        recipientEmail: z.string().trim().max(255).email().optional(),
        shipperEmail: z.string().trim().max(255).email().optional(),
        additionalEmail: z.string().trim().max(255).email().optional(),
        personalMessage: z.string().trim().max(500).optional(),
      })
      .optional(),
  })
  .refine(
    (data) =>
      data.pickup === undefined ||
      data.pickup.type !== "pickup" ||
      typeof data.pickup.date === "string",
    {
      message: "pickup.date is required when type is pickup",
      path: ["pickup", "date"],
    },
  )
  .refine(
    (data) => {
      if (data.notification?.enabled === true) {
        return (
          (typeof data.notification.recipientEmail === "string" &&
            data.notification.recipientEmail.length > 0) ||
          (typeof data.notification.shipperEmail === "string" &&
            data.notification.shipperEmail.length > 0) ||
          (typeof data.notification.additionalEmail === "string" &&
            data.notification.additionalEmail.length > 0)
        );
      }
      return true;
    },
    {
      message:
        "provide at least one notification email when notifications are enabled",
      path: ["notification", "recipientEmail"],
    },
  );

export const DutyTaxEstimateSchema = z.object({
  shipTo: VendorAddressSchema,
  serviceType: z.string().min(1).max(SEAM_LIMITS.maxCodeChars).optional(),
  shippingCost: z
    .object({
      amount: z.number().min(0),
      currency: z
        .string()
        .length(3)
        .regex(/^[A-Za-z]{3}$/),
    })
    .optional(),
  selectedRate: z
    .object({
      service: z.string().max(SEAM_LIMITS.maxCodeChars).optional(),
      cost: z.number().min(0).optional(),
      currency: z
        .string()
        .length(3)
        .regex(/^[A-Za-z]{3}$/)
        .optional(),
    })
    .optional(),
  customs: z.unknown(),
  vendorDetails: VendorDetailsSchema,
});

export const VendorCreateSchema = z.object({
  name: z.string().min(1).max(200),
  contactEmail: z.string().email().max(255).optional(),
  notes: z.string().max(2000).optional(),
});

export const VendorUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  contactEmail: z.string().email().max(255).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

/**
 * Strict admin ship-from contract. Kept separate from the permissive shape
 * embedded in LinkCreateSchema so normalizeShipFrom still enforces required
 * name/street/city/state/zip plus the country default/max-length rules.
 */
export const ShipFromSchema = z.object({
  name: z.string().min(1).max(SEAM_LIMITS.maxStringChars),
  street: z.string().min(1).max(SEAM_LIMITS.maxStringChars),
  city: z.string().min(1).max(SEAM_LIMITS.maxCityChars),
  state: z.string().min(1).max(SEAM_LIMITS.maxStateChars),
  zip: z.string().min(1).max(SEAM_LIMITS.maxZipChars),
  country: z
    .string()
    .length(2)
    .regex(/^[A-Za-z]{2}$/)
    .default("US"),
});

/**
 * Admin-supplied ship-from shape: every legacy field is optional because the
 * admin may send none, one, or all of them. Blank browser inputs are treated as
 * omitted; country keeps its strict 2-letter validation and "US" default.
 */
const optionalLegacyField = (schema: z.ZodString) =>
  z.preprocess(
    (value) => (value === "" ? undefined : value),
    schema.optional(),
  );
const LinkShipFromSchema = ShipFromSchema.extend({
  name: optionalLegacyField(ShipFromSchema.shape.name),
  street: optionalLegacyField(ShipFromSchema.shape.street),
  city: optionalLegacyField(ShipFromSchema.shape.city),
  state: optionalLegacyField(ShipFromSchema.shape.state),
  zip: optionalLegacyField(ShipFromSchema.shape.zip),
});

/**
 * Admin link creation. Both `vendorId` and `shipFrom` are optional: omitting
 * them creates an unassigned link (vendor_id NULL, ship_from {}). When
 * `shipFrom` IS supplied, legacy fields may be partial, while supplied values
 * still honor strict max lengths and the country validation/default.
 * `bcCompanyId`/`bcCompanyName` reference a Business Central company and must
 * be supplied together (both-or-neither); the id is verified against the
 * live BC companies list when BC is configured.
 */
export const LinkCreateSchema = z
  .object({
    vendorId: z.number().int().positive().optional(),
    bcCompanyId: z.string().uuid().optional(),
    bcCompanyName: z.string().trim().min(1).max(120).optional(),
    expiresInDays: z.number().int().min(1).max(365).default(7),
    maxUses: z.number().int().min(1).max(1000).optional(),
    shipFrom: LinkShipFromSchema.optional(),
  })
  .refine(
    (data) =>
      (data.bcCompanyId === undefined) === (data.bcCompanyName === undefined),
    {
      message: "bcCompanyId and bcCompanyName must be supplied together",
      path: ["bcCompanyId"],
    },
  );

export function toSeamAddress(address: z.infer<typeof VendorAddressSchema>): {
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  zipCode: string;
  countryCode: string;
  contactName?: string;
  contactPhone?: string;
  companyName?: string;
  contactEmail?: string;
} {
  return {
    addressLine1: address.addressLine1,
    ...(address.addressLine2 && { addressLine2: address.addressLine2 }),
    city: address.city,
    state: address.state,
    zipCode: address.zipCode,
    countryCode: address.countryCode,
    ...(address.contactName && { contactName: address.contactName }),
    ...(address.contactPhone && { contactPhone: address.contactPhone }),
    ...(address.companyName && { companyName: address.companyName }),
    ...(address.contactEmail && { contactEmail: address.contactEmail }),
  };
}

export function shipFromToSeamAddress(shipFrom: ShipFromAddress): {
  addressLine1: string;
  city: string;
  state: string;
  zipCode: string;
  countryCode: string;
  companyName: string;
} {
  return {
    addressLine1: shipFrom.street,
    city: shipFrom.city,
    state: shipFrom.state,
    zipCode: shipFrom.zip,
    countryCode: (shipFrom.country ?? "US").toUpperCase(),
    companyName: shipFrom.name,
  };
}

export function normalizeShipFrom(input: unknown): ShipFromAddress {
  const parsed = ShipFromSchema.parse(input);
  return {
    name: parsed.name,
    street: parsed.street,
    city: parsed.city,
    state: parsed.state,
    zip: parsed.zip,
    country: parsed.country,
  };
}

/**
 * FedEx international customs — shared validation, wire mapping and duty/tax
 * estimate mapping.
 *
 * Field names and enums come exclusively from the official FedEx artifacts:
 *  - Ship OpenAPI (`Shipment-Resource.json`): CustomsClearanceDetail,
 *    CommercialInvoice, Commodity, Payment_1, ResponsiblePartyParty,
 *    TaxpayerIdentification, UploadDocumentReferenceDetail, ExportDetail.
 *  - ETD Upload OpenAPI (`EDUDocuments-Resource.json`):
 *    Base64MultiETDUploadRequest / MultiMetaDataRequest_1.
 *  - Estimated Duty & Tax OpenAPI (`DutiesAndTaxesAPI-Resource.json`):
 *    EdtDetailsRequestVO / EdtDetailsResponseVO.
 *
 * Nothing here performs currency conversion: every money value on a shipment
 * must already be in `customs.currency`.
 */

import type {
  CarrierAddress,
  CustomsCharges,
  CustomsCommodity,
  CustomsDetails,
  CustomsDocumentSet,
  CustomsMoney,
  CustomsParty,
  CustomsTaxId,
  CustomsUpload,
  GeneratedDocumentType,
  ShipmentRequest,
} from "./carrier-types";

/** One structured, field-addressed validation error (public/seam contract). */
export interface FieldError {
  field: string;
  message: string;
}

export interface CustomsValidationContext {
  fromCountryCode: string;
  toCountryCode: string;
  /** Total shipment weight in LB (packages are LB-native). */
  packageWeightLb: number;
  /** Carrier the customs payload is destined for. */
  carrier?: string;
}

export type CustomsValidationResult =
  { ok: true; value: CustomsDetails } | { ok: false; errors: FieldError[] };

export const CUSTOMS_LIMITS = {
  maxUploads: 5,
  maxUploadBytes: 5 * 1024 * 1024,
  maxCommodities: 50,
  maxDescriptionChars: 450,
  maxDocumentDescriptionChars: 500,
  maxInvoiceNumberChars: 30,
  maxReferenceChars: 50,
  /** FedEx TaxpayerIdentification.number max length. */
  maxTaxIdChars: 18,
  maxTermsOfSaleChars: 3,
  maxUploadNameChars: 255,
  /** Commercial invoice free-text caps (official schema is unbounded). */
  maxOriginatorNameChars: 120,
  maxDeclarationStatementChars: 500,
  maxSpecialInstructionsChars: 500,
  maxInvoiceCommentChars: 500,
  /** FedEx prints only the first two `commercialInvoice.comments` indexes. */
  maxInvoiceComments: 2,
  /** US export line threshold (USD) that requires an export statement. */
  usExportStatementLineUsd: 2500,
  /** CA export total threshold (CAD) that requires an export statement. */
  caExportStatementTotalCad: 2000,
} as const;

export const CUSTOMS_SHIPMENT_PURPOSES = [
  "COMMERCIAL",
  "GIFT",
  "SAMPLE",
  "REPAIR_AND_RETURN",
  "PERSONAL_EFFECTS",
  "NOT_COMMERCIAL",
] as const;

export const CUSTOMS_DOCUMENT_TYPES = [
  "COMMERCIAL_INVOICE",
  "PRO_FORMA_INVOICE",
  "CERTIFICATE_OF_ORIGIN",
  "USMCA_CERTIFICATION_OF_ORIGIN",
  "USMCA_COMMERCIAL_INVOICE_CERTIFICATION_OF_ORIGIN",
  "ETD_LABEL",
  "OTHER",
] as const;

export const GENERATED_DOCUMENT_TYPES = [
  "COMMERCIAL_INVOICE",
  "PRO_FORMA_INVOICE",
  "CERTIFICATE_OF_ORIGIN",
  "USMCA_CERTIFICATION_OF_ORIGIN",
  "USMCA_COMMERCIAL_INVOICE_CERTIFICATION_OF_ORIGIN",
] as const;

/** Upload MIME types accepted by the FedEx ETD document upload API. */
export const CUSTOMS_UPLOAD_CONTENT_TYPES = [
  "application/pdf",
  "application/x-soffice",
  "application/doc",
  "text/richtext",
  "text/rtf",
  "application/x-rtf",
  "application/rtf",
  "application/msword",
  "text/plain",
  "image/bmp",
  "image/png",
  "image/gif",
  "image/jpeg",
  "image/tiff",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
] as const;

/** Official FedEx `tinType` enum — `OTHER` is not accepted on the wire. */
export const CUSTOMS_TIN_TYPES = [
  "PERSONAL_NATIONAL",
  "PERSONAL_STATE",
  "FEDERAL",
  "BUSINESS_NATIONAL",
  "BUSINESS_STATE",
  "BUSINESS_UNION",
] as const;

/** Official Ship `ExportDetail.b13AFilingOption` enum. */
export const B13_FILING_OPTIONS = [
  "NOT_REQUIRED",
  "MANUALLY_ATTACHED",
  "FILED_ELECTRONICALLY",
  "SUMMARY_REPORTING",
  "FEDEX_TO_STAMP",
] as const;

/** FedEx document upload `formCode` — required for USMCA document types. */
export const USMCA_DOCUMENT_TYPES = new Set<string>([
  "USMCA_CERTIFICATION_OF_ORIGIN",
  "USMCA_COMMERCIAL_INVOICE_CERTIFICATION_OF_ORIGIN",
]);

/** Countries whose US exports require an export compliance statement. */
const US_EXPORT_STATEMENT_COUNTRIES = new Set(["CN", "RU", "VE", "HK"]);
/** CA exports to these destinations are exempt from the CA statement rule. */
const CA_EXPORT_STATEMENT_EXEMPT = new Set(["US", "PR", "VI"]);

const ISO_CURRENCY_RE = /^[A-Z]{3}$/;
const ISO_COUNTRY_RE = /^[A-Z]{2}$/;
const TERMS_RE = /^[A-Z0-9]{1,3}$/;

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Country-based international detection (same source of truth everywhere). */
export function isInternationalRoute(
  fromCountryCode: string | undefined,
  toCountryCode: string | undefined,
): boolean {
  const from = (fromCountryCode || "US").trim().toUpperCase();
  const to = (toCountryCode || "US").trim().toUpperCase();
  return from !== to;
}

export function isInternationalShipment(shipment: ShipmentRequest): boolean {
  return isInternationalRoute(
    shipment.from.countryCode,
    shipment.to.countryCode,
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function pushError(errors: FieldError[], field: string, message: string): void {
  errors.push({ field, message });
}

function asMoney(
  value: unknown,
  field: string,
  currency: string | undefined,
  errors: FieldError[],
  required: boolean,
): CustomsMoney | undefined {
  if (value === undefined || value === null) {
    if (required) pushError(errors, field, `${field} is required`);
    return undefined;
  }
  const record = asRecord(value);
  if (!record) {
    pushError(errors, field, `${field} must be an object {amount,currency}`);
    return undefined;
  }
  const amount = Number(record.amount);
  if (!Number.isFinite(amount) || amount < 0) {
    pushError(errors, field, `${field}.amount must be a non-negative number`);
    return undefined;
  }
  const moneyCurrency = clean(record.currency).toUpperCase();
  if (!ISO_CURRENCY_RE.test(moneyCurrency)) {
    pushError(
      errors,
      `${field}.currency`,
      `${field}.currency must be a 3-letter ISO 4217 code`,
    );
    return undefined;
  }
  if (currency && moneyCurrency !== currency) {
    pushError(
      errors,
      `${field}.currency`,
      `${field}.currency must equal customs.currency (${currency}); implicit FX conversion is not allowed`,
    );
    return undefined;
  }
  return { amount: roundMoney(amount), currency: moneyCurrency };
}

function asTaxIds(
  value: unknown,
  field: string,
  errors: FieldError[],
): CustomsTaxId[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    pushError(errors, field, `${field} must be a non-empty array`);
    return undefined;
  }
  const result: CustomsTaxId[] = [];
  value.forEach((entry, index) => {
    const record = asRecord(entry);
    if (!record) {
      pushError(
        errors,
        `${field}[${index}]`,
        `${field}[${index}] must be an object`,
      );
      return;
    }
    // Browser contract uses `tinType`; legacy callers may send `type`.
    const rawType = clean(record.tinType ?? record.type).toUpperCase();
    if (rawType === "OTHER") {
      pushError(
        errors,
        `${field}[${index}].tinType`,
        "tinType OTHER is not supported by FedEx; choose PERSONAL_NATIONAL, PERSONAL_STATE, FEDERAL, BUSINESS_NATIONAL, BUSINESS_STATE or BUSINESS_UNION",
      );
      return;
    }
    if (!(CUSTOMS_TIN_TYPES as readonly string[]).includes(rawType)) {
      pushError(
        errors,
        `${field}[${index}].tinType`,
        "tinType must be PERSONAL_NATIONAL, PERSONAL_STATE, FEDERAL, BUSINESS_NATIONAL, BUSINESS_STATE or BUSINESS_UNION",
      );
      return;
    }
    const number = clean(record.number);
    if (!number || number.length > CUSTOMS_LIMITS.maxTaxIdChars) {
      pushError(
        errors,
        `${field}[${index}].number`,
        `number must be 1-${CUSTOMS_LIMITS.maxTaxIdChars} characters`,
      );
      return;
    }
    result.push({ number, tinType: rawType as CustomsTaxId["tinType"] });
  });
  return result;
}

function asAddress(
  value: unknown,
  field: string,
  errors: FieldError[],
): CarrierAddress | undefined {
  const record = asRecord(value);
  if (!record) {
    pushError(errors, field, `${field} must be an object`);
    return undefined;
  }
  const errorsBefore = errors.length;
  const addressLine1 = clean(record.addressLine1);
  const city = clean(record.city);
  const state = clean(record.state);
  const zipCode = clean(record.zipCode);
  const countryCode = clean(record.countryCode).toUpperCase();
  if (!addressLine1)
    pushError(errors, `${field}.addressLine1`, "addressLine1 is required");
  if (!city) pushError(errors, `${field}.city`, "city is required");
  // Party addresses (exporter/importer/third-party payor) are NOT required by
  // FedEx to carry state or postal code — only street, city and country.
  if (!ISO_COUNTRY_RE.test(countryCode)) {
    pushError(
      errors,
      `${field}.countryCode`,
      "countryCode must be a 2-letter ISO code",
    );
  }
  if (errors.length > errorsBefore) return undefined;
  const address: CarrierAddress = {
    addressLine1,
    city,
    state,
    zipCode,
    countryCode,
  };
  const addressLine2 = clean(record.addressLine2);
  if (addressLine2) address.addressLine2 = addressLine2;
  return address;
}

function asParty(
  value: unknown,
  field: string,
  errors: FieldError[],
): CustomsParty | undefined {
  const record = asRecord(value);
  if (!record) {
    pushError(errors, field, `${field} must be an object`);
    return undefined;
  }
  const party: CustomsParty = {};
  const accountNumber = clean(record.accountNumber);
  if (accountNumber) party.accountNumber = accountNumber;
  const contactName = clean(record.contactName);
  if (contactName) party.contactName = contactName;
  const companyName = clean(record.companyName);
  if (companyName) party.companyName = companyName;
  const contactPhone = clean(record.contactPhone);
  if (contactPhone) party.contactPhone = contactPhone;
  const contactEmail = clean(record.contactEmail);
  if (contactEmail) party.contactEmail = contactEmail;
  if (record.address !== undefined && record.address !== null) {
    const address = asAddress(record.address, `${field}.address`, errors);
    if (address) party.address = address;
  }
  const taxIds = asTaxIds(record.taxIds, `${field}.taxIds`, errors);
  if (taxIds) party.taxIds = taxIds;
  return party;
}

function asCommodity(
  value: unknown,
  index: number,
  currency: string,
  errors: FieldError[],
): CustomsCommodity | undefined {
  const field = `customs.commodities[${index}]`;
  const record = asRecord(value);
  if (!record) {
    pushError(errors, field, `${field} must be an object`);
    return undefined;
  }
  const errorsBefore = errors.length;
  const name = clean(record.name);
  if (!name) pushError(errors, `${field}.name`, "name is required");
  const description = clean(record.description);
  if (!description) {
    pushError(errors, `${field}.description`, "description is required");
  } else if (description.length > CUSTOMS_LIMITS.maxDescriptionChars) {
    pushError(
      errors,
      `${field}.description`,
      `description must be at most ${CUSTOMS_LIMITS.maxDescriptionChars} characters`,
    );
  }
  const intendedUse = clean(record.intendedUse);
  if (!intendedUse) {
    pushError(errors, `${field}.intendedUse`, "intendedUse is required");
  }
  const quantity = Number(record.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) {
    pushError(
      errors,
      `${field}.quantity`,
      "quantity must be an integer 1-9999",
    );
  }
  const unitPrice = Number(record.unitPrice);
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
    pushError(errors, `${field}.unitPrice`, "unitPrice must be greater than 0");
  }
  const commodityCurrency = clean(record.currency).toUpperCase() || currency;
  if (!ISO_CURRENCY_RE.test(commodityCurrency)) {
    pushError(
      errors,
      `${field}.currency`,
      "currency must be a 3-letter ISO 4217 code",
    );
  } else if (commodityCurrency !== currency) {
    pushError(
      errors,
      `${field}.currency`,
      `currency must equal customs.currency (${currency}); mixed currencies are not supported`,
    );
  }
  const weightUnits = clean(record.weightUnits).toUpperCase() || "LB";
  if (weightUnits !== "LB" && weightUnits !== "KG") {
    pushError(errors, `${field}.weightUnits`, "weightUnits must be LB or KG");
  }
  const weight = Number(record.weight);
  if (!Number.isFinite(weight) || weight <= 0) {
    pushError(errors, `${field}.weight`, "weight must be greater than 0");
  }
  const quantityUnits = clean(record.quantityUnits).toUpperCase() || "EA";
  if (!/^[A-Z]{1,3}$/.test(quantityUnits)) {
    pushError(
      errors,
      `${field}.quantityUnits`,
      "quantityUnits must be a 1-3 letter unit code (e.g. EA, PCS)",
    );
  }
  const hsCode = clean(record.hsCode);
  const hsDigits = hsCode.replace(/\./g, "");
  if (!/^[\d.]+$/.test(hsCode) || !/^\d{6,14}$/.test(hsDigits)) {
    pushError(
      errors,
      `${field}.hsCode`,
      "hsCode must be 6-14 digits (dots allowed)",
    );
  }
  const countryOfManufacture = clean(record.countryOfManufacture).toUpperCase();
  if (!ISO_COUNTRY_RE.test(countryOfManufacture)) {
    pushError(
      errors,
      `${field}.countryOfManufacture`,
      "countryOfManufacture must be a 2-letter ISO code",
    );
  }
  const purpose = clean(record.purpose).toUpperCase();
  if (purpose && purpose !== "BUSINESS" && purpose !== "CONSUMER") {
    pushError(
      errors,
      `${field}.purpose`,
      "purpose must be BUSINESS or CONSUMER",
    );
  }
  if (errors.length > errorsBefore) return undefined;
  const commodity: CustomsCommodity = {
    name,
    description,
    intendedUse,
    quantity,
    quantityUnits,
    weight,
    weightUnits: weightUnits as "LB" | "KG",
    unitPrice: roundMoney(unitPrice),
    currency: commodityCurrency,
    hsCode,
    countryOfManufacture,
  };
  if (purpose) commodity.purpose = purpose as "BUSINESS" | "CONSUMER";
  return commodity;
}

function asUpload(
  value: unknown,
  index: number,
  errors: FieldError[],
): CustomsUpload | undefined {
  const field = `customs.customsDocuments.uploads[${index}]`;
  const record = asRecord(value);
  if (!record) {
    pushError(errors, field, `${field} must be an object`);
    return undefined;
  }
  const errorsBefore = errors.length;
  const fileName = clean(record.fileName);
  if (!fileName || fileName.length > CUSTOMS_LIMITS.maxUploadNameChars) {
    pushError(
      errors,
      `${field}.fileName`,
      `fileName must be 1-${CUSTOMS_LIMITS.maxUploadNameChars} characters`,
    );
  }
  const contentType = clean(record.contentType).toLowerCase();
  if (
    !(CUSTOMS_UPLOAD_CONTENT_TYPES as readonly string[]).includes(contentType)
  ) {
    pushError(
      errors,
      `${field}.contentType`,
      "contentType is not a FedEx-supported document MIME type",
    );
  }
  const shipDocumentType = clean(record.shipDocumentType).toUpperCase();
  if (
    !(CUSTOMS_DOCUMENT_TYPES as readonly string[]).includes(shipDocumentType)
  ) {
    pushError(
      errors,
      `${field}.shipDocumentType`,
      "shipDocumentType is not a supported FedEx document type",
    );
  }
  const contentBase64 = clean(record.contentBase64);
  if (!contentBase64) {
    pushError(errors, `${field}.contentBase64`, "contentBase64 is required");
  } else {
    const compact = contentBase64.replace(/\s/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
      pushError(
        errors,
        `${field}.contentBase64`,
        "contentBase64 must be valid base64",
      );
    } else {
      const bytes = Buffer.from(compact, "base64");
      if (bytes.length === 0) {
        pushError(
          errors,
          `${field}.contentBase64`,
          "contentBase64 decodes to an empty document",
        );
      } else if (bytes.length > CUSTOMS_LIMITS.maxUploadBytes) {
        pushError(
          errors,
          `${field}.contentBase64`,
          `document exceeds the ${CUSTOMS_LIMITS.maxUploadBytes} byte (5 MiB) FedEx limit`,
        );
      }
    }
  }
  if (errors.length > errorsBefore) return undefined;
  return {
    fileName,
    contentType,
    shipDocumentType: shipDocumentType as CustomsUpload["shipDocumentType"],
    contentBase64,
  };
}

/**
 * Validates an untrusted customs payload into `CustomsDetails`.
 *
 * All failures are structured `{field,message}` errors so both the public
 * `/v1/shipment` API and the internal seam can return them verbatim.
 */
export function validateCustomsDetails(
  input: unknown,
  context: CustomsValidationContext,
): CustomsValidationResult {
  const errors: FieldError[] = [];
  const record = asRecord(input);
  if (!record) {
    return {
      ok: false,
      errors: [{ field: "customs", message: "customs must be an object" }],
    };
  }
  const fromCountry = (context.fromCountryCode || "US").trim().toUpperCase();
  const toCountry = (context.toCountryCode || "US").trim().toUpperCase();

  if (context.carrier && context.carrier !== "fedex") {
    pushError(
      errors,
      "customs",
      "customs details are only supported for FedEx shipments",
    );
  }
  if (fromCountry === toCountry) {
    pushError(
      errors,
      "customs",
      "customs details are only valid for international shipments (origin and destination countries differ)",
    );
  }

  const isDocumentOnly = record.isDocumentOnly === true;
  if (
    record.isDocumentOnly !== undefined &&
    typeof record.isDocumentOnly !== "boolean"
  ) {
    pushError(
      errors,
      "customs.isDocumentOnly",
      "isDocumentOnly must be a boolean",
    );
  }
  const documentDescription = clean(record.documentDescription);
  if (isDocumentOnly && !documentDescription) {
    pushError(
      errors,
      "customs.documentDescription",
      "documentDescription is required for documents-only shipments",
    );
  }
  if (documentDescription.length > CUSTOMS_LIMITS.maxDocumentDescriptionChars) {
    pushError(
      errors,
      "customs.documentDescription",
      `documentDescription must be at most ${CUSTOMS_LIMITS.maxDocumentDescriptionChars} characters`,
    );
  }

  const shipmentPurpose = clean(record.shipmentPurpose).toUpperCase();
  if (
    !(CUSTOMS_SHIPMENT_PURPOSES as readonly string[]).includes(shipmentPurpose)
  ) {
    pushError(
      errors,
      "customs.shipmentPurpose",
      "shipmentPurpose must be COMMERCIAL, GIFT, SAMPLE, REPAIR_AND_RETURN, PERSONAL_EFFECTS or NOT_COMMERCIAL",
    );
  }

  const invoiceNumber = clean(record.invoiceNumber);
  if (!invoiceNumber) {
    pushError(errors, "customs.invoiceNumber", "invoiceNumber is required");
  } else if (invoiceNumber.length > CUSTOMS_LIMITS.maxInvoiceNumberChars) {
    pushError(
      errors,
      "customs.invoiceNumber",
      `invoiceNumber must be at most ${CUSTOMS_LIMITS.maxInvoiceNumberChars} characters`,
    );
  }
  const shipmentReference = clean(record.shipmentReference);
  if (shipmentReference.length > CUSTOMS_LIMITS.maxReferenceChars) {
    pushError(
      errors,
      "customs.shipmentReference",
      `shipmentReference must be at most ${CUSTOMS_LIMITS.maxReferenceChars} characters`,
    );
  }

  const originatorName = clean(record.originatorName);
  if (originatorName.length > CUSTOMS_LIMITS.maxOriginatorNameChars) {
    pushError(
      errors,
      "customs.originatorName",
      `originatorName must be at most ${CUSTOMS_LIMITS.maxOriginatorNameChars} characters`,
    );
  }
  const declarationStatement = clean(record.declarationStatement);
  if (
    declarationStatement.length > CUSTOMS_LIMITS.maxDeclarationStatementChars
  ) {
    pushError(
      errors,
      "customs.declarationStatement",
      `declarationStatement must be at most ${CUSTOMS_LIMITS.maxDeclarationStatementChars} characters`,
    );
  }
  const specialInstructions = clean(record.specialInstructions);
  if (specialInstructions.length > CUSTOMS_LIMITS.maxSpecialInstructionsChars) {
    pushError(
      errors,
      "customs.specialInstructions",
      `specialInstructions must be at most ${CUSTOMS_LIMITS.maxSpecialInstructionsChars} characters`,
    );
  }

  let comments: string[] | undefined;
  if (record.comments !== undefined && record.comments !== null) {
    if (!Array.isArray(record.comments)) {
      pushError(
        errors,
        "customs.comments",
        "comments must be an array of strings",
      );
    } else if (record.comments.length > CUSTOMS_LIMITS.maxInvoiceComments) {
      pushError(
        errors,
        "customs.comments",
        `comments must contain at most ${CUSTOMS_LIMITS.maxInvoiceComments} entries (FedEx prints two)`,
      );
    } else {
      const sanitized: string[] = [];
      record.comments.forEach((entry, index) => {
        if (typeof entry !== "string") {
          pushError(
            errors,
            `customs.comments[${index}]`,
            "comments entries must be strings",
          );
          return;
        }
        const comment = entry.trim();
        if (!comment) return;
        if (comment.length > CUSTOMS_LIMITS.maxInvoiceCommentChars) {
          pushError(
            errors,
            `customs.comments[${index}]`,
            `comments entries must be at most ${CUSTOMS_LIMITS.maxInvoiceCommentChars} characters`,
          );
          return;
        }
        if (!sanitized.includes(comment)) sanitized.push(comment);
      });
      if (sanitized.length > 0) comments = sanitized;
    }
  }

  let partiesToTransactionAreRelated: boolean | undefined;
  const relatedPartiesInput =
    record.partiesToTransactionAreRelated ?? record.relatedParties;
  const relatedPartiesField =
    record.partiesToTransactionAreRelated !== undefined
      ? "customs.partiesToTransactionAreRelated"
      : "customs.relatedParties";
  if (relatedPartiesInput !== undefined && relatedPartiesInput !== null) {
    if (typeof relatedPartiesInput !== "boolean") {
      pushError(
        errors,
        relatedPartiesField,
        "relatedParties must be a boolean",
      );
    } else {
      partiesToTransactionAreRelated = relatedPartiesInput;
    }
  }

  const termsOfSale = clean(record.termsOfSale).toUpperCase();
  if (!TERMS_RE.test(termsOfSale)) {
    pushError(
      errors,
      "customs.termsOfSale",
      "termsOfSale must be a 1-3 character Incoterm code (e.g. FCA, DDP)",
    );
  }

  const currency = clean(record.currency).toUpperCase();
  if (!ISO_CURRENCY_RE.test(currency)) {
    pushError(
      errors,
      "customs.currency",
      "currency must be a 3-letter ISO 4217 code",
    );
  }

  const rawCommodities = record.commodities;
  const commodities: CustomsCommodity[] = [];
  if (rawCommodities !== undefined && rawCommodities !== null) {
    if (!Array.isArray(rawCommodities)) {
      pushError(errors, "customs.commodities", "commodities must be an array");
    } else if (rawCommodities.length > CUSTOMS_LIMITS.maxCommodities) {
      pushError(
        errors,
        "customs.commodities",
        `commodities must contain at most ${CUSTOMS_LIMITS.maxCommodities} lines`,
      );
    } else {
      rawCommodities.forEach((entry, index) => {
        const commodity = asCommodity(entry, index, currency, errors);
        if (commodity) commodities.push(commodity);
      });
    }
  }
  if (!isDocumentOnly) {
    if (commodities.length === 0) {
      pushError(
        errors,
        "customs.commodities",
        "at least one commodity is required unless isDocumentOnly is true",
      );
    }
    const totalWeightLb = commodities.reduce((sum, commodity) => {
      if (commodity.weight === undefined) return sum;
      const lb =
        commodity.weightUnits === "KG"
          ? commodity.weight * 2.2046226218
          : commodity.weight;
      return sum + lb;
    }, 0);
    if (
      context.packageWeightLb > 0 &&
      totalWeightLb > context.packageWeightLb + 0.01
    ) {
      pushError(
        errors,
        "customs.commodities",
        "total commodity weight exceeds the shipment package weight after LB/KG conversion",
      );
    }
  }

  const totalCustomsValue = asMoney(
    record.totalCustomsValue,
    "customs.totalCustomsValue",
    currency || undefined,
    errors,
    true,
  );
  if (totalCustomsValue && !isDocumentOnly) {
    const computed = roundMoney(
      commodities.reduce(
        (sum, commodity) => sum + commodity.quantity * commodity.unitPrice,
        0,
      ),
    );
    if (Math.abs(computed - totalCustomsValue.amount) > 0.01) {
      pushError(
        errors,
        "customs.totalCustomsValue",
        `totalCustomsValue ${totalCustomsValue.amount} does not match the commodity total ${computed}`,
      );
    }
  }
  if (
    totalCustomsValue &&
    totalCustomsValue.currency !== currency &&
    currency
  ) {
    pushError(
      errors,
      "customs.totalCustomsValue.currency",
      "totalCustomsValue.currency must equal customs.currency",
    );
  }

  if (isDocumentOnly) {
    // FedEx destination customs rejects zero/null declared value on
    // documents-only shipments (sandbox probe: CUSTOMS.VALUE.INVALID).
    if (totalCustomsValue && totalCustomsValue.amount <= 0) {
      pushError(
        errors,
        "customs.totalCustomsValue",
        "totalCustomsValue must be a positive amount for documents-only shipments: zero or null customs value is rejected by FedEx destination customs",
      );
    }
    if (!(context.packageWeightLb > 0)) {
      pushError(
        errors,
        "packages",
        "package weight is required to declare the documents-only customs commodity weight",
      );
    }
  }

  const dutiesRecord = asRecord(record.dutiesPayment);
  let dutiesPayment: CustomsDetails["dutiesPayment"] | undefined;
  if (!dutiesRecord) {
    // SENDER is the historical/default duties payer when omitted.
    dutiesPayment = { paymentType: "SENDER" };
  } else {
    const paymentType = clean(dutiesRecord.paymentType).toUpperCase();
    if (
      paymentType !== "SENDER" &&
      paymentType !== "RECIPIENT" &&
      paymentType !== "THIRD_PARTY"
    ) {
      pushError(
        errors,
        "customs.dutiesPayment.paymentType",
        "paymentType must be SENDER, RECIPIENT or THIRD_PARTY",
      );
    } else {
      // Payor is only meaningful (and only validated) when supplied — SENDER
      // and RECIPIENT shipments must not be forced to provide one.
      const payor =
        dutiesRecord.payor !== undefined && dutiesRecord.payor !== null
          ? asParty(dutiesRecord.payor, "customs.dutiesPayment.payor", errors)
          : undefined;
      if (paymentType === "THIRD_PARTY") {
        if (!payor) {
          pushError(
            errors,
            "customs.dutiesPayment.payor",
            "payor is required when dutiesPayment.paymentType is THIRD_PARTY",
          );
        } else {
          if (!payor.accountNumber) {
            pushError(
              errors,
              "customs.dutiesPayment.payor.accountNumber",
              "third-party duties payor requires an accountNumber",
            );
          }
          if (!payor.address) {
            pushError(
              errors,
              "customs.dutiesPayment.payor.address",
              "third-party duties payor requires a full address",
            );
          }
          if (!payor.contactName && !payor.companyName) {
            pushError(
              errors,
              "customs.dutiesPayment.payor.contactName",
              "third-party duties payor requires a contact name or company",
            );
          }
        }
      }
      dutiesPayment = {
        paymentType: (paymentType || "SENDER") as
          "SENDER" | "RECIPIENT" | "THIRD_PARTY",
        ...(payor ? { payor } : {}),
      };
    }
  }

  const shipperTaxIds = asTaxIds(
    record.shipperTaxIds,
    "customs.shipperTaxIds",
    errors,
  );
  const recipientTaxIds = asTaxIds(
    record.recipientTaxIds,
    "customs.recipientTaxIds",
    errors,
  );
  const exporter =
    record.exporter !== undefined && record.exporter !== null
      ? asParty(record.exporter, "customs.exporter", errors)
      : undefined;
  const importerOfRecord =
    record.importerOfRecord !== undefined && record.importerOfRecord !== null
      ? asParty(record.importerOfRecord, "customs.importerOfRecord", errors)
      : undefined;

  const chargesRecord = asRecord(record.charges);
  let charges: CustomsCharges | undefined;
  if (chargesRecord) {
    charges = {};
    const freight = asMoney(
      chargesRecord.freight,
      "customs.charges.freight",
      currency || undefined,
      errors,
      false,
    );
    if (freight) charges.freight = freight;
    const insurance = asMoney(
      chargesRecord.insurance,
      "customs.charges.insurance",
      currency || undefined,
      errors,
      false,
    );
    if (insurance) charges.insurance = insurance;
    // Browser contract key is `taxesOrMiscellaneous`; accept legacy alias.
    const taxesOrMiscellaneous = asMoney(
      chargesRecord.taxesOrMiscellaneous ?? chargesRecord.taxesOrMisc,
      "customs.charges.taxesOrMiscellaneous",
      currency || undefined,
      errors,
      false,
    );
    if (taxesOrMiscellaneous) {
      charges.taxesOrMiscellaneous = taxesOrMiscellaneous;
    }
    const packing = asMoney(
      chargesRecord.packing,
      "customs.charges.packing",
      currency || undefined,
      errors,
      false,
    );
    if (packing) charges.packing = packing;
    const handling = asMoney(
      chargesRecord.handling,
      "customs.charges.handling",
      currency || undefined,
      errors,
      false,
    );
    if (handling) charges.handling = handling;
    if (Object.keys(charges).length === 0) charges = undefined;
  } else if (record.charges !== undefined && record.charges !== null) {
    pushError(errors, "customs.charges", "charges must be an object");
  }

  const exportComplianceStatement = clean(record.exportComplianceStatement);
  if (exportComplianceStatement.length > 40) {
    pushError(
      errors,
      "customs.exportComplianceStatement",
      "exportComplianceStatement must be at most 40 characters",
    );
  }

  // Documents arrive in the browser shape
  //   documents: { etdEnabled, uploadTiming, generatedTypes, uploads }
  // and, for legacy/internal callers, the normalized shape
  //   customsDocuments: { mode, uploads } + generatedDocuments.
  const documentsRecord = asRecord(record.documents);
  const customsDocumentsRecord = asRecord(record.customsDocuments);
  const documentsSource = documentsRecord ?? customsDocumentsRecord;
  const etdEnabled =
    documentsRecord?.etdEnabled === undefined
      ? true
      : documentsRecord.etdEnabled === true;

  let customsDocuments: CustomsDocumentSet | undefined;
  if (documentsSource) {
    const rawMode = clean(
      documentsRecord?.uploadTiming ?? customsDocumentsRecord?.mode,
    ).toUpperCase();
    const mode = rawMode || "PRE_SHIPMENT";
    const modeField = documentsRecord
      ? "customs.documents.uploadTiming"
      : "customs.customsDocuments.mode";
    if (mode !== "PRE_SHIPMENT" && mode !== "POST_SHIPMENT") {
      pushError(
        errors,
        modeField,
        "uploadTiming must be PRE_SHIPMENT or POST_SHIPMENT",
      );
    }
    const rawUploads = documentsSource.uploads;
    const uploads: CustomsUpload[] = [];
    if (rawUploads === undefined || rawUploads === null) {
      if (documentsRecord) {
        // UI always sends `uploads` (possibly empty) — absent means empty.
      } else {
        pushError(
          errors,
          "customs.customsDocuments.uploads",
          "uploads must be a non-empty array",
        );
      }
    } else if (!Array.isArray(rawUploads)) {
      pushError(
        errors,
        documentsRecord
          ? "customs.documents.uploads"
          : "customs.customsDocuments.uploads",
        "uploads must be an array",
      );
    } else if (rawUploads.length > CUSTOMS_LIMITS.maxUploads) {
      pushError(
        errors,
        documentsRecord
          ? "customs.documents.uploads"
          : "customs.customsDocuments.uploads",
        `uploads must contain at most ${CUSTOMS_LIMITS.maxUploads} documents`,
      );
    } else if (rawUploads.length > 0) {
      rawUploads.forEach((entry, index) => {
        const upload = asUpload(entry, index, errors);
        if (upload) uploads.push(upload);
      });
    }
    if (
      uploads.length > 0 &&
      etdEnabled &&
      (mode === "PRE_SHIPMENT" || mode === "POST_SHIPMENT")
    ) {
      customsDocuments = { mode, uploads };
    }
  } else if (
    record.documents !== undefined &&
    record.documents !== null &&
    !documentsRecord
  ) {
    pushError(errors, "customs.documents", "documents must be an object");
  } else if (
    record.customsDocuments !== undefined &&
    record.customsDocuments !== null &&
    !customsDocumentsRecord
  ) {
    pushError(
      errors,
      "customs.customsDocuments",
      "customsDocuments must be an object",
    );
  }

  const rawGeneratedTypes =
    documentsRecord?.generatedTypes ?? record.generatedDocuments;
  let generatedDocuments: GeneratedDocumentType[] | undefined;
  if (rawGeneratedTypes !== undefined && rawGeneratedTypes !== null) {
    if (!Array.isArray(rawGeneratedTypes)) {
      pushError(
        errors,
        documentsRecord
          ? "customs.documents.generatedTypes"
          : "customs.generatedDocuments",
        "generatedTypes must be an array",
      );
    } else {
      const seen = new Set<string>();
      const types: GeneratedDocumentType[] = [];
      rawGeneratedTypes.forEach((entry, index) => {
        const type = clean(entry).toUpperCase();
        if (!(GENERATED_DOCUMENT_TYPES as readonly string[]).includes(type)) {
          pushError(
            errors,
            `customs.generatedDocuments[${index}]`,
            "generatedDocuments entries must be COMMERCIAL_INVOICE, PRO_FORMA_INVOICE, CERTIFICATE_OF_ORIGIN or USMCA origin certifications",
          );
          return;
        }
        if (!seen.has(type)) {
          seen.add(type);
          types.push(type as GeneratedDocumentType);
        }
      });
      if (types.length > 0) generatedDocuments = types;
    }
  }

  // Export compliance statement rules (official upload-guide thresholds).
  const statementRequired =
    (fromCountry === "US" &&
      (US_EXPORT_STATEMENT_COUNTRIES.has(toCountry) ||
        (!isDocumentOnly &&
          commodities.some(
            (commodity) =>
              roundMoney(commodity.quantity * commodity.unitPrice) >
              CUSTOMS_LIMITS.usExportStatementLineUsd,
          )))) ||
    (fromCountry === "CA" &&
      !CA_EXPORT_STATEMENT_EXEMPT.has(toCountry) &&
      currency === "CAD" &&
      (totalCustomsValue?.amount ?? 0) >=
        CUSTOMS_LIMITS.caExportStatementTotalCad);
  if (statementRequired && !exportComplianceStatement) {
    pushError(
      errors,
      "customs.exportComplianceStatement",
      "an exportComplianceStatement (ITN/FTR exemption or CA proof number) is required for this export route/value",
    );
  }

  // CA export filing option: required for non-document shipments originating
  // in Canada and destined outside CA/US/PR/VI (Ship ExportDetail enum).
  const b13AFilingOption = clean(record.b13AFilingOption).toUpperCase();
  if (
    b13AFilingOption &&
    !(B13_FILING_OPTIONS as readonly string[]).includes(b13AFilingOption)
  ) {
    pushError(
      errors,
      "customs.b13AFilingOption",
      "b13AFilingOption must be NOT_REQUIRED, MANUALLY_ATTACHED, FILED_ELECTRONICALLY, SUMMARY_REPORTING or FEDEX_TO_STAMP",
    );
  }
  const b13Required =
    fromCountry === "CA" &&
    !isDocumentOnly &&
    !["CA", "US", "PR", "VI"].includes(toCountry);
  if (b13Required && !b13AFilingOption) {
    pushError(
      errors,
      "customs.b13AFilingOption",
      "b13AFilingOption is required for non-document Canadian exports outside CA/US/PR/VI",
    );
  }

  if (errors.length || !dutiesPayment) {
    return { ok: false, errors };
  }

  // Validation above guarantees a positive declared value for documents-only
  // shipments; this invariant only documents the type narrowing.
  if (isDocumentOnly && !totalCustomsValue) {
    throw new Error(
      "documents-only customs validation invariant violated: totalCustomsValue is required",
    );
  }
  // Documents-only shipments still need one FedEx commodity line
  // (quantity 1, origin country, actual package weight) — the UI sends none.
  const mappingCommodities: CustomsCommodity[] = isDocumentOnly
    ? [
        {
          name: "Documents",
          description: documentDescription,
          intendedUse: "DOCUMENTS",
          quantity: 1,
          quantityUnits: "EA",
          weight: context.packageWeightLb,
          weightUnits: "LB",
          unitPrice: (totalCustomsValue as CustomsMoney).amount,
          currency,
          hsCode: "",
          countryOfManufacture: fromCountry,
        },
      ]
    : commodities;

  const value: CustomsDetails = {
    isDocumentOnly,
    shipmentPurpose: shipmentPurpose as CustomsDetails["shipmentPurpose"],
    invoiceNumber,
    termsOfSale,
    currency,
    commodities: mappingCommodities,
    totalCustomsValue: totalCustomsValue as CustomsMoney,
    dutiesPayment,
  };
  if (documentDescription) value.documentDescription = documentDescription;
  if (shipmentReference) value.shipmentReference = shipmentReference;
  if (originatorName) value.originatorName = originatorName;
  if (declarationStatement) value.declarationStatement = declarationStatement;
  if (specialInstructions) value.specialInstructions = specialInstructions;
  if (comments) value.comments = comments;
  if (partiesToTransactionAreRelated !== undefined) {
    value.partiesToTransactionAreRelated = partiesToTransactionAreRelated;
  }
  if (shipperTaxIds) value.shipperTaxIds = shipperTaxIds;
  if (recipientTaxIds) value.recipientTaxIds = recipientTaxIds;
  if (exporter) value.exporter = exporter;
  if (importerOfRecord) value.importerOfRecord = importerOfRecord;
  if (charges) value.charges = charges;
  if (exportComplianceStatement) {
    value.exportComplianceStatement = exportComplianceStatement;
  }
  if (b13AFilingOption && !b13Required) {
    // Keep a valid explicit option even when not required.
    value.b13AFilingOption = b13AFilingOption;
  }
  if (b13Required) value.b13AFilingOption = b13AFilingOption;
  if (customsDocuments) value.customsDocuments = customsDocuments;
  if (generatedDocuments) value.generatedDocuments = generatedDocuments;
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Ship wire mapping
// ---------------------------------------------------------------------------

function fedexPartyAddress(address: CarrierAddress): Record<string, unknown> {
  const state = (address.state ?? "").trim();
  return {
    streetLines: [address.addressLine1, address.addressLine2].filter(
      (line): line is string => typeof line === "string" && line.length > 0,
    ),
    city: address.city,
    ...(state.length > 0 && state.length <= 30
      ? { stateOrProvinceCode: state }
      : {}),
    ...(address.zipCode ? { postalCode: address.zipCode } : {}),
    countryCode: address.countryCode,
  };
}

function fedexTaxIds(
  taxIds: CustomsTaxId[] | undefined,
): Array<Record<string, unknown>> | undefined {
  if (!taxIds || taxIds.length === 0) return undefined;
  // TaxpayerIdentification requires both number and tinType; OTHER is rejected
  // during validation, so every entry carries an official enum value.
  return taxIds.map((taxId) => ({
    number: taxId.number,
    tinType: taxId.tinType,
  }));
}

function fedexParty(party: CustomsParty): Record<string, unknown> | undefined {
  const contact = {
    ...(party.contactName ? { personName: party.contactName } : {}),
    ...(party.companyName ? { companyName: party.companyName } : {}),
    ...(party.contactPhone ? { phoneNumber: party.contactPhone } : {}),
    ...(party.contactEmail ? { emailAddress: party.contactEmail } : {}),
  };
  const tins = fedexTaxIds(party.taxIds);
  if (
    !party.accountNumber &&
    Object.keys(contact).length === 0 &&
    !party.address &&
    !tins
  ) {
    return undefined;
  }
  return {
    ...(party.accountNumber
      ? { accountNumber: { value: party.accountNumber } }
      : {}),
    ...(Object.keys(contact).length > 0 ? { contact } : {}),
    ...(party.address ? { address: fedexPartyAddress(party.address) } : {}),
    ...(tins ? { tins } : {}),
  };
}

function fedexCommodity(commodity: CustomsCommodity): Record<string, unknown> {
  // FedEx has no `intendedUse` field: append it to the description.
  const description = [commodity.description, commodity.intendedUse]
    .filter((value) => value.trim().length > 0)
    .join(" — ")
    .slice(0, 450);
  return {
    name: commodity.name,
    description,
    quantity: commodity.quantity,
    quantityUnits: commodity.quantityUnits || "EA",
    numberOfPieces: Math.max(1, Math.ceil(commodity.quantity)),
    unitPrice: {
      amount: roundMoney(commodity.unitPrice),
      currency: commodity.currency,
    },
    customsValue: {
      amount: roundMoney(commodity.quantity * commodity.unitPrice),
      currency: commodity.currency,
    },
    weight: {
      units: commodity.weightUnits,
      value: commodity.weight,
    },
    countryOfManufacture: commodity.countryOfManufacture,
    ...(commodity.hsCode ? { harmonizedCode: commodity.hsCode } : {}),
    ...(commodity.purpose ? { purpose: commodity.purpose } : {}),
  };
}

export interface FedexCustomsMapping {
  customsClearanceDetail: Record<string, unknown>;
  shipperTins?: Array<Record<string, unknown>>;
  recipientTins?: Array<Record<string, unknown>>;
}

/**
 * Maps validated `CustomsDetails` onto the official Ship payload blocks.
 * Returns the clearance detail plus shipper/recipient `tins` (Party-level).
 */
export function toFedexCustomsMapping(
  customs: CustomsDetails,
  options: { fromCountryCode?: string } = {},
): FedexCustomsMapping {
  const exporter: CustomsParty =
    customs.exporter ??
    ({
      taxIds: customs.shipperTaxIds,
    } satisfies CustomsParty);
  const shipperTins = fedexTaxIds(
    exporter.taxIds && exporter.taxIds.length > 0
      ? exporter.taxIds
      : customs.shipperTaxIds,
  );

  const invoiceComments: string[] = [];
  const addInvoiceComment = (comment: string | undefined): void => {
    const trimmed = (comment ?? "").trim();
    if (
      !trimmed ||
      invoiceComments.length >= CUSTOMS_LIMITS.maxInvoiceComments ||
      invoiceComments.includes(trimmed)
    ) {
      return;
    }
    invoiceComments.push(trimmed);
  };
  // documentDescription keeps its historical first slot; caller comments that
  // duplicate it are skipped so FedEx's two-print limit is respected.
  addInvoiceComment(customs.documentDescription);
  for (const comment of customs.comments ?? []) addInvoiceComment(comment);

  const originatorName =
    customs.originatorName ??
    customs.exporter?.companyName ??
    customs.exporter?.contactName;

  const commercialInvoice: Record<string, unknown> = {
    shipmentPurpose: customs.shipmentPurpose,
    termsOfSale: customs.termsOfSale,
    customerReferences: [
      {
        customerReferenceType: "INVOICE_NUMBER",
        value: customs.invoiceNumber,
      },
      ...(customs.shipmentReference
        ? [
            {
              customerReferenceType: "CUSTOMER_REFERENCE",
              value: customs.shipmentReference,
            },
          ]
        : []),
    ],
    ...(originatorName ? { originatorName } : {}),
    ...(customs.declarationStatement
      ? { declarationStatement: customs.declarationStatement }
      : {}),
    ...(customs.specialInstructions
      ? { specialInstructions: customs.specialInstructions }
      : {}),
    ...(invoiceComments.length > 0 ? { comments: invoiceComments } : {}),
  };

  const charges = customs.charges;
  if (charges?.freight) {
    commercialInvoice.freightCharge = charges.freight;
  }
  if (charges?.taxesOrMiscellaneous) {
    commercialInvoice.taxesOrMiscellaneousCharge = charges.taxesOrMiscellaneous;
    commercialInvoice.taxesOrMiscellaneousChargeType = "OTHER";
  }
  if (charges?.packing) commercialInvoice.packingCosts = charges.packing;
  if (charges?.handling) commercialInvoice.handlingCosts = charges.handling;

  const dutiesPayment: Record<string, unknown> = {
    paymentType: customs.dutiesPayment.paymentType,
  };
  if (
    customs.dutiesPayment.paymentType === "THIRD_PARTY" &&
    customs.dutiesPayment.payor
  ) {
    const responsibleParty = fedexParty(customs.dutiesPayment.payor);
    if (responsibleParty) {
      dutiesPayment.payor = { responsibleParty };
    }
  }

  const clearanceDetail: Record<string, unknown> = {
    isDocumentOnly: customs.isDocumentOnly,
    dutiesPayment,
    totalCustomsValue: customs.totalCustomsValue,
    commodities: customs.commodities.map(fedexCommodity),
    commercialInvoice,
    ...(customs.partiesToTransactionAreRelated !== undefined
      ? {
          partiesToTransactionAreRelated:
            customs.partiesToTransactionAreRelated,
        }
      : {}),
    ...(customs.importerOfRecord
      ? (() => {
          const importer = fedexParty(customs.importerOfRecord);
          return importer ? { importerOfRecord: importer } : {};
        })()
      : {}),
    ...(charges?.insurance ? { insuranceCharge: charges.insurance } : {}),
    ...(customs.exportComplianceStatement || customs.b13AFilingOption
      ? {
          exportDetail: {
            ...(customs.b13AFilingOption
              ? { b13AFilingOption: customs.b13AFilingOption }
              : {}),
            ...(customs.exportComplianceStatement
              ? {
                  exportComplianceStatement: customs.exportComplianceStatement,
                }
              : {}),
          },
        }
      : {}),
  };

  return {
    customsClearanceDetail: clearanceDetail,
    ...(shipperTins ? { shipperTins } : {}),
    ...(fedexTaxIds(customs.recipientTaxIds)
      ? { recipientTins: fedexTaxIds(customs.recipientTaxIds) }
      : {}),
  };
}

/** Builds `shippingDocumentSpecification` + generated document format blocks. */
export function fedexShippingDocumentSpecification(
  generated: GeneratedDocumentType[] | undefined,
): Record<string, unknown> | undefined {
  if (!generated || generated.length === 0) return undefined;
  const hasCommercialInvoice =
    generated.includes("COMMERCIAL_INVOICE") ||
    generated.includes("PRO_FORMA_INVOICE");
  const hasCertificateOfOrigin = generated.includes("CERTIFICATE_OF_ORIGIN");
  const hasUsmcaCertificate = generated.includes(
    "USMCA_CERTIFICATION_OF_ORIGIN",
  );
  const hasUsmcaCommercialInvoice = generated.includes(
    "USMCA_COMMERCIAL_INVOICE_CERTIFICATION_OF_ORIGIN",
  );
  const format = { stockType: "PAPER_LETTER", docType: "PDF" };
  return {
    shippingDocumentTypes: generated,
    ...(hasCommercialInvoice
      ? { commercialInvoiceDetail: { documentFormat: format } }
      : {}),
    ...(hasCertificateOfOrigin
      ? { certificateOfOrigin: { documentFormat: format } }
      : {}),
    // USMCA certifications use their own dedicated detail blocks — never the
    // plain certificateOfOrigin block.
    ...(hasUsmcaCertificate
      ? { usmcaCertificationOfOriginDetail: { documentFormat: format } }
      : {}),
    ...(hasUsmcaCommercialInvoice
      ? {
          usmcaCommercialInvoiceCertificationOfOriginDetail: {
            documentFormat: format,
          },
        }
      : {}),
  };
}

/** ETD `requestedDocumentTypes` — only types Ship supports generating. */
export function fedexRequestedDocumentTypes(
  generated: GeneratedDocumentType[] | undefined,
): GeneratedDocumentType[] | undefined {
  if (!generated || generated.length === 0) return undefined;
  return generated;
}

// ---------------------------------------------------------------------------
// Duty & tax estimate mapping (official Estimated Duty and Tax API)
// ---------------------------------------------------------------------------

const DUTY_ESTIMATE_PURPOSE: Record<
  CustomsDetails["shipmentPurpose"],
  "DOCUMENTS" | "FOR_RESALE" | "NOT_FOR_RESALE" | "GIFT" | "RETURN"
> = {
  COMMERCIAL: "FOR_RESALE",
  NOT_COMMERCIAL: "NOT_FOR_RESALE",
  GIFT: "GIFT",
  SAMPLE: "NOT_FOR_RESALE",
  REPAIR_AND_RETURN: "RETURN",
  PERSONAL_EFFECTS: "NOT_FOR_RESALE",
};

export interface DutyTaxEstimateInput {
  from: CarrierAddress;
  to: CarrierAddress;
  serviceType?: string;
  shippingCost?: CustomsMoney;
  customs: CustomsDetails;
  destinationCountryCode?: string;
  destinationState?: string;
}

export interface DutyTaxEstimate {
  nonGuaranteed: true;
  guaranteed: false;
  disclaimer: string;
  currency?: string;
  duties: Array<Record<string, unknown>>;
  fees: Array<Record<string, unknown>>;
  taxes: Array<Record<string, unknown>>;
  summary?: Record<string, unknown>;
}

export type DutyTaxEstimateValidation =
  | { ok: true; request: Record<string, unknown> }
  | { ok: false; errors: FieldError[] };

/**
 * Builds the `/dutytax/v1/estimate` request. Requires state/province for
 * Canada and Brazil on BOTH shipper and recipient (official guide).
 */
export function buildDutyTaxEstimateRequest(
  input: DutyTaxEstimateInput,
): DutyTaxEstimateValidation {
  const errors: FieldError[] = [];
  const fromCountry = (input.from.countryCode || "").trim().toUpperCase();
  const toCountry = (input.to.countryCode || "").trim().toUpperCase();
  const fromState = (input.from.state || "").trim().toUpperCase();
  const toState = (input.to.state || "").trim().toUpperCase();
  if ((fromCountry === "CA" || fromCountry === "BR") && !fromState) {
    errors.push({
      field: "from.state",
      message: `state/province is required for ${fromCountry} duty & tax estimates`,
    });
  }
  if ((toCountry === "CA" || toCountry === "BR") && !toState) {
    errors.push({
      field: "to.state",
      message: `state/province is required for duty & tax estimates to ${toCountry}`,
    });
  }
  if (input.customs.commodities.length === 0) {
    errors.push({
      field: "customs.commodities",
      message: "at least one commodity is required for a duty & tax estimate",
    });
  }
  if (
    input.shippingCost &&
    input.shippingCost.currency !== input.customs.currency
  ) {
    errors.push({
      field: "shippingCost.currency",
      message: "shippingCost.currency must equal customs.currency",
    });
  }
  if (errors.length) return { ok: false, errors };

  const request: Record<string, unknown> = {
    shipper: {
      countryCode: fromCountry,
      ...(input.from.zipCode ? { postalCode: input.from.zipCode } : {}),
      ...(fromState && fromState.length <= 30
        ? { stateOrProvinceCode: fromState }
        : {}),
    },
    recipient: {
      countryCode: toCountry,
      ...(input.to.zipCode ? { postalCode: input.to.zipCode } : {}),
      ...(toState ? { stateOrProvinceCode: toState } : {}),
    },
    commodities: input.customs.commodities.map((commodity) => ({
      description: [commodity.description, commodity.intendedUse]
        .filter((value) => value.trim().length > 0)
        .join(" — "),
      quantity: commodity.quantity,
      unitPrice: {
        amount: roundMoney(commodity.unitPrice),
        // Official estimate field is `currencyCode`, not `currency`.
        currencyCode: commodity.currency,
      },
      countryOfManufacture: commodity.countryOfManufacture,
      ...(commodity.hsCode ? { harmonizedCode: commodity.hsCode } : {}),
    })),
    shipmentPurpose: DUTY_ESTIMATE_PURPOSE[input.customs.shipmentPurpose],
    preferredCurrency: input.customs.currency,
    ...(input.serviceType ? { serviceType: input.serviceType } : {}),
    ...(input.shippingCost
      ? {
          shippingCost: {
            amount: roundMoney(input.shippingCost.amount),
            currency: input.shippingCost.currency,
          },
        }
      : {}),
  };
  return { ok: true, request };
}

/** Sanitizes the estimate response; always flags it as non-guaranteed. */
export function mapDutyTaxEstimateResponse(raw: unknown): DutyTaxEstimate {
  const response = asRecord(raw);
  const output = asRecord(response?.output);
  const first = Array.isArray(output?.edtDetails)
    ? asRecord((output.edtDetails as unknown[])[0])
    : undefined;
  const details = (key: "duties" | "fees" | "taxes") =>
    Array.isArray(first?.[key])
      ? (first[key] as unknown[])
          .map((entry) => asRecord(entry))
          .filter((entry): entry is Record<string, unknown> => Boolean(entry))
          .map((entry) => ({
            amount: Number(entry.amount ?? 0),
            ...(typeof entry.currency === "string"
              ? { currency: entry.currency }
              : {}),
            ...(typeof entry.description === "string"
              ? { description: entry.description }
              : {}),
            ...(typeof entry.formula === "string"
              ? { formula: entry.formula }
              : {}),
            ...(typeof entry.note === "string" ? { note: entry.note } : {}),
          }))
      : [];
  const summary = asRecord(first?.summary);
  // Official examples return `totalDuty`; the schema also permits
  // `totalDuties`. Accept either and expose a stable `totalDuties` field.
  const totalDutyValue = summary?.totalDuty ?? summary?.totalDuties;
  return {
    nonGuaranteed: true,
    guaranteed: false,
    disclaimer:
      "Estimated duties, taxes and fees are non-guaranteed. Final charges are assessed by the carrier and destination customs authority.",
    ...(summary && typeof summary.currency === "string"
      ? { currency: summary.currency }
      : {}),
    duties: details("duties"),
    fees: details("fees"),
    taxes: details("taxes"),
    ...(summary
      ? {
          summary: {
            ...(Number.isFinite(Number(totalDutyValue))
              ? { totalDuties: Number(totalDutyValue) }
              : {}),
            ...(Number.isFinite(Number(summary.totalFees))
              ? { totalFees: Number(summary.totalFees) }
              : {}),
            ...(Number.isFinite(Number(summary.totalTaxes))
              ? { totalTaxes: Number(summary.totalTaxes) }
              : {}),
            ...(Number.isFinite(Number(summary.totalShippingCosts))
              ? { totalShippingCosts: Number(summary.totalShippingCosts) }
              : {}),
            ...(Number.isFinite(Number(summary.totalLandedCost))
              ? { totalLandedCost: Number(summary.totalLandedCost) }
              : {}),
            ...(typeof summary.currency === "string"
              ? { currency: summary.currency }
              : {}),
          },
        }
      : {}),
  };
}

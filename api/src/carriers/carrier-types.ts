/**
 * Carrier integration shared types — the carrier-native input/output shapes the
 * FedEx/UPS/USPS clients and the unified `carrier.service` facade speak.
 *
 * These mirror the shipping-cli reference models (`/home/anuj/projects/shipping-cli`
 * `src/shipping_cli/models.py`) ported to TypeScript: RateQuote, Label,
 * LabelFormat, Address, Package. Field names are the carrier-native ones —
 * the logistics services (shipping.service.ts) own the translation into the
 * legacy upstream wire shapes (ShipmentLabelDatum, RateQuoteDatum, ...).
 */

/** Carrier identifiers (lowercase, matches the Flutter carrier field). */
export type Carrier = "fedex" | "ups" | "usps" | "stamps";

export type CarrierEnvironment = "sandbox" | "production";

/**
 * Per-call FedEx credential override (BC tliLocation seam). Non-empty fields
 * win over the process.env base; missing fields fall back to env per field.
 */
export interface FedexCredentialOverride {
  apiKey?: string;
  apiSecret?: string;
  accountNumber?: string;
  baseUrl?: string;
}

/** Per-call UPS credential override (BC tliLocation seam). */
export interface UpsCredentialOverride {
  clientId?: string;
  clientSecret?: string;
  accountNumber?: string;
  baseUrl?: string;
}

/** Per-call USPS credential override (BC tliLocation seam). */
export interface UspsCredentialOverride {
  clientId?: string;
  clientSecret?: string;
  accountNumber?: string;
  baseUrl?: string;
}

/**
 * Per-call Stamps.com (SERA) credential override (BC tliLocation seam).
 * SERA authorizes with a refresh-token grant: client id/secret + a
 * long-lived refresh token.
 */
export interface StampsCredentialOverride {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  baseUrl?: string;
}

/** Union of the per-carrier credential overrides threaded through the facade. */
export type CarrierCredentialOverride =
  | FedexCredentialOverride
  | UpsCredentialOverride
  | UspsCredentialOverride
  | StampsCredentialOverride;

/** Label encoding a carrier can emit. */
export type LabelFormat = "PDF" | "ZPL";

/** Inputs for a rate-shop call (from/to ZIP + packages + optional full
 * addresses and ship date — carriers that require street-level addresses
 * (UPS shop, USPS total-rates) consume the full form). */
export interface RateShopArgs {
  fromZip: string;
  toZip: string;
  packages: CarrierPackage[];
  accountNumber?: string;
  fromAddress?: CarrierAddress;
  toAddress?: CarrierAddress;
  /** ISO date string (YYYY-MM-DD). */
  shipDate?: string;
  /** FedEx price bases to request. The checkout requests both so the admin
   * policy can select an exact response without relying on array order. */
  rateTypes?: Array<"ACCOUNT" | "LIST">;
  /** Exact FedEx price basis to return for each service. */
  preferredRateType?: "ACCOUNT" | "LIST";
  /** Reject the quote if preferredRateType is absent; never silently charge
   * a customer using a different price basis. */
  strictRateType?: boolean;
  /** Optional carrier-native service and packaging constraints. */
  serviceType?: string;
  packagingType?: string;
  pickupType?: string;
}

/** A single rate quote returned by a carrier's rate API. */
export interface RateQuote {
  carrier: Carrier;
  /** Service name/code (e.g. "FEDEX_GROUND", "03", "PRIORITY MAIL"). */
  service: string;
  cost: number;
  currency: string;
  /** Carrier service description (e.g. "UPS Ground"), when returned. */
  serviceDescription?: string;
  /** Guaranteed/transit days (e.g. UPS BusinessDaysInTransit), when returned. */
  deliveryDays?: string;
  /** Carrier-reported expected delivery date/datetime (ISO YYYY-MM-DD or RFC3339), verbatim from carrier rate response; absent when carrier returns none. Never computed locally. */
  deliveryDate?: string;
  /** FedEx ACCOUNT (negotiated) or LIST (published/public) price basis. */
  rateType?: "ACCOUNT" | "LIST";
  /** SERA packaging variant for the quoted rate (e.g. "usps_medium_flat_rate_box");
   * other carriers leave this unset. */
  packagingType?: string;
  /** USPS Domestic Prices v3 rate SKU — product identifier returned by
   * total-rates/search and required for label creation. */
  sku?: string;
  /** Price type of the quoted rate (USPS: COMMERCIAL / RETAIL / CONTRACT). */
  priceType?: string;
}

/** Carrier-native address block (from/to). */
export interface CarrierAddress {
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  zipCode: string;
  countryCode: string;
  /** Contact person name (legacy parity: the *_contact_no field). */
  contactName?: string;
  /** Contact phone (digits). */
  contactPhone?: string;
  /** Company name for the contact block. */
  companyName?: string;
  /** Contact email (shipper block). */
  contactEmail?: string;
}

/** A parsed address-validation candidate (one per carrier candidate). */
export interface AddressCandidate {
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  zipCode: string;
  countryCode: string;
  classification: string;
  ZIPPlus4: string;
}

/** Result of a carrier address-validation call (valid flag + raw response). */
export interface AddressValidationResult {
  carrier: Carrier;
  valid: boolean;
  response: unknown;
  /** Parsed candidates in the ValidateAddressDatum row shape; absent when the
   * carrier client does not parse candidates (legacy callers unaffected). */
  candidates?: AddressCandidate[];
}

/** One package (box) in a shipment or rate request. Weight in lbs. */
export interface CarrierPackage {
  weight: number;
  length?: number;
  width?: number;
  height?: number;
  /** Per-package insured value ("Insure for $") in USD. */
  insuredValue?: number;
}

/**
 * One customs line item for international shipments — sourced from the real
 * packing items (BC packingItems: itemNo/itemName/quantity/unitPrice), never
 * fabricated. `customsValue` per line = quantity × unitPrice.
 */
export interface CustomsItem {
  /** Item name/description (BC itemName, falling back to itemNo). */
  name: string;
  /** Quantity of the item (BC quantity). */
  quantity: number;
  /** Unit price in USD (BC unitPrice). */
  unitPrice: number;
  /** ISO country of manufacture, when known. */
  countryOfOrigin?: string;
}

// ---------------------------------------------------------------------------
// FedEx international customs (official Ship / ETD Upload / Duty & Tax enums)
// ---------------------------------------------------------------------------

/** Ship `commercialInvoice.shipmentPurpose` enum — the only values FedEx accepts. */
export type CustomsShipmentPurpose =
  | "COMMERCIAL"
  | "GIFT"
  | "SAMPLE"
  | "REPAIR_AND_RETURN"
  | "PERSONAL_EFFECTS"
  | "NOT_COMMERCIAL";

/** Official FedEx `TaxpayerIdentification.tinType` enum (no `OTHER`). */
export type CustomsTaxIdType =
  | "PERSONAL_NATIONAL"
  | "PERSONAL_STATE"
  | "FEDERAL"
  | "BUSINESS_NATIONAL"
  | "BUSINESS_STATE"
  | "BUSINESS_UNION";

/** Public tax id shape — matches the browser contract (`tinType`). */
export interface CustomsTaxId {
  number: string;
  tinType: CustomsTaxIdType;
}

export interface CustomsMoney {
  amount: number;
  currency: string;
}

/** A customs party (exporter / importer / third-party payor). */
export interface CustomsParty {
  accountNumber?: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
  companyName?: string;
  address?: CarrierAddress;
  taxIds?: CustomsTaxId[];
}

/** One customs line item. `weight` is the TOTAL line weight (not unit). */
export interface CustomsCommodity {
  /** Item name (FedEx `Commodity.name`). */
  name: string;
  /** Free-text description; `intendedUse` is appended on the wire. */
  description: string;
  /** Internal input only — FedEx has no `intendedUse` field. */
  intendedUse: string;
  quantity: number;
  quantityUnits: string;
  weight: number;
  weightUnits: "LB" | "KG";
  unitPrice: number;
  /** Must equal customs.currency — no implicit FX conversion. */
  currency: string;
  /** 6–14 digits (dots allowed). */
  hsCode: string;
  countryOfManufacture: string;
  purpose?: "BUSINESS" | "CONSUMER";
}

/** Ship upload metadata `shipDocumentType` enum. */
export type CustomsDocumentType =
  | "COMMERCIAL_INVOICE"
  | "PRO_FORMA_INVOICE"
  | "CERTIFICATE_OF_ORIGIN"
  | "USMCA_CERTIFICATION_OF_ORIGIN"
  | "USMCA_COMMERCIAL_INVOICE_CERTIFICATION_OF_ORIGIN"
  | "ETD_LABEL"
  | "OTHER";

export interface CustomsUpload {
  fileName: string;
  contentType: string;
  shipDocumentType: CustomsDocumentType;
  contentBase64: string;
}

/** Generated ETD document types (Ship `shippingDocumentTypes` enum subset). */
export type GeneratedDocumentType =
  | "COMMERCIAL_INVOICE"
  | "PRO_FORMA_INVOICE"
  | "CERTIFICATE_OF_ORIGIN"
  | "USMCA_CERTIFICATION_OF_ORIGIN"
  | "USMCA_COMMERCIAL_INVOICE_CERTIFICATION_OF_ORIGIN";

export interface CustomsDocumentSet {
  mode: "PRE_SHIPMENT" | "POST_SHIPMENT";
  uploads: CustomsUpload[];
}

export interface CustomsCharges {
  freight?: CustomsMoney;
  insurance?: CustomsMoney;
  /** Browser contract key (FedEx `taxesOrMiscellaneousCharge`). */
  taxesOrMiscellaneous?: CustomsMoney;
  packing?: CustomsMoney;
  handling?: CustomsMoney;
}

/** Full FedEx international customs payload (documents-only + multi-commodity). */
export interface CustomsDetails {
  isDocumentOnly: boolean;
  /** Required when isDocumentOnly: describes the documents being shipped. */
  documentDescription?: string;
  shipmentPurpose: CustomsShipmentPurpose;
  invoiceNumber: string;
  shipmentReference?: string;
  /** Incoterm (e.g. FCA, DDP); FedEx accepts max 3 characters. */
  termsOfSale: string;
  currency: string;
  /** Empty only when isDocumentOnly. */
  commodities: CustomsCommodity[];
  totalCustomsValue: CustomsMoney;
  dutiesPayment: {
    paymentType: "SENDER" | "RECIPIENT" | "THIRD_PARTY";
    payor?: CustomsParty;
  };
  shipperTaxIds?: CustomsTaxId[];
  recipientTaxIds?: CustomsTaxId[];
  /** Defaults to the shipper when omitted. */
  exporter?: CustomsParty;
  importerOfRecord?: CustomsParty;
  charges?: CustomsCharges;
  /** Commercial invoice originator; falls back to exporter company/contact. */
  originatorName?: string;
  /** Destination Control Statement printed on the commercial invoice. */
  declarationStatement?: string;
  /** Special instructions printed on the commercial invoice. */
  specialInstructions?: string;
  /** Commercial invoice comments (FedEx prints the first two indexes only). */
  comments?: string[];
  /** Ship `CustomsClearanceDetail.partiesToTransactionAreRelated`. */
  partiesToTransactionAreRelated?: boolean;
  exportComplianceStatement?: string;
  /** CA export filing option (Ship `ExportDetail.b13AFilingOption`). */
  b13AFilingOption?: string;
  customsDocuments?: CustomsDocumentSet;
  generatedDocuments?: GeneratedDocumentType[];
}

/** Sanitized shipment document returned by the carrier seam. */
export interface ShipmentDocument {
  /** Assigned by persistence on public responses. */
  id?: string;
  /** FedEx `contentType`/`docType` for generated docs, or uploaded `shipDocumentType`. */
  documentType: string;
  /** PDF/TXT/PNG/etc. */
  docType: string;
  fileName: string;
  contentBase64: string;
  source: "FEDEX_GENERATED" | "UPLOADED";
  uploadStatus?: "ATTACHED" | "UPLOADED" | "FAILED";
}

/** Carrier-native shipment request (create label / create shipment). */
export interface ShipmentRequest {
  from: CarrierAddress;
  to: CarrierAddress;
  packages: CarrierPackage[];
  serviceType: string;
  accountNumber?: string;
  labelFormat: LabelFormat;
  /** ISO date string (YYYY-MM-DD). */
  shipDate?: string;
  /** Who pays transportation ("SENDER" | "RECEIVER") — FedEx ship requires
   * shippingChargesPayment ("RECIPIENT" enum value on the wire). */
  billTransportationTo?: string;
  /** Receiver-billing payor account (the ship-to account_no field). */
  payorAccountNumber?: string;
  /** Raw shipping-form label size ("4 X 6", "4 X 675", …) — FedEx maps it to
   * a labelStockType enum on ZPL only (PDF sends imageType alone); absent
   * defaults to STOCK_4X6. */
  labelSize?: string;
  /** FedEx packaging type from the packing box code (YOUR_PACKAGING, FEDEX_PAK,
   * FX_* box codes); absent defaults to YOUR_PACKAGING. */
  packagingType?: string;
  /** FedEx One Rate flag — adds FEDEX_ONE_RATE special services. */
  fedexOneRate?: boolean;
  /** Cash-on-delivery amount in USD; > 0 adds COD special services. */
  codAmount?: number;
  /** Shipment references (your_reference / po_no → CUSTOMER_REFERENCE / P_O_NUMBER). */
  yourReference?: string;
  poNo?: string;
  /** Invoice number (create-body invoice_no → FedEx INVOICE_NUMBER reference). */
  invoiceNo?: string;
  /** Department (create-body department → FedEx DEPARTMENT reference). */
  department?: string;
  /** Customer reference (details customer_reference, BC sales-order
   * yourReference → second FedEx CUSTOMER_REFERENCE reference). */
  customerReference?: string;
  /** Shipment-level declared value in USD (FedEx totalDeclaredValue). */
  declaredValue?: number;
  /** Customs line items for international shipments (packing items with
   * values); carriers require them whenever origin ≠ destination country. */
  customsItems?: CustomsItem[];
  /** Full customs detail (FedEx international only). When present it takes
   * precedence over `customsItems` and drives documents/ETD/charges. */
  customs?: CustomsDetails;
  /** Pickup/drop-off selection for the shipment label flow. */
  pickup?: ShipmentPickup;
}

/** Pickup/drop-off selection for the shipment label flow. */
export interface ShipmentPickup {
  type: "pickup" | "dropoff";
  /** Pickup date ISO (YYYY-MM-DD); required for type "pickup". */
  date?: string;
  /** Package ready time at pickup location, HH:MM 24h local. */
  readyTime?: string;
  /** Location close time, HH:MM 24h local. */
  closeTime?: string;
  /** Optional driver instructions. */
  instructions?: string;
  /** Alternate pickup location; absent means the ship-from address. */
  address?: CarrierAddress;
}

/** Carrier-native label returned by a create-shipment call. */
export interface CarrierLabel {
  carrier: Carrier;
  /** Actual API environment at creation, independent of later runtime changes. */
  environment?: CarrierEnvironment;
  trackingNumber: string;
  /** Base64-encoded label bytes (PDF) or ZPL payload. */
  labelData: string;
  format: LabelFormat;
  /** Shipment charges, when the carrier returns them. */
  cost?: number;
  /** Customs/generated/uploaded documents returned or attached by the carrier. */
  documents?: ShipmentDocument[];
  /** Non-fatal document problems (e.g. post-shipment upload failed). */
  documentWarnings?: string[];
}

/** Result of a carrier void-shipment call. */
export interface VoidShipmentResult {
  carrier: Carrier;
  voided: boolean;
  trackingNumber: string;
  response: unknown;
}

/** One tracking scan event. */
export interface TrackingEvent {
  timestamp: string;
  status: string;
  location?: string;
  description?: string;
}

/** Carrier-native tracking result. */
export interface TrackingInfo {
  carrier: Carrier;
  trackingNumber: string;
  status: string;
  events: TrackingEvent[];
}

/**
 * Carrier-native pickup-scheduling result (shipping-cli `Pickup` model).
 * `date` is the requested pickup date (ISO YYYY-MM-DD); `timeWindow` is the
 * carrier-quoted window (FedEx/UPS hardcode "09:00-17:00" per the CLI port;
 * USPS reads it from the response).
 */
export interface PickupResult {
  carrier: Carrier;
  confirmationNumber: string;
  date: string;
  timeWindow: string;
}

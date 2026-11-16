/**
 * Internal shipping seam types — intentionally narrow contract for the
 * shipping-label-generator project. Nothing here depends on LogisticsSession,
 * Business Central, or the existing shipping service.
 */
import type {
  Carrier,
  CarrierAddress,
  CarrierPackage,
  ShipmentPickup,
} from "../carriers/carrier-types";

export type { Carrier } from "../carriers/carrier-types";

export type InternalLabelFormat = "PDF" | "ZPL";

export interface InternalRateQuoteRequest {
  carrier: Carrier | "all";
  from: CarrierAddress;
  to: CarrierAddress;
  packages: CarrierPackage[];
  shipDate?: string;
  /** Carrier-native service and packaging constraints (optional). */
  serviceType?: string;
  packagingType?: string;
  /** FedEx-only price basis preference. */
  preferredRateType?: "ACCOUNT" | "LIST";
  strictRateType?: boolean;
}

export interface InternalRateQuote {
  carrier: Carrier;
  service: string;
  serviceDescription?: string;
  cost: number;
  currency: string;
  deliveryDays?: string;
  deliveryDate?: string;
  rateType?: "ACCOUNT" | "LIST";
  packagingType?: string;
  sku?: string;
  priceType?: string;
}

export interface InternalCreateShipmentRequest {
  carrier: Carrier;
  serviceType: string;
  from: CarrierAddress;
  to: CarrierAddress;
  packages: CarrierPackage[];
  shipDate?: string;
  labelFormat?: InternalLabelFormat;
  /** Who pays transportation: SENDER | RECEIVER. Default SENDER. */
  billTransportationTo?: "SENDER" | "RECEIVER";
  /** Receiver-billing payor account (required when RECEIVER). */
  payorAccountNumber?: string;
  accountNumber?: string;
  packagingType?: string;
  /** Pickup/drop-off selection from vendor flow. */
  pickup?: ShipmentPickup;
  /** Shipment references passed through to carriers that support them. */
  yourReference?: string;
  poNo?: string;
  invoiceNo?: string;
  department?: string;
  customerReference?: string;
  declaredValue?: number;
}

export interface InternalShipmentLabel {
  carrier: Carrier;
  trackingNumber: string;
  labelData: string;
  format: InternalLabelFormat;
  cost?: number;
}

export interface InternalServiceCatalogEntry {
  code: string;
  description: string;
}

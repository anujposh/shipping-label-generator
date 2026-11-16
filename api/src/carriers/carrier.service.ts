import * as fedexClient from "./fedex.client";
import * as upsClient from "./ups.client";
import * as uspsClient from "./usps.client";
import * as stampsClient from "./stamps.client";
import { CarrierValidationError } from "./carrier-errors";
import { log } from "../core/logger";
import type { DutyTaxEstimate, DutyTaxEstimateInput } from "./customs";
import type {
  AddressValidationResult,
  Carrier,
  CarrierAddress,
  CarrierCredentialOverride,
  CarrierLabel,
  PickupResult,
  RateQuote,
  RateShopArgs,
  ShipmentRequest,
  TrackingInfo,
  VoidShipmentResult,
} from "./carrier-types";

export type { Carrier } from "./carrier-types";

/** The operations every carrier client exposes. */
interface CarrierClient {
  rateShop(
    args: RateShopArgs,
    cfg?: CarrierCredentialOverride,
  ): Promise<RateQuote[]>;
  validateAddress(
    address: CarrierAddress,
    cfg?: CarrierCredentialOverride,
  ): Promise<AddressValidationResult>;
  createShipment(
    shipment: ShipmentRequest,
    cfg?: CarrierCredentialOverride,
  ): Promise<CarrierLabel[]>;
  voidShipment(
    trackingNumber: string,
    cfg?: CarrierCredentialOverride,
  ): Promise<VoidShipmentResult>;
  track(
    trackingNumber: string,
    cfg?: CarrierCredentialOverride,
  ): Promise<TrackingInfo>;
  schedulePickup(
    pickupDate: string,
    cfg?: CarrierCredentialOverride,
  ): Promise<PickupResult>;
}

const CLIENTS: Record<Carrier, CarrierClient> = {
  fedex: fedexClient,
  ups: upsClient,
  usps: uspsClient,
  stamps: stampsClient,
};

export const ALL_CARRIERS: Carrier[] = ["fedex", "ups", "usps", "stamps"];

/** Test-only: clears every carrier client's per-credential token caches. */
export function __resetCarrierCachesForTests(): void {
  fedexClient.__resetForTests();
  upsClient.__resetForTests();
  uspsClient.__resetForTests();
  stampsClient.__resetForTests();
}

/**
 * Normalizes a carrier label from the shipping form ("FEDEX", "UPS", "USPS",
 * "STAMPS") to the lowercase Carrier id. Unknown / "ALL" inputs resolve to
 * "all".
 */
export function normalizeCarrier(input: string): Carrier | "all" {
  const lower = input.toLowerCase();
  if (
    lower === "fedex" ||
    lower === "ups" ||
    lower === "usps" ||
    lower === "stamps"
  ) {
    return lower;
  }
  return "all";
}

export async function rateShop(
  carrier: Carrier | "all",
  args: RateShopArgs,
  cfg?: CarrierCredentialOverride,
): Promise<RateQuote[]> {
  if (carrier === "all") {
    const settled = await Promise.allSettled(
      ALL_CARRIERS.map((entry) => CLIENTS[entry].rateShop(args, cfg)),
    );
    // Per-carrier failures are intentionally tolerated so one broken carrier
    // cannot take down rate shopping — but they must never be invisible.
    settled.forEach((result, i) => {
      if (result.status === "rejected") {
        const reason = result.reason as { message?: unknown };
        log("warn", "carrier_rate_shop_failed", {
          carrier: ALL_CARRIERS[i],
          error: String(reason?.message ?? result.reason).slice(0, 500),
        });
      }
    });
    return settled
      .filter(
        (result): result is PromiseFulfilledResult<RateQuote[]> =>
          result.status === "fulfilled",
      )
      .flatMap((result) => result.value);
  }
  return CLIENTS[carrier].rateShop(args, cfg);
}

export function validateAddress(
  carrier: Carrier,
  address: CarrierAddress,
  cfg?: CarrierCredentialOverride,
): Promise<AddressValidationResult> {
  return CLIENTS[carrier].validateAddress(address, cfg);
}

export function createShipment(
  carrier: Carrier,
  shipment: ShipmentRequest,
  cfg?: CarrierCredentialOverride,
): Promise<CarrierLabel[]> {
  return CLIENTS[carrier].createShipment(shipment, cfg);
}

export function voidShipment(
  carrier: Carrier,
  trackingNumber: string,
  cfg?: CarrierCredentialOverride,
): Promise<VoidShipmentResult> {
  return CLIENTS[carrier].voidShipment(trackingNumber, cfg);
}

export function track(
  carrier: Carrier,
  trackingNumber: string,
  cfg?: CarrierCredentialOverride,
): Promise<TrackingInfo> {
  return CLIENTS[carrier].track(trackingNumber, cfg);
}

export function schedulePickup(
  carrier: Carrier,
  pickupDate: string,
  cfg?: CarrierCredentialOverride,
): Promise<PickupResult> {
  return CLIENTS[carrier].schedulePickup(pickupDate, cfg);
}

/** Non-guaranteed duty & tax estimate — FedEx only. */
export function estimateDutyTax(
  carrier: Carrier,
  input: DutyTaxEstimateInput,
  cfg?: CarrierCredentialOverride,
): Promise<DutyTaxEstimate> {
  if (carrier !== "fedex") {
    return Promise.reject(
      new CarrierValidationError(
        "Duty & tax estimates are only available for FedEx international shipments",
      ),
    );
  }
  return fedexClient.estimateDutyTax(input, cfg);
}

/**
 * Static per-carrier service catalog for the internal shipping seam.
 *
 * Plan decision (§4 Decision 1 / Session-BC strategy): the seam must NOT read
 * Business Central (tliShippingAgentServices) to resolve service codes — no
 * LogisticsSession exists here. Instead it exposes this static, code-owned
 * catalog. Deployments can override any carrier's list via
 * `SLG_INTERNAL_SERVICES_<CARRIER>` (comma-separated `code=Description`
 * entries) without a code change.
 *
 * Entries are informational for the calling service's UI: the caller still
 * supplies the exact service code on create-shipment.
 */

import type { SeamCarrier } from "../internal-shipping.dto";

export interface ServiceCatalogEntry {
  /** Carrier-native service code passed through to create-shipment. */
  service: string;
  /** Human-readable label for UI display. */
  description: string;
}

const DEFAULT_SERVICE_CATALOG: Record<SeamCarrier, ServiceCatalogEntry[]> = {
  fedex: [
    { service: "FEDEX_GROUND", description: "FedEx Ground" },
    { service: "FEDEX_HOME_DELIVERY", description: "FedEx Home Delivery" },
    { service: "FEDEX_EXPRESS_SAVER", description: "FedEx Express Saver" },
    { service: "FEDEX_2_DAY", description: "FedEx 2Day" },
    { service: "FEDEX_2_DAY_AM", description: "FedEx 2Day AM" },
    { service: "STANDARD_OVERNIGHT", description: "FedEx Standard Overnight" },
    { service: "PRIORITY_OVERNIGHT", description: "FedEx Priority Overnight" },
    { service: "FEDEX_FIRST_OVERNIGHT", description: "FedEx First Overnight" },
    {
      service: "FEDEX_INTERNATIONAL_CONNECT_PLUS",
      description: "FedEx International Connect Plus",
    },
    {
      service: "INTERNATIONAL_PRIORITY",
      description: "FedEx International Priority",
    },
    {
      service: "INTERNATIONAL_ECONOMY",
      description: "FedEx International Economy",
    },
  ],
  ups: [
    { service: "03", description: "UPS Ground" },
    { service: "11", description: "UPS Standard" },
    { service: "12", description: "UPS 3 Day Select" },
    { service: "02", description: "UPS 2nd Day Air" },
    { service: "59", description: "UPS 2nd Day Air A.M." },
    { service: "13", description: "UPS Next Day Air Saver" },
    { service: "01", description: "UPS Next Day Air" },
    { service: "14", description: "UPS Next Day Air Early" },
    { service: "07", description: "UPS Worldwide Express" },
    { service: "08", description: "UPS Worldwide Expedited" },
    { service: "65", description: "UPS Worldwide Saver" },
  ],
  usps: [
    {
      service: "PRIORITY_MAIL_EXPRESS",
      description: "Priority Mail Express",
    },
    { service: "PRIORITY_MAIL", description: "Priority Mail" },
    { service: "GROUND_ADVANTAGE", description: "Ground Advantage" },
    { service: "MEDIA_MAIL", description: "Media Mail" },
  ],
  stamps: [
    {
      service: "usps_priority_mail_express_flat_rate_envelope",
      description: "Priority Mail Express Flat Rate Envelope",
    },
    {
      service: "usps_priority_mail_flat_rate_envelope",
      description: "Priority Mail Flat Rate Envelope",
    },
    {
      service: "usps_priority_mail_medium_flat_rate_box",
      description: "Priority Mail Medium Flat Rate Box",
    },
    {
      service: "usps_priority_mail_large_flat_rate_box",
      description: "Priority Mail Large Flat Rate Box",
    },
    {
      service: "usps_ground_advantage",
      description: "Ground Advantage",
    },
  ],
};

/**
 * Parses a `code=Description` comma-separated override list. Entries without
 * `=` keep the code as its own description; empty entries are dropped.
 */
function parseCatalogOverride(raw: string): ServiceCatalogEntry[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf("=");
      if (separator === -1) return { service: entry, description: entry };
      return {
        service: entry.slice(0, separator).trim(),
        description: entry.slice(separator + 1).trim(),
      };
    })
    .filter((entry) => entry.service.length > 0)
    .map((entry) => ({
      service: entry.service,
      description: entry.description || entry.service,
    }));
}

/**
 * Returns the service catalog for one carrier. Reads the env override on
 * every call so tests and runtime toggles need no reload.
 */
export function getServiceCatalog(carrier: SeamCarrier): ServiceCatalogEntry[] {
  const override =
    process.env[`SLG_INTERNAL_SERVICES_${carrier.toUpperCase()}`];
  if (override !== undefined) return parseCatalogOverride(override);
  return DEFAULT_SERVICE_CATALOG[carrier];
}

/** Test-only: the code-owned defaults (so tests can pin behavior). */
export function __defaultServiceCatalog(
  carrier: SeamCarrier,
): ServiceCatalogEntry[] {
  return DEFAULT_SERVICE_CATALOG[carrier];
}

import { randomUUID } from "node:crypto";
import { config } from "../config";
import { log, errorDetails } from "../core/logger";
import type {
  CustomsDetails,
  CustomsMoney,
  ShipmentDocument,
} from "./carrier-types";
import type { DutyTaxEstimate } from "./customs";

export type SeamCarrier = "fedex" | "ups" | "usps" | "stamps";

export interface SeamAddress {
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
}

export interface SeamPackage {
  weight: number;
  length?: number;
  width?: number;
  height?: number;
  insuredValue?: number;
}

export interface SeamRate {
  carrier: SeamCarrier;
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

export interface SeamLabel {
  carrier: SeamCarrier;
  trackingNumber: string;
  labelData: string;
  format: "PDF" | "ZPL";
  environment?: "sandbox" | "production";
  cost?: number;
  /** Sanitized customs/generated/uploaded documents (FedEx international). */
  documents?: ShipmentDocument[];
  /** Non-fatal document problems (e.g. post-shipment upload failed). */
  documentWarnings?: string[];
}

export interface RateQuoteParams {
  carrier: SeamCarrier | "all";
  from: SeamAddress;
  to: SeamAddress;
  packages: SeamPackage[];
  serviceType?: string;
  packagingType?: string;
  shipDate?: string;
  rateTypes?: Array<"ACCOUNT" | "LIST">;
  preferredRateType?: "ACCOUNT" | "LIST";
  strictRateType?: boolean;
}

export interface CreateShipmentParams {
  carrier: SeamCarrier;
  from: SeamAddress;
  to: SeamAddress;
  packages: SeamPackage[];
  serviceType: string;
  labelFormat: "PDF" | "ZPL";
  packagingType?: string;
  labelSize?: string;
  shipDate?: string;
  reference?: string;
  /** Vendor pickup/drop-off selection. */
  pickup?: {
    type: "pickup" | "dropoff";
    date?: string;
    readyTime?: string;
    closeTime?: string;
    instructions?: string;
    address?: SeamAddress;
  };
  /** FedEx international customs payload (validated server-side). */
  customs?: CustomsDetails;
}

export interface DutyTaxEstimateParams {
  from: SeamAddress;
  to: SeamAddress;
  serviceType?: string;
  shippingCost?: CustomsMoney;
  customs: CustomsDetails;
}

export interface ServiceCatalogEntry {
  service: string;
  description: string;
}

interface SeamClientOptions {
  baseUrl?: string;
  apiKey?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

function makeAuthHeaders(
  requestId: string,
  apiKey: string = config.internalApiKey,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "X-Request-Id": requestId,
  };
}

async function fetchJson<T>(
  method: "GET" | "POST",
  url: string,
  body: unknown | undefined,
  requestId: string,
  options: SeamClientOptions,
): Promise<T> {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;

  const response = await fetcher(url, {
    method,
    headers: makeAuthHeaders(requestId, options.apiKey),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await response.text();
  if (!response.ok) {
    log("warn", "seam_request_failed", {
      requestId,
      url,
      status: response.status,
      bodyPreview: text.slice(0, 500),
    });
    const error: Error & {
      status?: number;
      code?: string;
      details?: unknown;
    } = new Error(`Seam ${method} ${url} failed: HTTP ${response.status}`);
    error.status = response.status;
    error.code = "SEAM_REQUEST_FAILED";
    try {
      const parsed = JSON.parse(text) as {
        error?: unknown;
        code?: unknown;
        details?: unknown;
      };
      if (typeof parsed.error === "string" && parsed.error.length > 0) {
        // Keep the HTTP status in the message for existing diagnostics.
        error.message = `${parsed.error} (HTTP ${response.status})`;
      }
      if (typeof parsed.code === "string" && parsed.code.length > 0) {
        error.code = parsed.code;
      }
      if (Array.isArray(parsed.details)) error.details = parsed.details;
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    throw error;
  }

  try {
    return JSON.parse(text) as T;
  } catch (parseError) {
    log("error", "seam_response_parse_failed", {
      requestId,
      url,
      error: errorDetails(parseError),
      bodyPreview: text.slice(0, 500),
    });
    const error: Error & { code?: string } = new Error(
      "Seam response was not valid JSON",
    );
    error.code = "SEAM_RESPONSE_PARSE_FAILED";
    throw error;
  }
}

export function createSeamClient(options: SeamClientOptions = {}) {
  const baseUrl = (options.baseUrl ?? config.internalApiBaseUrl).replace(
    /\/$/,
    "",
  );

  return {
    async getServices(
      carrier: SeamCarrier,
      requestId?: string,
    ): Promise<{ carrier: SeamCarrier; services: ServiceCatalogEntry[] }> {
      const id = requestId ?? randomUUID();
      const url = `${baseUrl}/internal/shipping/services/${encodeURIComponent(carrier)}`;
      return fetchJson("GET", url, undefined, id, options);
    },

    async rateQuote(
      params: RateQuoteParams,
      requestId?: string,
    ): Promise<{ rates: SeamRate[] }> {
      const id = requestId ?? randomUUID();
      const url = `${baseUrl}/internal/shipping/rate-quote`;
      const body = {
        carrier: params.carrier,
        from: params.from,
        to: params.to,
        packages: params.packages,
        ...(params.serviceType && { serviceType: params.serviceType }),
        ...(params.packagingType && { packagingType: params.packagingType }),
        ...(params.shipDate && { shipDate: params.shipDate }),
        ...(params.rateTypes && { rateTypes: params.rateTypes }),
        ...(params.preferredRateType && {
          preferredRateType: params.preferredRateType,
        }),
        ...(params.strictRateType !== undefined && {
          strictRateType: params.strictRateType,
        }),
      };
      return fetchJson("POST", url, body, id, options);
    },

    async createShipment(
      params: CreateShipmentParams,
      requestId?: string,
    ): Promise<{ labels: SeamLabel[] }> {
      const id = requestId ?? randomUUID();
      const url = `${baseUrl}/internal/shipping/create-shipment`;
      const body = {
        carrier: params.carrier,
        from: params.from,
        to: params.to,
        packages: params.packages,
        serviceType: params.serviceType,
        labelFormat: params.labelFormat,
        ...(params.packagingType && { packagingType: params.packagingType }),
        ...(params.labelSize && { labelSize: params.labelSize }),
        ...(params.shipDate && { shipDate: params.shipDate }),
        ...(params.reference && { reference: params.reference }),
        ...(params.pickup && { pickup: params.pickup }),
        ...(params.customs && { customs: params.customs }),
      };
      return fetchJson("POST", url, body, id, options);
    },

    async dutyTaxEstimate(
      params: DutyTaxEstimateParams,
      requestId?: string,
    ): Promise<{ estimate: DutyTaxEstimate }> {
      const id = requestId ?? randomUUID();
      const url = `${baseUrl}/internal/shipping/duty-tax-estimate`;
      const body = {
        carrier: "fedex",
        from: params.from,
        to: params.to,
        ...(params.serviceType && { serviceType: params.serviceType }),
        ...(params.shippingCost && { shippingCost: params.shippingCost }),
        customs: params.customs,
      };
      return fetchJson("POST", url, body, id, options);
    },
  };
}

export const seamClient = createSeamClient();

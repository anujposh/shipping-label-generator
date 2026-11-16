/**
 * Internal shipping seam router — plan §4 Decision 1 (Option A).
 *
 * Exposes EXACTLY:
 *   POST /rate-quote        -> carrier rate shop (sanitized quotes)
 *   POST /create-shipment   -> carrier label creation (sanitized labels)
 *   GET  /services/:carrier -> static per-carrier service catalog
 * mounted by server.ts at /internal/shipping. Anything else 404s.
 *
 * Session/BC strategy (plan §4): this seam never touches shipping.service
 * (no LogisticsSession, no tliLocations, no tliShippingAgentServices lookups,
 * no Business Central reads). It calls the carrier.service facade directly
 * with cfg=undefined so each carrier client resolves its credentials
 * per-field from process.env (the CARRIER_ENV_CREDENTIALS / FEDEX_* / UPS_* /
 * USPS_* / STAMPS_* surface) and requires the caller to supply the explicit
 * service code.
 *
 * Gating (all failures are indistinguishable 404s, matching the server's
 * unknown-route shape):
 *   - SLG_INTERNAL_API_ENABLED must be "true" AND SLG_INTERNAL_API_KEY set,
 *   - SLG_INTERNAL_API_ALLOWED_IPS (comma-separated), when set, must contain
 *     the client IP,
 *   - Authorization: Bearer <key> must match via timingSafeEqual (mirrors
 *     core/metrics.ts isMetricsRequestAuthorized).
 *
 * When the flag is off (the default) every path answers 404 exactly like an
 * unknown route — no behavior change for any existing consumer.
 */

import { timingSafeEqual } from "node:crypto";
import {
  type ErrorRequestHandler,
  NextFunction,
  Request,
  Response,
  Router,
} from "express";
import { errorDetails, log } from "../../core/logger";
import * as carrierService from "../../carriers/carrier.service";
import {
  fakeCreateShipment,
  fakeDutyTaxEstimate,
  fakeRateShop,
  isFakeCarrierMode,
} from "../services/fake-carriers";
import {
  CarrierApiError,
  CarrierRateLimitError,
  CarrierValidationError,
} from "../../carriers/carrier-errors";
import type {
  Carrier,
  CarrierLabel,
  RateQuote,
  RateShopArgs,
  ShipmentRequest,
} from "../../carriers/carrier-types";
import {
  isSeamCarrier,
  sanitizeCarrierLabel,
  sanitizeRateQuote,
  sanitizeCreateShipmentRequest,
  sanitizeDutyTaxEstimateRequest,
  sanitizeRateQuoteRequest,
} from "../internal-shipping.dto";
import type {
  DutyTaxEstimate,
  DutyTaxEstimateInput,
} from "../../carriers/customs";
import { getServiceCatalog } from "../services/service-catalog";

/** Overridable carrier operations (tests inject fakes; prod uses the facade). */
export interface InternalShippingDeps {
  rateShop?: (
    carrier: Carrier | "all",
    args: RateShopArgs,
    cfg?: never,
  ) => Promise<RateQuote[]>;
  createShipment?: (
    carrier: Carrier,
    shipment: ShipmentRequest,
    cfg?: never,
  ) => Promise<CarrierLabel[]>;
  estimateDutyTax?: (
    carrier: Carrier,
    input: DutyTaxEstimateInput,
    cfg?: never,
  ) => Promise<DutyTaxEstimate>;
}

function isSeamEnabled(): boolean {
  return (
    process.env.SLG_INTERNAL_API_ENABLED === "true" &&
    typeof process.env.SLG_INTERNAL_API_KEY === "string" &&
    process.env.SLG_INTERNAL_API_KEY.length > 0
  );
}

/** Strips the IPv6-mapped prefix so "::ffff:127.0.0.1" == "127.0.0.1". */
function normalizeIp(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

function allowedIps(): string[] {
  const raw = process.env.SLG_INTERNAL_API_ALLOWED_IPS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => normalizeIp(entry.trim()))
    .filter(Boolean);
}

function isIpAllowed(req: Request): boolean {
  const allow = allowedIps();
  if (allow.length === 0) return true;
  const client = normalizeIp(req.ip ?? req.socket.remoteAddress ?? "unknown");
  return allow.includes(client);
}

/** Bearer shared-secret compare — mirrors core/metrics.ts. */
function isRequestAuthorized(
  authorization: string | undefined,
  secret: string | undefined,
): boolean {
  if (!secret || !authorization?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(authorization.slice("Bearer ".length));
  const expected = Buffer.from(secret);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

function notFound(res: Response): void {
  res.status(404).json({ error: "Not found" });
}

/**
 * Builds the seam router. Mount at /internal/shipping. Every request passes
 * the flag + IP + shared-secret gate before any route matches; the trailing
 * router.use keeps unknown sub-paths byte-identical 404s.
 */
export function createInternalShippingRouter(
  deps: InternalShippingDeps = {},
): Router {
  // DEV-ONLY fake carrier mode (SLG_INTERNAL_FAKE_CARRIERS=true, never in
  // production): return deterministic fake rates/labels so the isolated
  // shipping-label-generator UI can be exercised without carrier credentials.
  const fakeMode = isFakeCarrierMode();
  const rateShop =
    deps.rateShop ?? (fakeMode ? fakeRateShop : carrierService.rateShop);
  const createShipment =
    deps.createShipment ??
    (fakeMode ? fakeCreateShipment : carrierService.createShipment);
  const estimateDutyTax =
    deps.estimateDutyTax ??
    (fakeMode ? fakeDutyTaxEstimate : carrierService.estimateDutyTax);

  const router = Router();

  router.use((req: Request, res: Response, next: NextFunction): void => {
    if (!isSeamEnabled()) {
      log("warn", "internal_shipping_request_rejected", {
        requestId: req.requestId,
        reason: "disabled",
        path: req.path,
      });
      notFound(res);
      return;
    }
    if (!isIpAllowed(req)) {
      log("warn", "internal_shipping_request_rejected", {
        requestId: req.requestId,
        reason: "ip_not_allowed",
        path: req.path,
      });
      notFound(res);
      return;
    }
    if (
      !isRequestAuthorized(
        req.header("authorization"),
        process.env.SLG_INTERNAL_API_KEY,
      )
    ) {
      log("warn", "internal_shipping_request_rejected", {
        requestId: req.requestId,
        reason: "unauthorized",
        path: req.path,
      });
      notFound(res);
      return;
    }
    next();
  });

  router.post(
    "/rate-quote",
    (req: Request, res: Response, next: NextFunction): void => {
      void (async (): Promise<void> => {
        const parsed = sanitizeRateQuoteRequest(req.body);
        if (!parsed.ok) {
          res.status(400).json({
            error: parsed.error,
            code: "VALIDATION_ERROR",
            ...(parsed.details ? { details: parsed.details } : {}),
            ...(parsed.details
              ? {
                  fieldErrors: Object.fromEntries(
                    parsed.details.map((entry) => [entry.field, entry.message]),
                  ),
                }
              : {}),
          });
          return;
        }
        // cfg stays undefined: carrier clients resolve env credentials per field.
        const quotes = await rateShop(parsed.value.carrier, parsed.value.args);
        log("info", "internal_shipping_rate_quote", {
          requestId: req.requestId,
          carrier: parsed.value.carrier,
          rateCount: quotes.length,
        });
        res.setHeader("Cache-Control", "no-store");
        res.status(200).json({ rates: quotes.map(sanitizeRateQuote) });
      })().catch(next);
    },
  );

  router.post(
    "/create-shipment",
    (req: Request, res: Response, next: NextFunction): void => {
      void (async (): Promise<void> => {
        const parsed = sanitizeCreateShipmentRequest(req.body);
        if (!parsed.ok) {
          res.status(400).json({
            error: parsed.error,
            code: "VALIDATION_ERROR",
            ...(parsed.details ? { details: parsed.details } : {}),
            ...(parsed.details
              ? {
                  fieldErrors: Object.fromEntries(
                    parsed.details.map((entry) => [entry.field, entry.message]),
                  ),
                }
              : {}),
          });
          return;
        }
        // cfg stays undefined: carrier clients resolve env credentials per
        // field. The explicit caller-supplied serviceType passes through
        // (no BC tliShippingAgentServices resolution — plan Decision 1).
        const labels = await createShipment(
          parsed.value.carrier,
          parsed.value.shipment,
        );
        log("info", "internal_shipping_create_shipment", {
          requestId: req.requestId,
          carrier: parsed.value.carrier,
          labelCount: labels.length,
        });
        res.setHeader("Cache-Control", "no-store");
        res.status(200).json({ labels: labels.map(sanitizeCarrierLabel) });
      })().catch(next);
    },
  );

  router.post(
    "/duty-tax-estimate",
    (req: Request, res: Response, next: NextFunction): void => {
      void (async (): Promise<void> => {
        const parsed = sanitizeDutyTaxEstimateRequest(req.body);
        if (!parsed.ok) {
          res.status(400).json({
            error: parsed.error,
            code: "VALIDATION_ERROR",
            ...(parsed.details ? { details: parsed.details } : {}),
            ...(parsed.details
              ? {
                  fieldErrors: Object.fromEntries(
                    parsed.details.map((entry) => [entry.field, entry.message]),
                  ),
                }
              : {}),
          });
          return;
        }
        const estimate = await estimateDutyTax(parsed.value.carrier, {
          from: parsed.value.from,
          to: parsed.value.to,
          ...(parsed.value.serviceType
            ? { serviceType: parsed.value.serviceType }
            : {}),
          ...(parsed.value.shippingCost
            ? { shippingCost: parsed.value.shippingCost }
            : {}),
          customs: parsed.value.customs,
        });
        log("info", "internal_shipping_duty_tax_estimate", {
          requestId: req.requestId,
          commodityCount: parsed.value.customs.commodities.length,
        });
        res.setHeader("Cache-Control", "no-store");
        res.status(200).json({ estimate });
      })().catch(next);
    },
  );

  router.get(
    "/services/:carrier",
    (req: Request, res: Response, next: NextFunction): void => {
      void (async (): Promise<void> => {
        const carrier = String(req.params.carrier ?? "").toLowerCase();
        if (!isSeamCarrier(carrier)) {
          notFound(res);
          return;
        }
        res.setHeader("Cache-Control", "no-store");
        res.status(200).json({
          carrier,
          services: getServiceCatalog(carrier),
        });
      })().catch(next);
    },
  );

  // Unknown sub-path / wrong method — indistinguishable from the server-wide
  // unknown-route 404.
  router.use((_req: Request, res: Response): void => {
    notFound(res);
  });

  // Carrier errors map onto a small, sanitized contract. Raw carrier response
  // bodies (CarrierApiError.body) are never serialized to the client.
  const internalShippingErrorHandler: ErrorRequestHandler = (
    error: unknown,
    req: Request,
    res: Response,
    _next: NextFunction,
  ): void => {
    log("error", "internal_shipping_error", {
      requestId: req.requestId,
      error: errorDetails(error),
    });
    if (error instanceof CarrierValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof CarrierRateLimitError) {
      res.status(429).json({ error: "Carrier rate limit exceeded" });
      return;
    }
    if (error instanceof CarrierApiError) {
      res.status(502).json({
        error: "Carrier request failed",
        message: error.message,
      });
      return;
    }
    res.status(502).json({ error: "Carrier request failed" });
  };
  router.use(internalShippingErrorHandler);

  return router;
}

/** Default instance mounted by server.ts at /internal/shipping. */
export const internalShippingRouter = createInternalShippingRouter();

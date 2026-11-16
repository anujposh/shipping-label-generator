/**
 * Internal shipping seam router — flag-gated, shared-secret authenticated,
 * IP-allowlisted, exact-endpoint-allowlisted.
 *
 * Historical plan: docs/original-implementation-plan.md §4 Decision 1 (Option A).
 *
 * Gating: SLG_INTERNAL_API_ENABLED must be exactly "true" AND
 * SLG_INTERNAL_API_KEY must be set. When either is missing, EVERY request
 * (including unknown paths) returns 404 — indistinguishable from an unknown
 * route, and no behavior changes anywhere in the app while disabled.
 *
 * Auth mirrors backend/src/core/metrics.ts isMetricsRequestAuthorized:
 * Bearer token compared with timingSafeEqual.
 *
 * IP allowlist: SLG_INTERNAL_API_ALLOWED_IPS (comma-separated). When set,
 * requests from other IPs get 404 (indistinguishable unknown route).
 */
import { timingSafeEqual } from "node:crypto";
import { NextFunction, Request, Response, Router } from "express";
import { errorDetails, log } from "../core/logger";
import { normalizeCarrier } from "../carriers/carrier.service";
import {
  mapCarrierError,
  rateQuote,
  createShipment,
  serviceCatalog,
  validateCreateShipmentRequest,
  validateRateQuoteRequest,
} from "./internal-shipping.service";

export const internalShippingRouter = Router();

function seamEnabled(): boolean {
  return (
    process.env.SLG_INTERNAL_API_ENABLED === "true" &&
    typeof process.env.SLG_INTERNAL_API_KEY === "string" &&
    process.env.SLG_INTERNAL_API_KEY.length > 0
  );
}

function isSeamRequestAuthorized(
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

function allowedIps(): Set<string> | null {
  const raw = process.env.SLG_INTERNAL_API_ALLOWED_IPS;
  if (!raw) return null;
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.length ? new Set(entries) : null;
}

function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "";
}

/** 404 response identical to the app's global unknown-route handler so the
 * seam is indistinguishable from an unregistered route when disabled,
 * unauthorized, or IP-rejected. */
function notFound(res: Response): void {
  res.status(404).json({ error: "Not found" });
}

// Gate everything — flag, key, IP — before any route matching.
internalShippingRouter.use(
  (req: Request, res: Response, next: NextFunction) => {
    if (!seamEnabled()) {
      notFound(res);
      return;
    }
    const allow = allowedIps();
    if (allow && !allow.has(clientIp(req))) {
      log("warn", "internal_shipping_seam_ip_rejected", {
        requestId: req.requestId,
        ip: clientIp(req),
      });
      notFound(res);
      return;
    }
    if (
      !isSeamRequestAuthorized(
        req.header("authorization"),
        process.env.SLG_INTERNAL_API_KEY,
      )
    ) {
      log("warn", "internal_shipping_seam_auth_rejected", {
        requestId: req.requestId,
        ip: clientIp(req),
      });
      notFound(res);
      return;
    }
    next();
  },
);

function wrap(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };
}

internalShippingRouter.post(
  "/rate-quote",
  wrap(async (req, res) => {
    const validation = validateRateQuoteRequest(req.body ?? {});
    if (!validation.ok || !validation.value) {
      res.status(400).json({
        error: "Invalid request",
        code: "VALIDATION_ERROR",
        details: validation.errors,
      });
      return;
    }
    try {
      const quotes = await rateQuote(validation.value);
      res.status(200).json({ quotes });
    } catch (error) {
      throw mapCarrierError(error);
    }
  }),
);

internalShippingRouter.post(
  "/create-shipment",
  wrap(async (req, res) => {
    const validation = validateCreateShipmentRequest(req.body ?? {});
    if (!validation.ok || !validation.value) {
      res.status(400).json({
        error: "Invalid request",
        code: "VALIDATION_ERROR",
        details: validation.errors,
      });
      return;
    }
    try {
      const labels = await createShipment(validation.value);
      res.status(200).json({ labels });
    } catch (error) {
      throw mapCarrierError(error);
    }
  }),
);

// Static per-carrier service-type catalog (env-overridable) — NOT BC lookups.
internalShippingRouter.get(
  "/services/:carrier",
  wrap(async (req, res) => {
    const carrier = normalizeCarrier(req.params.carrier);
    if (carrier === "all") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(200).json({ carrier, services: serviceCatalog(carrier) });
  }),
);

// Allowlist: anything else under the mounted prefix is 404 (never falls
// through to a method rewrite or implicit GET listing).
internalShippingRouter.use((req: Request, res: Response) => {
  notFound(res);
});

// Error handler pinned to the seam contract.
internalShippingRouter.use(
  (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status =
      typeof (error as { status?: unknown })?.status === "number"
        ? (error as { status: number }).status
        : 500;
    if (status >= 500) {
      log("error", "internal_shipping_seam_request_failed", {
        error: errorDetails(error),
      });
    }
    res.status(status).json({
      error:
        status >= 500
          ? "Internal server error"
          : String((error as Error)?.message ?? error),
    });
  },
);

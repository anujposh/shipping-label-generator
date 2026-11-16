import path from "path";
import dotenv from "dotenv";
import express, { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import { config } from "./config";
import { requestContext } from "./core/request-context";
import { createRateLimit, tokenRateLimitKey } from "./core/rate-limit";
import { createVendorRouter } from "./routes/vendor.routes";
import { createAdminRouter } from "./routes/admin.routes";
import { internalShippingRouter } from "./internal-shipping/routes/internal-shipping.routes";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const app = express();

app.disable("x-powered-by");
app.set(
  "trust proxy",
  config.nodeEnv === "production"
    ? process.env.TRUST_PROXY_HOPS
      ? Number(process.env.TRUST_PROXY_HOPS)
      : true
    : 1,
);

app.use(helmet());
app.use(requestContext);

// FedEx ETD documents travel inline as base64 (up to 5 files × 5 MiB raw,
// ≈ 33 MiB base64 + JSON overhead). Only the endpoints that accept customs
// payloads get the larger parser; everything else stays at 256 kb.
const CUSTOMS_UPLOAD_JSON_LIMIT = "40mb";
app.use("/v1/shipment", express.json({ limit: CUSTOMS_UPLOAD_JSON_LIMIT }));
app.use(
  "/v1/duty-tax-estimate",
  express.json({ limit: CUSTOMS_UPLOAD_JSON_LIMIT }),
);
app.use(
  "/internal/shipping/create-shipment",
  express.json({ limit: CUSTOMS_UPLOAD_JSON_LIMIT }),
);
app.use(
  "/internal/shipping/duty-tax-estimate",
  express.json({ limit: CUSTOMS_UPLOAD_JSON_LIMIT }),
);
app.use(express.json({ limit: "256kb" }));

const publicRateLimit = createRateLimit({
  name: "public_api",
  points: 120,
  durationSeconds: 60,
  blockSeconds: 60,
});

const tokenRateLimit = createRateLimit({
  name: "token_api",
  points: 60,
  durationSeconds: 60,
  blockSeconds: 60,
  key: (req) => tokenRateLimitKey(req),
});

const adminRateLimit = createRateLimit({
  name: "admin_api",
  points: 120,
  durationSeconds: 60,
  blockSeconds: 60,
});

app.get("/healthz", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

// Internal shipping seam (/internal/shipping/*) — flag-gated
// (SLG_INTERNAL_API_ENABLED), shared-secret + optional IP-allowlist
// authenticated inside the router itself. When disabled every sub-path
// answers 404 exactly like an unknown route.
app.use("/internal/shipping", internalShippingRouter);

app.use("/v1", publicRateLimit);
app.use("/v1", tokenRateLimit);
app.use("/v1", createVendorRouter());

app.use("/admin/v1", adminRateLimit, createAdminRouter());

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  let status = Number((err as { status?: number })?.status);
  if (!Number.isInteger(status) || status < 400 || status > 499) status = 500;
  if ((err as { type?: string })?.type === "entity.too.large") status = 413;
  else if ((err as { type?: string })?.type === "entity.parse.failed")
    status = 400;

  res.status(status).json({
    error: status >= 500 ? "Internal server error" : message,
  });
});

const PORT = config.apiPort;

const server = app.listen(PORT, () => {
  console.log(`slg-api listening on port ${PORT}`);
});

server.headersTimeout = 60_000;
server.requestTimeout = 60_000;
server.keepAliveTimeout = 30_000;
server.maxHeadersCount = 100;

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = setTimeout(() => {
    server.closeAllConnections();
    process.exit(1);
  }, 10_000).unref();
  server.close((error) => {
    clearTimeout(deadline);
    process.exit(error ? 1 : 0);
  });
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

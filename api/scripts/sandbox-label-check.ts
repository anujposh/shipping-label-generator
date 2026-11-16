/**
 * Sandbox-only carrier authentication / label / international-customs check.
 *
 * Opt-in harness. The default invocation keeps the original domestic carrier
 * sweep; international scenarios are opt-in via CLI flag or environment.
 *
 *   --scenario=domestic (default)
 *   --scenario=international-us-ca   US -> CA, two commodities, FedEx-generated
 *                                    COMMERCIAL_INVOICE + CERTIFICATE_OF_ORIGIN
 *   --scenario=documents-only        FedEx documents-only (Express service,
 *                                    explicit 1 USD synthetic declared value:
 *                                    FedEx rejects zero-value documents-only)
 *
 * Optional flags, international scenarios only:
 *
 *   --with-etd-upload     Second, clearly-labelled shipment attempt that attaches
 *                         a pre-shipment ETD PDF upload. Only runs after the
 *                         base label succeeds.
 *   --with-duty-estimate  Read-only, non-guaranteed duty/tax estimate for the
 *                         same customs payload.
 *
 * Environment equivalents:
 *
 *   SANDBOX_SCENARIO=international-us-ca
 *   WITH_ETD_UPLOAD=1
 *   WITH_DUTY_ESTIMATE=1
 *
 * ## Safety model
 *
 * - Refuses to run unless the effective FedEx environment (FEDEX_BASE_URL, or
 *   the CARRIER_SANDBOX default) is the sandbox API host. There is deliberately
 *   no production mode and no override flag.
 * - Refuses production-named carrier settings, non-sandbox document hosts,
 *   non-loopback internal seam URLs, and fake-carrier mode.
 * - Talks only to the loopback internal shipping seam; carrier credentials stay
 *   inside the API process.
 * - Uses synthetic addresses/commodities/documents only.
 * - No retries: each shipment write happens at most once per scenario step, so
 *   a failed call cannot duplicate a label.
 * - Never logs or persists credentials, request bodies, or raw carrier
 *   responses. results.json/README.md and label/document artifacts are written
 *   under api/test-results/sandbox-labels with 0600/0700 permissions.
 *
 * ## Safe commands
 *
 * Assume `api/.env` points `SLG_INTERNAL_API_BASE_URL` at the loopback API,
 * `CARRIER_SANDBOX=true` (or a sandbox FEDEX_BASE_URL), and sandbox-issued
 * FedEx credentials. Never run against production credentials.
 *
 *   cd api
 *   npm run sandbox:labels
 *   npm run sandbox:labels -- --scenario=international-us-ca
 *   npm run sandbox:labels -- --scenario=international-us-ca --with-duty-estimate
 *   npm run sandbox:labels -- --scenario=international-us-ca --with-etd-upload --with-duty-estimate
 *   npm run sandbox:labels -- --scenario=documents-only
 *   SANDBOX_SCENARIO=international-us-ca WITH_DUTY_ESTIMATE=1 npm run sandbox:labels
 *
 * ETD upload and duty-tax estimate are credential/permission-gated FedEx
 * sub-flows; their failures are recorded, not retried. Duty-tax figures are
 * non-guaranteed by definition.
 *
 * Documents-only shipments must use an Express service; Ground is rejected by
 * FedEx for those shipments.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { PDFDocument } from "pdf-lib";

export type Carrier = "fedex" | "ups" | "usps" | "stamps";
export type AuthMode = "missing" | "wrong" | "valid";
export type ScenarioName =
  "domestic" | "international-us-ca" | "documents-only";
export type Env = Record<string, string | undefined>;

export interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

export interface AuthCheck {
  ok: boolean;
  expectedStatus: number;
  actualStatus?: number;
  error?: string;
}

export interface RateCheck {
  attempted: boolean;
  ok: boolean;
  httpStatus?: number;
  rateCount?: number;
  error?: string;
}

export interface LabelCheck {
  supported: boolean;
  attempted: boolean;
  ok: boolean;
  httpStatus?: number;
  environment?: "sandbox";
  environmentEvidence?: string;
  trackingNumber?: string;
  artifact?: string;
  bytes?: number;
  sha256?: string;
  pdfPages?: number;
  reason?: string;
  error?: string;
}

export interface DocumentArtifact {
  documentType: string;
  docType: string;
  fileName: string;
  artifact: string;
  bytes: number;
  sha256: string;
  source: string;
  uploadStatus?: string;
}

export interface DutyEstimateResult {
  attempted: boolean;
  ok: boolean;
  nonGuaranteed?: true;
  guaranteed?: false;
  currency?: string;
  disclaimer?: string;
  duties?: unknown[];
  fees?: unknown[];
  taxes?: unknown[];
  summary?: Record<string, unknown>;
  error?: string;
}

export interface EtdAttemptResult {
  attempted: boolean;
  ok: boolean;
  label?: LabelCheck;
  documents?: DocumentArtifact[];
  error?: string;
}

export interface InternationalResult {
  scenario: ScenarioName;
  withEtdUpload: boolean;
  withDutyEstimate: boolean;
  label: LabelCheck;
  documents: DocumentArtifact[];
  dutyEstimate: DutyEstimateResult;
  etdAttempt: EtdAttemptResult;
}

export interface CarrierResult {
  carrier: Carrier;
  credentialsPresent: boolean;
  sandboxEndpointChecked: boolean;
  rateAuthentication: RateCheck;
  label: LabelCheck;
}

export interface ScenarioSelection {
  name: ScenarioName;
  withEtdUpload: boolean;
  withDutyEstimate: boolean;
}

export const API_ROOT = path.resolve(__dirname, "..");
export const PROJECT_ROOT = path.resolve(API_ROOT, "..");
const ENV_FILE = path.join(API_ROOT, ".env");
export const OUTPUT_DIR = path.join(API_ROOT, "test-results", "sandbox-labels");
const RESULTS_FILE = path.join(OUTPUT_DIR, "results.json");
const README_FILE = path.join(OUTPUT_DIR, "README.md");
const INVALID_KEY = "slg-deliberately-invalid-sandbox-key";

export const CREDENTIALS: Record<Carrier, readonly string[]> = {
  fedex: ["FEDEX_API_KEY", "FEDEX_API_SECRET", "FEDEX_ACCOUNT_NUMBER"],
  ups: ["UPS_CLIENT_ID", "UPS_CLIENT_SECRET", "UPS_ACCOUNT_NUMBER"],
  usps: ["USPS_CLIENT_ID", "USPS_CLIENT_SECRET", "USPS_ACCOUNT_NUMBER"],
  stamps: ["STAMPS_CLIENT_ID", "STAMPS_CLIENT_SECRET", "STAMPS_REFRESH_TOKEN"],
};

const CARRIERS: readonly Carrier[] = ["fedex", "ups", "usps", "stamps"];
const LABEL_CARRIERS = new Set<Carrier>(["fedex", "ups", "usps"]);
const SERVICE_TYPES: Record<Carrier, string> = {
  fedex: "FEDEX_GROUND",
  ups: "03",
  usps: "USPS_GROUND_ADVANTAGE",
  stamps: "usps_ground_advantage",
};

/** FedEx API sandbox host; any other effective host is refused. */
export const FEDEX_SANDBOX_API_HOST = "apis-sandbox.fedex.com";
/** FedEx ETD document sandbox host (not the API host). */
export const FEDEX_SANDBOX_DOCUMENT_HOST = "documentapitest.prod.fedex.com";

const KNOWN_SANDBOX_HOSTS: Record<string, readonly string[]> = {
  FEDEX_BASE_URL: [FEDEX_SANDBOX_API_HOST],
  FEDEX_DOCUMENT_BASE_URL: [FEDEX_SANDBOX_DOCUMENT_HOST],
  STAMPS_BASE_URL: ["api.testing.stampsendicia.com"],
  STAMPS_SIGNIN_URL: ["signin.testing.stampsendicia.com"],
  USPS_RATE_BASE_URL: ["apis-tem.usps.com"],
  UPS_BASE_URL: ["wwwcie.ups.com"],
};

const SCENARIO_NAMES: readonly ScenarioName[] = [
  "domestic",
  "international-us-ca",
  "documents-only",
];

// ---------------------------------------------------------------------------
// Scenario selection (pure; unit-tested)
// ---------------------------------------------------------------------------

function truthyFlag(value: string | undefined): boolean {
  return ["1", "true", "yes"].includes((value ?? "").trim().toLowerCase());
}

/** CLI flags win over environment; default stays the domestic sweep. */
export function parseScenario(
  argv: readonly string[],
  env: Env,
): ScenarioSelection {
  const rawFlag =
    argv
      .find((arg) => arg.startsWith("--scenario="))
      ?.slice("--scenario=".length) ?? (env.SANDBOX_SCENARIO ?? "").trim();

  let name: ScenarioName = "domestic";
  if (rawFlag) {
    if (!(SCENARIO_NAMES as readonly string[]).includes(rawFlag)) {
      throw new Error(
        `Unknown scenario "${rawFlag}"; expected one of ${SCENARIO_NAMES.join(
          ", ",
        )}`,
      );
    }
    name = rawFlag as ScenarioName;
  }

  return {
    name,
    withEtdUpload:
      argv.includes("--with-etd-upload") || truthyFlag(env.WITH_ETD_UPLOAD),
    withDutyEstimate:
      argv.includes("--with-duty-estimate") ||
      truthyFlag(env.WITH_DUTY_ESTIMATE),
  };
}

// ---------------------------------------------------------------------------
// Environment loading + sandbox-only guards (pure; unit-tested)
// ---------------------------------------------------------------------------

function parseHttpsUrl(raw: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  assert.equal(url.protocol, "https:", `${name} must use https`);
  assert.equal(url.username, "", `${name} must not contain credentials`);
  assert.equal(url.password, "", `${name} must not contain credentials`);
  return url;
}

export interface EffectiveFedexEnvironment {
  hostname: string;
  sandbox: boolean;
  source: "FEDEX_BASE_URL" | "CARRIER_SANDBOX" | "default";
}

/** Mirrors the carrier client's host precedence: explicit URL, else flag. */
export function effectiveFedexEnvironment(env: Env): EffectiveFedexEnvironment {
  if (env.FEDEX_BASE_URL?.trim()) {
    const url = parseHttpsUrl(env.FEDEX_BASE_URL.trim(), "FEDEX_BASE_URL");
    return {
      hostname: url.hostname,
      sandbox: /sandbox/i.test(url.hostname),
      source: "FEDEX_BASE_URL",
    };
  }
  if (env.CARRIER_SANDBOX?.trim() === "true") {
    return {
      hostname: FEDEX_SANDBOX_API_HOST,
      sandbox: true,
      source: "CARRIER_SANDBOX",
    };
  }
  return { hostname: "apis.fedex.com", sandbox: false, source: "default" };
}

function assertSandboxHostSetting(env: Env, key: string): void {
  const raw = env[key]?.trim();
  if (!raw) return;
  const url = parseHttpsUrl(raw, key);
  const allowed = KNOWN_SANDBOX_HOSTS[key];
  if (allowed) {
    assert.ok(
      allowed.includes(url.hostname),
      `Refusing non-sandbox ${key}: ${url.hostname} (expected ${allowed.join(
        " or ",
      )})`,
    );
    return;
  }
  assert.match(
    url.hostname,
    /sandbox|test|testing|wwwcie|tem\./i,
    `Refusing non-sandbox ${key}: ${url.hostname}`,
  );
}

/**
 * Refuses any configuration whose effective FedEx environment is production.
 * Also refuses production-named carrier settings and non-sandbox carrier hosts.
 */
export function assertSandboxOnlyEnvironment(env: Env): void {
  const flag = env.CARRIER_SANDBOX?.trim();
  if (flag !== undefined && flag !== "true") {
    throw new Error(
      `CARRIER_SANDBOX must be "true" for sandbox verification (saw "${flag}")`,
    );
  }

  const effective = effectiveFedexEnvironment(env);
  if (!effective.sandbox) {
    throw new Error(
      `Refusing non-sandbox FedEx environment: effective API host ${effective.hostname} (${effective.source}). Pin FEDEX_BASE_URL to https://${FEDEX_SANDBOX_API_HOST}/ or set CARRIER_SANDBOX=true.`,
    );
  }
  assert.equal(
    effective.hostname,
    FEDEX_SANDBOX_API_HOST,
    `Refusing FedEx API host ${effective.hostname}; expected ${FEDEX_SANDBOX_API_HOST}`,
  );

  for (const [key, value] of Object.entries(env)) {
    if (
      /^(FEDEX|UPS|USPS|STAMPS)_/.test(key) &&
      /(PRODUCTION|_PROD)/.test(key) &&
      (value ?? "").trim()
    ) {
      throw new Error(`Production-named carrier setting forbidden: ${key}`);
    }
  }

  for (const key of Object.keys(KNOWN_SANDBOX_HOSTS)) {
    assertSandboxHostSetting(env, key);
  }
}

/** Loopback-only internal seam config; refuses fake-carrier mode. */
export function assertInternalSeamConfig(env: Env): void {
  assert.equal(
    env.SLG_INTERNAL_API_ENABLED?.trim(),
    "true",
    "SLG_INTERNAL_API_ENABLED must be true",
  );
  assert.notEqual(
    (env.SLG_INTERNAL_FAKE_CARRIERS ?? "").trim().toLowerCase(),
    "true",
    "SLG_INTERNAL_FAKE_CARRIERS must not be true: fake labels are not sandbox evidence",
  );

  const key = env.SLG_INTERNAL_API_KEY?.trim();
  assert.ok(key, "SLG_INTERNAL_API_KEY is missing");
  assert.notEqual(
    key,
    INVALID_KEY,
    "SLG_INTERNAL_API_KEY must not be the harness negative-test key",
  );

  const raw = env.SLG_INTERNAL_API_BASE_URL?.trim();
  assert.ok(raw, "SLG_INTERNAL_API_BASE_URL is missing");
  const url = new URL(raw);
  assert.equal(
    url.username,
    "",
    "Internal API URL must not contain credentials",
  );
  assert.equal(
    url.password,
    "",
    "Internal API URL must not contain credentials",
  );
  assert.ok(
    ["127.0.0.1", "localhost", "::1"].includes(url.hostname),
    "Internal API URL must be loopback",
  );
}

/** Domestic sweep needs every carrier; international needs FedEx only. */
export function requiredCredentialKeys(
  scenario: ScenarioName,
): readonly string[] {
  return scenario === "domestic"
    ? Object.values(CREDENTIALS).flat()
    : CREDENTIALS.fedex;
}

export function assertRequiredCredentials(
  env: Env,
  scenario: ScenarioName,
): void {
  for (const key of requiredCredentialKeys(scenario)) {
    assert.ok(env[key]?.trim(), `Missing sandbox credential setting: ${key}`);
  }
}

/** Loads api/.env, then lets relevant shell env vars override it. */
export function loadEnv(processEnvironment: Env = process.env): Env {
  let fileEnv: Env = {};
  if (fs.existsSync(ENV_FILE)) {
    fileEnv = dotenv.parse(fs.readFileSync(ENV_FILE));
  }
  const overrides: Env = {};
  for (const [key, value] of Object.entries(processEnvironment)) {
    if (value === undefined) continue;
    if (
      /^(FEDEX|UPS|USPS|STAMPS|SLG_INTERNAL|CARRIER_SANDBOX|SANDBOX_|WITH_)/.test(
        key,
      )
    ) {
      overrides[key] = value;
    }
  }
  return { ...fileEnv, ...overrides };
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

export function secretsForRedaction(env: Env): string[] {
  const names = new Set<string>([
    "SLG_INTERNAL_API_KEY",
    ...Object.values(CREDENTIALS).flat(),
  ]);
  const values: string[] = [];
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string" && value.length > 0) values.push(value);
  }
  return values.sort((a, b) => b.length - a.length);
}

export function redact(value: unknown, secrets: readonly string[]): string {
  let text = value instanceof Error ? value.message : String(value);
  for (const secret of secrets) {
    text = text.split(secret).join("[REDACTED]");
  }
  text = text
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [REDACTED]")
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
      "[REDACTED_TOKEN]",
    );
  return text.slice(0, 500);
}

function apiError(result: ApiResult, secrets: readonly string[]): string {
  const parts = [result.body.error, result.body.message].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const detail = parts.length > 0 ? parts.join(": ") : "no error detail";
  return redact(`HTTP ${result.status} (${detail})`, secrets);
}

// ---------------------------------------------------------------------------
// Synthetic fixtures (pure; unit-tested)
// ---------------------------------------------------------------------------

const DOMESTIC_FROM = {
  addressLine1: "4120 Bingham Ave",
  city: "St. Louis",
  state: "MO",
  zipCode: "63116",
  countryCode: "US",
  contactName: "Sample Shipper",
  companyName: "SLG Sandbox Test",
  contactPhone: "3145551234",
} as const;

const DOMESTIC_TO = {
  addressLine1: "1100 Market St",
  city: "St. Louis",
  state: "MO",
  zipCode: "63118",
  countryCode: "US",
  contactName: "Sample Recipient",
  companyName: "SLG Sandbox Test",
  contactPhone: "3145555678",
} as const;

const CANADA_TO = {
  addressLine1: "100 Queen St W",
  city: "Toronto",
  state: "ON",
  zipCode: "M5H2N2",
  countryCode: "CA",
  contactName: "Sample Recipient",
  companyName: "SLG Sandbox Test",
  contactPhone: "4165550100",
} as const;

export function domesticShipmentBody(
  carrier: Carrier,
  shipDate: string,
  reference: string,
): Record<string, unknown> {
  return {
    carrier,
    from: { ...DOMESTIC_FROM },
    to: { ...DOMESTIC_TO },
    packages: [{ weight: 5, length: 10, width: 8, height: 4 }],
    serviceType: SERVICE_TYPES[carrier],
    ...(carrier === "fedex" ? { packagingType: "YOUR_PACKAGING" } : {}),
    labelFormat: "PDF",
    shipDate,
    reference,
  };
}

/**
 * US -> CA resale shipment: two commodities whose total matches
 * totalCustomsValue, plus FedEx-generated commercial invoice and
 * certificate of origin. All values synthetic.
 */
export function usCaCommodityCustoms(
  reference: string,
): Record<string, unknown> {
  const suffix = reference.slice(-8);
  return {
    shipmentPurpose: "COMMERCIAL",
    invoiceNumber: `INV-${suffix}`,
    shipmentReference: reference,
    termsOfSale: "DDP",
    currency: "USD",
    totalCustomsValue: { amount: 95, currency: "USD" },
    dutiesPayment: { paymentType: "SENDER" },
    commodities: [
      {
        name: "Printed Circuit Board Assembly",
        description: "Synthetic sandbox PCB assembly",
        intendedUse: "COMMERCIAL",
        quantity: 2,
        quantityUnits: "EA",
        unitPrice: 25,
        currency: "USD",
        weight: 2,
        weightUnits: "LB",
        hsCode: "853400",
        countryOfManufacture: "US",
        purpose: "BUSINESS",
      },
      {
        name: "Connector Kit",
        description: "Synthetic sandbox connector kit",
        intendedUse: "COMMERCIAL",
        quantity: 3,
        quantityUnits: "EA",
        unitPrice: 15,
        currency: "USD",
        weight: 3,
        weightUnits: "LB",
        hsCode: "853669",
        countryOfManufacture: "US",
        purpose: "BUSINESS",
      },
    ],
    documents: {
      etdEnabled: true,
      uploadTiming: "PRE_SHIPMENT",
      generatedTypes: ["COMMERCIAL_INVOICE", "CERTIFICATE_OF_ORIGIN"],
      uploads: [],
    },
  };
}

/**
 * Documents-only: the declared customs value is synthetic test data (1 USD).
 * FedEx destination customs rejects zero/null values for documents-only
 * shipments, so the fixture declares 1 USD explicitly. No caller commodities;
 * the backend synthesizes the single document line from this declared value
 * and the actual package weight.
 */
export function documentsOnlyCustoms(
  reference: string,
): Record<string, unknown> {
  const suffix = reference.slice(-8);
  return {
    isDocumentOnly: true,
    documentDescription: "Technical manuals and product specifications",
    shipmentPurpose: "NOT_COMMERCIAL",
    invoiceNumber: `DOC-${suffix}`,
    shipmentReference: reference,
    termsOfSale: "DDP",
    currency: "USD",
    // Explicit synthetic declaration (1 USD of documents); not a placeholder —
    // the backend copies it onto the synthesized commodity line.
    totalCustomsValue: { amount: 1, currency: "USD" },
    dutiesPayment: { paymentType: "SENDER" },
    documents: {
      etdEnabled: true,
      uploadTiming: "PRE_SHIPMENT",
      generatedTypes: [],
      uploads: [],
    },
  };
}

/** FedEx international body for either international scenario. */
export function internationalShipmentBody(
  scenario: ScenarioName,
  shipDate: string,
  reference: string,
): Record<string, unknown> {
  const documentsOnly = scenario === "documents-only";
  return {
    carrier: "fedex",
    from: { ...DOMESTIC_FROM },
    to: { ...CANADA_TO },
    packages: [
      { weight: documentsOnly ? 2 : 5, length: 10, width: 8, height: 4 },
    ],
    serviceType: "INTERNATIONAL_PRIORITY",
    packagingType: "YOUR_PACKAGING",
    labelFormat: "PDF",
    shipDate,
    reference,
    customs: documentsOnly
      ? documentsOnlyCustoms(reference)
      : usCaCommodityCustoms(reference),
  };
}

async function generatedPdfBase64(): Promise<string> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  page.drawText("SLG Sandbox ETD Upload Fixture", { x: 72, y: 720, size: 12 });
  page.drawText("Deliberately small, valid PDF for sandbox upload testing.", {
    x: 72,
    y: 680,
    size: 10,
  });
  return pdf.saveAsBase64();
}

// ---------------------------------------------------------------------------
// Seam client
// ---------------------------------------------------------------------------

async function callApi(
  baseUrl: string,
  internalKey: string,
  method: "GET" | "POST",
  endpoint: string,
  authMode: AuthMode,
  body?: Record<string, unknown>,
): Promise<ApiResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-request-id": `slg-sandbox-${Date.now()}`,
  };
  if (authMode === "valid") headers.authorization = `Bearer ${internalKey}`;
  if (authMode === "wrong") headers.authorization = `Bearer ${INVALID_KEY}`;

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${endpoint}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120_000),
  });

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    return {
      status: response.status,
      body: { error: "Internal API returned a non-JSON response" },
    };
  }
  return {
    status: response.status,
    body:
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { error: "Internal API returned an unexpected response shape" },
  };
}

async function authCheck(
  expectedStatus: number,
  action: () => Promise<ApiResult>,
  secrets: readonly string[],
): Promise<AuthCheck> {
  try {
    const result = await action();
    return {
      ok: result.status === expectedStatus,
      expectedStatus,
      actualStatus: result.status,
      ...(result.status === expectedStatus
        ? {}
        : { error: apiError(result, secrets) }),
    };
  } catch (error) {
    return { ok: false, expectedStatus, error: redact(error, secrets) };
  }
}

function decodePdf(labelData: unknown): Buffer {
  assert.ok(
    typeof labelData === "string" && labelData.length > 0,
    "Carrier returned no label data",
  );
  const compact = (labelData as string).replace(/\s/g, "");
  assert.ok(
    /^[A-Za-z0-9+/]*={0,2}$/.test(compact),
    "Label data is not valid base64",
  );
  assert.notEqual(compact.length % 4, 1, "Label base64 has an invalid length");
  const padded = compact.padEnd(
    compact.length + ((4 - (compact.length % 4)) % 4),
    "=",
  );
  const bytes = Buffer.from(padded, "base64");
  assert.ok(bytes.length > 5, "Decoded label is empty");
  assert.equal(
    bytes.toString("base64").replace(/=+$/, ""),
    compact.replace(/=+$/, ""),
    "Label base64 round-trip failed",
  );
  assert.equal(
    bytes.subarray(0, 5).toString("ascii"),
    "%PDF-",
    "Label is not a PDF",
  );
  return bytes;
}

function blankRateCheck(): RateCheck {
  return { attempted: false, ok: false };
}

function blankLabelCheck(carrier: Carrier): LabelCheck {
  return {
    supported: LABEL_CARRIERS.has(carrier),
    attempted: false,
    ok: false,
  };
}

function artifactName(
  prefix: string,
  trackingNumber: string,
  documentType: string,
  docType: string,
): string {
  const safeType = documentType.replace(/[^A-Za-z0-9_-]+/g, "-");
  const ext = docType.toLowerCase();
  return `${prefix}-${safeType}-${trackingNumber}.${ext}`;
}

function decodeDocument(contentBase64: unknown): Buffer {
  assert.ok(
    typeof contentBase64 === "string" && contentBase64.length > 0,
    "Document content missing",
  );
  const compact = contentBase64.replace(/\s/g, "");
  const padded = compact.padEnd(
    compact.length + ((4 - (compact.length % 4)) % 4),
    "=",
  );
  return Buffer.from(padded, "base64");
}

function saveDocument(
  prefix: string,
  trackingNumber: string,
  doc: Record<string, unknown>,
): DocumentArtifact {
  const documentType = String(doc.documentType ?? "document");
  const docType = String(doc.docType ?? "pdf").toUpperCase();
  const fileName = String(
    doc.fileName ?? artifactName(prefix, trackingNumber, documentType, docType),
  );
  const bytes = decodeDocument(doc.contentBase64);
  const artifactPath = path.join(
    OUTPUT_DIR,
    artifactName(prefix, trackingNumber, documentType, docType),
  );
  fs.writeFileSync(artifactPath, bytes, { mode: 0o600 });
  return {
    documentType,
    docType,
    fileName,
    artifact: path.relative(PROJECT_ROOT, artifactPath),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    source: String(doc.source ?? "UNKNOWN"),
    ...(typeof doc.uploadStatus === "string"
      ? { uploadStatus: doc.uploadStatus }
      : {}),
  };
}

async function createAndSaveLabel(
  baseUrl: string,
  internalKey: string,
  body: Record<string, unknown>,
  prefix: string,
  secrets: readonly string[],
): Promise<{ label: LabelCheck; documents: DocumentArtifact[] }> {
  const createResult = await callApi(
    baseUrl,
    internalKey,
    "POST",
    "/internal/shipping/create-shipment",
    "valid",
    body,
  );
  const httpStatus = createResult.status;
  if (httpStatus !== 200) {
    return {
      label: {
        supported: true,
        attempted: true,
        ok: false,
        httpStatus,
        error: apiError(createResult, secrets),
      },
      documents: [],
    };
  }

  const labels = createResult.body.labels;
  if (!Array.isArray(labels) || labels.length === 0) {
    return {
      label: {
        supported: true,
        attempted: true,
        ok: false,
        httpStatus,
        error: "Internal API returned no labels",
      },
      documents: [],
    };
  }

  const label = labels[0] as Record<string, unknown>;
  if (label.environment !== undefined && label.environment !== "sandbox") {
    return {
      label: {
        supported: true,
        attempted: true,
        ok: false,
        httpStatus,
        error: "Safety failure: carrier returned a production label",
      },
      documents: [],
    };
  }

  const bytes = decodePdf(label.labelData);
  const pdf = await PDFDocument.load(bytes);
  const trackingNumber =
    typeof label.trackingNumber === "string" ? label.trackingNumber : "UNKNOWN";
  const artifactPath = path.join(OUTPUT_DIR, `${prefix}.pdf`);
  fs.writeFileSync(artifactPath, bytes, { mode: 0o600 });

  const savedLabel: LabelCheck = {
    supported: true,
    attempted: true,
    ok: true,
    httpStatus,
    environment: label.environment === "sandbox" ? "sandbox" : undefined,
    environmentEvidence:
      label.environment === "sandbox"
        ? "Carrier label metadata and exact sandbox-host preflight"
        : "Exact sandbox-host preflight and client sandbox pinning; carrier label metadata omitted",
    trackingNumber,
    artifact: path.relative(PROJECT_ROOT, artifactPath),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    pdfPages: pdf.getPageCount(),
  };

  const rawDocuments = label.documents;
  const documents: DocumentArtifact[] = [];
  if (Array.isArray(rawDocuments)) {
    for (const doc of rawDocuments) {
      if (doc && typeof doc === "object" && !Array.isArray(doc)) {
        documents.push(
          saveDocument(prefix, trackingNumber, doc as Record<string, unknown>),
        );
      }
    }
  }
  return { label: savedLabel, documents };
}

async function runDutyTaxEstimate(
  baseUrl: string,
  internalKey: string,
  body: Record<string, unknown>,
  secrets: readonly string[],
): Promise<DutyEstimateResult> {
  try {
    const result = await callApi(
      baseUrl,
      internalKey,
      "POST",
      "/internal/shipping/duty-tax-estimate",
      "valid",
      {
        carrier: "fedex",
        from: body.from,
        to: body.to,
        serviceType: body.serviceType,
        customs: body.customs,
      },
    );
    if (result.status !== 200) {
      return { attempted: true, ok: false, error: apiError(result, secrets) };
    }
    const data =
      result.body.estimate !== null &&
      typeof result.body.estimate === "object" &&
      !Array.isArray(result.body.estimate)
        ? (result.body.estimate as Record<string, unknown>)
        : {};
    return {
      attempted: true,
      ok: true,
      nonGuaranteed: true,
      guaranteed: false,
      ...(typeof data.currency === "string" ? { currency: data.currency } : {}),
      ...(typeof data.disclaimer === "string"
        ? { disclaimer: data.disclaimer }
        : {
            disclaimer:
              "Duty/tax figures are estimates and are not guaranteed by FedEx.",
          }),
      ...(Array.isArray(data.duties) ? { duties: data.duties } : {}),
      ...(Array.isArray(data.fees) ? { fees: data.fees } : {}),
      ...(Array.isArray(data.taxes) ? { taxes: data.taxes } : {}),
      ...(data.summary && typeof data.summary === "object"
        ? { summary: data.summary as Record<string, unknown> }
        : {}),
    };
  } catch (error) {
    return { attempted: true, ok: false, error: redact(error, secrets) };
  }
}

async function runEtdAttempt(
  baseUrl: string,
  internalKey: string,
  baseBody: Record<string, unknown>,
  reference: string,
  prefix: string,
  secrets: readonly string[],
): Promise<EtdAttemptResult> {
  const pdfBase64 = await generatedPdfBase64();
  const customs = { ...(baseBody.customs as Record<string, unknown>) };
  const documents = { ...(customs.documents as Record<string, unknown>) };
  documents.uploads = [
    {
      fileName: "commercial-invoice-upload.pdf",
      contentType: "application/pdf",
      shipDocumentType: "COMMERCIAL_INVOICE",
      contentBase64: pdfBase64,
    },
  ];
  customs.documents = documents;
  const etdBody = { ...baseBody, customs, reference: `${reference}-ETD` };
  try {
    const { label, documents: docs } = await createAndSaveLabel(
      baseUrl,
      internalKey,
      etdBody,
      prefix,
      secrets,
    );
    return {
      attempted: true,
      ok: label.ok,
      label,
      documents: docs,
      ...(label.ok ? {} : { error: label.error }),
    };
  } catch (error) {
    return { attempted: true, ok: false, error: redact(error, secrets) };
  }
}

async function runInternalApiAuthChecks(
  baseUrl: string,
  internalKey: string,
  secrets: readonly string[],
): Promise<Record<string, AuthCheck>> {
  const auth: Record<string, AuthCheck> = {};
  auth.missingBearerServices = await authCheck(
    404,
    () =>
      callApi(
        baseUrl,
        internalKey,
        "GET",
        "/internal/shipping/services/fedex",
        "missing",
      ),
    secrets,
  );
  auth.wrongBearerServices = await authCheck(
    404,
    () =>
      callApi(
        baseUrl,
        internalKey,
        "GET",
        "/internal/shipping/services/fedex",
        "wrong",
      ),
    secrets,
  );
  auth.wrongBearerCreate = await authCheck(
    404,
    () =>
      callApi(
        baseUrl,
        internalKey,
        "POST",
        "/internal/shipping/create-shipment",
        "wrong",
        { carrier: "fedex" },
      ),
    secrets,
  );
  auth.validBearerServices = await authCheck(
    200,
    () =>
      callApi(
        baseUrl,
        internalKey,
        "GET",
        "/internal/shipping/services/fedex",
        "valid",
      ),
    secrets,
  );
  return auth;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

interface DomesticResults {
  internalApiAuthentication: Record<string, AuthCheck>;
  carriers: CarrierResult[];
  summary: { labelsCreated: number; labelsFailed: number; allPassed: boolean };
}

async function runDomesticScenario(
  results: DomesticResults,
  env: Env,
  secrets: readonly string[],
  baseUrl: string,
  internalKey: string,
  shipDate: string,
  reference: string,
): Promise<void> {
  results.internalApiAuthentication = await runInternalApiAuthChecks(
    baseUrl,
    internalKey,
    secrets,
  );
  assert.ok(
    Object.values(results.internalApiAuthentication).every((check) => check.ok),
    "Internal API authentication checks failed",
  );

  for (const carrier of CARRIERS) {
    const carrierResult: CarrierResult = {
      carrier,
      credentialsPresent: CREDENTIALS[carrier].every((key) =>
        Boolean(env[key]?.trim()),
      ),
      sandboxEndpointChecked: true,
      rateAuthentication: blankRateCheck(),
      label: blankLabelCheck(carrier),
    };
    results.carriers.push(carrierResult);

    try {
      carrierResult.rateAuthentication.attempted = true;
      const rateResult = await callApi(
        baseUrl,
        internalKey,
        "POST",
        "/internal/shipping/rate-quote",
        "valid",
        domesticShipmentBody(carrier, shipDate, reference),
      );
      carrierResult.rateAuthentication.httpStatus = rateResult.status;
      const rates = rateResult.body.rates;
      if (rateResult.status === 200 && Array.isArray(rates)) {
        carrierResult.rateAuthentication.ok = true;
        carrierResult.rateAuthentication.rateCount = rates.length;
      } else {
        carrierResult.rateAuthentication.error = apiError(rateResult, secrets);
      }
    } catch (error) {
      carrierResult.rateAuthentication.error = redact(error, secrets);
    }

    if (!LABEL_CARRIERS.has(carrier)) {
      carrierResult.label = {
        supported: false,
        attempted: false,
        ok: true,
        reason:
          "Stamps is rate-only in this project; createShipment is explicitly unsupported.",
      };
      continue;
    }

    try {
      const { label } = await createAndSaveLabel(
        baseUrl,
        internalKey,
        domesticShipmentBody(carrier, shipDate, reference),
        `${carrier}-sandbox`,
        secrets,
      );
      carrierResult.label = label;
    } catch (error) {
      carrierResult.label = {
        ...carrierResult.label,
        attempted: true,
        ok: false,
        error: redact(error, secrets),
      };
      const previousArtifact = path.join(OUTPUT_DIR, `${carrier}-sandbox.pdf`);
      if (fs.existsSync(previousArtifact)) {
        carrierResult.label.artifact = path.relative(
          PROJECT_ROOT,
          previousArtifact,
        );
      }
    }
  }

  results.summary.labelsCreated = results.carriers.filter(
    (result) => result.label.supported && result.label.ok,
  ).length;
  results.summary.labelsFailed = results.carriers.filter(
    (result) => result.label.supported && !result.label.ok,
  ).length;
  results.summary.allPassed =
    Object.values(results.internalApiAuthentication).length === 4 &&
    Object.values(results.internalApiAuthentication).every(
      (check) => check.ok,
    ) &&
    results.carriers.length === CARRIERS.length &&
    results.carriers.every((result) => result.rateAuthentication.ok) &&
    results.summary.labelsFailed === 0 &&
    results.summary.labelsCreated === LABEL_CARRIERS.size;
}

interface InternationalResults {
  internalApiAuthentication: Record<string, AuthCheck>;
  fedexInternational?: InternationalResult;
  summary: { labelsCreated: number; labelsFailed: number; allPassed: boolean };
}

async function runInternationalScenario(
  scenario: ScenarioSelection,
  results: InternationalResults,
  secrets: readonly string[],
  baseUrl: string,
  internalKey: string,
  shipDate: string,
  reference: string,
): Promise<void> {
  results.internalApiAuthentication = await runInternalApiAuthChecks(
    baseUrl,
    internalKey,
    secrets,
  );
  assert.ok(
    Object.values(results.internalApiAuthentication).every((check) => check.ok),
    "Internal API authentication checks failed",
  );

  const prefix =
    scenario.name === "documents-only"
      ? "fedex-documents-only-sandbox"
      : "fedex-international-us-ca-sandbox";
  const body = internationalShipmentBody(scenario.name, shipDate, reference);

  const intl: InternationalResult = {
    scenario: scenario.name,
    withEtdUpload: scenario.withEtdUpload,
    withDutyEstimate: scenario.withDutyEstimate,
    label: { supported: true, attempted: false, ok: false },
    documents: [],
    dutyEstimate: { attempted: false, ok: false },
    etdAttempt: { attempted: false, ok: false },
  };

  try {
    const { label, documents } = await createAndSaveLabel(
      baseUrl,
      internalKey,
      body,
      prefix,
      secrets,
    );
    intl.label = label;
    intl.documents = documents;
  } catch (error) {
    intl.label = {
      supported: true,
      attempted: true,
      ok: false,
      error: redact(error, secrets),
    };
  }

  if (intl.label.ok && scenario.withDutyEstimate) {
    intl.dutyEstimate = await runDutyTaxEstimate(
      baseUrl,
      internalKey,
      body,
      secrets,
    );
  }

  if (intl.label.ok && scenario.withEtdUpload) {
    intl.etdAttempt = await runEtdAttempt(
      baseUrl,
      internalKey,
      body,
      reference,
      `${prefix}-etd`,
      secrets,
    );
  }

  results.fedexInternational = intl;
  results.summary.labelsCreated = intl.label.ok ? 1 : 0;
  results.summary.labelsFailed = intl.label.ok ? 0 : 1;
  results.summary.allPassed =
    Object.values(results.internalApiAuthentication).every(
      (check) => check.ok,
    ) && intl.label.ok;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

interface RunResults {
  generatedAt: string;
  mode: "sandbox";
  scenario: ScenarioSelection;
  credentialsIncluded: false;
  rawCarrierResponsesIncluded: false;
  preflight: { ok: boolean; error?: string };
  internalApiAuthentication?: Record<string, AuthCheck>;
  carriers?: CarrierResult[];
  fedexInternational?: InternationalResult;
  summary: { labelsCreated: number; labelsFailed: number; allPassed: boolean };
}

export function markdownReport(results: RunResults): string {
  const scenarioName = results.scenario.name;
  const authOk =
    results.internalApiAuthentication !== undefined &&
    Object.values(results.internalApiAuthentication).every((check) => check.ok);

  if (!results.preflight.ok) {
    return (
      `# Sandbox label verification (${scenarioName})\n\n` +
      `Preflight refused this run: ${results.preflight.error ?? "unknown error"}\n\n` +
      `No carrier requests were made.\n`
    );
  }

  if (scenarioName !== "domestic" && results.fedexInternational) {
    const intl = results.fedexInternational;
    const labelLine = intl.label.ok
      ? `Created (${intl.label.pdfPages} page)`
      : `Failed - ${intl.label.error ?? "see results.json"}`;
    const docList =
      intl.documents
        .map(
          (doc) =>
            `- ${doc.documentType} (${doc.docType}): \`${doc.artifact}\``,
        )
        .join("\n") || "- none returned";
    const dutyLine = intl.dutyEstimate.attempted
      ? intl.dutyEstimate.ok
        ? "Read (non-guaranteed)"
        : `Failed - ${intl.dutyEstimate.error ?? "see results.json"}`
      : "Not requested";
    const etdLine = intl.etdAttempt.attempted
      ? intl.etdAttempt.ok
        ? "Attached (see ETD label artifact)"
        : `Failed - ${intl.etdAttempt.error ?? "see results.json"}`
      : "Not requested";
    const etdDocs = intl.etdAttempt.documents ?? [];
    return (
      `# Sandbox FedEx international verification\n\n` +
      `Generated: ${results.generatedAt}\n\n` +
      `**Scenario:** ${scenarioName} | **ETD upload:** ${
        intl.withEtdUpload ? "yes" : "no"
      } | **Duty estimate:** ${intl.withDutyEstimate ? "yes" : "no"}\n\n` +
      `**Sandbox only.** These are carrier test artifacts, not evidence of a physical shipment. ` +
      `No credentials, raw carrier responses, or request payloads are included.\n\n` +
      `## Results\n\n` +
      `- Internal API missing/wrong Bearer rejection: ${
        authOk ? "passed" : "failed"
      }\n` +
      `- Label: ${labelLine}\n` +
      `- Label artifact: \`${intl.label.artifact ?? "none"}\`\n` +
      `- Documents returned: ${intl.documents.length}\n` +
      `${docList}\n` +
      `- Duty-tax estimate: ${dutyLine}\n` +
      `- ETD upload attempt: ${etdLine}\n` +
      (etdDocs.length
        ? `- ETD documents: ${etdDocs
            .map((doc) => `\`${doc.artifact}\``)
            .join(", ")}\n`
        : "") +
      `- Overall: ${results.summary.allPassed ? "PASS" : "FAIL"}\n\n` +
      `ETD and duty-tax are optional FedEx sub-flows; failures there do not fail the base label check. ` +
      `Duty-tax figures are non-guaranteed. Machine-readable, redacted evidence is in \`results.json\`.\n`
    );
  }

  const rows = (results.carriers ?? []).map((result) => {
    const labelState = !result.label.supported
      ? "rate-only"
      : result.label.ok
        ? `created (${result.label.pdfPages} page)`
        : `failed - ${result.label.error ?? "see results.json"}`;
    const artifact = result.label.artifact
      ? `\`${result.label.artifact}\``
      : "-";
    return `| ${result.carrier} | ${
      result.rateAuthentication.ok ? "ok" : "failed"
    } | ${labelState} | ${artifact} |`;
  });

  return (
    `# Sandbox carrier verification (domestic)\n\n` +
    `Generated: ${results.generatedAt}\n\n` +
    `**Sandbox only.** These are carrier test artifacts, not evidence of a physical shipment. ` +
    `No credentials, raw carrier responses, or request payloads are included.\n\n` +
    `## Results\n\n` +
    `| Carrier | Sandbox auth/rate request | Label | Artifact |\n` +
    `|---|---|---|---|\n${rows.join("\n")}\n\n` +
    `- Internal API missing/wrong Bearer rejection: ${
      authOk ? "passed" : "failed"
    }\n` +
    `- Labels created and PDF-validated: ${results.summary.labelsCreated}\n` +
    `- Supported label attempts failed: ${results.summary.labelsFailed}\n` +
    `- Overall: ${results.summary.allPassed ? "PASS" : "FAIL"}\n\n` +
    `Stamps label creation is not implemented by the current client, so only its sandbox authentication/rate path is tested.\n` +
    `Machine-readable, redacted evidence is in \`results.json\`.\n`
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(OUTPUT_DIR, 0o700);
  } catch {
    // Best effort on filesystems without POSIX modes.
  }

  const generatedAt = new Date().toISOString();
  const results: RunResults = {
    generatedAt,
    mode: "sandbox",
    scenario: {
      name: "domestic",
      withEtdUpload: false,
      withDutyEstimate: false,
    },
    credentialsIncluded: false,
    rawCarrierResponsesIncluded: false,
    preflight: { ok: false },
    summary: { labelsCreated: 0, labelsFailed: 0, allPassed: false },
  };

  let env: Env = {};
  let secrets: string[] = [];

  try {
    env = loadEnv();
    secrets = secretsForRedaction(env);
    const scenario = parseScenario(argv, env);
    results.scenario = scenario;

    assertSandboxOnlyEnvironment(env);
    assertInternalSeamConfig(env);
    assertRequiredCredentials(env, scenario.name);

    const baseUrl = env.SLG_INTERNAL_API_BASE_URL as string;
    const internalKey = env.SLG_INTERNAL_API_KEY as string;
    const shipDate = generatedAt.slice(0, 10);
    const reference = `SLG-SANDBOX-${Date.now()}`;

    results.preflight.ok = true;

    if (scenario.name === "domestic") {
      const domestic: DomesticResults = {
        internalApiAuthentication: {},
        carriers: [],
        summary: results.summary,
      };
      await runDomesticScenario(
        domestic,
        env,
        secrets,
        baseUrl,
        internalKey,
        shipDate,
        reference,
      );
      results.internalApiAuthentication = domestic.internalApiAuthentication;
      results.carriers = domestic.carriers;
    } else {
      const international: InternationalResults = {
        internalApiAuthentication: {},
        summary: results.summary,
      };
      await runInternationalScenario(
        scenario,
        international,
        secrets,
        baseUrl,
        internalKey,
        shipDate,
        reference,
      );
      results.internalApiAuthentication =
        international.internalApiAuthentication;
      results.fedexInternational = international.fedexInternational;
    }
  } catch (error) {
    results.preflight.error = redact(error, secrets);
  }

  fs.writeFileSync(RESULTS_FILE, `${JSON.stringify(results, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.writeFileSync(README_FILE, markdownReport(results), { mode: 0o600 });

  console.log(
    `Sandbox label verification (${results.scenario.name}): ${
      results.summary.allPassed ? "PASS" : "FAIL"
    }`,
  );
  console.log(
    `Labels created: ${results.summary.labelsCreated}; supported label failures: ${results.summary.labelsFailed}`,
  );
  if (!results.preflight.ok) {
    console.log(`Preflight refused the run: ${results.preflight.error}`);
  }
  console.log(`Results: ${path.relative(PROJECT_ROOT, RESULTS_FILE)}`);

  return results.summary.allPassed ? 0 : 1;
}

if (require.main === module) {
  void main().then((code) => {
    process.exitCode = code;
  });
}

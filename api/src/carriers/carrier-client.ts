/**
 * Carrier base client — the shared OAuth token cache + authenticated request
 * helper every carrier client (FedEx/UPS/USPS) builds on. Ported from
 * shipping-cli `src/shipping_cli/client.py` (BaseClient) and the per-carrier
 * `_request_access_token` / `get_auth_headers` idioms.
 *
 * Each carrier client owns its own `fetch` transport seam (mirroring bc-client's
 * `__setBcTransportForTests`) and its own OAuth `fetchToken` + `authHeaders`
 * builder; this module supplies the token caching and the Bearer-authenticated
 * request wrapper with a single 401-refresh retry.
 */

import { createHash } from "node:crypto";

import { CarrierApiError, CarrierUnavailableError } from "./carrier-errors";

export type CarrierTransport = typeof fetch;

export const TOKEN_REFRESH_BUFFER_SECONDS = 60;

/** Address validation, rate quotes, tracking, and OAuth token requests. */
export const CARRIER_DEFAULT_TIMEOUT_MS = 30_000;

/** Shipment / label creation (carrier label generation can be slow). */
export const CARRIER_SHIPMENT_TIMEOUT_MS = 90_000;

/** True for fetch aborts: AbortSignal.timeout → TimeoutError, caller signal → AbortError. */
export function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

/**
 * Canonical JSON with recursively sorted keys — a stable serialization for
 * fingerprinting full effective configs (field order never changes the hash).
 */
export function canonicalConfigJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalConfigJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalConfigJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Stable sha256 fingerprint of a FULL effective carrier config (all fields,
 * including accountNumber). Token caches are keyed by this so two locations /
 * companies with different credentials never share a carrier token.
 */
export function configFingerprint(config: unknown): string {
  return createHash("sha256").update(canonicalConfigJson(config)).digest("hex");
}

interface OAuthToken {
  accessToken: string;
  expiresAt: number;
}

/**
 * Builds a cached token getter. `refresh` performs the carrier-specific OAuth
 * exchange and returns `{ accessToken, expiresIn }` (expiresIn in seconds).
 * The returned function caches the token until ~60s before expiry.
 */
export function createTokenCache(
  refresh: () => Promise<{ accessToken: string; expiresIn: number }>,
): (forceRefresh?: boolean) => Promise<string> {
  let cached: OAuthToken | null = null;

  return async function getToken(forceRefresh = false): Promise<string> {
    if (
      !forceRefresh &&
      cached &&
      cached.expiresAt - Date.now() > TOKEN_REFRESH_BUFFER_SECONDS * 1000
    ) {
      return cached.accessToken;
    }
    const token = await refresh();
    cached = {
      accessToken: token.accessToken,
      expiresAt: Date.now() + token.expiresIn * 1000,
    };
    return cached.accessToken;
  };
}

/**
 * Performs a Bearer-authenticated request, refreshing the token once on a 401.
 * `authHeaders` lets each carrier add its own extra headers (UPS transId /
 * transactionSrc, USPS X-Request-Id). When `timeoutMs` is set and the caller
 * did not supply `init.signal`, an `AbortSignal.timeout(timeoutMs)` governs
 * both the initial request and the token-refresh retry; an abort surfaces as
 * a CarrierUnavailableError carrying the timeout in its message.
 */
export async function bearerRequest(
  transport: CarrierTransport,
  getToken: (forceRefresh?: boolean) => Promise<string>,
  authHeaders: () => Record<string, string>,
  url: string,
  init: RequestInit,
  timeoutMs?: number,
): Promise<Response> {
  const baseHeaders = init.headers as Record<string, string> | undefined;
  const buildHeaders = async (
    force = false,
  ): Promise<Record<string, string>> => ({
    ...(baseHeaders ?? {}),
    ...authHeaders(),
    Authorization: `Bearer ${await getToken(force)}`,
  });
  const withTimeout = (requestInit: RequestInit): RequestInit =>
    timeoutMs !== undefined && requestInit.signal === undefined
      ? { ...requestInit, signal: AbortSignal.timeout(timeoutMs) }
      : requestInit;

  try {
    let response = await transport(
      url,
      withTimeout({ ...init, headers: await buildHeaders(false) }),
    );

    if (response.status === 401) {
      response = await transport(
        url,
        withTimeout({ ...init, headers: await buildHeaders(true) }),
      );
    }
    return response;
  } catch (error) {
    if (timeoutMs !== undefined && isAbortError(error)) {
      throw new CarrierUnavailableError(
        error,
        `Carrier request timed out after ${timeoutMs}ms`,
      );
    }
    throw error;
  }
}

/**
 * Extracts a human-readable detail line from the structured error bodies the
 * carriers actually return (none use a top-level `message`):
 * FedEx `{errors: [{code, message}]}`, UPS `{response: {errors: [...]}}`,
 * USPS OAuth-style `{error, error_description}` (string error) and
 * USPS API-style `{error: {code, message}}` (object error).
 */
export function carrierErrorDetail(data: unknown): string | null {
  if (data === null || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (Array.isArray(record.errors)) {
    const parts: string[] = [];
    for (const entry of record.errors) {
      if (entry !== null && typeof entry === "object") {
        const detail = entry as Record<string, unknown>;
        const part = [detail.code, detail.message]
          .filter((v): v is string => typeof v === "string" && v.length > 0)
          .join(": ");
        if (part) parts.push(part);
      } else if (typeof entry === "string" && entry.length > 0) {
        parts.push(entry);
      }
    }
    if (parts.length > 0) return parts.join(" | ");
  }
  if (record.response !== null && typeof record.response === "object") {
    const nested = carrierErrorDetail(record.response);
    if (nested) return nested;
  }
  if (typeof record.error === "string" && record.error.length > 0) {
    const description =
      typeof record.error_description === "string" &&
      record.error_description.length > 0
        ? `: ${record.error_description}`
        : "";
    return `${record.error}${description}`;
  }
  // USPS API-style object error (see carrierErrorDetail docstring).
  if (record.error !== null && typeof record.error === "object") {
    const detail = record.error as Record<string, unknown>;
    const part = [detail.code, detail.message]
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .join(": ");
    if (part) return part;
  }
  return null;
}

/**
 * Parses a carrier response body and throws CarrierApiError on non-2xx.
 * Returns the parsed JSON (or undefined for an empty body).
 */
export async function readCarrierJson<T>(
  response: Response,
  operation: string,
): Promise<T> {
  const text = await response.text();
  let data: unknown;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!response.ok) {
    const message =
      data !== null && typeof data === "object"
        ? ((data as { message?: string }).message ?? carrierErrorDetail(data))
        : null;
    throw new CarrierApiError({
      status: response.status,
      message:
        message ?? `Carrier request failed with status ${response.status}`,
      body: data,
    });
  }
  return data as T;
}

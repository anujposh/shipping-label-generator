import { config } from "../config";
import { log, errorDetails } from "../core/logger";

/**
 * Business Central companies directory (read-only proxy).
 *
 * Companies are mastered in Business Central, NOT in a local table. This
 * service performs the OAuth2 client-credentials flow against the tenant
 * token endpoint and then lists companies from the tenant-level v2.0 API.
 */

const BC_TIMEOUT_MS = 15_000;
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const COMPANIES_CACHE_TTL_MS = 5 * 60_000;

export interface BcCompany {
  id: string;
  name: string;
}

interface BcTokenResponse {
  access_token?: string;
  expires_in?: number;
}

interface BcCompaniesResponse {
  value?: Array<{ id: string; name?: string; displayName?: string }>;
}

let cachedToken: { token: string; expiresAt: number } | null = null;
let cachedCompanies: { companies: BcCompany[]; expiresAt: number } | null =
  null;

/** true when all client-credentials env vars are present. */
export function bcCompaniesConfigured(): boolean {
  return Boolean(
    config.bcTenantId && config.bcClientId && config.bcClientSecret,
  );
}

/** Fetch (and cache) an access token via client credentials. */
async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.token;
  }

  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(
    config.bcTenantId,
  )}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.bcClientId,
    client_secret: config.bcClientSecret,
    scope: "https://api.businesscentral.dynamics.com/.default",
  });

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(BC_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `BC token request failed (${res.status}): ${text.slice(0, 200)}`,
    );
  }

  const json = (await res.json()) as BcTokenResponse;
  if (!json.access_token) {
    throw new Error("BC token response missing access_token");
  }

  const expiresInMs = (json.expires_in ?? 3600) * 1000;
  cachedToken = {
    token: json.access_token,
    expiresAt: Date.now() + Math.max(expiresInMs - TOKEN_EXPIRY_SKEW_MS, 0),
  };
  return json.access_token;
}

/**
 * List companies from the tenant-level Business Central API, mapped to
 * `{ id, name }` where `name` prefers BC's displayName. Cached 5 minutes.
 * Throws on any failure so the route can respond 502.
 */
export async function fetchBcCompanies(): Promise<BcCompany[]> {
  if (cachedCompanies && cachedCompanies.expiresAt > Date.now()) {
    return cachedCompanies.companies;
  }

  try {
    const accessToken = await getAccessToken();

    const url = `${config.bcBaseUrl}/${encodeURIComponent(
      config.bcTenantId,
    )}/${encodeURIComponent(config.bcEnvironment)}/api/TLI/posh/v2.0/companies`;

    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(BC_TIMEOUT_MS),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `BC companies request failed (${res.status}): ${text.slice(0, 200)}`,
      );
    }

    const json = (await res.json()) as BcCompaniesResponse;
    const companies: BcCompany[] = (json.value ?? []).map((c) => ({
      id: c.id,
      name: c.displayName ?? c.name ?? c.id,
    }));

    cachedCompanies = {
      companies,
      expiresAt: Date.now() + COMPANIES_CACHE_TTL_MS,
    };
    return companies;
  } catch (err) {
    log("warn", "bc_companies_fetch_failed", errorDetails(err));
    throw err;
  }
}

/** Find one company by BC GUID in the (cached) company list. */
export async function findBcCompanyById(
  id: string,
): Promise<BcCompany | null> {
  const companies = await fetchBcCompanies();
  return companies.find((company) => company.id === id) ?? null;
}

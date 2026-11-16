import "server-only";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
export async function proxy(request: NextRequest, path: string, token?: string) {
  // Same-origin check for mutations. request.nextUrl.origin can reflect the
  // bind address (e.g. http://0.0.0.0:3011) rather than the Host header, so
  // derive the allowed origin from Host (+ x-forwarded-proto behind a proxy)
  // as well and accept either form.
  if (!["GET", "HEAD"].includes(request.method)) {
    const host = request.headers.get("host");
    const proto = request.headers.get("x-forwarded-proto") ?? "http";
    const allowed = new Set([request.nextUrl.origin, ...(host ? [`${proto}://${host}`] : [])]);
    const origin = request.headers.get("origin");
    if (!origin || !allowed.has(origin)) {
      return NextResponse.json({ error: "origin_not_allowed" }, { status: 403, headers });
    }
  }
  const jar = await cookies();
  if (path === "/admin/auth/logout") { jar.delete("slg_admin"); return NextResponse.json({ ok: true }, { headers }); }
  const login = path === "/admin/auth/login";
  const credential = token ?? jar.get("slg_admin")?.value;
  if (!login && !credential) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });
  const base = process.env.SLG_API_BASE_URL;
  if (!base) return NextResponse.json({ error: "service_unavailable" }, { status: 503, headers });
  try {
    // BFF paths are /admin/... but the api service mounts admin at /admin/v1.
    const upstreamPath = path.startsWith("/admin/") ? `/admin/v1/${path.slice("/admin/".length)}` : path;
    const url = new URL(upstreamPath, base);
    // Only non-secret, explicitly supported filters may cross the BFF boundary.
    const adminLabel = /^\/admin\/shipments\/[a-zA-Z0-9-]+\/label\.pdf$/.test(path);
    for (const key of adminLabel ? ["inline"] : ["shipmentId", "documentId", "vendorId", "status", "limit", "offset"]) {
      const value = request.nextUrl.searchParams.get(key); if (value) url.searchParams.set(key, value);
    }
    const upstream = await fetch(url, {
      method: request.method, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(60000),
      headers: { "Content-Type": "application/json", ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
      body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.text(),
    });
    if (login && upstream.ok) {
      const data = await upstream.json();
      const jwt = data.token ?? data.accessToken;
      if (typeof jwt !== "string") throw new Error("Invalid session response");
      jar.set("slg_admin", jwt, { httpOnly: true, secure: process.env.NODE_ENV === "production" && (request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https"), sameSite: "strict", path: "/", maxAge: 8 * 60 * 60 });
      return NextResponse.json({ ok: true }, { headers });
    }
    if (!token && upstream.status === 401) jar.delete("slg_admin");
    const responseHeaders = new Headers(headers);
    responseHeaders.set("Content-Type", upstream.headers.get("content-type") ?? "application/json");
    if ((path.endsWith("label.pdf") || path === "/v1/document") && upstream.ok) {
      responseHeaders.set("Content-Disposition", upstream.headers.get("content-disposition") ?? (path === "/v1/document" ? "attachment" : 'attachment; filename="label.pdf"'));
      responseHeaders.set("X-Content-Type-Options", "nosniff");
      const length = upstream.headers.get("content-length");
      if (length && !upstream.headers.get("content-encoding")) responseHeaders.set("Content-Length", length);
    }
    const retry = upstream.headers.get("retry-after"); if (retry) responseHeaders.set("Retry-After", retry);
    return new NextResponse(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch { return NextResponse.json({ error: "service_unavailable" }, { status: 502, headers }); }
}

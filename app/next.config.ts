import type { NextConfig } from "next";
const config: NextConfig = {
  output: "standalone", typedRoutes: true, poweredByHeader: false,
  // LAN testing: allow dev-origin access from this host's LAN IP
  // (dev server binds 0.0.0.0; without this Next blocks cross-origin
  // dev resources and client hydration fails for remote browsers).
  allowedDevOrigins: ["192.168.1.152", "localhost"],
  experimental: { cpus: 1 },
  async headers() { return [{ source: "/:path*", headers: [
    { key: "Referrer-Policy", value: "no-referrer" },
    { key: "Cache-Control", value: "no-store" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
  ] }]; },
};
export default config;

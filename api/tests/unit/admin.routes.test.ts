import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { createAdminRouter } from "../../src/routes/admin.routes";
import { fakeKnex } from "./fake-knex";
import * as dbModule from "../../src/db";
import { hashPassword } from "../../src/core/password";
import { signAdminToken } from "../../src/core/jwt";

type AdminRouterOptions = Parameters<typeof createAdminRouter>[0];

function makeApp(
  state: ReturnType<typeof fakeKnex>,
  options: AdminRouterOptions = {},
) {
  const app = express();
  app.use((req, _res, next) => {
    req.requestId = `req-${Math.random().toString(36).slice(2)}`;
    next();
  });
  app.use(express.json());
  app.use("/admin/v1", createAdminRouter(options));
  return app;
}

async function httpRequest(
  app: ReturnType<typeof makeApp>,
  opts: { method: string; path: string; token?: string; body?: unknown },
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  body: any;
}> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: addr.port,
          path: opts.path,
          method: opts.method,
          headers: {
            "Content-Type": "application/json",
            ...(opts.token && { Authorization: `Bearer ${opts.token}` }),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            server.close(() => {
              let parsed: unknown;
              try {
                parsed = text ? JSON.parse(text) : null;
              } catch {
                parsed = text;
              }
              resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                text,
                body: parsed,
              });
            });
          });
        },
      );
      req.on("error", reject);
      if (opts.body) req.write(JSON.stringify(opts.body));
      req.end();
    });
  });
}

describe("admin routes", () => {
  let realDb: typeof dbModule.db;

  before(() => {
    realDb = dbModule.db;
  });

  after(() => {
    dbModule.setDb(realDb);
  });

  function setState(rows: any[]) {
    const state = fakeKnex({ rows });
    dbModule.setDb(state as unknown as typeof dbModule.db);
    return state;
  }

  it("logs in with valid credentials and returns JWT", async () => {
    const passwordHash = await hashPassword("Password1!");
    const state = setState([
      {
        id: 1,
        email: "admin@test.com",
        password_hash: passwordHash,
        name: "Admin",
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);
    const app = makeApp(state);
    const res = await httpRequest(app, {
      method: "POST",
      path: "/admin/v1/auth/login",
      body: { email: "admin@test.com", password: "Password1!" },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
  });

  it("returns 401 for bad password and audits failure", async () => {
    const passwordHash = await hashPassword("Password1!");
    const state = setState([
      {
        id: 1,
        email: "admin@test.com",
        password_hash: passwordHash,
        name: "Admin",
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);
    const app = makeApp(state);
    const res = await httpRequest(app, {
      method: "POST",
      path: "/admin/v1/auth/login",
      body: { email: "admin@test.com", password: "WrongPassword1!" },
    });
    assert.equal(res.status, 401);
    const audit = (state as any).rows.filter(
      (r: any) => r.event_type === "admin_login_failure",
    );
    assert.equal(audit.length, 1);
  });

  it("creates and lists vendors", async () => {
    const state = setState([]);
    const token = signAdminToken({
      sub: 1,
      email: "admin@test.com",
      role: "admin",
    });
    const app = makeApp(state);

    const createRes = await httpRequest(app, {
      method: "POST",
      path: "/admin/v1/vendors",
      token,
      body: { name: "Acme Co", contactEmail: "acme@example.com" },
    });
    assert.equal(createRes.status, 201);
    assert.equal(createRes.body.vendor.name, "Acme Co");

    const listRes = await httpRequest(app, {
      method: "GET",
      path: "/admin/v1/vendors",
      token,
    });
    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.vendors.length, 1);
  });

  it("archives a vendor via PATCH", async () => {
    const state = setState([
      {
        id: 1,
        name: "Acme Co",
        contact_email: null,
        notes: null,
        created_at: new Date().toISOString(),
        archived_at: null,
      },
    ]);
    const token = signAdminToken({
      sub: 1,
      email: "admin@test.com",
      role: "admin",
    });
    const app = makeApp(state);
    const res = await httpRequest(app, {
      method: "PATCH",
      path: "/admin/v1/vendors/1",
      token,
      body: { archived: true },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.vendor.archived_at);
  });

  it("GET /companies returns empty list with configured:false when BC is unconfigured", async () => {
    const state = setState([]);
    const token = signAdminToken({
      sub: 1,
      email: "admin@test.com",
      role: "admin",
    });
    const app = makeApp(state);
    const res = await httpRequest(app, {
      method: "GET",
      path: "/admin/v1/companies",
      token,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { companies: [], configured: false });
  });

  it("creates a link with bcCompanyId/bcCompanyName persisted when BC is unconfigured", async () => {
    const state = setState([]);
    const token = signAdminToken({
      sub: 1,
      email: "admin@test.com",
      role: "admin",
    });
    const app = makeApp(state);
    const res = await httpRequest(app, {
      method: "POST",
      path: "/admin/v1/links",
      token,
      body: {
        bcCompanyId: "123e4567-e89b-12d3-a456-426614174000",
        bcCompanyName: "CRONUS USA, Inc.",
        expiresInDays: 7,
      },
    });
    assert.equal(res.status, 201);
    assert.ok(res.body.token);
    assert.ok(res.body.id);

    const rows = (state as any).rows;
    const linkRow = rows.find(
      (r: any) => r.token_hash && r.bc_company_id !== undefined,
    );
    assert.ok(linkRow, "link row should be persisted with bc_company_id");
    assert.equal(linkRow.bc_company_id, "123e4567-e89b-12d3-a456-426614174000");
    assert.equal(linkRow.bc_company_name, "CRONUS USA, Inc.");

    const audit = rows.filter((r: any) => r.event_type === "link_created");
    assert.equal(audit.length, 1);
    assert.equal(
      audit[0].metadata?.bcCompanyId,
      "123e4567-e89b-12d3-a456-426614174000",
    );
  });

  it("creates a link and returns token once", async () => {
    const state = setState([
      {
        id: 1,
        name: "Acme Co",
        contact_email: null,
        notes: null,
        created_at: new Date().toISOString(),
        archived_at: null,
      },
    ]);
    const token = signAdminToken({
      sub: 1,
      email: "admin@test.com",
      role: "admin",
    });
    const app = makeApp(state);
    const res = await httpRequest(app, {
      method: "POST",
      path: "/admin/v1/links",
      token,
      body: {
        vendorId: 1,
        expiresInDays: 7,
        shipFrom: {
          name: "WH",
          street: "123 Main",
          city: "City",
          state: "ST",
          zip: "12345",
        },
      },
    });
    assert.equal(res.status, 201);
    assert.ok(res.body.token);
    assert.ok(res.body.id);
    const audit = (state as any).rows.filter(
      (r: any) => r.event_type === "link_created",
    );
    assert.equal(audit.length, 1);
  });

  it("creates an unassigned link when neither vendorId nor shipFrom is supplied", async () => {
    const state = setState([]);
    const token = signAdminToken({
      sub: 1,
      email: "admin@test.com",
      role: "admin",
    });
    const app = makeApp(state);
    const res = await httpRequest(app, {
      method: "POST",
      path: "/admin/v1/links",
      token,
      body: {},
    });

    assert.equal(res.status, 201);
    assert.ok(res.body.token);
    assert.ok(res.body.id);

    const rows = (state as any).rows;
    const linkRow = rows.find((r: any) => r.token_hash && r.vendor_id === null);
    assert.ok(linkRow, "link row should be persisted with vendor_id null");
    assert.deepEqual(linkRow.ship_from, {});

    const audit = rows.filter((r: any) => r.event_type === "link_created");
    assert.equal(audit.length, 1);
    assert.equal(audit[0].vendor_id, null);
  });

  it("creates an unassigned link from partial legacy ship-from data", async () => {
    const state = setState([]);
    const token = signAdminToken({
      sub: 1,
      email: "admin@test.com",
      role: "admin",
    });
    const app = makeApp(state);
    const res = await httpRequest(app, {
      method: "POST",
      path: "/admin/v1/links",
      token,
      body: {
        shipFrom: {
          name: "",
          street: "",
          city: "Partial City",
          state: "",
          zip: "",
        },
      },
    });

    assert.equal(res.status, 201);

    const rows = (state as any).rows;
    const linkRow = rows.find((r: any) => r.token_hash && r.vendor_id === null);
    assert.ok(linkRow, "link row should be persisted with vendor_id null");
    assert.deepEqual(linkRow.ship_from, {
      city: "Partial City",
      country: "US",
    });

    const audit = rows.filter((r: any) => r.event_type === "link_created");
    assert.equal(audit.length, 1);
    assert.equal(audit[0].vendor_id, null);
  });

  it("revokes a link and audits", async () => {
    const state = setState([
      {
        id: 1,
        name: "Acme Co",
        contact_email: null,
        notes: null,
        created_at: new Date().toISOString(),
        archived_at: null,
      },
      {
        id: 1,
        vendor_id: 1,
        token_hash: "hash",
        expires_at: new Date(Date.now() + 86400_000).toISOString(),
        revoked_at: null,
        max_uses: null,
        use_count: 0,
        created_by: "admin@test.com",
        ship_from: {},
        created_at: new Date().toISOString(),
      },
    ]);
    const token = signAdminToken({
      sub: 1,
      email: "admin@test.com",
      role: "admin",
    });
    const app = makeApp(state);
    const res = await httpRequest(app, {
      method: "POST",
      path: "/admin/v1/links/1/revoke",
      token,
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.link.revoked_at);
    const audit = (state as any).rows.filter(
      (r: any) => r.event_type === "link_revoked",
    );
    assert.equal(audit.length, 1);
  });

  it("rejects ship-from not in allowlist", async () => {
    process.env.SLG_ALLOWED_SHIP_FROMS = JSON.stringify([
      {
        name: "Allowed",
        street: "1 Allowed",
        city: "City",
        state: "ST",
        zip: "12345",
      },
    ]);
    const state = setState([
      {
        id: 1,
        name: "Acme Co",
        contact_email: null,
        notes: null,
        created_at: new Date().toISOString(),
        archived_at: null,
      },
    ]);
    const token = signAdminToken({
      sub: 1,
      email: "admin@test.com",
      role: "admin",
    });
    const app = makeApp(state);
    const res = await httpRequest(app, {
      method: "POST",
      path: "/admin/v1/links",
      token,
      body: {
        vendorId: 1,
        expiresInDays: 7,
        shipFrom: {
          name: "Bad",
          street: "999 Bad",
          city: "City",
          state: "ST",
          zip: "12345",
        },
      },
    });
    assert.equal(res.status, 400);
    delete process.env.SLG_ALLOWED_SHIP_FROMS;
  });

  const PDF_BASE64 = Buffer.from("%PDF-1.4 admin label").toString("base64");

  function adminToken() {
    return signAdminToken({
      sub: 1,
      email: "admin@test.com",
      role: "admin",
    });
  }

  function labelState(overrides: { shipment?: any; label?: any } = {}) {
    return setState([
      {
        id: 5,
        link_id: 7,
        vendor_id: 9,
        status: "label_created",
        ship_from: {},
        ship_to: {},
        packages: {},
        selected_rate: null,
        carrier: "usps",
        service_type: "USPS_GROUND_ADVANTAGE",
        tracking_number: "9400111111111111111111",
        created_at: 10,
        updated_at: 10,
        ...overrides.shipment,
      },
      {
        id: 1,
        shipment_id: 5,
        label_pdf_base64: PDF_BASE64,
        carrier_response: null,
        label_size: null,
        tracking_number: "9400111111111111111111",
        carrier: "usps",
        service_type: "USPS_GROUND_ADVANTAGE",
        voided_at: null,
        voided_by: null,
        created_at: 11,
        ...overrides.label,
      },
    ]);
  }

  it("serves the stored label PDF as an attachment by default", async () => {
    const state = labelState();
    const app = makeApp(state);
    const res = await httpRequest(app, {
      method: "GET",
      path: "/admin/v1/shipments/5/label.pdf",
      token: adminToken(),
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers["content-type"], "application/pdf");
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(
      res.headers["content-length"],
      String(Buffer.from(PDF_BASE64, "base64").length),
    );
    assert.equal(
      res.headers["content-disposition"],
      'attachment; filename="shipment-5.pdf"',
    );
    assert.equal(res.text, "%PDF-1.4 admin label");
  });

  it("serves the label PDF inline when inline=1", async () => {
    const state = labelState();
    const app = makeApp(state);
    const res = await httpRequest(app, {
      method: "GET",
      path: "/admin/v1/shipments/5/label.pdf?inline=1",
      token: adminToken(),
    });

    assert.equal(res.status, 200);
    assert.equal(
      res.headers["content-disposition"],
      'inline; filename="shipment-5.pdf"',
    );
  });

  it("returns 400 for an invalid shipment id on label download", async () => {
    const state = labelState();
    const app = makeApp(state);
    const res = await httpRequest(app, {
      method: "GET",
      path: "/admin/v1/shipments/abc/label.pdf",
      token: adminToken(),
    });

    assert.equal(res.status, 400);
  });

  it("returns 404 for missing, non-label_created, or voided labels", async () => {
    const missingApp = makeApp(setState([]));
    const missing = await httpRequest(missingApp, {
      method: "GET",
      path: "/admin/v1/shipments/5/label.pdf",
      token: adminToken(),
    });
    assert.equal(missing.status, 404);

    const draftApp = makeApp(labelState({ shipment: { status: "draft" } }));
    const draft = await httpRequest(draftApp, {
      method: "GET",
      path: "/admin/v1/shipments/5/label.pdf",
      token: adminToken(),
    });
    assert.equal(draft.status, 404);

    const voidedApp = makeApp(
      labelState({
        label: {
          voided_at: "2026-01-01T00:00:00.000Z",
          voided_by: "admin@test.com",
        },
      }),
    );
    const voided = await httpRequest(voidedApp, {
      method: "GET",
      path: "/admin/v1/shipments/5/label.pdf",
      token: adminToken(),
    });
    assert.equal(voided.status, 404);
  });

  it("voids the latest label through the injected carrier seam and audits", async () => {
    const state = labelState();
    const calls: Array<{ carrier: string; trackingNumber: string }> = [];
    const app = makeApp(state, {
      voidShipment: async (carrier, trackingNumber) => {
        calls.push({ carrier, trackingNumber });
        return { carrier, voided: true, trackingNumber, response: {} };
      },
    });
    const res = await httpRequest(app, {
      method: "POST",
      path: "/admin/v1/shipments/5/void",
      token: adminToken(),
    });

    assert.equal(res.status, 200);
    assert.deepEqual(calls, [
      { carrier: "usps", trackingNumber: "9400111111111111111111" },
    ]);
    assert.equal(res.body.shipment.status, "voided");
    assert.ok(res.body.shipment.voidedAt);
    assert.ok(res.body.label.voidedAt);

    const rows = (state as any).rows;
    const shipmentRow = rows.find((r: any) => r.id === 5);
    assert.equal(shipmentRow.status, "voided");
    const labelRow = rows.find((r: any) => r.id === 1 && r.shipment_id === 5);
    assert.equal(labelRow.voided_at, "NOW()");
    assert.equal(labelRow.voided_by, "admin@test.com");

    const audit = rows.filter((r: any) => r.event_type === "label_voided");
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor_type, "admin");
    assert.equal(audit[0].actor, "admin@test.com");
    assert.equal(audit[0].link_id, 7);
    assert.equal(audit[0].vendor_id, 9);
    assert.equal(audit[0].shipment_id, 5);
    assert.deepEqual(audit[0].metadata, {
      labelId: 1,
      carrier: "usps",
      trackingNumber: "9400111111111111111111",
    });
  });

  it("returns 409 without carrier I/O when the shipment is already voided", async () => {
    const state = labelState({
      shipment: { status: "voided" },
      label: {
        voided_at: "2026-01-01T00:00:00.000Z",
        voided_by: "admin@test.com",
      },
    });
    let calls = 0;
    const app = makeApp(state, {
      voidShipment: async () => {
        calls += 1;
        throw new Error("carrier must not be called");
      },
    });
    const res = await httpRequest(app, {
      method: "POST",
      path: "/admin/v1/shipments/5/void",
      token: adminToken(),
    });

    assert.equal(res.status, 409);
    assert.equal(calls, 0);
  });

  it("returns 409 without carrier I/O when the latest label is already voided", async () => {
    const state = labelState({
      label: {
        voided_at: "2026-01-01T00:00:00.000Z",
        voided_by: "admin@test.com",
      },
    });
    let calls = 0;
    const app = makeApp(state, {
      voidShipment: async () => {
        calls += 1;
        throw new Error("carrier must not be called");
      },
    });
    const res = await httpRequest(app, {
      method: "POST",
      path: "/admin/v1/shipments/5/void",
      token: adminToken(),
    });

    assert.equal(res.status, 409);
    assert.equal(calls, 0);
  });

  it("returns 502 with a sanitized error when the carrier void fails", async () => {
    const state = labelState();
    const app = makeApp(state, {
      voidShipment: async () => {
        throw new Error("USPS 500 internal detail that must not leak");
      },
    });
    const res = await httpRequest(app, {
      method: "POST",
      path: "/admin/v1/shipments/5/void",
      token: adminToken(),
    });

    assert.equal(res.status, 502);
    assert.deepEqual(res.body, { error: "Label void failed" });

    const rows = (state as any).rows;
    assert.equal(rows.find((r: any) => r.id === 5).status, "label_created");
    assert.equal(
      rows.find((r: any) => r.id === 1 && r.shipment_id === 5).voided_at,
      null,
    );
    assert.equal(
      rows.filter((r: any) => r.event_type === "label_voided").length,
      0,
    );
  });

  it("returns 400/404 for invalid or missing shipment ids on void", async () => {
    const invalid = await httpRequest(makeApp(labelState()), {
      method: "POST",
      path: "/admin/v1/shipments/abc/void",
      token: adminToken(),
    });
    assert.equal(invalid.status, 400);

    const missing = await httpRequest(makeApp(setState([])), {
      method: "POST",
      path: "/admin/v1/shipments/5/void",
      token: adminToken(),
    });
    assert.equal(missing.status, 404);
  });
});

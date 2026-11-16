import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { createVendorRouter } from "../../src/routes/vendor.routes";
import { fakeKnex } from "./fake-knex";
import * as dbModule from "../../src/db";
import * as linksStore from "../../src/store/links.store";
import type { NotificationMail } from "../../src/core/mailer";

function makeApp(
  state: ReturnType<typeof fakeKnex>,
  seamClient: any,
  mailer?: { sendNotificationMail: (mail: NotificationMail) => Promise<void> },
) {
  const app = express();
  app.use((req, _res, next) => {
    req.requestId = `req-${Math.random().toString(36).slice(2)}`;
    next();
  });
  app.use(express.json());
  app.use("/v1", createVendorRouter({ seamClient, mailer }));
  return app;
}

function isoFuture(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

async function httpRequest(
  app: ReturnType<typeof makeApp>,
  opts: { method: string; path: string; token?: string; body?: unknown },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }> {
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
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            server.close(() => {
              let parsed: unknown;
              try {
                parsed = data ? JSON.parse(data) : null;
              } catch {
                parsed = data;
              }
              resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
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

describe("vendor routes", () => {
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

  function makeLink(
    token: string,
    overrides: Partial<import("../../src/types").Link> = {},
  ) {
    return {
      id: 1,
      vendor_id: 1,
      token_hash: linksStore.hashToken(token),
      expires_at: isoFuture(7),
      revoked_at: null,
      max_uses: null,
      use_count: 0,
      created_by: "admin@test.com",
      ship_from: {
        name: "Warehouse",
        street: "123 Main",
        city: "City",
        state: "ST",
        zip: "12345",
      },
      vendor_details: null,
      created_at: new Date().toISOString(),
      ...overrides,
    };
  }

  function vendorDetails(overrides: Record<string, unknown> = {}) {
    return {
      companyName: "Warehouse",
      contactName: "Warehouse Contact",
      contactEmail: "warehouse@example.com",
      contactPhone: "5125550100",
      addressLine1: "123 Main",
      city: "City",
      state: "ST",
      zipCode: "12345",
      countryCode: "US",
      taxIds: [],
      ...overrides,
    };
  }

  it("returns 401 without bearer token", async () => {
    setState([]);
    const app = makeApp(fakeKnex({ rows: [] }), null);
    const res = await httpRequest(app, { method: "GET", path: "/v1/status" });
    assert.equal(res.status, 401);
  });

  it("returns 404 for unknown token", async () => {
    setState([]);
    const app = makeApp(fakeKnex({ rows: [] }), null);
    const res = await httpRequest(app, {
      method: "GET",
      path: "/v1/status",
      token: "unknown-token",
    });
    assert.equal(res.status, 404);
  });

  it("returns 410 for expired link", async () => {
    const token = linksStore.generateToken();
    const state = setState([
      makeLink(token, {
        expires_at: new Date(Date.now() - 86400_000).toISOString(),
      }),
    ]);
    const app = makeApp(state, null);
    const res = await httpRequest(app, {
      method: "GET",
      path: "/v1/status",
      token,
    });
    assert.equal(res.status, 410);
    assert.equal(res.body.error, "link_expired");
  });

  it("returns 403 for revoked link", async () => {
    const token = linksStore.generateToken();
    const state = setState([
      makeLink(token, { revoked_at: new Date().toISOString() }),
    ]);
    const app = makeApp(state, null);
    const res = await httpRequest(app, {
      method: "GET",
      path: "/v1/status",
      token,
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "link_revoked");
  });

  it("rejects new rate requests for exhausted link", async () => {
    const token = linksStore.generateToken();
    const state = setState([makeLink(token, { max_uses: 1, use_count: 1 })]);
    const app = makeApp(state, null);
    const res = await httpRequest(app, {
      method: "POST",
      path: "/v1/rates",
      token,
      body: {
        shipTo: {
          addressLine1: "456 Oak",
          city: "Town",
          state: "CA",
          zipCode: "90210",
          countryCode: "US",
        },
        packages: [{ weight: 2.5 }],
        vendorDetails: vendorDetails(),
      },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "link_exhausted");
  });

  it("returns status for active link", async () => {
    const token = linksStore.generateToken();
    const state = setState([makeLink(token)]);
    const app = makeApp(state, null);
    const res = await httpRequest(app, {
      method: "GET",
      path: "/v1/status",
      token,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.link.status, "active");
  });

  it("returns rates from seam and writes audit event", async () => {
    const token = linksStore.generateToken();
    const state = setState([makeLink(token)]);

    const seamClient = {
      rateQuote: async () => ({
        rates: [
          {
            carrier: "fedex",
            service: "FEDEX_GROUND",
            cost: 12.5,
            currency: "USD",
          },
          {
            carrier: "stamps" as const,
            service: "usps_ground_advantage",
            cost: 8.5,
            currency: "USD",
          },
        ],
      }),
    };

    const app = makeApp(state, seamClient);
    const res = await httpRequest(app, {
      method: "POST",
      path: "/v1/rates",
      token,
      body: {
        shipTo: {
          addressLine1: "456 Oak",
          city: "Town",
          state: "CA",
          zipCode: "90210",
          countryCode: "US",
        },
        packages: [{ weight: 2.5 }],
        vendorDetails: vendorDetails(),
      },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.rates.length, 1);
    const audit = (state as any).rows.filter(
      (r: any) => r.event_type === "rate_retrieved",
    );
    assert.equal(audit.length, 1);
  });

  it("forwards shipDate to seam on rates", async () => {
    const token = linksStore.generateToken();
    const state = setState([makeLink(token)]);

    let captured: Record<string, unknown> | undefined;
    const seamClient = {
      rateQuote: async (params: Record<string, unknown>) => {
        captured = params;
        return { rates: [] };
      },
    };

    const app = makeApp(state, seamClient);
    const res = await httpRequest(app, {
      method: "POST",
      path: "/v1/rates",
      token,
      body: {
        shipTo: {
          addressLine1: "456 Oak",
          city: "Town",
          state: "CA",
          zipCode: "90210",
          countryCode: "US",
        },
        packages: [{ weight: 2.5 }],
        shipDate: "2026-11-15",
        vendorDetails: vendorDetails(),
      },
    });

    assert.equal(res.status, 200);
    assert.equal(captured?.shipDate, "2026-11-15");
  });

  it("forwards shipDate and pickup to seam and persists pickup on shipment", async () => {
    const token = linksStore.generateToken();
    const state = setState([makeLink(token)]);

    let captured: Record<string, unknown> | undefined;
    const seamClient = {
      createShipment: async (params: Record<string, unknown>) => {
        captured = params;
        return {
          labels: [
            {
              carrier: "fedex",
              trackingNumber: "TRACK1",
              labelData: "aGVsbG8=",
              format: "PDF",
            },
          ],
        };
      },
    };

    const app = makeApp(state, seamClient);
    const res = await httpRequest(app, {
      method: "POST",
      path: "/v1/shipment",
      token,
      body: {
        shipTo: {
          addressLine1: "456 Oak",
          city: "Town",
          state: "CA",
          zipCode: "90210",
          countryCode: "US",
        },
        packages: [{ weight: 2.5 }],
        vendorDetails: vendorDetails(),
        carrier: "fedex",
        serviceType: "FEDEX_GROUND",
        shipDate: "2026-11-15",
        pickup: {
          type: "pickup",
          date: "2026-11-15",
          readyTime: "09:00",
          closeTime: "17:00",
          instructions: "Ring bell",
        },
      },
    });

    assert.equal(res.status, 201);
    assert.equal(captured?.shipDate, "2026-11-15");
    assert.deepEqual(captured?.pickup, {
      type: "pickup",
      date: "2026-11-15",
      readyTime: "09:00",
      closeTime: "17:00",
      instructions: "Ring bell",
    });

    const rows = (state as any).rows as any[];
    const shipmentRow = rows.find((r) => r.link_id === 1 && r.pickup);
    assert.ok(shipmentRow, "shipment row should have persisted pickup");
    assert.equal(shipmentRow.pickup.type, "pickup");
  });

  it("rejects shipment with invalid pickup", async () => {
    const token = linksStore.generateToken();
    const state = setState([makeLink(token)]);
    const app = makeApp(state, null);

    for (const [label, body] of [
      [
        "bad type",
        {
          shipTo: {
            addressLine1: "456 Oak",
            city: "Town",
            state: "CA",
            zipCode: "90210",
            countryCode: "US",
          },
          packages: [{ weight: 2.5 }],
          vendorDetails: vendorDetails(),
          carrier: "fedex",
          serviceType: "FEDEX_GROUND",
          pickup: { type: "curbside" },
        },
      ],
      [
        "pickup missing date",
        {
          shipTo: {
            addressLine1: "456 Oak",
            city: "Town",
            state: "CA",
            zipCode: "90210",
            countryCode: "US",
          },
          packages: [{ weight: 2.5 }],
          vendorDetails: vendorDetails(),
          carrier: "fedex",
          serviceType: "FEDEX_GROUND",
          pickup: { type: "pickup" },
        },
      ],
      [
        "bad readyTime",
        {
          shipTo: {
            addressLine1: "456 Oak",
            city: "Town",
            state: "CA",
            zipCode: "90210",
            countryCode: "US",
          },
          packages: [{ weight: 2.5 }],
          vendorDetails: vendorDetails(),
          carrier: "fedex",
          serviceType: "FEDEX_GROUND",
          pickup: { type: "pickup", date: "2026-11-15", readyTime: "25:00" },
        },
      ],
    ] as const) {
      const res = await httpRequest(app, {
        method: "POST",
        path: "/v1/shipment",
        token,
        body,
      });
      assert.equal(res.status, 400, `${label} must 400`);
      assert.equal(res.body.code, "VALIDATION_ERROR");
      assert.ok(res.body.fieldErrors, `${label} should include fieldErrors`);
    }
  });

  it("rejects package weight over max cap", async () => {
    const token = linksStore.generateToken();
    const state = setState([makeLink(token)]);
    const app = makeApp(state, null);
    const res = await httpRequest(app, {
      method: "POST",
      path: "/v1/rates",
      token,
      body: {
        shipTo: {
          addressLine1: "456 Oak",
          city: "Town",
          state: "CA",
          zipCode: "90210",
          countryCode: "US",
        },
        packages: [{ weight: 999 }],
        vendorDetails: vendorDetails(),
      },
    });
    assert.equal(res.status, 400);
  });

  it("sends notification email with only recipientEmail", async () => {
    const token = linksStore.generateToken();
    const state = setState([makeLink(token)]);
    const previousHost = process.env.SMTP_HOST;
    process.env.SMTP_HOST = "smtp.test";

    const seamClient = {
      createShipment: async () => ({
        labels: [
          {
            carrier: "fedex",
            trackingNumber: "TRACK1",
            labelData: "aGVsbG8=",
            format: "PDF",
          },
        ],
      }),
    };

    let capturedMail: NotificationMail | undefined;
    const mailer = {
      sendNotificationMail: async (mail: NotificationMail) => {
        capturedMail = mail;
      },
    };

    const app = makeApp(state, seamClient, mailer);
    const res = await httpRequest(app, {
      method: "POST",
      path: "/v1/shipment",
      token,
      body: {
        shipTo: {
          addressLine1: "456 Oak",
          city: "Town",
          state: "CA",
          zipCode: "90210",
          countryCode: "US",
        },
        packages: [{ weight: 2.5 }],
        vendorDetails: vendorDetails({
          contactEmail: "first@example.com",
        }),
        carrier: "fedex",
        serviceType: "FEDEX_GROUND",
        notification: {
          enabled: true,
          recipientEmail: "second@example.com",
        },
      },
    });

    assert.equal(res.status, 201);
    assert.ok(capturedMail, "mailer should have been called");
    assert.deepEqual(capturedMail!.to, ["second@example.com"]);
    assert.equal(capturedMail!.trackingNumber, "TRACK1");
    // The label PDF rides along as an attachment.
    assert.deepEqual(capturedMail!.attachments, [
      { fileName: "label-TRACK1.pdf", contentBase64: "aGVsbG8=" },
    ]);

    const audit = (state as any).rows.filter(
      (r: any) => r.event_type === "notification_email_sent",
    );
    assert.equal(audit.length, 1);
    assert.deepEqual(audit[0].metadata.recipients, ["second@example.com"]);

    if (previousHost !== undefined) {
      process.env.SMTP_HOST = previousHost;
    } else {
      delete process.env.SMTP_HOST;
    }
  });

  it("deduplicates recipient, shipper, and additional emails in one mail", async () => {
    const token = linksStore.generateToken();
    const state = setState([makeLink(token)]);
    const previousHost = process.env.SMTP_HOST;
    process.env.SMTP_HOST = "smtp.test";

    const seamClient = {
      createShipment: async () => ({
        labels: [
          {
            carrier: "fedex",
            trackingNumber: "TRACK1",
            labelData: "aGVsbG8=",
            format: "PDF",
          },
        ],
      }),
    };

    let capturedMail: NotificationMail | undefined;
    const mailer = {
      sendNotificationMail: async (mail: NotificationMail) => {
        capturedMail = mail;
      },
    };

    const app = makeApp(state, seamClient, mailer);
    const res = await httpRequest(app, {
      method: "POST",
      path: "/v1/shipment",
      token,
      body: {
        shipTo: {
          addressLine1: "456 Oak",
          city: "Town",
          state: "CA",
          zipCode: "90210",
          countryCode: "US",
        },
        packages: [{ weight: 2.5 }],
        vendorDetails: vendorDetails({
          contactEmail: "same@example.com",
        }),
        carrier: "fedex",
        serviceType: "FEDEX_GROUND",
        notification: {
          enabled: true,
          recipientEmail: "same@example.com",
          shipperEmail: "SAME@EXAMPLE.COM",
          additionalEmail: "other@example.com",
        },
      },
    });

    assert.equal(res.status, 201);
    assert.deepEqual(capturedMail!.to, ["same@example.com", "other@example.com"]);

    if (previousHost !== undefined) {
      process.env.SMTP_HOST = previousHost;
    } else {
      delete process.env.SMTP_HOST;
    }
  });

  it("records notification_email_failed but still returns 201 when mailer throws", async () => {
    const token = linksStore.generateToken();
    const state = setState([makeLink(token)]);
    const previousHost = process.env.SMTP_HOST;
    process.env.SMTP_HOST = "smtp.test";

    const seamClient = {
      createShipment: async () => ({
        labels: [
          {
            carrier: "fedex",
            trackingNumber: "TRACK1",
            labelData: "aGVsbG8=",
            format: "PDF",
          },
        ],
      }),
    };

    const mailer = {
      sendNotificationMail: async () => {
        throw new Error("SMTP refused");
      },
    };

    const app = makeApp(state, seamClient, mailer);
    const res = await httpRequest(app, {
      method: "POST",
      path: "/v1/shipment",
      token,
      body: {
        shipTo: {
          addressLine1: "456 Oak",
          city: "Town",
          state: "CA",
          zipCode: "90210",
          countryCode: "US",
        },
        packages: [{ weight: 2.5 }],
        vendorDetails: vendorDetails({
          contactEmail: "first@example.com",
        }),
        carrier: "fedex",
        serviceType: "FEDEX_GROUND",
        notification: {
          enabled: true,
          recipientEmail: "second@example.com",
        },
      },
    });

    assert.equal(res.status, 201);
    const audit = (state as any).rows.filter(
      (r: any) => r.event_type === "notification_email_failed",
    );
    assert.equal(audit.length, 1);
    assert.equal(audit[0].metadata.error, "SMTP refused");

    if (previousHost !== undefined) {
      process.env.SMTP_HOST = previousHost;
    } else {
      delete process.env.SMTP_HOST;
    }
  });

  it("skips notification email when SMTP is not configured", async () => {
    const token = linksStore.generateToken();
    const state = setState([makeLink(token)]);

    const seamClient = {
      createShipment: async () => ({
        labels: [
          {
            carrier: "fedex",
            trackingNumber: "TRACK1",
            labelData: "aGVsbG8=",
            format: "PDF",
          },
        ],
      }),
    };

    const previousHost = process.env.SMTP_HOST;
    process.env.SMTP_HOST = "";

    const app = makeApp(state, seamClient);
    const res = await httpRequest(app, {
      method: "POST",
      path: "/v1/shipment",
      token,
      body: {
        shipTo: {
          addressLine1: "456 Oak",
          city: "Town",
          state: "CA",
          zipCode: "90210",
          countryCode: "US",
        },
        packages: [{ weight: 2.5 }],
        vendorDetails: vendorDetails({
          contactEmail: "first@example.com",
        }),
        carrier: "fedex",
        serviceType: "FEDEX_GROUND",
        notification: {
          enabled: true,
          recipientEmail: "second@example.com",
        },
      },
    });

    assert.equal(res.status, 201);
    const audit = (state as any).rows.filter(
      (r: any) => r.event_type === "notification_email_skipped",
    );
    assert.equal(audit.length, 1);
    assert.equal(audit[0].metadata.reason, "smtp_not_configured");

    if (previousHost !== undefined) {
      process.env.SMTP_HOST = previousHost;
    } else {
      delete process.env.SMTP_HOST;
    }
  });

  it("rejects notification enabled without email", async () => {
    const token = linksStore.generateToken();
    const state = setState([makeLink(token)]);
    const app = makeApp(state, null);
    const res = await httpRequest(app, {
      method: "POST",
      path: "/v1/shipment",
      token,
      body: {
        shipTo: {
          addressLine1: "456 Oak",
          city: "Town",
          state: "CA",
          zipCode: "90210",
          countryCode: "US",
        },
        packages: [{ weight: 2.5 }],
        vendorDetails: vendorDetails(),
        carrier: "fedex",
        serviceType: "FEDEX_GROUND",
        notification: {
          enabled: true,
        },
      },
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.code, "VALIDATION_ERROR");
    assert.equal(
      res.body.fieldErrors["notification.recipientEmail"],
      "provide at least one notification email when notifications are enabled",
    );
  });

  it("rejects notification enabled with invalid email", async () => {
    const token = linksStore.generateToken();
    const state = setState([makeLink(token)]);
    const app = makeApp(state, null);
    const res = await httpRequest(app, {
      method: "POST",
      path: "/v1/shipment",
      token,
      body: {
        shipTo: {
          addressLine1: "456 Oak",
          city: "Town",
          state: "CA",
          zipCode: "90210",
          countryCode: "US",
        },
        packages: [{ weight: 2.5 }],
        vendorDetails: vendorDetails(),
        carrier: "fedex",
        serviceType: "FEDEX_GROUND",
        notification: {
          enabled: true,
          recipientEmail: "not-an-email",
        },
      },
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.code, "VALIDATION_ERROR");
    assert.ok(res.body.fieldErrors["notification.recipientEmail"]);
  });

  it("blocks second label creation with 409", async () => {
    const token = linksStore.generateToken();
    const link = makeLink(token);
    const shipment = {
      id: 1,
      link_id: 1,
      vendor_id: 1,
      status: "label_created",
      ship_from: link.ship_from,
      ship_to: {},
      packages: {},
      selected_rate: null,
      carrier: null,
      service_type: null,
      tracking_number: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const label = {
      id: 1,
      shipment_id: 1,
      label_pdf_base64: "aGVsbG8=",
      carrier_response: null,
      label_size: null,
      tracking_number: "TRACK1",
      carrier: "fedex",
      service_type: "FEDEX_GROUND",
      voided_at: null,
      voided_by: null,
      created_at: new Date().toISOString(),
    };
    const state = setState([link, shipment, label]);
    const app = makeApp(state, null);
    const res = await httpRequest(app, {
      method: "POST",
      path: "/v1/shipment",
      token,
      body: {
        shipTo: {
          addressLine1: "456 Oak",
          city: "Town",
          state: "CA",
          zipCode: "90210",
          countryCode: "US",
        },
        packages: [{ weight: 2.5 }],
        vendorDetails: vendorDetails(),
        carrier: "fedex",
        serviceType: "FEDEX_GROUND",
      },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "label_already_exists");
  });

  it("downloads label.pdf with no-store headers after link exhaustion", async () => {
    const token = linksStore.generateToken();
    const link = makeLink(token, { max_uses: 1, use_count: 1 });
    const shipment = {
      id: 1,
      link_id: 1,
      vendor_id: 1,
      status: "label_created",
      ship_from: link.ship_from,
      ship_to: {},
      packages: {},
      selected_rate: null,
      carrier: null,
      service_type: null,
      tracking_number: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const label = {
      id: 1,
      shipment_id: 1,
      label_pdf_base64: Buffer.from("%PDF-1.4").toString("base64"),
      carrier_response: null,
      label_size: null,
      tracking_number: "TRACK1",
      carrier: "fedex",
      service_type: "FEDEX_GROUND",
      voided_at: null,
      voided_by: null,
      created_at: new Date().toISOString(),
    };
    const state = setState([link, shipment, label]);
    const app = makeApp(state, null);
    const statusRes = await httpRequest(app, {
      method: "GET",
      path: "/v1/status",
      token,
    });
    assert.equal(statusRes.status, 200);
    assert.equal(statusRes.body.link.status, "exhausted");
    assert.equal(statusRes.body.shipments.length, 1);

    const res = await httpRequest(app, {
      method: "GET",
      path: "/v1/label.pdf",
      token,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-type"], "application/pdf");
    assert.equal(res.headers["cache-control"], "no-store");
  });
});

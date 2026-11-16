import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  __resetForTests,
  __setUspsTransportForTests,
  createShipment,
  voidShipment,
} from "../../src/carriers/usps.client";
import {
  CarrierAuthError,
  CarrierConfigError,
} from "../../src/carriers/carrier-errors";
import type { ShipmentRequest } from "../../src/carriers/carrier-types";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

const ENV_KEYS = [
  "USPS_CLIENT_ID",
  "USPS_CLIENT_SECRET",
  "USPS_ACCOUNT_NUMBER",
  "CARRIER_SANDBOX",
] as const;
let savedEnv: Record<string, string | undefined> = {};

function fakeJwt(
  claims: Record<string, unknown> = {
    crid: "test-crid",
    mail_owners: [{ crid: "test-crid", mids: "test-mid" }],
  },
): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.test-signature`;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function capturingTransport(
  captured: CapturedRequest[],
  tokenClaims?: Record<string, unknown>,
): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const textBody = String(init?.body ?? "");
    let body: unknown = textBody;
    if (
      textBody &&
      init?.headers &&
      new Headers(init.headers).get("content-type")?.includes("json")
    ) {
      body = JSON.parse(textBody);
    }
    captured.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body,
    });
    if (url.includes("oauth2/v3/token")) {
      return json({ access_token: fakeJwt(tokenClaims), expires_in: 3600 });
    }
    if (url.includes("payments/v3/payment-authorization")) {
      return json({ paymentAuthorizationToken: "test-payment-token" });
    }
    if (url.includes("labels/v3/label")) {
      return json({
        trackingNumber: "9400111111111111111111",
        labelImage: Buffer.from("%PDF-1.4 test label").toString("base64"),
        postage: 5.25,
      });
    }
    throw new Error(`Unexpected test request: ${url}`);
  }) as typeof fetch;
}

function shipment(): ShipmentRequest {
  return {
    from: {
      addressLine1: "2901 Waugh Dr",
      city: "Houston",
      state: "TX",
      zipCode: "77019",
      countryCode: "US",
      contactName: "Sample Shipper",
      companyName: "SLG Sandbox Test",
    },
    to: {
      addressLine1: "350 5th Ave",
      addressLine2: "Suite 1",
      city: "New York",
      state: "NY",
      zipCode: "10118",
      countryCode: "US",
      contactName: "Sample Recipient",
    },
    packages: [
      { weight: 5, length: 10, width: 8, height: 4, insuredValue: 100 },
    ],
    serviceType: "USPS_GROUND_ADVANTAGE",
    labelFormat: "PDF",
    shipDate: "2026-11-10",
  };
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.USPS_CLIENT_ID = "test-client";
  process.env.USPS_CLIENT_SECRET = "test-secret";
  process.env.USPS_ACCOUNT_NUMBER = "test-eps-account";
  process.env.CARRIER_SANDBOX = "true";
  __resetForTests();
});

afterEach(() => {
  __setUspsTransportForTests(null);
  __resetForTests();
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("createShipment uses payments claims and the current sandbox label contract", async () => {
  const captured: CapturedRequest[] = [];
  __setUspsTransportForTests(capturingTransport(captured));

  const labels = await createShipment(shipment());

  assert.equal(labels.length, 1);
  assert.equal(labels[0].carrier, "usps");
  assert.equal(labels[0].environment, "sandbox");
  assert.equal(labels[0].trackingNumber, "9400111111111111111111");
  assert.equal(labels[0].cost, 5.25);
  assert.equal(
    Buffer.from(labels[0].labelData, "base64").toString(),
    "%PDF-1.4 test label",
  );

  const paymentCall = captured.find((entry) =>
    entry.url.includes("payments/v3/payment-authorization"),
  );
  assert.ok(paymentCall);
  const paymentBody = paymentCall.body as {
    roles: Array<Record<string, unknown>>;
  };
  assert.deepEqual(paymentBody.roles, [
    {
      roleName: "PAYER",
      CRID: "test-crid",
      MID: "test-mid",
      manifestMID: "test-mid",
      accountType: "EPS",
      accountNumber: "test-eps-account",
    },
    {
      roleName: "LABEL_OWNER",
      CRID: "test-crid",
      MID: "test-mid",
      manifestMID: "test-mid",
      accountType: "EPS",
      accountNumber: "test-eps-account",
    },
  ]);

  const labelCall = captured.find((entry) =>
    entry.url.includes("labels/v3/label"),
  );
  assert.ok(labelCall);
  assert.equal(labelCall.url, "https://apis-tem.usps.com/labels/v3/label");
  assert.equal(labelCall.method, "POST");
  assert.equal(
    labelCall.headers.get("x-payment-authorization-token"),
    "test-payment-token",
  );
  assert.equal(
    labelCall.headers.get("accept"),
    "application/vnd.usps.labels+json",
  );
  const body = labelCall.body as Record<string, any>;
  assert.deepEqual(body.imageInfo, {
    imageType: "PDF",
    labelType: "4X6LABEL",
    receiptOption: "NONE",
    suppressPostage: false,
    suppressMailDate: false,
    returnLabel: false,
  });
  assert.equal(body.toAddress.firstName, "Sample");
  assert.equal(body.toAddress.lastName, "Recipient");
  assert.equal(body.toAddress.secondaryAddress, "Suite 1");
  assert.equal(body.fromAddress.firm, "SLG Sandbox Test");
  assert.deepEqual(body.packageDescription, {
    mailClass: "USPS_GROUND_ADVANTAGE",
    rateIndicator: "SP",
    weightUOM: "lb",
    weight: 5,
    dimensionsUOM: "in",
    length: 10,
    width: 8,
    height: 4,
    processingCategory: "MACHINABLE",
    mailingDate: "2026-11-10",
    extraServices: [920],
    destinationEntryFacilityType: "NONE",
    packageOptions: { packageValue: 100 },
  });
  assert.equal("serviceType" in body, false);
  assert.equal("shipDate" in body, false);

  const oauthScopes = captured
    .filter((entry) => entry.url.includes("oauth2/v3/token"))
    .map((entry) => new URLSearchParams(String(entry.body)).get("scope"));
  assert.deepEqual(oauthScopes, ["payments", "labels"]);
  for (const entry of captured) {
    assert.equal(new URL(entry.url).hostname, "apis-tem.usps.com");
  }
});

test("createShipment reuses payment authorization for multiple packages", async () => {
  const captured: CapturedRequest[] = [];
  __setUspsTransportForTests(capturingTransport(captured));
  const input = shipment();
  input.packages.push({ weight: 2, length: 8, width: 6, height: 2 });

  const labels = await createShipment(input);

  assert.equal(labels.length, 2);
  assert.equal(
    captured.filter((entry) =>
      entry.url.includes("payments/v3/payment-authorization"),
    ).length,
    1,
  );
  assert.equal(
    captured.filter((entry) => entry.url.includes("labels/v3/label")).length,
    2,
  );
});

test("createShipment rejects a missing EPS account before network I/O", async () => {
  delete process.env.USPS_ACCOUNT_NUMBER;
  const captured: CapturedRequest[] = [];
  __setUspsTransportForTests(capturingTransport(captured));

  await assert.rejects(createShipment(shipment()), CarrierConfigError);
  assert.equal(captured.length, 0);
});

test("createShipment rejects OAuth tokens without payment identity claims", async () => {
  const captured: CapturedRequest[] = [];
  __setUspsTransportForTests(
    capturingTransport(captured, { sub: "no-payment-identity" }),
  );

  await assert.rejects(createShipment(shipment()), CarrierAuthError);
  assert.equal(
    captured.filter((entry) =>
      entry.url.includes("payments/v3/payment-authorization"),
    ).length,
    0,
  );
  assert.equal(
    captured.filter((entry) => entry.url.includes("labels/v3/label")).length,
    0,
  );
});
test("voidShipment uses the labels v3 DELETE contract on the sandbox host", async () => {
  const captured: CapturedRequest[] = [];
  __setUspsTransportForTests(capturingTransport(captured));

  const result = await voidShipment("9400111111111111111111");

  assert.equal(result.carrier, "usps");
  assert.equal(result.voided, true);
  assert.equal(result.trackingNumber, "9400111111111111111111");

  const voidCall = captured.find((entry) => entry.method === "DELETE");
  assert.ok(voidCall);
  assert.equal(
    voidCall.url,
    "https://apis-tem.usps.com/labels/v3/label/9400111111111111111111",
  );
  assert.equal(
    voidCall.headers.get("x-payment-authorization-token"),
    "test-payment-token",
  );

  // Payments OAuth first, then one payment-authorization call, then labels OAuth.
  const scopes = captured
    .filter((entry) => entry.url.includes("oauth2/v3/token"))
    .map((entry) => new URLSearchParams(String(entry.body)).get("scope"));
  assert.deepEqual(scopes, ["payments", "labels"]);
  assert.equal(
    captured.filter((entry) =>
      entry.url.includes("payments/v3/payment-authorization"),
    ).length,
    1,
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  __setFedexTransportForTests,
  rateShop as fedexRateShop,
  createShipment as fedexCreateShipment,
} from "../../src/carriers/fedex.client";
import {
  __setUpsTransportForTests,
  rateShop as upsRateShop,
} from "../../src/carriers/ups.client";
import {
  __setStampsTransportForTests,
  rateShop as stampsRateShop,
} from "../../src/carriers/stamps.client";
import { __resetCarrierCachesForTests } from "../../src/carriers/carrier.service";

/**
 * Carrier-reported delivery dates + pickup/drop-off wiring.
 *
 * Verifies each carrier client surfaces the expected delivery date VERBATIM
 * from the carrier's rate response (never computed locally) and that the
 * FedEx ship request reflects the shipment's pickup/drop-off selection.
 * Only obviously fake placeholder credentials — no real secrets.
 */

process.env.FEDEX_API_KEY = "test-fedex-key";
process.env.FEDEX_API_SECRET = "test-fedex-secret";
process.env.FEDEX_ACCOUNT_NUMBER = "test-fedex-account";
process.env.UPS_CLIENT_ID = "test-ups-id";
process.env.UPS_CLIENT_SECRET = "test-ups-secret";
process.env.UPS_ACCOUNT_NUMBER = "test-ups-account";
process.env.STAMPS_CLIENT_ID = "test-stamps-id";
process.env.STAMPS_CLIENT_SECRET = "test-stamps-secret";
process.env.STAMPS_REFRESH_TOKEN = "test-stamps-refresh";

const SHIP_DATE = "2026-11-20";

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const rateArgs = {
  fromZip: "342013",
  toZip: "11797",
  fromAddress: {
    addressLine1: "Street 1",
    city: "Jodhpur",
    state: "RJ",
    zipCode: "342013",
    countryCode: "IN",
  },
  toAddress: {
    addressLine1: "145 Michael Drive",
    city: "Syosset",
    state: "NY",
    zipCode: "11797",
    countryCode: "US",
  },
  packages: [{ weight: 2, length: 10, width: 8, height: 4 }],
  shipDate: SHIP_DATE,
};

// ---------------------------------------------------------------------------
// FedEx
// ---------------------------------------------------------------------------

function fakeFedexTransport(captured: { bodies: unknown[] }): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    const target = String(url);
    if (target.includes("oauth/token")) {
      return json({ access_token: "fake-token", expires_in: 3600 });
    }
    if (init?.body) captured.bodies.push(JSON.parse(String(init.body)));
    if (target.includes("rates/quotes")) {
      return json({
        output: {
          rateReplyDetails: [
            {
              serviceName: "FedEx International Priority",
              serviceType: "INTERNATIONAL_PRIORITY",
              // Only the commit date stamp — no deliveryTimestamp.
              commit: { dateDetail: { dayFormat: "2026-11-27" } },
              ratedShipmentDetails: [
                { totalNetCharge: { amount: 100, currency: "USD" } },
              ],
            },
            {
              serviceName: "FedEx International Connect Plus",
              serviceType: "FEDEX_INTERNATIONAL_CONNECT_PLUS",
              // deliveryTimestamp wins over commit.dateDetail.
              deliveryTimestamp: "2026-11-30T17:00:00-05:00",
              commit: { dateDetail: { dayFormat: "2026-11-29" } },
              ratedShipmentDetails: [
                { totalNetCharge: { amount: 80, currency: "USD" } },
              ],
            },
            {
              serviceName: "FedEx International Economy",
              serviceType: "INTERNATIONAL_ECONOMY",
              // Neither field — deliveryDate must stay absent.
              ratedShipmentDetails: [
                { totalNetCharge: { amount: 60, currency: "USD" } },
              ],
            },
          ],
        },
      });
    }
    if (target.includes("shipments")) {
      return json({
        output: {
          transactionShipments: [
            {
              masterTrackingNumber: "794658901234",
              pieceResponses: [
                {
                  packageDocuments: [
                    {
                      contentType: "LABEL",
                      docType: "PDF",
                      encodedLabel:
                        Buffer.from("%PDF-1.4 fake").toString("base64"),
                    },
                  ],
                },
              ],
            },
          ],
        },
      });
    }
    return json({});
  }) as typeof fetch;
}

const fedexShipmentBase = {
  // Domestic US→US so no customs detail is required.
  from: {
    addressLine1: "1 Ship Way",
    city: "Austin",
    state: "TX",
    zipCode: "78701",
    countryCode: "US",
    contactName: "Shipper",
  },
  to: {
    addressLine1: "145 Michael Drive",
    city: "Syosset",
    state: "NY",
    zipCode: "11797",
    countryCode: "US",
    contactName: "Recipient",
  },
  packages: [{ weight: 2 }],
  serviceType: "FEDEX_GROUND",
  labelFormat: "PDF" as const,
  shipDate: SHIP_DATE,
};

test("FedEx rateShop sends shipDatestamp and surfaces commit dates verbatim", async () => {
  __resetCarrierCachesForTests();
  const captured = { bodies: [] as unknown[] };
  __setFedexTransportForTests(fakeFedexTransport(captured));
  try {
    const rates = await fedexRateShop(rateArgs);
    const rateRequest = captured.bodies[0] as {
      requestedShipment: Record<string, unknown>;
    };
    assert.equal(
      rateRequest.requestedShipment.shipDatestamp,
      SHIP_DATE,
      "shipDate must reach the FedEx rate request as shipDatestamp",
    );
    const byService = Object.fromEntries(
      rates.map((rate) => [rate.service, rate]),
    );
    assert.equal(
      byService.INTERNATIONAL_PRIORITY.deliveryDate,
      "2026-11-27",
      "commit.dateDetail.dayFormat surfaces verbatim",
    );
    assert.equal(
      byService.FEDEX_INTERNATIONAL_CONNECT_PLUS.deliveryDate,
      "2026-11-30T17:00:00-05:00",
      "deliveryTimestamp wins when present",
    );
    assert.equal(
      byService.INTERNATIONAL_ECONOMY.deliveryDate,
      undefined,
      "no carrier date → no deliveryDate (never computed locally)",
    );
  } finally {
    __setFedexTransportForTests(null);
  }
});

test("FedEx createShipment sends DROPOFF_AT_FEDEX_LOCATION for drop-off", async () => {
  __resetCarrierCachesForTests();
  const captured = { bodies: [] as unknown[] };
  __setFedexTransportForTests(fakeFedexTransport(captured));
  try {
    await fedexCreateShipment({
      ...fedexShipmentBase,
      pickup: { type: "dropoff" },
    });
    const shipRequest = captured.bodies.at(-1) as {
      requestedShipment: Record<string, unknown>;
    };
    assert.equal(
      shipRequest.requestedShipment.pickupType,
      "DROPOFF_AT_FEDEX_LOCATION",
    );
    assert.equal(
      shipRequest.requestedShipment.pickupDetail,
      undefined,
      "drop-off shipments carry no pickupDetail",
    );
  } finally {
    __setFedexTransportForTests(null);
  }
});

test("FedEx createShipment sends pickupDetail window for scheduled pickup", async () => {
  __resetCarrierCachesForTests();
  const captured = { bodies: [] as unknown[] };
  __setFedexTransportForTests(fakeFedexTransport(captured));
  try {
    await fedexCreateShipment({
      ...fedexShipmentBase,
      pickup: {
        type: "pickup",
        date: SHIP_DATE,
        readyTime: "10:30",
        closeTime: "17:00",
        instructions: "Side door",
      },
    });
    const shipRequest = captured.bodies.at(-1) as {
      requestedShipment: {
        pickupType?: string;
        pickupDetail?: Record<string, unknown>;
      };
    };
    assert.equal(
      shipRequest.requestedShipment.pickupType,
      "USE_SCHEDULED_PICKUP",
    );
    assert.deepEqual(shipRequest.requestedShipment.pickupDetail, {
      readyPickupDateTime: "2026-11-20",
      latestPickupDateTime: "2026-11-20",
      courierInstructions: "Side door",
    });
  } finally {
    __setFedexTransportForTests(null);
  }
});

// ---------------------------------------------------------------------------
// UPS
// ---------------------------------------------------------------------------

test("UPS rateShop surfaces EstimatedArrival as deliveryDate", async () => {
  __resetCarrierCachesForTests();
  __setUpsTransportForTests(
    (async (url: unknown) => {
      const target = String(url);
      if (target.includes("oauth/token")) {
        return json({ access_token: "fake", expires_in: 3600 });
      }
      if (target.includes("rating")) {
        return json({
          RateResponse: {
            RatedShipment: [
              {
                Service: { Code: "03", Description: "UPS Ground" },
                TotalCharges: { MonetaryValue: "25.00", CurrencyCode: "USD" },
                TimeInTransit: {
                  BusinessDaysInTransit: "5",
                  ServiceSummary: {
                    EstimatedArrival: {
                      Arrival: { Date: "20261127", Time: "170000" },
                    },
                  },
                },
              },
              {
                Service: { Code: "01", Description: "UPS Next Day Air" },
                TotalCharges: { MonetaryValue: "90.00", CurrencyCode: "USD" },
                TimeInTransit: { BusinessDaysInTransit: "1" },
              },
            ],
          },
        });
      }
      return json({});
    }) as typeof fetch,
  );
  try {
    const rates = await upsRateShop(rateArgs);
    const byService = Object.fromEntries(
      rates.map((rate) => [rate.service, rate]),
    );
    assert.equal(
      byService["03"].deliveryDate,
      "2026-11-27T17:00:00",
      "EstimatedArrival Date+Time normalized to ISO",
    );
    assert.equal(
      byService["01"].deliveryDate,
      undefined,
      "no EstimatedArrival → no deliveryDate",
    );
    assert.equal(byService["01"].deliveryDays, "1");
  } finally {
    __setUpsTransportForTests(null);
  }
});

// ---------------------------------------------------------------------------
// Stamps (SERA)
// ---------------------------------------------------------------------------

test("Stamps rateShop surfaces estimated_delivery_date as deliveryDate", async () => {
  __resetCarrierCachesForTests();
  __setStampsTransportForTests(
    (async (url: unknown) => {
      const target = String(url);
      if (target.includes("oauth/token")) {
        return json({ access_token: "fake", expires_in: 3600 });
      }
      if (target.includes("sera/v1/rates")) {
        return json([
          {
            service_type: "usps_priority_mail",
            packaging_type: "package",
            estimated_delivery_days: "3",
            estimated_delivery_date: "2026-11-25",
            shipment_cost: { total_amount: 9.5, currency: "usd" },
          },
        ]);
      }
      return json({});
    }) as typeof fetch,
  );
  try {
    const rates = await stampsRateShop(rateArgs);
    const priority = rates.find(
      (rate) => rate.service === "usps_priority_mail",
    );
    assert.ok(priority, "expected a priority mail quote");
    assert.equal(priority.deliveryDate, "2026-11-25");
    assert.equal(priority.deliveryDays, "3");
  } finally {
    __setStampsTransportForTests(null);
  }
});

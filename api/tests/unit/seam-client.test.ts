import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSeamClient } from "../../src/carriers/seam-client";

describe("seam client", () => {
  it("calls rate-quote with correct headers and body", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const fetcher = (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return Promise.resolve(
        new Response(JSON.stringify({ rates: [] }), { status: 200 }),
      );
    };

    process.env.SLG_INTERNAL_API_KEY = "test-key-32-characters-long!!";
    const client = createSeamClient({
      baseUrl: "http://backend.test",
      fetcher: fetcher as unknown as typeof fetch,
    });

    await client.rateQuote(
      {
        carrier: "fedex",
        from: {
          addressLine1: "123 Main",
          city: "City",
          state: "ST",
          zipCode: "12345",
          countryCode: "US",
        },
        to: {
          addressLine1: "456 Oak",
          city: "Town",
          state: "CA",
          zipCode: "90210",
          countryCode: "US",
        },
        packages: [{ weight: 1 }],
      },
      "req-123",
    );

    assert.equal(requests.length, 1);
    const req = requests[0];
    assert.equal(req.url, "http://backend.test/internal/shipping/rate-quote");
    const headers = req.init.headers as Record<string, string>;
    assert.equal(
      headers["Authorization"],
      "Bearer test-key-32-characters-long!!",
    );
    assert.equal(headers["X-Request-Id"], "req-123");
    const body = JSON.parse(req.init.body as string);
    assert.equal(body.carrier, "fedex");
  });

  it("calls create-shipment with correct payload", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const fetcher = (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            labels: [
              {
                carrier: "fedex",
                trackingNumber: "TRACK",
                labelData: "aGVsbG8=",
                format: "PDF",
              },
            ],
          }),
          { status: 200 },
        ),
      );
    };

    process.env.SLG_INTERNAL_API_KEY = "test-key-32-characters-long!!";
    const client = createSeamClient({
      baseUrl: "http://backend.test",
      fetcher: fetcher as unknown as typeof fetch,
    });

    const result = await client.createShipment({
      carrier: "fedex",
      from: {
        addressLine1: "123 Main",
        city: "City",
        state: "ST",
        zipCode: "12345",
        countryCode: "US",
      },
      to: {
        addressLine1: "456 Oak",
        city: "Town",
        state: "CA",
        zipCode: "90210",
        countryCode: "US",
      },
      packages: [{ weight: 1 }],
      serviceType: "FEDEX_GROUND",
      labelFormat: "PDF",
    });

    assert.equal(result.labels.length, 1);
    assert.equal(result.labels[0].trackingNumber, "TRACK");
  });

  it("throws on non-2xx responses", async () => {
    const fetcher = () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "bad request" }), { status: 400 }),
      );

    process.env.SLG_INTERNAL_API_KEY = "test-key-32-characters-long!!";
    const client = createSeamClient({
      baseUrl: "http://backend.test",
      fetcher: fetcher as unknown as typeof fetch,
    });

    await assert.rejects(
      () => client.getServices("fedex", "req-456"),
      /HTTP 400/,
    );
  });
});

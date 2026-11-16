import assert from "node:assert/strict";
import test from "node:test";
import type { Knex } from "knex";
import {
  createShipment,
  getShipmentById,
  listShipmentsByVendor,
  markShipmentVoided,
  updateShipment,
} from "../../src/store/shipments.store";
import { fakeKnex, FakeRow } from "./fake-knex";

function makeKnex(rows: FakeRow[] = []): Knex {
  return fakeKnex({ rows });
}

test("createShipment defaults status to draft", async () => {
  const knex = makeKnex();
  const shipment = await createShipment(
    {
      link_id: 1,
      vendor_id: 2,
      ship_from: { city: "A" },
      ship_to: { city: "B" },
      packages: { items: [{ weight: 1 }] },
    },
    knex,
  );
  assert.equal(shipment.status, "draft");
  assert.equal(shipment.vendor_id, 2);
});

test("updateShipment updates selected rate and carrier", async () => {
  const knex = makeKnex([
    {
      id: 1,
      link_id: 1,
      vendor_id: 2,
      status: "draft",
      ship_from: {},
      ship_to: {},
      packages: {},
      selected_rate: null,
      carrier: null,
      service_type: null,
      tracking_number: null,
      created_at: 1,
      updated_at: 1,
    },
  ]);
  const updated = await updateShipment(
    1,
    {
      status: "rated",
      selected_rate: { amount: 12.5 },
      carrier: "fedex",
    },
    knex,
  );
  assert.equal(updated?.status, "rated");
  assert.equal(updated?.carrier, "fedex");
});

test("markShipmentVoided sets status to voided", async () => {
  const knex = makeKnex([
    {
      id: 1,
      link_id: 1,
      vendor_id: 2,
      status: "label_created",
      ship_from: {},
      ship_to: {},
      packages: {},
      selected_rate: null,
      carrier: null,
      service_type: null,
      tracking_number: null,
      created_at: 1,
      updated_at: 1,
    },
  ]);
  const ok = await markShipmentVoided(1, knex);
  assert.equal(ok, true);
  assert.equal((await getShipmentById(1, knex))?.status, "voided");
});

test("listShipmentsByVendor filters by vendor_id", async () => {
  const knex = makeKnex([
    {
      id: 1,
      link_id: 1,
      vendor_id: 2,
      status: "draft",
      ship_from: {},
      ship_to: {},
      packages: {},
      selected_rate: null,
      carrier: null,
      service_type: null,
      tracking_number: null,
      created_at: 1,
      updated_at: 1,
    },
    {
      id: 2,
      link_id: 2,
      vendor_id: 3,
      status: "draft",
      ship_from: {},
      ship_to: {},
      packages: {},
      selected_rate: null,
      carrier: null,
      service_type: null,
      tracking_number: null,
      created_at: 2,
      updated_at: 2,
    },
  ]);
  const rows = await listShipmentsByVendor(2, knex);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 1);
});

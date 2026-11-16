import assert from "node:assert/strict";
import test from "node:test";
import type { Knex } from "knex";
import {
  createLabel,
  getLabelById,
  getLabelsByShipment,
  latestLabelByShipment,
  markLabelVoided,
} from "../../src/store/labels.store";
import { fakeKnex, FakeRow } from "./fake-knex";

function makeKnex(rows: FakeRow[] = []): Knex {
  return fakeKnex({ rows });
}

test("createLabel stores base64 pdf", async () => {
  const knex = makeKnex();
  const label = await createLabel(
    { shipment_id: 1, label_pdf_base64: "JVBERi0=" },
    knex,
  );
  assert.equal(label.label_pdf_base64, "JVBERi0=");
  assert.ok(!label.voided_at, "new label must not be voided");
  assert.ok(!label.voided_by);
});

test("latestLabelByShipment returns newest label", async () => {
  const knex = makeKnex([
    {
      id: 1,
      shipment_id: 5,
      label_pdf_base64: "old",
      carrier_response: null,
      label_size: null,
      tracking_number: null,
      carrier: null,
      service_type: null,
      voided_at: null,
      voided_by: null,
      created_at: 1,
    },
    {
      id: 2,
      shipment_id: 5,
      label_pdf_base64: "new",
      carrier_response: null,
      label_size: null,
      tracking_number: null,
      carrier: null,
      service_type: null,
      voided_at: null,
      voided_by: null,
      created_at: 2,
    },
  ]);
  const label = await latestLabelByShipment(5, knex);
  assert.equal(label?.label_pdf_base64, "new");
});

test("markLabelVoided sets void metadata", async () => {
  const knex = makeKnex([
    {
      id: 1,
      shipment_id: 1,
      label_pdf_base64: "x",
      carrier_response: null,
      label_size: null,
      tracking_number: null,
      carrier: null,
      service_type: null,
      voided_at: null,
      voided_by: null,
      created_at: 1,
    },
  ]);
  const label = await markLabelVoided(1, "admin@example.com", knex);
  assert.equal(label?.voided_at, "NOW()");
  assert.equal(label?.voided_by, "admin@example.com");
});

test("getLabelsByShipment returns labels ordered newest first", async () => {
  const knex = makeKnex([
    {
      id: 1,
      shipment_id: 9,
      label_pdf_base64: "a",
      carrier_response: null,
      label_size: null,
      tracking_number: null,
      carrier: null,
      service_type: null,
      voided_at: null,
      voided_by: null,
      created_at: 3,
    },
    {
      id: 2,
      shipment_id: 9,
      label_pdf_base64: "b",
      carrier_response: null,
      label_size: null,
      tracking_number: null,
      carrier: null,
      service_type: null,
      voided_at: null,
      voided_by: null,
      created_at: 1,
    },
  ]);
  const labels = await getLabelsByShipment(9, knex);
  assert.deepEqual(
    labels.map((l) => l.id),
    [1, 2],
  );
});

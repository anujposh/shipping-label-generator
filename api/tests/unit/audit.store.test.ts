import assert from "node:assert/strict";
import test from "node:test";
import type { Knex } from "knex";
import { listAuditEvents, recordAuditEvent } from "../../src/store/audit.store";
import { fakeKnex, FakeRow } from "./fake-knex";

function makeKnex(rows: FakeRow[] = []): Knex {
  return fakeKnex({ rows });
}

test("recordAuditEvent stores all fields", async () => {
  const knex = makeKnex();
  const event = await recordAuditEvent(
    {
      event_type: "link_created",
      actor: "admin@example.com",
      actor_type: "admin",
      ip_address: "127.0.0.1",
      request_id: "req-1",
      link_id: 1,
      vendor_id: 2,
      metadata: { token_preview: "abc..." },
    },
    knex,
  );
  assert.equal(event.event_type, "link_created");
  assert.equal(event.actor, "admin@example.com");
  assert.equal(event.actor_type, "admin");
  assert.equal(event.ip_address, "127.0.0.1");
  assert.equal(event.request_id, "req-1");
  assert.equal(event.link_id, 1);
  assert.equal(event.vendor_id, 2);
  assert.deepEqual(event.metadata, { token_preview: "abc..." });
});

test("listAuditEvents filters by link_id", async () => {
  const knex = makeKnex([
    {
      id: 1,
      event_type: "link_created",
      actor: null,
      actor_type: "system",
      ip_address: null,
      occurred_at: 1,
      request_id: null,
      link_id: 1,
      vendor_id: null,
      shipment_id: null,
      metadata: null,
    },
    {
      id: 2,
      event_type: "link_revoked",
      actor: null,
      actor_type: "system",
      ip_address: null,
      occurred_at: 2,
      request_id: null,
      link_id: 2,
      vendor_id: null,
      shipment_id: null,
      metadata: null,
    },
  ]);
  const events = await listAuditEvents({ linkId: 1 }, knex);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, 1);
});

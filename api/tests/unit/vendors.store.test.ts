import assert from "node:assert/strict";
import test from "node:test";
import type { Knex } from "knex";
import {
  archiveVendor,
  createVendor,
  getVendorById,
  listVendors,
  updateVendor,
} from "../../src/store/vendors.store";
import { fakeKnex, FakeRow } from "./fake-knex";

function makeKnex(rows: FakeRow[] = []): Knex {
  return fakeKnex({ rows });
}

test("createVendor inserts and returns row", async () => {
  const knex = makeKnex();
  const vendor = await createVendor(
    { name: "Acme", contact_email: "acme@example.com" },
    knex,
  );
  assert.equal(vendor.name, "Acme");
  assert.equal(vendor.contact_email, "acme@example.com");
  assert.ok(!vendor.archived_at, "new vendor must not be archived");
  assert.equal(vendor.notes, null);
});

test("getVendorById returns null when missing", async () => {
  const knex = makeKnex();
  const vendor = await getVendorById(404, knex);
  assert.equal(vendor, null);
});

test("updateVendor patches only provided fields", async () => {
  const knex = makeKnex([
    {
      id: 1,
      name: "Acme",
      contact_email: "old@example.com",
      notes: "notes",
      created_at: 1,
      archived_at: null,
    },
  ]);
  const updated = await updateVendor(1, { name: "Acme Inc" }, knex);
  assert.equal(updated?.name, "Acme Inc");
  assert.equal(updated?.contact_email, "old@example.com");
});

test("archiveVendor sets archived_at", async () => {
  const knex = makeKnex([
    {
      id: 1,
      name: "Acme",
      contact_email: null,
      notes: null,
      created_at: 1,
      archived_at: null,
    },
  ]);
  const archived = await archiveVendor(1, knex);
  assert.equal(archived, true);
  assert.equal((await getVendorById(1, knex))?.archived_at, "NOW()");
});

test("listVendors excludes archived by default", async () => {
  const knex = makeKnex([
    {
      id: 1,
      name: "Active",
      contact_email: null,
      notes: null,
      created_at: 1,
      archived_at: null,
    },
    {
      id: 2,
      name: "Archived",
      contact_email: null,
      notes: null,
      created_at: 2,
      archived_at: "NOW()",
    },
  ]);
  const vendors = await listVendors({}, knex);
  assert.equal(vendors.length, 1);
  assert.equal(vendors[0].id, 1);
});

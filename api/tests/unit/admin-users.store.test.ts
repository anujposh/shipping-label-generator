import assert from "node:assert/strict";
import test from "node:test";
import type { Knex } from "knex";
import {
  createAdminUser,
  deactivateAdminUser,
  getAdminUserByEmail,
  updateAdminUser,
} from "../../src/store/admin-users.store";
import { fakeKnex, FakeRow } from "./fake-knex";

function makeKnex(rows: FakeRow[] = []): Knex {
  return fakeKnex({ rows });
}

test("createAdminUser lowercases email", async () => {
  const knex = makeKnex();
  const user = await createAdminUser(
    { email: "ADMIN@Example.com", password_hash: "hash" },
    knex,
  );
  assert.equal(user.email, "admin@example.com");
});

test("getAdminUserByEmail is case-insensitive", async () => {
  const knex = makeKnex([
    {
      id: 1,
      email: "admin@example.com",
      password_hash: "hash",
      name: null,
      is_active: true,
      created_at: 1,
      updated_at: 1,
    },
  ]);
  const user = await getAdminUserByEmail("ADMIN@EXAMPLE.COM", knex);
  assert.ok(user);
  assert.equal(user?.id, 1);
});

test("updateAdminUser lowercases email and updates password", async () => {
  const knex = makeKnex([
    {
      id: 1,
      email: "old@example.com",
      password_hash: "oldhash",
      name: "Old",
      is_active: true,
      created_at: 1,
      updated_at: 1,
    },
  ]);
  const updated = await updateAdminUser(
    1,
    { email: "NEW@Example.com", password_hash: "newhash" },
    knex,
  );
  assert.equal(updated?.email, "new@example.com");
  assert.equal(updated?.password_hash, "newhash");
  assert.equal(updated?.name, "Old");
});

test("deactivateAdminUser flips is_active", async () => {
  const knex = makeKnex([
    {
      id: 1,
      email: "admin@example.com",
      password_hash: "hash",
      name: null,
      is_active: true,
      created_at: 1,
      updated_at: 1,
    },
  ]);
  const updated = await deactivateAdminUser(1, knex);
  assert.equal(updated?.is_active, false);
});

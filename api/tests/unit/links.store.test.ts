import assert from "node:assert/strict";
import test from "node:test";
import type { Knex } from "knex";
import {
  createLink,
  getLinkById,
  getLinkByTokenHash,
  hashToken,
  incrementLinkUseCount,
  isLinkActive,
  listLinksByVendor,
  revokeLink,
} from "../../src/store/links.store";
import type { Link } from "../../src/types";
import { fakeKnex, FakeRow } from "./fake-knex";

function makeKnex(rows: FakeRow[] = []): Knex {
  return fakeKnex({ rows });
}

test("createLink stores token hash and returns plaintext token", async () => {
  const knex = makeKnex();
  const { link, token } = await createLink(
    {
      vendor_id: 1,
      expires_at: new Date(Date.now() + 3600_000),
      created_by: "admin@example.com",
      ship_from: {
        name: "WH",
        street: "123 Main",
        city: "City",
        state: "ST",
        zip: "12345",
      },
    },
    knex,
  );
  assert.ok(token.length >= 64);
  assert.equal(link.token_hash, hashToken(token));
});

test("getLinkByTokenHash returns matching link", async () => {
  const token = "abc123";
  const knex = makeKnex([
    {
      id: 1,
      vendor_id: 1,
      token_hash: hashToken(token),
      expires_at: new Date(Date.now() + 3600_000),
      revoked_at: null,
      max_uses: null,
      use_count: 0,
      created_by: "admin@example.com",
      ship_from: { name: "WH" },
      created_at: 1,
    },
  ]);
  const link = await getLinkByTokenHash(hashToken(token), knex);
  assert.ok(link);
  assert.equal(link?.vendor_id, 1);
});

test("revokeLink sets revoked_at", async () => {
  const knex = makeKnex([
    {
      id: 1,
      vendor_id: 1,
      token_hash: hashToken("x"),
      expires_at: new Date(Date.now() + 3600_000),
      revoked_at: null,
      max_uses: null,
      use_count: 0,
      created_by: "admin@example.com",
      ship_from: { name: "WH" },
      created_at: 1,
    },
  ]);
  const link = await revokeLink(1, knex);
  assert.ok(link);
  assert.equal(link?.revoked_at, "NOW()");
});

test("isLinkActive respects expiry, revocation, and max uses", () => {
  const base: Link = {
    id: 1,
    vendor_id: 1,
    bc_company_id: null,
    bc_company_name: null,
    token_hash: "hash",
    expires_at: new Date(Date.now() + 3600_000),
    revoked_at: null,
    max_uses: null,
    use_count: 0,
    created_by: "admin@example.com",
    ship_from: { name: "WH" },
    vendor_details: null,
    created_at: new Date(),
  };
  assert.equal(isLinkActive(base), true);
  assert.equal(isLinkActive({ ...base, revoked_at: new Date() }), false);
  assert.equal(
    isLinkActive({ ...base, expires_at: new Date(Date.now() - 1) }),
    false,
  );
  assert.equal(isLinkActive({ ...base, max_uses: 5, use_count: 5 }), false);
});

test("incrementLinkUseCount bumps use_count", async () => {
  const knex = makeKnex([
    {
      id: 1,
      vendor_id: 1,
      token_hash: hashToken("x"),
      expires_at: new Date(Date.now() + 3600_000),
      revoked_at: null,
      max_uses: 10,
      use_count: 2,
      created_by: "admin@example.com",
      ship_from: { name: "WH" },
      created_at: 1,
    },
  ]);
  await incrementLinkUseCount(1, knex);
  assert.equal((await getLinkById(1, knex))?.use_count, 3);
});

test("listLinksByVendor orders newest first", async () => {
  const knex = makeKnex([
    {
      id: 1,
      vendor_id: 7,
      token_hash: "a",
      expires_at: new Date(Date.now() + 3600_000),
      revoked_at: null,
      max_uses: null,
      use_count: 0,
      created_by: "admin@example.com",
      ship_from: { name: "WH" },
      created_at: 1,
    },
    {
      id: 2,
      vendor_id: 7,
      token_hash: "b",
      expires_at: new Date(Date.now() + 3600_000),
      revoked_at: null,
      max_uses: null,
      use_count: 0,
      created_by: "admin@example.com",
      ship_from: { name: "WH" },
      created_at: 2,
    },
  ]);
  const links = await listLinksByVendor(7, knex);
  assert.deepEqual(
    links.map((l) => l.id),
    [2, 1],
  );
});

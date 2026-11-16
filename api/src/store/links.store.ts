import { createHash, randomBytes } from "node:crypto";
import { Knex } from "knex";
import { db } from "../db";
import type { Link, LinkInsert } from "../types";

const TABLE = "slg_links";

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createLink(
  row: Omit<LinkInsert, "token_hash"> & { token?: string },
  knex: Knex = db,
): Promise<{ link: Link; token: string }> {
  const token = row.token ?? generateToken();
  const tokenHash = hashToken(token);
  const [{ id }] = await knex<Link>(TABLE)
    .insert({
      vendor_id: row.vendor_id,
      bc_company_id: row.bc_company_id ?? null,
      bc_company_name: row.bc_company_name ?? null,
      token_hash: tokenHash,
      expires_at: row.expires_at,
      max_uses: row.max_uses ?? null,
      created_by: row.created_by,
      ship_from: row.ship_from,
      vendor_details: row.vendor_details ?? null,
    })
    .returning("id");
  const link = await getLinkById(id as number, knex);
  if (!link) {
    throw new Error("Link insert did not return a row");
  }
  return { link, token };
}

export async function getLinkById(
  id: number,
  knex: Knex = db,
): Promise<Link | null> {
  const rows = await knex<Link>(TABLE).where({ id }).limit(1);
  return rows[0] ?? null;
}

export async function getLinkByTokenHash(
  tokenHash: string,
  knex: Knex = db,
): Promise<Link | null> {
  const rows = await knex<Link>(TABLE)
    .where({ token_hash: tokenHash })
    .limit(1);
  return rows[0] ?? null;
}

export async function listLinksByVendor(
  vendorId: number,
  knex: Knex = db,
): Promise<Link[]> {
  return knex<Link>(TABLE)
    .where({ vendor_id: vendorId })
    .orderBy("created_at", "desc");
}

export async function listAllLinks(knex: Knex = db): Promise<Link[]> {
  return knex<Link>(TABLE).orderBy("created_at", "desc").limit(500);
}

export async function incrementLinkUseCount(
  id: number,
  knex: Knex = db,
): Promise<void> {
  await knex<Link>(TABLE).where({ id }).increment("use_count", 1);
}

/**
 * Persist validated vendor identity on an authenticated link. The `id` must
 * always come from bearer-token resolution (`req.link.id`), never the browser.
 */
export async function updateLinkVendorDetails(
  id: number,
  details: Record<string, unknown>,
  knex: Knex = db,
): Promise<Link | null> {
  await knex<Link>(TABLE).where({ id }).update({ vendor_details: details });
  return getLinkById(id, knex);
}

export async function revokeLink(
  id: number,
  knex: Knex = db,
): Promise<Link | null> {
  const existing = await getLinkById(id, knex);
  if (!existing || existing.revoked_at !== null) return null;

  await knex<Link>(TABLE).where({ id }).update({ revoked_at: knex.fn.now() });
  return getLinkById(id, knex);
}

export function isLinkActive(link: Link, now: Date = new Date()): boolean {
  if (link.revoked_at) return false;
  if (new Date(link.expires_at) <= now) return false;
  if (link.max_uses !== null && link.use_count >= link.max_uses) return false;
  return true;
}

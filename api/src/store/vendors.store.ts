import { Knex } from "knex";
import { db } from "../db";
import type { Vendor, VendorInsert } from "../types";

const TABLE = "slg_vendors";

export async function createVendor(
  row: VendorInsert,
  knex: Knex = db,
): Promise<Vendor> {
  const [{ id }] = await knex<Vendor>(TABLE)
    .insert({
      name: row.name,
      contact_email: row.contact_email ?? null,
      notes: row.notes ?? null,
    })
    .returning("id");
  const created = await getVendorById(id as number, knex);
  if (!created) {
    throw new Error("Vendor insert did not return a row");
  }
  return created;
}

export async function getVendorById(
  id: number,
  knex: Knex = db,
): Promise<Vendor | null> {
  const rows = await knex<Vendor>(TABLE).where({ id }).limit(1);
  return rows[0] ?? null;
}

export async function listVendors(
  options: { includeArchived?: boolean; limit?: number; offset?: number } = {},
  knex: Knex = db,
): Promise<Vendor[]> {
  const rows = await knex<Vendor>(TABLE).orderBy("created_at", "desc");
  let result = options.includeArchived
    ? rows
    : rows.filter((r) => r.archived_at == null);
  if (options.offset !== undefined) {
    result = result.slice(options.offset);
  }
  if (options.limit !== undefined) {
    result = result.slice(0, options.limit);
  }
  return result;
}

export async function updateVendor(
  id: number,
  patch: Partial<VendorInsert>,
  knex: Knex = db,
): Promise<Vendor | null> {
  const existing = await getVendorById(id, knex);
  if (!existing) return null;

  await knex<Vendor>(TABLE)
    .where({ id })
    .update({
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.contact_email !== undefined && {
        contact_email: patch.contact_email,
      }),
      ...(patch.notes !== undefined && { notes: patch.notes }),
    });
  return getVendorById(id, knex);
}

export async function archiveVendor(
  id: number,
  knex: Knex = db,
): Promise<boolean> {
  const existing = await getVendorById(id, knex);
  if (!existing || existing.archived_at !== null) return false;

  const count = await knex<Vendor>(TABLE)
    .where({ id })
    .update({ archived_at: knex.fn.now() });
  return count > 0;
}

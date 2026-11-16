import { Knex } from "knex";
import { db } from "../db";
import type { AdminUser, AdminUserInsert } from "../types";

const TABLE = "slg_admin_users";

export async function createAdminUser(
  row: AdminUserInsert,
  knex: Knex = db,
): Promise<AdminUser> {
  const [{ id }] = await knex<AdminUser>(TABLE)
    .insert({
      email: row.email.toLowerCase().trim(),
      password_hash: row.password_hash,
      name: row.name ?? null,
    })
    .returning("id");
  const user = await getAdminUserById(id as number, knex);
  if (!user) {
    throw new Error("Admin user insert did not return a row");
  }
  return user;
}

export async function getAdminUserById(
  id: number,
  knex: Knex = db,
): Promise<AdminUser | null> {
  const rows = await knex<AdminUser>(TABLE).where({ id }).limit(1);
  return rows[0] ?? null;
}

export async function getAdminUserByEmail(
  email: string,
  knex: Knex = db,
): Promise<AdminUser | null> {
  const rows = await knex<AdminUser>(TABLE)
    .where({ email: email.toLowerCase().trim() })
    .limit(1);
  return rows[0] ?? null;
}

export async function listAdminUsers(knex: Knex = db): Promise<AdminUser[]> {
  return knex<AdminUser>(TABLE).orderBy("created_at", "desc");
}

export async function updateAdminUser(
  id: number,
  patch: Partial<AdminUserInsert>,
  knex: Knex = db,
): Promise<AdminUser | null> {
  const existing = await getAdminUserById(id, knex);
  if (!existing) return null;

  await knex<AdminUser>(TABLE)
    .where({ id })
    .update({
      ...(patch.email !== undefined && {
        email: patch.email.toLowerCase().trim(),
      }),
      ...(patch.password_hash !== undefined && {
        password_hash: patch.password_hash,
      }),
      ...(patch.name !== undefined && { name: patch.name }),
      updated_at: knex.fn.now(),
    });
  return getAdminUserById(id, knex);
}

export async function deactivateAdminUser(
  id: number,
  knex: Knex = db,
): Promise<AdminUser | null> {
  const existing = await getAdminUserById(id, knex);
  if (!existing) return null;

  await knex<AdminUser>(TABLE)
    .where({ id })
    .update({ is_active: false, updated_at: knex.fn.now() });
  return getAdminUserById(id, knex);
}

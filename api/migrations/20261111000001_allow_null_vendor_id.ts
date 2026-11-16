import { Knex } from "knex";

/**
 * Optional admin shipping-link assignment:
 *  - slg_links.vendor_id      — NULL means the admin created an unassigned
 *    link (no vendor/ship-from selected). Existing rows are untouched.
 *  - slg_shipments.vendor_id  — shipments created through an unassigned link
 *    inherit that NULL; the rest keep their vendor.
 *
 * Forward-only in practice: `down` restores NOT NULL but does not delete or
 * backfill data, so it naturally fails if NULL rows still exist.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("slg_links", (table) => {
    table.integer("vendor_id").unsigned().nullable().alter();
  });
  await knex.schema.alterTable("slg_shipments", (table) => {
    table.integer("vendor_id").unsigned().nullable().alter();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("slg_shipments", (table) => {
    table.integer("vendor_id").unsigned().notNullable().alter();
  });
  await knex.schema.alterTable("slg_links", (table) => {
    table.integer("vendor_id").unsigned().notNullable().alter();
  });
}

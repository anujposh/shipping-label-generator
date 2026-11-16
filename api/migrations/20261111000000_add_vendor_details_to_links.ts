import { Knex } from "knex";

/**
 * Public shared-link vendor identity:
 *  - slg_links.vendor_details — reusable, validated pickup/shipping identity
 *    submitted by the vendor (no account required). NULL means the vendor has
 *    not submitted details yet; it is never a fallback to the admin-configured
 *    `ship_from` column, which stays untouched for legacy admin records.
 *
 * Each shipment stores an immutable snapshot of these details in its own
 * `ship_from` JSONB column, so later link edits never rewrite history.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("slg_links", (table) => {
    table.jsonb("vendor_details").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("slg_links", (table) => {
    table.dropColumn("vendor_details");
  });
}

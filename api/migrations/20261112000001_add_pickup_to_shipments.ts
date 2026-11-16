import { Knex } from "knex";

/**
 * Persist vendor pickup/drop-off selection on the shipment row so the
 * choice survives from rate browsing through label creation.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("slg_shipments", (table) => {
    table.jsonb("pickup").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("slg_shipments", (table) => {
    table.dropColumn("pickup");
  });
}

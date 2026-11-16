import { Knex } from "knex";

/**
 * Business Central company reference on links. Companies live in Business
 * Central, not in a local table, so these are plain string columns:
 * `bc_company_id` is the BC company GUID and `bc_company_name` is the
 * display-name snapshot captured at link creation.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("slg_links", (table) => {
    table.uuid("bc_company_id").nullable();
    table.string("bc_company_name", 120).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("slg_links", (table) => {
    table.dropColumn("bc_company_name");
    table.dropColumn("bc_company_id");
  });
}

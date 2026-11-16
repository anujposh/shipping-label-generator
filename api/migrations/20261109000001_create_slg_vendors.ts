import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("slg_vendors", (table) => {
    table.increments("id").primary();
    table.string("name").notNullable();
    table.string("contact_email").nullable();
    table.text("notes").nullable();
    table
      .timestamp("created_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
    table.timestamp("archived_at", { useTz: true }).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable("slg_vendors");
}

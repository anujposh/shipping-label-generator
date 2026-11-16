import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("slg_links", (table) => {
    table.increments("id").primary();
    table
      .integer("vendor_id")
      .unsigned()
      .notNullable()
      .references("id")
      .inTable("slg_vendors")
      .onDelete("CASCADE");
    table.string("token_hash").notNullable().unique();
    table.timestamp("expires_at", { useTz: true }).notNullable();
    table.timestamp("revoked_at", { useTz: true }).nullable();
    table.integer("max_uses").unsigned().nullable();
    table.integer("use_count").unsigned().notNullable().defaultTo(0);
    table.string("created_by").notNullable();
    table.jsonb("ship_from").notNullable();
    table
      .timestamp("created_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());

    table.index(["vendor_id", "created_at"]);
    table.index(["token_hash"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable("slg_links");
}

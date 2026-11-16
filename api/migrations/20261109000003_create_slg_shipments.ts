import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("slg_shipments", (table) => {
    table.increments("id").primary();
    table
      .integer("link_id")
      .unsigned()
      .notNullable()
      .references("id")
      .inTable("slg_links")
      .onDelete("CASCADE");
    table
      .integer("vendor_id")
      .unsigned()
      .notNullable()
      .references("id")
      .inTable("slg_vendors")
      .onDelete("CASCADE");
    table
      .enum("status", ["draft", "rated", "label_created", "voided", "expired"])
      .notNullable()
      .defaultTo("draft");
    table.jsonb("ship_from").notNullable();
    table.jsonb("ship_to").notNullable();
    table.jsonb("packages").notNullable();
    table.jsonb("selected_rate").nullable();
    table.string("carrier").nullable();
    table.string("service_type").nullable();
    table.string("tracking_number").nullable();
    table
      .timestamp("created_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
    table
      .timestamp("updated_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());

    table.index(["vendor_id", "created_at"]);
    table.index(["link_id", "created_at"]);
    table.index(["status"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable("slg_shipments");
}

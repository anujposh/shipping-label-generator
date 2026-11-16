import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("slg_labels", (table) => {
    table.increments("id").primary();
    table
      .integer("shipment_id")
      .unsigned()
      .notNullable()
      .references("id")
      .inTable("slg_shipments")
      .onDelete("CASCADE");
    table.text("label_pdf_base64").notNullable();
    table.jsonb("carrier_response").nullable();
    table.string("label_size").nullable();
    table.string("tracking_number").nullable();
    table.string("carrier").nullable();
    table.string("service_type").nullable();
    table.timestamp("voided_at", { useTz: true }).nullable();
    table.string("voided_by").nullable();
    table
      .timestamp("created_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());

    table.index(["shipment_id", "created_at"]);
    table.index(["tracking_number"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable("slg_labels");
}

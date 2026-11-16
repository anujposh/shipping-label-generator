import { Knex } from "knex";

/**
 * FedEx international support:
 *  - slg_shipments.customs       — validated customs payload snapshot
 *  - slg_documents              — generated/uploaded customs documents
 *
 * Bytes are stored as base64 text (consistent with slg_labels) so downloads
 * work without an object store; upload validation caps each document at 5 MiB.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("slg_shipments", (table) => {
    table.jsonb("customs").nullable();
  });

  await knex.schema.createTable("slg_documents", (table) => {
    table.increments("id").primary();
    table
      .integer("shipment_id")
      .unsigned()
      .notNullable()
      .references("id")
      .inTable("slg_shipments")
      .onDelete("CASCADE");
    table
      .integer("label_id")
      .unsigned()
      .nullable()
      .references("id")
      .inTable("slg_labels")
      .onDelete("SET NULL");
    table.string("document_type").notNullable();
    table.string("doc_type").notNullable();
    table.string("file_name").notNullable();
    table.text("content_base64").notNullable();
    table.string("source").notNullable();
    table.string("upload_status").nullable();
    table.string("fedex_document_id").nullable();
    table
      .timestamp("created_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());

    table.index(["shipment_id", "created_at"]);
    table.unique(
      ["shipment_id", "document_type", "source", "file_name"],
      "slg_documents_shipment_doc_unique",
    );
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable("slg_documents");
  await knex.schema.alterTable("slg_shipments", (table) => {
    table.dropColumn("customs");
  });
}

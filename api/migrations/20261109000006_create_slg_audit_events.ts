import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("slg_audit_events", (table) => {
    table.increments("id").primary();
    table
      .enum("event_type", [
        "link_created",
        "link_revoked",
        "link_expired",
        "submission_created",
        "rate_retrieved",
        "label_created",
        "label_downloaded",
        "admin_login_success",
        "admin_login_failure",
      ])
      .notNullable();
    table.string("actor").nullable();
    table
      .enum("actor_type", ["vendor", "admin", "system"])
      .notNullable()
      .defaultTo("system");
    table.string("ip_address").nullable();
    table
      .timestamp("occurred_at", { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());
    table.string("request_id").nullable();
    table.integer("link_id").unsigned().nullable();
    table.integer("vendor_id").unsigned().nullable();
    table.integer("shipment_id").unsigned().nullable();
    table.jsonb("metadata").nullable();

    table.index(["event_type", "occurred_at"]);
    table.index(["link_id", "occurred_at"]);
    table.index(["vendor_id", "occurred_at"]);
    table.index(["request_id"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable("slg_audit_events");
}

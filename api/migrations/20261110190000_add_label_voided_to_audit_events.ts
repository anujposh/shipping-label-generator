import { Knex } from "knex";

const EVENT_TYPES = [
  "link_created",
  "link_revoked",
  "link_expired",
  "submission_created",
  "rate_retrieved",
  "label_created",
  "label_downloaded",
  "label_voided",
  "admin_login_success",
  "admin_login_failure",
] as const;

const CONSTRAINT = "slg_audit_events_event_type_check";

function constraintSql(eventTypes: readonly string[]): string {
  const values = eventTypes.map((value) => `'${value}'`).join(", ");
  return `ALTER TABLE slg_audit_events ADD CONSTRAINT ${CONSTRAINT} CHECK (event_type = ANY (ARRAY[${values}]))`;
}

export async function up(knex: Knex): Promise<void> {
  await knex.schema.raw(
    `ALTER TABLE slg_audit_events DROP CONSTRAINT ${CONSTRAINT}`,
  );
  await knex.schema.raw(constraintSql(EVENT_TYPES));
}

export async function down(knex: Knex): Promise<void> {
  const existing = await knex("slg_audit_events")
    .where({ event_type: "label_voided" })
    .count<{ count: string }[]>("id as count");
  if (Number(existing[0]?.count ?? 0) > 0) {
    throw new Error(
      "Cannot remove label_voided from the audit constraint while those audit events exist",
    );
  }

  await knex.schema.raw(
    `ALTER TABLE slg_audit_events DROP CONSTRAINT ${CONSTRAINT}`,
  );
  await knex.schema.raw(
    constraintSql(EVENT_TYPES.filter((value) => value !== "label_voided")),
  );
}

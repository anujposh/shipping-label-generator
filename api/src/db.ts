import knexFactory, { Knex } from "knex";
import { types as pgTypes } from "pg";
import { config } from "./config";

pgTypes.setTypeParser(pgTypes.builtins.NUMERIC, (value) => parseFloat(value));
pgTypes.setTypeParser(pgTypes.builtins.DATE, (value) => value);

export function createKnex(connectionUrl?: string): Knex {
  const connection = connectionUrl ?? config.databaseUrl;
  if (!connection) {
    throw new Error("Missing required database connection");
  }
  return knexFactory({
    client: "pg",
    connection,
    pool: { min: 2, max: 25 },
  });
}

export let db: Knex = createKnex();

export function setDb(replacement: Knex): void {
  db = replacement;
}

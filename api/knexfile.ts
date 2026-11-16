import path from "path";
import dotenv from "dotenv";

// The knex CLI loads this file through its own module loader (dynamic
// import), where `import type` from "knex" breaks under its TS transform.
// Keep this file dependency-free apart from node/dotenv and resolve paths
// from the process working directory — knex is always invoked via npm
// scripts from this package's directory.
const here = process.cwd();

dotenv.config({ path: path.resolve(here, ".env") });

const connection = process.env.DATABASE_URL;
const testConnection = process.env.TEST_DATABASE_URL;
const migrationDirectory = path.resolve(here, "migrations");

type MigrationConfig = {
  directory: string;
  tableName: string;
  extension: "ts" | "js";
};

const shared = {
  client: "pg",
  connection,
  migrations: {
    directory: migrationDirectory,
    // Distinct bookkeeping table: backend owns `knex_migrations` in the
    // shared Postgres; this project never touches it (plan §6 / §9).
    tableName: "slg_knex_migrations",
    extension: "js",
  } as MigrationConfig,
};

const config: Record<string, typeof shared> = {
  development: {
    ...shared,
    migrations: { ...shared.migrations, extension: "ts" },
  },
  test: {
    ...shared,
    connection: testConnection,
    migrations: { ...shared.migrations, extension: "ts" },
  },
  production: shared,
};

export default config;

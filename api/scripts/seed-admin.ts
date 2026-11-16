import path from "path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { createKnex } from "../src/db";
import * as adminUsersStore from "../src/store/admin-users.store";
import { hashPassword, assertPasswordPolicy } from "../src/core/password";

async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    console.error(
      "ADMIN_EMAIL and ADMIN_PASSWORD environment variables are required",
    );
    process.exit(1);
  }

  try {
    assertPasswordPolicy(password);
  } catch (error) {
    console.error(
      `Password policy violation: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  const knex = createKnex();
  try {
    const existing = await adminUsersStore.getAdminUserByEmail(email, knex);
    const passwordHash = await hashPassword(password);

    if (existing) {
      await adminUsersStore.updateAdminUser(
        existing.id,
        { password_hash: passwordHash },
        knex,
      );
      console.log(`Updated admin user: ${email}`);
    } else {
      await adminUsersStore.createAdminUser(
        { email, password_hash: passwordHash, name: "Admin" },
        knex,
      );
      console.log(`Created admin user: ${email}`);
    }
  } finally {
    await knex.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

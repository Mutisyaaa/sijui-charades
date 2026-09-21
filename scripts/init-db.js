require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

const email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;
const displayName = String(process.env.ADMIN_DISPLAY_NAME || "k3v1n").trim();

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required to initialize the database.");
}

if (!email || !password || !displayName) {
  throw new Error("ADMIN_EMAIL, ADMIN_PASSWORD, and ADMIN_DISPLAY_NAME are required.");
}

if (password.length < 8 || password.length > 128) {
  throw new Error("ADMIN_PASSWORD must be between 8 and 128 characters.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ...(process.env.NODE_ENV === "production"
    ? { ssl: { rejectUnauthorized: false } }
    : {}),
});

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const schema = fs.readFileSync(
      path.join(__dirname, "..", "database.render.sql"),
      "utf8",
    );
    await client.query(schema);

    const passwordHash = await bcrypt.hash(password, 12);
    const existing = await client.query(
      "SELECT id FROM public.users WHERE lower(email) = $1",
      [email],
    );

    if (existing.rows[0]) {
      await client.query(
        `UPDATE public.users
         SET display_name = $1, password_hash = $2, role = 'admin', updated_at = now()
         WHERE id = $3`,
        [displayName, passwordHash, existing.rows[0].id],
      );
    } else {
      await client.query(
        `INSERT INTO public.users (display_name, email, password_hash, role)
         VALUES ($1, $2, $3, 'admin')`,
        [displayName, email, passwordHash],
      );
    }

    await client.query("COMMIT");
    console.log("Database schema is ready and the admin account is configured.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

"use strict";
const fs = require("fs");
const path = require("path");
const { Pool, types } = require("pg");

// Return NUMERIC as JS numbers and DATE as "YYYY-MM-DD" strings (no timezone shifts).
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
types.setTypeParser(1082, (v) => v);
types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // BIGINT ids/counts (safe below 2^53)

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. On Railway, add a Postgres database and reference its DATABASE_URL in this service's variables.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

const query = (text, params) => pool.query(text, params);

/** Run fn(client) inside a transaction. */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Apply migrations/*.sql in order, once each. */
async function migrate() {
  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const dir = path.join(__dirname, "..", "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const done = await query("SELECT 1 FROM schema_migrations WHERE name = $1", [f]);
    if (done.rowCount) continue;
    await tx(async (c) => {
      await c.query(fs.readFileSync(path.join(dir, f), "utf8"));
      await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
    });
    console.log("migration applied:", f);
  }
}

/** First start: load countries and default settings from data/reference.json. */
async function seed() {
  const ref = require("../data/reference.json");
  const { rows } = await query("SELECT count(*)::int AS n FROM countries");
  if (rows[0].n === 0) {
    await tx(async (c) => {
      for (const x of ref.countries) {
        await c.query(
          `INSERT INTO countries (code, name, name_uk, rate, currency, region, layout, rule, rate_note, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'seed')`,
          [x.code, x.name, x.name_uk, x.rate, x.currency, x.region, x.layout, x.rule || "", x.rate_note]
        );
      }
    });
    console.log("seeded", ref.countries.length, "countries");
  }
  const defaults = {
    general: { startNumber: Number(process.env.START_NUMBER) || 10712, terms: ref.terms },
  };
  for (const [key, value] of Object.entries(defaults)) {
    await query("INSERT INTO settings (key, value, updated_by) VALUES ($1, $2, 'seed') ON CONFLICT (key) DO NOTHING", [key, value]);
  }
}

module.exports = { pool, query, tx, migrate, seed };

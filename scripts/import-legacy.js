"use strict";
/*
 * Command-line version of Settings → "Імпорт з Google-таблиці".
 *   DATABASE_URL=… node scripts/import-legacy.js INVOICE_LOG.csv
 */
const fs = require("fs");
const file = process.argv[2];
if (!file) { console.error("Usage: node scripts/import-legacy.js <INVOICE_LOG.csv>"); process.exit(1); }
const { migrate, seed, pool } = require("../server/db");
const { importLegacyCsv } = require("../server/legacy");

(async () => {
  await migrate();
  await seed();
  const stats = await importLegacyCsv(fs.readFileSync(file, "utf8"), "cli-import");
  console.log(JSON.stringify(stats, null, 2));
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });

"use strict";
/*
 * Import of the INVOICE_LOG tab from the "INVOICE 2.0" Google Sheet (exported as CSV).
 *
 * - Every CSV row goes into invoice_log as action LEGACY, with the original row kept in details.raw.
 * - Rows are grouped by base number (10711, 10711-1, 10711-2 → 10711) into one archive record
 *   with status "legacy"; each row that has a PDF file id becomes a document linked to Google Drive.
 * - Safe to run again: rows already imported (same content hash) are skipped, so you can import
 *   once now for testing and once more on the day you switch over.
 */
const crypto = require("crypto");
const { parse } = require("csv-parse/sync");
const { tx } = require("./db");

const KNOWN_MODES = /^(SINGLE|MULTI|NO_VAT_SINGLE|NO_VAT_MULTI|NEW|EDIT|CREDIT NOTE)/i;
const looksLikeDate = (s) => /^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}/.test(String(s || "").trim());
const clean = (s) => { const v = String(s ?? "").trim(); return v === "" || v.toLowerCase() === "nan" ? null : v; };

function num(v) {
  let s = clean(v); if (s == null) return null;
  s = s.replace(/\s/g, "").replace(/[^\d.,-]/g, "");
  if (s.includes(",") && s.includes(".")) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (s.includes(",")) s = s.replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
/** "14.07.2026", "14/07/2026", "2026-07-14" → "2026-07-14" (null if impossible). */
function isoDate(v) {
  const s = clean(v); if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  let y, mo, d;
  if (m) [y, mo, d] = [m[1], m[2], m[3]];
  else if ((m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})/))) [d, mo, y] = [m[1], m[2], m[3]];
  else return null;
  mo = +mo; d = +d;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
/** Timestamp "13/04/2026 10:13:36" or "2026-04-13 10:13:36" (UTC) → ISO string. */
function isoTime(v) {
  const s = clean(v); if (!s) return null;
  const d = isoDate(s); if (!d) return null;
  const t = (s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/) || []);
  return `${d}T${String(t[1] || 0).padStart(2, "0")}:${t[2] || "00"}:${t[3] || "00"}Z`;
}
const count = (v) => { const s = clean(v); return s && /^\d{1,3}(\.0+)?$/.test(s) ? parseInt(s, 10) : null; };
const baseOf = (n) => { const m = String(n || "").trim().match(/^(\d+)/); return m ? Number(m[1]) : null; };

/** Normalise one CSV row (handles the early rows written in an older column order). */
function normaliseRow(r) {
  const g = (k) => clean(r[k]);
  const row = {
    number: g("invoice number"), name: g("customer name"), email: g("customer email"), country: g("country"),
    channel: g("Payment channel"), type: g("customer type"), payCount: g("payments count"), llc: g("LLC"),
    by: g("requested by"), mode: g("mode"), invoiceDate: g("invoice date"), amount: g("invoice amount"),
    vat: g("VAT amount"), total: g("total incl VAT"), currency: g("currency"), vatRule: g("VAT rule"),
    clientVat: g("client VAT number"), archiveId: g("archive file id"), pdfId: g("pdf file id"), ts: g("timestamp UTC"),
  };
  // Early format: LLC in "customer type", timestamp in "payments count", user in "LLC".
  if (looksLikeDate(row.payCount)) {
    row.ts = row.payCount; row.by = row.llc; row.llc = row.type; row.type = null; row.payCount = null;
  }
  if (row.by && !row.by.includes("@")) row.by = null; // "USER_KEY:…" placeholders
  if (row.country === "CUSTOM") row.country = null;
  return row;
}

async function importLegacyCsv(csvText, userEmail) {
  const records = parse(csvText, { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true });
  if (!records.length || !("invoice number" in records[0])) throw new Error("Це не схоже на експорт вкладки INVOICE_LOG (немає колонки «invoice number»).");
  const stats = { rows: records.length, imported: 0, skipped: 0, noNumber: 0, invoices: 0, documents: 0, conflicts: [] };

  await tx(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(4711)"); // same lock as number assignment
    const seen = new Set((await db.query("SELECT details->>'rowHash' AS h FROM invoice_log WHERE action = 'LEGACY'")).rows.map((r) => r.h));
    const groups = new Map();
    const countries = Object.fromEntries((await db.query("SELECT code, currency FROM countries")).rows.map((r) => [r.code, r.currency]));
    const occurrences = new Map();
    records.forEach((raw, i) => {
      // identical rows can legitimately appear twice; the occurrence index keeps both and re-imports idempotent
      const key = JSON.stringify(raw);
      const n = (occurrences.get(key) || 0) + 1; occurrences.set(key, n);
      const hash = crypto.createHash("sha1").update(key + "#" + n).digest("hex");
      if (seen.has(hash)) { stats.skipped++; return; }
      seen.add(hash);
      const row = normaliseRow(raw);
      row.hash = hash; row.line = i + 2; row.raw = raw;
      const base = baseOf(row.number);
      if (base == null) { stats.noNumber++; }
      row.base = base;
      if (base != null) { if (!groups.has(base)) groups.set(base, []); groups.get(base).push(row); }
      row.importedLog = false;
      if (base == null) groups.set("nonum-" + i, [row]);
    });

    for (const [base, rows] of groups) {
      let invoiceId = null;
      if (typeof base === "number") {
        const existing = (await db.query("SELECT id, legacy FROM invoices WHERE number = $1", [base])).rows[0];
        if (existing && !existing.legacy) { stats.conflicts.push(base); }
        else {
          // the latest row with real data describes the invoice best
          const withData = rows.filter((r) => r.name || r.email);
          const top = withData[withData.length - 1] || rows[rows.length - 1];
          // a document number can appear several times (regenerated / edited) — the last row wins
          const latest = new Map();
          rows.filter((r) => r.pdfId || (r.mode && !/ARCHIVE/i.test(r.mode) && r.total)).forEach((r) => latest.set(r.number, r));
          const docRows = [...latest.values()];
          const gross = docRows.reduce((s, r) => s + (num(r.total) || 0), 0);
          const vat = docRows.reduce((s, r) => s + (num(r.vat) || 0), 0);
          const net = docRows.reduce((s, r) => s + (num(r.amount) || 0), 0);
          const cur = (r) => (r.currency && r.currency !== "AUTO" ? r.currency : countries[r.country] || null);
          const isCredit = rows.some((r) => /CREDIT/i.test(r.mode || ""));
          const mode = /SINGLE/i.test(top.mode || "") ? "SINGLE" : "MULTI";
          const entity = /trible/i.test(top.llc || "") ? "trible" : /celeb/i.test(top.llc || "") ? "celeb" : null;
          const times = rows.map((r) => isoTime(r.ts)).filter(Boolean).sort();
          const dates = docRows.map((r) => isoDate(r.invoiceDate)).filter(Boolean).sort();
          const vals = [base, isCredit ? "credit_note" : "invoice", top.type === "B2B" || top.type === "B2C" ? top.type : null, entity, mode,
            /NO_VAT/i.test(top.mode || "") ? "NO_VAT" : "VAT", top.name, top.email, top.clientVat, top.country, cur(top), top.channel,
            count(top.payCount), dates.at(-1) || null, Math.round(net * 100) / 100, Math.round(vat * 100) / 100, Math.round(gross * 100) / 100,
            top.vatRule, times[0] || null, rows.find((r) => r.by)?.by || null];
          if (existing) {
            invoiceId = existing.id;
          } else {
            const ins = await db.query(
              `INSERT INTO invoices (number, doc_type, kind, entity, mode, layout, client_name, client_email, client_vat, country, currency, channel,
                 pay_count, invoice_date, net, vat, gross, vat_rule, created_at, created_by, status, legacy, current_version, updated_at, updated_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,COALESCE($19::timestamptz, now()),$20,'legacy',true,0,now(),'import')
               RETURNING id`, vals);
            invoiceId = ins.rows[0].id; stats.invoices++;
          }
          for (const r of rows) {
            if (!r.pdfId) continue;
            const superseded = latest.get(r.number) !== r;
            if (existing && !superseded) await db.query("UPDATE documents SET superseded = true WHERE invoice_id = $1 AND number = $2", [invoiceId, r.number]);
            await db.query(
              `INSERT INTO documents (invoice_id, number, doc_date, net, vat, gross, currency, drive_file_id, superseded, created_at, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10::timestamptz, now()),$11)`,
              [invoiceId, r.number, isoDate(r.invoiceDate), num(r.amount), num(r.vat), num(r.total), cur(r), r.pdfId, superseded, isoTime(r.ts), r.by]);
            stats.documents++;
          }
        }
      }
      for (const r of rows) {
        await db.query(
          `INSERT INTO invoice_log (at, user_email, action, invoice_id, invoice_number, customer_name, customer_email, country, payment_channel,
             customer_type, pay_count, llc, mode, invoice_date, amount, vat_amount, total, currency, vat_rule, client_vat, details)
           VALUES (COALESCE($1::timestamptz, now()),$2,'LEGACY',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
          [isoTime(r.ts), r.by, invoiceId, r.number, r.name, r.email, r.country, r.channel, r.type, count(r.payCount), r.llc, r.mode,
            isoDate(r.invoiceDate), num(r.amount), num(r.vat), num(r.total), r.currency === "AUTO" ? countries[r.country] || null : r.currency, r.vatRule, r.clientVat,
            { rowHash: r.hash, csvLine: r.line, archiveFileId: r.archiveId, pdfFileId: r.pdfId, importedBy: userEmail, raw: r.raw }]);
        stats.imported++;
      }
    }
    // Continue numbering after the sheet: start number = highest sheet number + 1.
    // Ignore an obvious typo (a number far above the rest, e.g. 107120 among 107xx).
    const nums = (await db.query("SELECT number FROM invoices WHERE legacy ORDER BY number DESC LIMIT 2")).rows.map((r) => r.number);
    if (nums.length) {
      let top = nums[0];
      if (nums[1] && top > nums[1] * 1.5) { stats.suspicious = top; top = nums[1]; }
      const g = (await db.query("SELECT value FROM settings WHERE key = 'general'")).rows[0];
      const general = Object.assign({}, g ? g.value : {});
      if (!(general.startNumber > top)) {
        general.startNumber = top + 1;
        await db.query(`INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('general', $1, now(), $2)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`, [general, userEmail]);
      }
      stats.startNumber = general.startNumber;
    }
    if (stats.imported) {
      await db.query("INSERT INTO invoice_log (user_email, action, details) VALUES ($1, 'SETTINGS', $2)",
        [userEmail, { legacyImport: { rows: stats.rows, imported: stats.imported, skipped: stats.skipped, invoices: stats.invoices, documents: stats.documents, conflicts: stats.conflicts, startNumber: stats.startNumber, suspicious: stats.suspicious } }]);
    }
  });
  return stats;
}

module.exports = { importLegacyCsv, isoDate, isoTime, normaliseRow };

"use strict";
const crypto = require("crypto");
const express = require("express");
const { query, tx } = require("./db");
const { requireUser, requireAdmin } = require("./auth");
const { checkVat } = require("./vies");
const calc = require("../shared/calc");
const REF = require("../data/reference.json");

const router = express.Router();
router.use(requireUser);

const NUMBER_LOCK = 4711; // advisory lock id used while handing out invoice numbers

/* ---------- helpers ---------- */

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new HttpError(status, code, message); };

/** Reference data = static JSON + countries/settings from the database (admins can edit those). */
async function reference(db = { query }) {
  const [c, s] = await Promise.all([
    db.query("SELECT code, name, name_uk, rate, currency, region, layout, rule, rate_note FROM countries ORDER BY name"),
    db.query("SELECT key, value FROM settings"),
  ]);
  const settings = Object.fromEntries(s.rows.map((r) => [r.key, r.value]));
  const general = settings.general || {};
  return Object.assign({}, REF, {
    countries: c.rows,
    terms: general.terms || REF.terms,
    startNumber: general.startNumber || 1,
  });
}

function summaryColumns(ref, data) {
  const s = calc.summary(ref, data);
  return {
    s,
    cols: {
      doc_type: s.docType, kind: s.kind, entity: s.entity, mode: s.mode, layout: s.layout,
      client_name: s.clientName, client_email: s.clientEmail, client_vat: s.clientVat,
      country: s.country, currency: s.currency, channel: s.channel, pay_count: s.payCount,
      invoice_date: s.invoiceDate || null, net: s.net, vat: s.vat, gross: s.gross, vat_rule: s.vatRule,
      solidgate_order_id: s.solidgateOrderId || null, credit_for: data.creditFor || null,
    },
  };
}

/** Write one row to the invoice log (sheet-compatible columns + details). */
async function log(db, user, action, inv, extra = {}) {
  const ref = extra.ref;
  const s = inv && inv.data && ref ? calc.summary(ref, inv.data) : null;
  const d = extra.doc;
  const entity = s ? (REF.entities[s.entity] || {}).name : null;
  await db.query(
    `INSERT INTO invoice_log (user_email, action, invoice_id, invoice_number, customer_name, customer_email, country,
       payment_channel, customer_type, pay_count, llc, mode, invoice_date, amount, vat_amount, total, currency, vat_rule, client_vat, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [
      user, action, inv ? inv.id : null,
      d ? d.number : inv && inv.number != null ? String(inv.number) : null,
      s && s.clientName, s && s.clientEmail, s && s.country, s && s.channel, s && s.kind, s && s.payCount, entity,
      s ? (s.docType === "credit_note" ? "CREDIT_NOTE" : (s.layout === "NO_VAT" ? "NO_VAT_" : "") + s.mode) : null,
      d ? d.date : s && s.invoiceDate, d ? d.net : s && s.net, d ? d.vat : s && s.vat, d ? d.gross : s && s.gross,
      s && s.currency, s && s.vatRule, s && s.clientVat, extra.details || {},
    ]
  );
}

/** Freeze the country row + payment terms into the saved data (see calc.countryFor). */
async function freezeRules(db, ref, data) {
  if (data.docType === "credit_note" && data.creditFor) {
    // a credit note must use exactly the rules of the document it corrects
    const { rows } = await db.query(
      `SELECT v.data->'rules' AS rules FROM documents d JOIN invoice_versions v ON v.invoice_id = d.invoice_id AND v.v = d.version
       WHERE d.number = $1 AND NOT d.superseded ORDER BY d.created_at DESC LIMIT 1`, [String(data.creditFor)]);
    if (rows[0] && rows[0].rules && rows[0].rules.country && rows[0].rules.country.code === data.country) {
      data.rules = Object.assign({}, rows[0].rules, { source: String(data.creditFor) });
      return data;
    }
  }
  const c = ref.countries.find((x) => x.code === data.country);
  data.rules = {
    country: c ? { code: c.code, name: c.name, name_uk: c.name_uk, rate: c.rate, currency: c.currency, region: c.region, layout: c.layout, rule: c.rule } : null,
    terms: ref.terms,
    frozenAt: new Date().toISOString(),
  };
  return data;
}
const sameData = (a, b) => {
  const strip = (x) => { const y = calc.normalize(x); if (y.rules) delete y.rules.frozenAt; return JSON.stringify(y); };
  return strip(a) === strip(b);
};

/** Next free invoice number: after the highest number issued here, never below the start number. */
async function nextNumber(db, start) {
  const { rows } = await db.query(
    `SELECT GREATEST(COALESCE((SELECT MAX(number) FROM invoices WHERE NOT legacy), 0) + 1, $1::int) AS n`, [start]);
  let n = rows[0].n;
  // skip numbers already used by imported (legacy) records
  for (;;) {
    const taken = await db.query("SELECT 1 FROM invoices WHERE number = $1", [n]);
    if (!taken.rowCount) return n;
    n++;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateParam = (v) => { if (!DATE_RE.test(String(v))) fail(400, "bad_date", "Дата має бути у форматі РРРР-ММ-ДД."); return String(v); };

async function loadInvoice(db, id, lock) {
  const { rows } = await db.query(
    `SELECT i.*, v.data FROM invoices i LEFT JOIN invoice_versions v ON v.invoice_id = i.id AND v.v = i.current_version
     WHERE i.id = $1 ${lock ? "FOR UPDATE OF i" : ""}`, [id]);
  if (!rows[0]) fail(404, "not_found", "Інвойс не знайдено.");
  return rows[0];
}

const idParam = (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) fail(400, "bad_id");
  return id;
};

/* ---------- me & reference ---------- */

router.get("/me", (req, res) => res.json(req.user));

router.get("/reference", wrap(async (req, res) => {
  const ref = await reference();
  res.json(Object.assign(ref, { nextNumber: await nextNumber({ query }, ref.startNumber) }));
}));

router.put("/settings/general", requireAdmin, wrap(async (req, res) => {
  const startNumber = parseInt(req.body.startNumber, 10);
  const terms = String(req.body.terms || "").trim();
  if (!(startNumber > 0) || !terms) fail(400, "invalid", "Вкажіть номер і текст умов оплати.");
  await tx(async (db) => {
    await db.query(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('general', $1, now(), $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [{ startNumber, terms }, req.user.email]);
    await log(db, req.user.email, "SETTINGS", null, { details: { startNumber, terms } });
  });
  res.json({ ok: true });
}));

router.put("/countries", requireAdmin, wrap(async (req, res) => {
  const list = Array.isArray(req.body.list) ? req.body.list : [];
  const codes = new Set();
  for (const c of list) {
    if (!/^[A-Z]{3}$/.test(c.code || "") || !String(c.name || "").trim()) fail(400, "invalid", "Кожна країна: код з 3 латинських літер і назва.");
    if (codes.has(c.code)) fail(400, "invalid", "Код " + c.code + " повторюється.");
    if (!["EU", "nonEU", "UK"].includes(c.region) || !["VAT", "NO_VAT"].includes(c.layout)) fail(400, "invalid", "Невірний регіон або шаблон для " + c.code);
    if (!(Number(c.rate) >= 0 && Number(c.rate) < 100)) fail(400, "invalid", "Невірна ставка для " + c.code);
    codes.add(c.code);
  }
  await tx(async (db) => {
    const before = (await db.query("SELECT * FROM countries")).rows;
    const byCode = Object.fromEntries(before.map((r) => [r.code, r]));
    const changes = [];
    for (const c of list) {
      const old = byCode[c.code];
      const row = [c.code, c.name.trim(), c.name_uk || null, Number(c.rate), String(c.currency || "EUR").toUpperCase(), c.region, c.layout, c.rule || "", c.rate_note || null];
      if (old && old.name === row[1] && (old.name_uk || null) === row[2] && Number(old.rate) === row[3] && old.currency === row[4] &&
          old.region === row[5] && old.layout === row[6] && old.rule === row[7]) continue;
      changes.push({ code: c.code, before: old || null, after: { name: row[1], rate: row[3], currency: row[4], region: row[5], layout: row[6], rule: row[7] } });
      await db.query(
        `INSERT INTO countries (code, name, name_uk, rate, currency, region, layout, rule, rate_note, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now(), $10)
         ON CONFLICT (code) DO UPDATE SET name=$2, name_uk=$3, rate=$4, currency=$5, region=$6, layout=$7, rule=$8, rate_note=$9, updated_at=now(), updated_by=$10`,
        row.concat([req.user.email]));
    }
    const removed = before.filter((r) => !codes.has(r.code)).map((r) => r.code);
    if (removed.length) await db.query("DELETE FROM countries WHERE code = ANY($1)", [removed]);
    if (changes.length || removed.length) await log(db, req.user.email, "COUNTRIES", null, { details: { changes, removed } });
  });
  res.json({ ok: true });
}));

/* ---------- archive ---------- */

const LIST_COLS = `id, number, doc_type, credit_for, status, legacy, current_version, kind, entity, mode, layout, client_name, client_email,
  country, currency, channel, pay_count, invoice_date, net, vat, gross, solidgate_order_id, created_at, created_by, updated_at, updated_by`;

router.get("/invoices", wrap(async (req, res) => {
  const where = [], p = [];
  const add = (sql, v) => { p.push(v); where.push(sql.replace("?", "$" + p.length)); };
  const q = String(req.query.q || "").trim();
  if (q) {
    p.push("%" + q.toLowerCase() + "%");
    const n = "$" + p.length;
    where.push(`(lower(coalesce(client_name,'')) LIKE ${n} OR lower(coalesce(client_email,'')) LIKE ${n} OR CAST(number AS TEXT) LIKE ${n}
      OR lower(coalesce(client_vat,'')) LIKE ${n} OR lower(coalesce(solidgate_order_id,'')) LIKE ${n}
      OR id IN (SELECT invoice_id FROM documents WHERE number LIKE ${n}))`);
  }
  if (req.query.email) add("lower(client_email) = ?", String(req.query.email).toLowerCase().trim());
  if (req.query.status) add("status = ?", String(req.query.status));
  if (req.query.type) add("doc_type = ?", String(req.query.type));
  if (req.query.country) add("country = ?", String(req.query.country));
  if (req.query.from) add("invoice_date >= ?", dateParam(req.query.from));
  if (req.query.to) add("invoice_date <= ?", dateParam(req.query.to));
  if (req.query.mine === "1") add("created_by = ?", req.user.email);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const w = where.length ? "WHERE " + where.join(" AND ") : "";
  const [rows, count] = await Promise.all([
    query(`SELECT ${LIST_COLS} FROM invoices ${w} ORDER BY (number IS NULL) DESC, number DESC NULLS LAST, updated_at DESC LIMIT ${limit} OFFSET ${offset}`, p),
    query(`SELECT count(*)::int AS n FROM invoices ${w}`, p),
  ]);
  res.json({ rows: rows.rows, total: count.rows[0].n });
}));

router.get("/invoices/:id", wrap(async (req, res) => {
  const id = idParam(req);
  const inv = await loadInvoice({ query }, id);
  const [versions, docs, logs] = await Promise.all([
    query("SELECT v, data, note, created_at, created_by FROM invoice_versions WHERE invoice_id = $1 ORDER BY v DESC", [id]),
    query(`SELECT id, version, number, doc_date, net, vat, gross, currency, sha256, drive_file_id, superseded, created_at, created_by,
             (pdf IS NOT NULL) AS has_pdf FROM documents WHERE invoice_id = $1 ORDER BY created_at DESC, number`, [id]),
    query("SELECT id, at, user_email, action, invoice_number, total, currency, details FROM invoice_log WHERE invoice_id = $1 ORDER BY at DESC, id DESC", [id]),
  ]);
  const related = inv.doc_type === "credit_note" && inv.credit_for
    ? await query("SELECT DISTINCT i.id, i.number FROM invoices i JOIN documents d ON d.invoice_id = i.id WHERE d.number = $1", [inv.credit_for])
    : await query(`SELECT id, number, credit_for FROM invoices WHERE doc_type = 'credit_note'
                   AND credit_for IN (SELECT number FROM documents WHERE invoice_id = $1)`, [id]);
  res.json({ invoice: inv, versions: versions.rows, documents: docs.rows, log: logs.rows, related: related.rows });
}));

/** New draft. No number yet — the number is given at first PDF generation, so abandoned drafts leave no gaps. */
router.post("/invoices", wrap(async (req, res) => {
  const data = calc.normalize(req.body.data);
  const out = await tx(async (db) => {
    const ref = await reference(db);
    await freezeRules(db, ref, data);
    const { cols } = summaryColumns(ref, data);
    const keys = Object.keys(cols);
    const { rows } = await db.query(
      `INSERT INTO invoices (${keys.join(",")}, status, current_version, created_by, updated_by)
       VALUES (${keys.map((_, i) => "$" + (i + 1)).join(",")}, 'draft', 1, $${keys.length + 1}, $${keys.length + 1}) RETURNING *`,
      keys.map((k) => cols[k]).concat([req.user.email]));
    const inv = rows[0];
    await db.query("INSERT INTO invoice_versions (invoice_id, v, data, note, created_by) VALUES ($1, 1, $2, $3, $4)",
      [inv.id, data, String(req.body.note || ""), req.user.email]);
    await log(db, req.user.email, data.docType === "credit_note" ? "CREATE_CREDIT_NOTE" : "CREATE", Object.assign(inv, { data }), { ref });
    return inv;
  });
  res.status(201).json({ id: out.id, version: 1, status: out.status, number: out.number, data });
}));

/** Save a new version. baseVersion protects against two people overwriting each other. */
router.put("/invoices/:id", wrap(async (req, res) => {
  const id = idParam(req);
  const data = calc.normalize(req.body.data);
  const out = await tx(async (db) => {
    const inv = await loadInvoice(db, id, true);
    if (inv.legacy) fail(409, "legacy", "Інвойс з Google-таблиці не редагується. Створіть копію.");
    if (inv.status === "void") fail(409, "void", "Анульований інвойс не редагується.");
    if (Number(req.body.baseVersion) !== inv.current_version)
      fail(409, "conflict", "Хтось уже зберіг новішу версію (" + inv.current_version + "). Оновіть інвойс, щоб не затерти зміни.");
    const ref = await reference(db);
    await freezeRules(db, ref, data);
    if (sameData(inv.data, data)) return { id, version: inv.current_version, status: inv.status, number: inv.number, same: true, data: inv.data };
    const reason = String(req.body.reason || "").trim();
    if (inv.number != null && data.docType !== inv.doc_type) fail(409, "type_locked", "Тип документа після присвоєння номера не змінюється.");
    const { cols } = summaryColumns(ref, data);
    const v = inv.current_version + 1;
    const status = inv.status; // no workflow statuses any more: an edit keeps the invoice as it is
    const keys = Object.keys(cols);
    await db.query(
      `UPDATE invoices SET ${keys.map((k, i) => k + " = $" + (i + 1)).join(", ")},
         current_version = $${keys.length + 1}, status = $${keys.length + 2}, updated_at = now(), updated_by = $${keys.length + 3}
       WHERE id = $${keys.length + 4}`,
      keys.map((k) => cols[k]).concat([v, status, req.user.email, id]));
    await db.query("INSERT INTO invoice_versions (invoice_id, v, data, note, created_by) VALUES ($1,$2,$3,$4,$5)",
      [id, v, data, reason || String(req.body.note || ""), req.user.email]);
    await log(db, req.user.email, "EDIT", Object.assign({}, inv, { data }), {
      ref, details: { version: v, reason: reason || undefined, statusBefore: inv.status, statusAfter: status } });
    return { id, version: v, status, number: inv.number, data };
  });
  res.json(out);
}));

/** Delete a draft that never got a number. */
router.delete("/invoices/:id", wrap(async (req, res) => {
  const id = idParam(req);
  await tx(async (db) => {
    const inv = await loadInvoice(db, id, true);
    if (inv.number != null) fail(409, "has_number", "Інвойс уже має номер — його можна лише анулювати.");
    await log(db, req.user.email, "DELETE_DRAFT", inv, { ref: await reference(db) });
    await db.query("DELETE FROM invoices WHERE id = $1", [id]);
  });
  res.json({ ok: true });
}));

/**
 * Step 1 of PDF generation: the server checks the saved version, gives the invoice a
 * number if it has none, and returns the document numbers + totals the PDFs must show.
 */
router.post("/invoices/:id/prepare", wrap(async (req, res) => {
  const id = idParam(req);
  const out = await tx(async (db) => {
    const inv = await loadInvoice(db, id, true);
    if (inv.legacy || inv.status === "void") fail(409, "locked", "Для цього інвойсу PDF не генерується.");
    if (Number(req.body.version) !== inv.current_version) fail(409, "conflict", "Збережіть зміни перед генерацією.");
    const ref = await reference(db);
    const errors = calc.checks(ref, inv.data).filter((c) => c[0] === "error");
    if (errors.length) fail(422, "invalid", errors.map((e) => e[1]).join(" "));
    let number = inv.number;
    if (number == null) {
      await db.query("SELECT pg_advisory_xact_lock($1)", [NUMBER_LOCK]);
      number = await nextNumber(db, ref.startNumber);
      await db.query("UPDATE invoices SET number = $1, updated_at = now(), updated_by = $2 WHERE id = $3", [number, req.user.email, id]);
      await log(db, req.user.email, "NUMBER", Object.assign({}, inv, { number, data: inv.data }), { ref });
    }
    const docs = calc.documents(ref, inv.data, number).map((d) => ({ number: d.number, date: d.date, net: d.net, vat: d.vat, gross: d.gross }));
    return { number, version: inv.current_version, documents: docs, data: inv.data };
  });
  res.json(out);
}));

/** Step 2: store the PDFs the browser rendered. Totals are recalculated here, not taken from the browser. */
router.post("/invoices/:id/documents", wrap(async (req, res) => {
  const id = idParam(req);
  const files = Array.isArray(req.body.files) ? req.body.files : [];
  const out = await tx(async (db) => {
    const inv = await loadInvoice(db, id, true);
    if (inv.number == null) fail(409, "no_number", "Спочатку підготуйте документ.");
    if (inv.status === "void" || inv.legacy) fail(409, "locked", "Для цього інвойсу PDF не зберігається.");
    if (Number(req.body.version) !== inv.current_version) fail(409, "conflict", "Інвойс змінився — згенеруйте PDF ще раз.");
    const ref = await reference(db);
    const expected = calc.documents(ref, inv.data, inv.number);
    const byNumber = Object.fromEntries(files.map((f) => [String(f.number), f]));
    if (files.length !== expected.length || expected.some((d) => !byNumber[d.number])) fail(400, "mismatch", "Набір PDF не збігається з інвойсом.");
    const pdfs = expected.map((d) => {
      const buf = Buffer.from(String(byNumber[d.number].pdf || ""), "base64");
      if (buf.length < 500 || buf.subarray(0, 5).toString() !== "%PDF-") fail(400, "bad_pdf", "Файл " + d.number + " не схожий на PDF.");
      if (buf.length > 5 * 1024 * 1024) fail(400, "too_big", "PDF завеликий.");
      return { d, buf };
    });
    await db.query("UPDATE documents SET superseded = true WHERE invoice_id = $1 AND NOT superseded", [id]);
    const saved = [];
    for (const { d, buf } of pdfs) {
      const sha = crypto.createHash("sha256").update(buf).digest("hex");
      const { rows } = await db.query(
        `INSERT INTO documents (invoice_id, version, number, doc_date, net, vat, gross, currency, pdf, sha256, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, number`,
        [id, inv.current_version, d.number, d.date, d.net, d.vat, d.gross, d.tax.currency, buf, sha, req.user.email]);
      saved.push(rows[0]);
      await log(db, req.user.email, "GENERATE", Object.assign({}, inv, { data: inv.data }), {
        ref, doc: d, details: { version: inv.current_version, documentId: rows[0].id, sha256: sha } });
    }
    await db.query("UPDATE invoices SET updated_at = now(), updated_by = $1 WHERE id = $2", [req.user.email, id]);
    return { documents: saved };
  });
  res.json(out);
}));

router.post("/invoices/:id/void", wrap(async (req, res) => {
  const id = idParam(req);
  const reason = String(req.body.reason || "").trim();
  if (!reason) fail(400, "reason_required", "Вкажіть причину анулювання.");
  await tx(async (db) => {
    const inv = await loadInvoice(db, id, true);
    if (inv.legacy) fail(409, "legacy", "Інвойси з Google-таблиці анулюються там.");
    if (inv.status === "void") return;
    if (inv.number == null) fail(409, "no_number", "Чернетку без номера можна просто видалити.");
    await db.query("UPDATE invoices SET status = 'void', void_reason = $1, updated_at = now(), updated_by = $2 WHERE id = $3", [reason, req.user.email, id]);
    await log(db, req.user.email, "VOID", inv, { ref: await reference(db), details: { reason, statusBefore: inv.status } });
  });
  res.json({ ok: true });
}));

/** Copy an invoice's data into a new draft (new number on generation). */
router.post("/invoices/:id/copy", wrap(async (req, res) => {
  const id = idParam(req);
  const inv = await loadInvoice({ query }, id);
  if (!inv.data) fail(409, "no_data", "У цього запису немає даних для копії (імпорт з таблиці).");
  const data = calc.normalize(inv.data);
  data.docType = "invoice"; data.creditFor = ""; delete data.rules;
  res.json({ data });
}));

/** Draft credit note for one document (e.g. 10622-2): same client, same line(s), amounts become negative. */
router.post("/invoices/:id/credit-note", wrap(async (req, res) => {
  const id = idParam(req);
  const docNumber = String(req.body.docNumber || "");
  const inv = await loadInvoice({ query }, id);
  if (inv.doc_type === "credit_note") fail(409, "is_credit_note", "Це вже кредит-нота.");
  const docs = await query("SELECT number, version FROM documents WHERE invoice_id = $1 AND number = $2 ORDER BY created_at DESC LIMIT 1", [id, docNumber]);
  if (!docs.rows[0]) fail(404, "no_document", "Документ " + docNumber + " не знайдено.");
  const ver = docs.rows[0].version ? await query("SELECT data FROM invoice_versions WHERE invoice_id = $1 AND v = $2", [id, docs.rows[0].version]) : { rows: [] };
  const src = calc.normalize((ver.rows[0] || {}).data || inv.data);
  if (!src) fail(409, "no_data", "Немає даних документа.");
  const data = calc.normalize(src);
  if (src.mode === "SINGLE") {
    const idx = Number(docNumber.split("-")[1]) - 1;
    data.lines = src.lines[idx] ? [src.lines[idx]] : src.lines;
  }
  data.docType = "credit_note"; data.creditFor = docNumber; data.mode = "MULTI"; data.dateAuto = false; data.invoiceDate = calc.todayISO();
  res.json({ data });
}));

/* ---------- documents ---------- */

router.get("/documents/:id/pdf", wrap(async (req, res) => {
  const id = idParam(req);
  const { rows } = await query("SELECT number, pdf, drive_file_id FROM documents WHERE id = $1", [id]);
  const d = rows[0];
  if (!d) fail(404, "not_found");
  if (!d.pdf && d.drive_file_id) return res.redirect("https://drive.google.com/file/d/" + encodeURIComponent(d.drive_file_id) + "/view");
  if (!d.pdf) fail(404, "no_pdf");
  res.set("Content-Type", "application/pdf");
  res.set("Content-Disposition", `${req.query.inline ? "inline" : "attachment"}; filename="${String(d.number).replace(/[^\w.-]/g, "")}_Invoice.pdf"`);
  res.send(d.pdf);
}));

/* ---------- invoice log ---------- */

function logFilter(req) {
  const where = [], p = [];
  const add = (sql, v) => { p.push(v); where.push(sql.replace("?", "$" + p.length)); };
  const q = String(req.query.q || "").trim();
  if (q) {
    p.push("%" + q.toLowerCase() + "%");
    const n = "$" + p.length;
    where.push(`(lower(coalesce(invoice_number,'')) LIKE ${n} OR lower(coalesce(customer_name,'')) LIKE ${n}
      OR lower(coalesce(customer_email,'')) LIKE ${n} OR lower(coalesce(user_email,'')) LIKE ${n})`);
  }
  if (req.query.action) add("action = ?", String(req.query.action));
  if (req.query.user) add("user_email = ?", String(req.query.user));
  if (req.query.from) add("at >= ?::date", dateParam(req.query.from));
  if (req.query.to) add("at < (?::date + 1)", dateParam(req.query.to));
  return { w: where.length ? "WHERE " + where.join(" AND ") : "", p };
}

router.get("/log", wrap(async (req, res) => {
  const { w, p } = logFilter(req);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const [rows, count] = await Promise.all([
    query(`SELECT * FROM invoice_log ${w} ORDER BY at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`, p),
    query(`SELECT count(*)::int AS n FROM invoice_log ${w}`, p),
  ]);
  res.json({ rows: rows.rows, total: count.rows[0].n });
}));

const csvCell = (v) => {
  if (v == null) return "";
  let s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (typeof v !== "number" && !/^-?\d+(\.\d+)?$/.test(s) && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
  return /[",\n\r;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

router.get("/log.csv", wrap(async (req, res) => {
  const { w, p } = logFilter(req);
  const { rows } = await query(`SELECT * FROM invoice_log ${w} ORDER BY at DESC, id DESC LIMIT 50000`, p);
  const cols = [
    ["invoice number", "invoice_number"], ["customer name", "customer_name"], ["customer email", "customer_email"], ["country", "country"],
    ["Payment channel", "payment_channel"], ["customer type", "customer_type"], ["payments count", "pay_count"], ["LLC", "llc"],
    ["requested by", "user_email"], ["mode", "mode"], ["invoice date", "invoice_date"], ["invoice amount", "amount"], ["VAT amount", "vat_amount"],
    ["total incl VAT", "total"], ["currency", "currency"], ["VAT rule", "vat_rule"], ["client VAT number", "client_vat"],
    ["action", "action"], ["timestamp UTC", "at"], ["details", "details"],
  ];
  const out = [cols.map((c) => c[0]).join(",")].concat(rows.map((r) => cols.map((c) => csvCell(r[c[1]])).join(",")));
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="invoice_log_${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send("﻿" + out.join("\r\n"));
}));

/* ---------- tools ---------- */

router.post("/vat/check", wrap(async (req, res) => {
  try {
    res.json(await checkVat(req.body.vat, req.body.country));
  } catch (e) {
    res.status(422).json({ error: "vies", message: e.message });
  }
}));

router.post("/admin/import-legacy", requireAdmin, wrap(async (req, res) => {
  const { importLegacyCsv } = require("./legacy");
  try {
    res.json(await importLegacyCsv(String(req.body.csv || ""), req.user.email));
  } catch (e) {
    if (e.code && String(e.code).startsWith("CSV_")) fail(400, "bad_csv", "Не вдалося прочитати CSV: " + e.message);
    if (!e.status && !e.code) fail(400, "bad_csv", e.message);
    throw e;
  }
}));

/* ---------- errors ---------- */

router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, message: err.message });
  if (err && err.type === "entity.too.large") return res.status(413).json({ error: "too_big", message: "Запит завеликий." });
  console.error(err);
  res.status(500).json({ error: "server_error", message: "Помилка сервера. Спробуйте ще раз." });
});

module.exports = { router, reference };

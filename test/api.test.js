"use strict";
/*
 * End-to-end API test. Needs a running server with DEV_LOGIN_EMAIL set (never in production):
 *   TEST_URL=http://localhost:3000 npm test
 */
const test = require("node:test");
const assert = require("node:assert");
const BASE = process.env.TEST_URL;
const calc = require("../shared/calc");
const ref = require("../data/reference.json");

let cookie = "";
async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method, redirect: "manual",
    headers: Object.assign({ cookie, "X-Requested-With": "rise-invoices" }, body ? { "Content-Type": "application/json" } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  const type = res.headers.get("content-type") || "";
  return { status: res.status, body: type.includes("json") ? await res.json() : await res.text() };
}
const fakePdf = () => Buffer.concat([Buffer.from("%PDF-1.3\n"), Buffer.alloc(800, 32)]).toString("base64");
const line = (amount, date, type = "monthly") => ({ type, desc: ref.lineTypes[type].desc, date, amount: String(amount) });

async function generate(id, version) {
  const prep = await call("POST", `/api/invoices/${id}/prepare`, { version });
  assert.equal(prep.status, 200, JSON.stringify(prep.body));
  const files = prep.body.documents.map((d) => ({ number: d.number, pdf: fakePdf() }));
  const up = await call("POST", `/api/invoices/${id}/documents`, { version, files });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  return prep.body;
}

test("tax math matches the Google Sheet", () => {
  const t = (d) => calc.documents(ref, Object.assign(calc.blank(), d), 1)[0];
  const can = t({ country: "CAN", lines: [line(19.99, "2026-09-20")] });           // log row 10710
  assert.deepEqual([can.net, can.vat, can.gross], [19.04, 0.95, 19.99]);
  const deu = t({ country: "DEU", lines: [line(39.99, "2026-01-01")] });
  assert.deepEqual([deu.net, deu.vat], [33.61, 6.38]);
  const tx = t({ country: "USA", usState: "TX", taxMode: "custom", customRate: "8.25", lines: [line(100, "2026-01-01")] });
  assert.equal(tx.vat, Math.round(100 * 0.8 * 0.0825 / 1.0825 * 100) / 100);
  const aus = t({ country: "AUS", lines: [line(48.99, "2026-01-01")] });
  assert.equal(aus.tax.title, "Invoice"); assert.equal(aus.tax.taxLabel, "GST"); assert.equal(aus.tax.sellerTaxId, "ARN: 3000 3990 0474");
  const jpn = t({ country: "JPN", lines: [line(10, "2026-01-01")] });
  assert.equal(jpn.tax.novat, true); assert.equal(jpn.vat, 0); assert.equal(jpn.tax.sellerTaxId, "");
  const note = t({ country: "IRL", kind: "B2B", taxMode: "zero", entity: "celeb", lines: [line(10, "2026-01-01")] });
  assert.equal(note.tax.note, ref.notes.EU);
  const uk = t({ country: "GBR", kind: "B2B", taxMode: "zero", entity: "celeb", lines: [line(10, "2026-01-01")] });
  assert.equal(uk.tax.note, ref.notes.UK); assert.equal(uk.tax.sellerTaxId, "VAT number: GB465794147");
  const trible = t({ country: "IRL", kind: "B2B", taxMode: "zero", entity: "trible", lines: [line(10, "2026-01-01")] });
  assert.equal(trible.tax.note, "");
  const cn = t({ docType: "credit_note", creditFor: "10622-2", country: "BEL", lines: [line(44.99, "2026-07-14")] });
  assert.equal(cn.gross, -44.99); assert.equal(cn.tax.title, "Credit Note for Invoice 10622-2");
  const errs = (d) => calc.checks(ref, Object.assign(calc.blank(), d)).filter((c) => c[0] === "error").map((c) => c[1]).join(" ");
  assert.match(errs({ client: { name: "x" }, entity: "trible", lines: [line(1, "2025-06-30")] }), /01\.07\.2025/);
  assert.match(errs({ client: { name: "x" }, entity: "trible", payment: { channel: "PayPal" }, lines: [line(1, "2026-01-01")] }), /PayPal/);
});

test("API flow", { skip: !BASE && "set TEST_URL to run" }, async (t) => {
  await call("GET", "/auth/dev");
  const me = await call("GET", "/api/me");
  assert.equal(me.status, 200);

  await t.test("csrf header is required", async () => {
    const r = await fetch(BASE + "/api/invoices", { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(r.status, 403);
  });

  const data = Object.assign(calc.blank(), {
    client: { name: "Test GmbH", email: "test-" + Date.now() + "@example.com", address: "Berlin", vat: "" },
    country: "DEU", lines: [line(39.99, "2026-09-01", "initial"), line(39.99, "2026-09-29")],
  });
  const created = await call("POST", "/api/invoices", { data });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal(created.body.number, null, "drafts have no number");

  await t.test("status needs a PDF first", async () => {
    const r = await call("POST", `/api/invoices/${id}/status`, { status: "review" });
    assert.equal(r.status, 409);
  });

  let number;
  await t.test("generation assigns the next number and stores documents", async () => {
    const ref2 = (await call("GET", "/api/reference")).body;
    const prep = await generate(id, 1);
    number = prep.number;
    assert.equal(number, ref2.nextNumber);
    assert.equal(prep.documents.length, 1);
    assert.equal(prep.documents[0].gross, 79.98);
    const again = await generate(id, 1);
    assert.equal(again.number, number, "regenerating keeps the number");
  });

  await t.test("server rejects PDFs that do not match", async () => {
    const r = await call("POST", `/api/invoices/${id}/documents`, { version: 1, files: [{ number: number + "-9", pdf: fakePdf() }] });
    assert.equal(r.status, 400);
  });

  await t.test("approve → edit needs a reason and returns to draft", async () => {
    assert.equal((await call("POST", `/api/invoices/${id}/status`, { status: "approved" })).status, 200);
    const d2 = Object.assign({}, data, { lines: [line(39.99, "2026-09-01", "initial")] });
    const noReason = await call("PUT", `/api/invoices/${id}`, { data: d2, baseVersion: 1 });
    assert.equal(noReason.status, 409); assert.equal(noReason.body.error, "reason_required");
    const ok = await call("PUT", `/api/invoices/${id}`, { data: d2, baseVersion: 1, reason: "client asked for one payment" });
    assert.equal(ok.status, 200); assert.equal(ok.body.version, 2); assert.equal(ok.body.status, "draft");
    const stale = await call("PUT", `/api/invoices/${id}`, { data, baseVersion: 1, reason: "x" });
    assert.equal(stale.status, 409); assert.equal(stale.body.error, "conflict");
  });

  await t.test("credit note gets its own number", async () => {
    await generate(id, 2);
    const draft = await call("POST", `/api/invoices/${id}/credit-note`, { docNumber: String(number) });
    assert.equal(draft.status, 200);
    assert.equal(draft.body.data.creditFor, String(number));
    const cn = await call("POST", "/api/invoices", { data: draft.body.data });
    const prep = await generate(cn.body.id, 1);
    assert.equal(prep.number, number + 1);
    assert.equal(prep.documents[0].gross, -39.99);
    const detail = await call("GET", `/api/invoices/${id}`);
    assert.equal(detail.body.related.length, 1);
  });

  await t.test("issued documents keep their tax rate when the country table changes", async () => {
    const d = Object.assign({}, data, { client: Object.assign({}, data.client, { email: "rate-" + Date.now() + "@example.com" }) });
    const c = await call("POST", "/api/invoices", { data: d });
    assert.equal(c.body.data.rules.country.rate, 19);
    const before = await generate(c.body.id, 1);
    const ref1 = (await call("GET", "/api/reference")).body;
    const list = ref1.countries.map((x) => (x.code === "DEU" ? Object.assign({}, x, { rate: 20 }) : x));
    assert.equal((await call("PUT", "/api/countries", { list })).status, 200);
    const after = await generate(c.body.id, 1);
    assert.deepEqual(after.documents, before.documents, "same version → same numbers");
    const list2 = ref1.countries; // restore
    assert.equal((await call("PUT", "/api/countries", { list: list2 })).status, 200);
  });

  await t.test("CSV keeps negative amounts numeric", async () => {
    const csv = await call("GET", "/api/log.csv?action=GENERATE");
    assert.match(csv.body, /,-39\.99,/);
    assert.doesNotMatch(csv.body, /'-39/);
  });

  await t.test("bad dates are rejected, not 500", async () => {
    assert.equal((await call("GET", "/api/log?from=yesterday")).status, 400);
  });

  await t.test("void keeps the record and blocks edits", async () => {
    assert.equal((await call("POST", `/api/invoices/${id}/void`, {})).status, 400);
    assert.equal((await call("POST", `/api/invoices/${id}/void`, { reason: "test" })).status, 200);
    const r = await call("PUT", `/api/invoices/${id}`, { data, baseVersion: 2, reason: "x" });
    assert.equal(r.status, 409);
    assert.equal((await call("DELETE", `/api/invoices/${id}`)).status, 409);
  });

  await t.test("drafts without a number can be deleted", async () => {
    const d = await call("POST", "/api/invoices", { data });
    assert.equal((await call("DELETE", `/api/invoices/${d.body.id}`)).status, 200);
  });

  await t.test("log is append-only and complete", async () => {
    const r = await call("GET", "/api/log?q=" + number);
    const actions = r.body.rows.map((x) => x.action);
    for (const a of ["NUMBER", "GENERATE", "STATUS", "EDIT", "VOID"]) assert.ok(actions.includes(a), a);
    const csv = await call("GET", "/api/log.csv?q=" + number);
    assert.match(csv.body, /invoice number,customer name/);
  });

  await t.test("search finds documents by number", async () => {
    const r = await call("GET", "/api/invoices?q=" + number);
    assert.ok(r.body.rows.some((x) => x.id === id));
  });
});

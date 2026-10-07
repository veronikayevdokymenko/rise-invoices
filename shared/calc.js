/*
 * Invoice business rules — shared by the browser (preview, PDF) and the server
 * (totals stored in the archive and the log). The server never trusts totals sent
 * by the browser: it recalculates them from the saved invoice data with this file.
 *
 * Rules ported from the "INVOICE 2.0" Google Sheet:
 *  - VAT_RULES:  rate per country, EU / nonEU / UK, VAT vs NO VAT layout, currency
 *  - Setup!A7:   Standard VAT → country rate, "B2B - 0% VAT" → 0, CUSTOM → own rate
 *  - Setup!C13:  USA + Texas → only 80% of the amount is taxable
 *  - VAT_RULES!Y/Z: VAT = ROUND(gross × share × rate / (1 + rate), 2), net = gross − VAT
 *  - Invoice!B12: seller tax ID depends on legal entity + country (AUS / CAN / GBR / other)
 *  - Invoice!G10: "Invoice" for AUS, otherwise "Tax Invoice"; no-VAT layout = "Invoice"
 *  - Invoice!B41: Celeb + B2B + 0% → reverse-charge note by region (EU / UK / nonEU)
 *  - SINGLE mode: one document per payment, numbered <base>-1, <base>-2 …
 *  - Credit note: own number, title "Credit Note for Invoice X", negative amounts
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.InvoiceCalc = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const parseAmount = (v) => {
    if (typeof v === "number") return v;
    let s = String(v ?? "").trim().replace(/\s/g, "").replace(/[^\d.,-]/g, "");
    if (!s) return 0;
    const c = s.lastIndexOf(","), d = s.lastIndexOf(".");
    if (c !== -1 && d !== -1) s = c > d ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
    else if (c !== -1) s = s.replace(",", ".");
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  };
  const todayISO = () => {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  };

  /** Empty invoice. Field names are stored in the database as-is (JSON). */
  function blank() {
    return {
      docType: "invoice",          // invoice | credit_note
      creditFor: "",               // credit note: document number it corrects
      kind: "B2C",                 // B2C | B2B
      client: { name: "", email: "", address: "", vat: "" },
      country: "USA",
      usState: "",                 // USA: "TX" → 80% taxable
      currency: "AUTO",            // AUTO = country default
      layout: "auto",              // auto | VAT | NO_VAT
      taxMode: "standard",         // standard | zero | custom
      customRate: "",
      note: "auto",                // auto | none | EU | UK | nonEU | custom
      noteText: "",
      entity: "celeb",             // celeb | trible
      payment: { channel: "Card Visa", last4: "", paypalId: "", plan: "4-week", solidgateOrderId: "" },
      lines: [{ type: "initial", desc: "Monthly subscription to RiseGuide platform:\nInitial Plan Activation", date: todayISO(), amount: "" }],
      mode: "MULTI",               // MULTI = one PDF | SINGLE = one PDF per payment
      dateAuto: true,
      invoiceDate: todayISO(),
    };
  }

  /** Fill in fields that older saved versions may not have. */
  function normalize(d) {
    const b = blank();
    const x = Object.assign(b, JSON.parse(JSON.stringify(d || {})));
    x.client = Object.assign(blank().client, x.client || {});
    x.payment = Object.assign(blank().payment, x.payment || {});
    if (!Array.isArray(x.lines)) x.lines = [];
    return x;
  }

  function countryOf(ref, code) {
    return ref.countries.find((c) => c.code === code) ||
      { code, name: code, rate: 0, currency: "EUR", region: "nonEU", layout: "NO_VAT", rule: "" };
  }

  /** Tax setup for an invoice: rate, labels, layout, note, seller tax ID. */
  /**
   * Country rules for an invoice. Each saved version carries a frozen copy (data.rules) made by
   * the server at save time, so a later change in the country table never changes an issued document.
   */
  function countryFor(ref, d) {
    const fr = d.rules && d.rules.country;
    return fr && fr.code === d.country ? fr : countryOf(ref, d.country);
  }

  function taxInfo(ref, d) {
    const c = countryFor(ref, d);
    const layout = d.layout === "VAT" || d.layout === "NO_VAT" ? d.layout : c.layout;
    const novat = layout === "NO_VAT";
    let rate = 0;
    if (!novat) {
      if (d.taxMode === "standard") rate = Number(c.rate) || 0;
      else if (d.taxMode === "custom") rate = parseAmount(d.customRate); // always in percent: "20" = 20%
    }
    const share = d.country === "USA" && String(d.usState).toUpperCase() === "TX" ? 0.8 : 1;
    const currency = d.currency && d.currency !== "AUTO" ? d.currency : c.currency;
    const isAus = d.country === "AUS";
    const word = isAus ? "GST" : "VAT";
    const taxLabel = isAus ? "GST" : d.country === "USA" ? "Sales tax" : "VAT";
    const entity = ref.entities[d.entity] || ref.entities.celeb;
    const sellerTaxId = novat ? "" : (entity.taxIds[d.country] || entity.taxIds.default);

    let note = "";
    const noteKey = d.note === "auto"
      ? (!novat && d.entity === "celeb" && d.kind === "B2B" && rate === 0 ? c.region : "none")
      : d.note;
    if (noteKey === "custom") note = d.noteText || "";
    else if (ref.notes[noteKey]) note = ref.notes[noteKey];

    const credit = d.docType === "credit_note";
    const title = credit ? "Credit Note for Invoice " + (d.creditFor || "") : novat ? "Invoice" : isAus ? "Invoice" : "Tax Invoice";
    return {
      country: c, layout, novat, rate, share, currency, taxLabel, sellerTaxId, note, noteKey, title, credit,
      heads: novat
        ? { total: "Total amount, " + currency }
        : { amount: "Amount, " + currency, tax: word + ", " + currency, gross: "Amount (inc. " + word + "), " + currency },
      totalLabel: isAus ? "TOTAL incl GST" : "TOTAL incl VAT",
      vatRuleText: novat ? "NO VAT" : d.taxMode === "zero" ? "B2B - 0% VAT" : d.taxMode === "custom" ? "CUSTOM " + rate + "%" : "Standard VAT",
    };
  }

  /** One payment line → gross / net / VAT (sheet formula). Credit notes are negative. */
  function calcLine(line, t) {
    let gross = round2(parseAmount(line.amount));
    if (t.credit) gross = -Math.abs(gross);
    if (t.novat) return { gross, net: gross, vat: 0 };
    const r = t.rate / 100;
    const vat = round2(gross * t.share * r / (1 + r));
    return { gross, net: round2(gross - vat), vat };
  }

  function lastDate(d) {
    return d.lines.map((l) => l.date).filter(Boolean).sort().at(-1) || todayISO();
  }

  /**
   * The documents (PDFs) an invoice produces for a given base number.
   * MULTI → one document "<base>"; SINGLE → "<base>-1" … "<base>-N".
   */
  function documents(ref, data, baseNumber) {
    const d = normalize(data);
    const t = taxInfo(ref, d);
    const lines = d.lines.map((l) => Object.assign({}, l, calcLine(l, t)));
    const sum = (ls, k) => round2(ls.reduce((s, l) => s + l[k], 0));
    const make = (number, date, ls) => ({
      number: String(number), date, lines: ls, tax: t,
      entity: ref.entities[d.entity] || ref.entities.celeb,
      client: d.client, terms: (d.rules && d.rules.terms) || ref.terms, creditFor: d.creditFor,
      net: sum(ls, "net"), vat: sum(ls, "vat"), gross: sum(ls, "gross"),
    });
    const base = baseNumber == null || baseNumber === "" ? "—" : String(baseNumber);
    if (d.mode === "SINGLE" && d.docType !== "credit_note") return lines.map((l, i) => make(base + "-" + (i + 1), l.date, [l]));
    return [make(base, d.dateAuto ? lastDate(d) : d.invoiceDate, lines)];
  }

  /** Totals for the archive row. */
  function summary(ref, data) {
    const d = normalize(data);
    const docs = documents(ref, d, "0");
    const t = docs[0].tax;
    const sum = (k) => round2(docs.reduce((s, x) => s + x[k], 0));
    return {
      docType: d.docType, kind: d.kind, entity: d.entity, mode: d.mode,
      clientName: d.client.name.trim(), clientEmail: d.client.email.trim(), clientVat: d.client.vat.trim(),
      country: d.country, currency: t.currency, channel: d.payment.channel,
      payCount: d.lines.length, invoiceDate: docs.at(-1).date,
      net: sum("net"), vat: sum("vat"), gross: sum("gross"), vatRule: t.vatRuleText, layout: t.layout,
      solidgateOrderId: (d.payment.solidgateOrderId || "").trim(),
    };
  }

  /**
   * Validation. "error" blocks PDF generation, "warn"/"info" are shown only.
   * Messages are in Ukrainian, like the rest of the UI.
   */
  function checks(ref, data) {
    const d = normalize(data);
    const out = [];
    const E = (m) => out.push(["error", m]), W = (m) => out.push(["warn", m]), I = (m) => out.push(["info", m]);
    const c = countryFor(ref, d);
    const t = taxInfo(ref, d);
    const ent = ref.entities[d.entity];
    const h = (x) => String(x ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    if (!d.client.name.trim()) E("Вкажіть ім'я клієнта або назву компанії.");
    if (!d.lines.length) E("Додайте хоча б один платіж.");
    if (d.lines.length > ref.maxPayments) E("Максимум " + ref.maxPayments + " платежів в одному документі.");
    d.lines.forEach((l, i) => {
      if (!l.date) E("Платіж " + (i + 1) + ": немає дати.");
      if (!(parseAmount(l.amount) > 0)) E("Платіж " + (i + 1) + ": немає суми (вводимо додатне число, як у Solid).");
      if (!String(l.desc || "").trim()) E("Платіж " + (i + 1) + ": порожній опис.");
    });
    if (d.docType === "credit_note" && !String(d.creditFor).trim()) E("Кредит-нота: вкажіть номер інвойсу, який вона коригує.");
    if (ent && ent.minDate) {
      const dates = d.lines.map((l) => l.date).concat(d.dateAuto ? [] : [d.invoiceDate]).filter(Boolean);
      if (dates.some((x) => x < ent.minDate)) E("Для " + ent.name + " дата має бути з " + ent.minDate.split("-").reverse().join(".") + " або пізніше.");
    }
    const forced = ref.channelEntity[d.payment.channel];
    if (forced && forced !== d.entity) E(h(d.payment.channel) + " — лише через " + ref.entities[forced].name + ". Перемкніть юрособу.");
    if (d.taxMode === "custom" && !t.novat && !(parseAmount(d.customRate) > 0)) E("Вкажіть свою ставку податку.");
    if (d.country === "USA") W("<b>США:</b> перевірте місто/штат (для Texas оберіть TX — податок рахується з 80% суми).");
    if (d.country === "CAN") W("<b>Канада:</b> перевірте провінцію.");
    if (c.rule === "alert") W("<b>" + h(c.name) + " — Alert.</b> Перед відправкою ескалюйте в legal-канал.");
    if (c.rule === "escalate") W("<b>" + h(c.name) + "</b>: вимоги складні, ескалюємо кейс-бай-кейс у legal.");
    if (d.layout !== "auto" && d.layout !== c.layout) W("Шаблон змінено вручну: для " + h(c.name) + " за таблицею — " + (c.layout === "VAT" ? "з VAT" : "без VAT") + ".");
    if (d.kind === "B2B") {
      if (d.taxMode === "zero" && !d.client.vat.trim()) W("0% для компанії — лише з валідним VAT-номером. Немає номера → інвойс з VAT, як для B2C.");
      if (!d.client.address.trim()) W("Для B2B-інвойсу додайте адресу компанії.");
      if (c.region === "EU" && d.client.vat.trim()) I("Перевірте VAT-номер у VIES (кнопка біля поля).");
    }
    if (d.kind === "B2C" && d.taxMode === "zero") W("0% зазвичай лише для B2B з валідним VAT-номером.");
    if (d.kind === "B2C" && !d.client.email.trim()) W("Немає email — перевірте, що це саме те, що просив юзер.");
    if (d.payment.channel === "PayPal" && c.region === "nonEU") I("PayPal у нас лише для Європи — перевірте країну в Solid (Issuer country).");
    I("Без апруву юристів інвойси не надсилаємо — після генерації кидаємо PDF у <b>riseguide_support_legal</b> → Invoice Request.");
    return out;
  }

  return { round2, parseAmount, todayISO, blank, normalize, countryOf, countryFor, taxInfo, calcLine, lastDate, documents, summary, checks };
});

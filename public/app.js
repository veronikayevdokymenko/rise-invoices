"use strict";
/* Rise Invoices — front end. Talks to the server API; all business rules live in /shared/calc.js. */
(function () {
const C = window.InvoiceCalc, P = window.InvoicePDF;
const { money, esc, fmtShort } = P;
const $ = (s, el = document) => el.querySelector(s), $$ = (s, el = document) => [...el.querySelectorAll(s)];
const clone = (o) => JSON.parse(JSON.stringify(o));

const STATUSES = { draft: "Чернетка", review: "На апруві", fix: "Потрібні правки", approved: "Апрувнуто", sent: "Надіслано юзеру" };
const ALL_STATUSES = Object.assign({}, STATUSES, { void: "Анульовано", legacy: "З Google-таблиці" });
const ACTIONS = {
  CREATE: "Створено", CREATE_CREDIT_NOTE: "Кредит-нота", EDIT: "Зміни", NUMBER: "Номер", GENERATE: "PDF", STATUS: "Статус",
  VOID: "Анульовано", DELETE_DRAFT: "Чернетку видалено", SETTINGS: "Налаштування", COUNTRIES: "Країни", LEGACY: "Імпорт з таблиці",
};
const POPULAR = ["USA", "GBR", "CAN", "AUS", "DEU", "FRA", "ESP", "ITA", "NLD", "POL", "IRL", "BEL"];

let R = null, ME = null;              // reference data, current user
let inv = null;                       // invoice data being edited
let cur = null;                       // {id, version, status, number, legacy, docType} of the saved invoice, or null
let savedJSON = null, viewingVersion = null;

/* ---------- API ---------- */
async function api(method, path, body) {
  const res = await fetch("/api" + path, {
    method, credentials: "same-origin",
    headers: Object.assign({ "X-Requested-With": "rise-invoices" }, body ? { "Content-Type": "application/json" } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.href = "/auth/login"; throw new Error("not signed in"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.message || "Помилка " + res.status); e.code = data.error; e.status = res.status; throw e; }
  return data;
}

/* ---------- small UI helpers ---------- */
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("on"), 3200); }
let onModalClose = null; // called once when a modal closes in any way (button, Escape, backdrop)
function openModal(h, onClose) {
  if (!$("#modalScrim").hidden) closeModal();
  $("#modal").innerHTML = h; $("#modalScrim").hidden = false; onModalClose = onClose || null;
  setTimeout(() => $("#modal").querySelector("input,textarea,button")?.focus(), 0);
}
function closeModal() {
  if ($("#modalScrim").hidden) return;
  $("#modalScrim").hidden = true; $("#modal").onclick = null;
  const f = onModalClose; onModalClose = null; if (f) f();
}
function closeDrawer() { $("#drawerScrim").hidden = true; }
const fmtWhen = (iso) => { if (!iso) return ""; const d = new Date(iso); return d.toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "2-digit" }) + " " + d.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" }); };
const fmtUTC = (iso) => { if (!iso) return ""; const d = new Date(iso); return d.toISOString().slice(0, 16).replace("T", " "); };
const who = (email) => (email || "").split("@")[0];
const getPath = (o, p) => p.split(".").reduce((a, k) => a?.[k], o);
const setPath = (o, p, v) => { const ks = p.split("."); let a = o; ks.slice(0, -1).forEach((k) => (a = a[k])); a[ks.at(-1)] = v; };
const countryName = (c) => (c.name_uk || c.name);
const pill = (status) => `<span class="pill s-${esc(status)}">${esc(ALL_STATUSES[status] || status)}</span>`;

/** Ask for a short text (reason/comment). Resolves to the text or null. */
function askText(title, hint, okLabel) {
  return new Promise((resolve) => {
    let answer = null;
    openModal(`<h3>${esc(title)}</h3><p class="hint">${hint}</p><textarea id="askT" style="min-height:90px"></textarea>
      <div class="actions"><button class="btn" data-no>Скасувати</button><button class="btn primary" data-ok>${esc(okLabel || "Готово")}</button></div>`,
      () => resolve(answer));
    $("#modal").onclick = (e) => {
      if (e.target.closest("[data-no]")) closeModal();
      if (e.target.closest("[data-ok]")) { const v = $("#askT").value.trim(); if (!v) return toast("Заповніть поле"); answer = v; closeModal(); }
    };
  });
}

function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
const blobToBase64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(blob); });

/* ---------- local draft (per browser, convenience only) ---------- */
const draftKey = () => "rise-inv-draft:" + (ME ? ME.email : "");
function saveLocalDraft() { try { localStorage.setItem(draftKey(), JSON.stringify({ inv, cur, savedJSON })); } catch (e) {} }
function loadLocalDraft() {
  try { const x = JSON.parse(localStorage.getItem(draftKey()) || "null"); if (x && x.inv) { inv = C.normalize(x.inv); cur = x.cur || null; savedJSON = x.savedJSON || null; return true; } } catch (e) {}
  return false;
}

/* ---------- editor ---------- */
function countryOf(code) { return C.countryOf(R, code); }
function isDirty() { return savedJSON !== JSON.stringify(stripUI(inv)); }
function stripUI(d) { const c = clone(d); c.lines.forEach((l) => delete l._edit); delete c.client.vatCheck_ui; return c; }
const locked = () => !!cur && (cur.legacy || cur.status === "void");

function fillSelects() {
  const sorted = [...R.countries].sort((a, b) => countryName(a).localeCompare(countryName(b), "uk"));
  const opt = (c) => `<option value="${esc(c.code)}">${esc(countryName(c))} — ${esc(c.code)} · ${c.layout === "VAT" ? c.rate + "%" : "без VAT"}</option>`;
  const pop = POPULAR.map((p) => R.countries.find((c) => c.code === p)).filter(Boolean);
  $("#countrySel").innerHTML = `<optgroup label="Часті">${pop.map(opt).join("")}</optgroup><optgroup label="ЄС">${sorted.filter((c) => c.region === "EU").map(opt).join("")}</optgroup><optgroup label="Інші">${sorted.filter((c) => c.region !== "EU").map(opt).join("")}</optgroup>`;
  $("#channelSel").innerHTML = R.paymentChannels.map((c) => `<option>${esc(c)}</option>`).join("");
  $("#statusSel").innerHTML = Object.entries(STATUSES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("") + `<option value="void" disabled>Анульовано</option>`;
  $("#fStatus").innerHTML = `<option value="">Усі статуси</option>` + Object.entries(ALL_STATUSES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
  $("#lAction").innerHTML = `<option value="">Усі дії</option>` + Object.entries(ACTIONS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
  const L = R.links;
  $("#linksMenu").innerHTML = [["Notion: Invoice request", L.notionRequest], ["Notion: B2B", L.notionB2B], ["Notion: B2C", L.notionB2C], ["VIES (EU VAT)", L.vies], ["UK VAT checker", L.ukVat], ["AU ABN lookup", L.auAbn]]
    .map(([t, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a>`).join("");
}

function syncForm() {
  const c = countryOf(inv.country), t = C.taxInfo(R, inv);
  $("#curSel").innerHTML = `<option value="AUTO">Авто (${esc(c.currency)})</option>` + R.currencies.map((x) => `<option>${esc(x)}</option>`).join("");
  $("#layoutSel").innerHTML = `<option value="auto">Авто — ${c.layout === "VAT" ? "з VAT" : "без VAT"} (за таблицею)</option><option value="VAT">З VAT</option><option value="NO_VAT">Без VAT</option>`;
  $$("#form [data-k]").forEach((el) => {
    const v = getPath(inv, el.dataset.k);
    if (el.type === "checkbox") el.checked = !!v; else if (document.activeElement !== el) el.value = v ?? "";
  });
  if ($("#countrySel").value !== inv.country) { $("#countrySel").insertAdjacentHTML("beforeend", `<option value="${esc(inv.country)}">${esc(inv.country)}</option>`); $("#countrySel").value = inv.country; }
  $$("[data-seg]").forEach((seg) => { const v = getPath(inv, seg.dataset.seg); seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === v))); });
  const b2b = inv.kind === "B2B", credit = inv.docType === "credit_note";
  $$(".b2b").forEach((e) => (e.hidden = !b2b));
  $$(".cn-only").forEach((e) => (e.hidden = !credit));
  $$(".us-only").forEach((e) => (e.hidden = inv.country !== "USA"));
  $$(".vat-only").forEach((e) => (e.hidden = t.novat));
  const pp = inv.payment.channel === "PayPal";
  $$(".card-only").forEach((e) => (e.hidden = pp)); $$(".pp-only").forEach((e) => (e.hidden = !pp));
  $("#nameLabel").textContent = b2b ? "Назва компанії" : "Ім'я та прізвище";
  $("#btnVies").hidden = c.region !== "EU";
  $("#customRateWrap").hidden = t.novat || inv.taxMode !== "custom";
  $("#noteTextWrap").hidden = inv.note !== "custom";
  $("#taxStdBtn").textContent = `Standard VAT (${c.rate}%)`;
  $("#taxHint").textContent = { standard: `Ставка ${c.rate}% для ${countryName(c)} — суми з податком, податок виділяється всередині.${t.share < 1 ? " Texas: податок з 80% суми." : ""}`, zero: "Компанія з валідним VAT-номером: 0%.", custom: "Своя ставка, якщо legal сказали інакше." }[inv.taxMode] || "";
  $("#noteHint").textContent = inv.note === "auto" ? (t.note ? "Буде: " + t.note : "За правилом примітки не буде (вона додається для Celeb + B2B + 0%).") : "";
  $(".multi-only-wrap").hidden = credit;
  $("#dateWrap").hidden = inv.mode === "SINGLE" && !credit;
  $("#invDate").hidden = inv.dateAuto;
  if (inv.dateAuto) $("#invDate").value = C.lastDate(inv);
  $("#addLine").disabled = inv.lines.length >= R.maxPayments || locked();
  $("#linesHint").textContent = `Суми — як у Solid, з податком. До ${R.maxPayments} платежів.`;
  const vc = inv.client.vatCheck;
  $("#vatRes").className = "vat-res" + (vc ? (vc.valid ? " ok" : " bad") : "");
  $("#vatRes").textContent = vc && vc.vat === inv.client.vat ? (vc.valid ? "VALID — " + (vc.name || "назва недоступна") : "INVALID") + " · VIES " + fmtWhen(vc.checkedAt) : "";
  $("#statusSel").value = cur ? cur.status : "draft";
  $("#statusSel").disabled = !cur || locked();
  $$("#form input, #form select, #form textarea, #form .seg button, #form .line button").forEach((el) => (el.disabled = locked()));
  $("#btnSave").disabled = locked();
}

function renderLines() {
  const t = C.taxInfo(R, inv);
  $("#lines").innerHTML = inv.lines.map((l, i) => {
    const c = C.calcLine(l, t);
    return `<div class="line" data-i="${i}">
    <div class="line-top">
      <span class="n">${i + 1}</span>
      <select data-l="type" aria-label="Тип платежу">${Object.entries(R.lineTypes).map(([k, v]) => `<option value="${k}" ${k === l.type ? "selected" : ""}>${esc(v.label)}</option>`).join("")}</select>
      <input class="d" type="date" data-l="date" value="${esc(l.date)}" aria-label="Дата платежу">
      <input class="a" type="text" inputmode="decimal" data-l="amount" value="${esc(l.amount)}" placeholder="0.00" aria-label="Сума">
      <button type="button" class="icon-btn" data-del="${i}" aria-label="Видалити платіж" ${inv.lines.length < 2 ? "disabled" : ""}>×</button>
    </div>
    ${l.type === "custom" || l._edit ? `<textarea data-l="desc" rows="2" aria-label="Опис">${esc(l.desc)}</textarea>` : ""}
    <div class="calc"><span>${esc(String(l.desc).replace("\n", " "))}</span>${l.type !== "custom" && !l._edit ? `<button type="button" class="link-btn" data-edit="${i}">Змінити текст</button>` : ""}
    <span>${lineCalcText(c, t)}</span></div>
  </div>`;
  }).join("");
}
const lineCalcText = (c, t) => (t.novat ? "" : `без податку ${money(c.net)} · ${esc(t.taxLabel)} ${money(c.vat)} · `) + `разом ${money(c.gross)} ${esc(t.currency)}`;

let rafP = 0;
function renderPreview() {
  cancelAnimationFrame(rafP);
  rafP = requestAnimationFrame(() => {
    if (!window.jspdf) { $("#desk").innerHTML = '<div class="empty">Не вдалося завантажити генератор PDF. Оновіть сторінку.</div>'; return; }
    const num = cur && cur.number != null ? cur.number : R.nextNumber;
    let h = "";
    C.documents(R, inv, num).forEach((D) => {
      const pages = P.layout(D);
      pages.forEach((p, pi) => {
        h += `<div class="paper-cap"><span>${esc(D.number)}_Invoice.pdf${pages.length > 1 ? ` · стор. ${pi + 1}` : ""}</span><span>${viewingVersion ? `версія ${viewingVersion}` : cur && cur.number != null ? "" : "номер попередній — дається при генерації"}</span></div><div class="paper">${P.toSVG(p)}</div>`;
      });
    });
    $("#desk").innerHTML = h;
    const cs = C.checks(R, inv);
    if (dupInfo) cs.unshift(["warn", dupInfo]);
    $("#alerts").innerHTML = cs.map(([lv, t]) => `<div class="alert ${lv}"><span class="dot"></span><span>${t}</span></div>`).join("");
    $("#btnGen").disabled = locked() || cs.some((c) => c[0] === "error");
    renderCtx();
  });
}

function renderCtx() {
  let h;
  if (!cur) h = `Новий ${inv.docType === "credit_note" ? "документ (кредит-нота)" : "інвойс"} · <span class="sub">наступний № ${esc(R.nextNumber)}</span>`;
  else h = `${cur.number != null ? `<b>№ ${esc(cur.number)}</b>` : "<b>Чернетка</b> без номера"} ${pill(cur.status)}${cur.docType === "credit_note" ? ' <span class="pill cn">кредит-нота</span>' : ""} <span class="sub">v${esc(cur.version)}</span>`;
  if (viewingVersion) h += ` <span class="pill">відкрито версію ${viewingVersion}</span>`;
  if (!locked() && isDirty()) h += ` <span class="sub">є незбережені зміни</span>`;
  $("#ctx").innerHTML = h;
}

function refresh(full) { if (full) renderLines(); syncForm(); renderPreview(); saveLocalDraft(); }

/* duplicate hint: other invoices for the same email */
let dupInfo = "", dupFor = "";
async function checkDuplicates() {
  const email = inv.client.email.trim().toLowerCase();
  if (email === dupFor) return;
  dupFor = email; dupInfo = "";
  if (email.includes("@")) {
    try {
      const r = await api("GET", "/invoices?limit=10&email=" + encodeURIComponent(email));
      const others = r.rows.filter((x) => !cur || x.id !== cur.id);
      if (others.length) dupInfo = `<b>Для цього email в архіві вже є:</b> ` + others.map((x) => `<a href="#" data-open-id="${x.id}">${esc(x.number ?? "чернетка")}</a> (${esc(fmtShort(x.invoice_date))}, ${money(x.gross || 0)} ${esc(x.currency || "")})`).join(", ") + ". Перевірте, що це не дубль.";
    } catch (e) {}
  }
  renderPreview();
}
$("#alerts").addEventListener("click", (e) => { const a = e.target.closest("[data-open-id]"); if (a) { e.preventDefault(); openDrawer(+a.dataset.openId); } });

/* editor events */
$("#form").addEventListener("submit", (e) => e.preventDefault());
$("#form").addEventListener("input", (e) => {
  const el = e.target;
  if (el.dataset.k) {
    let v = el.type === "checkbox" ? el.checked : el.value;
    if (el.dataset.k === "payment.last4") { v = String(v).replace(/\D/g, "").slice(0, 4); el.value = v; }
    setPath(inv, el.dataset.k, v);
    if (el.dataset.k === "country") { inv.currency = "AUTO"; inv.layout = "auto"; if (v !== "USA") inv.usState = ""; }
    if (el.dataset.k === "payment.channel") { const forced = R.channelEntity[v]; if (forced && inv.entity !== forced) { inv.entity = forced; toast(v + " → юрособа " + R.entities[forced].name); } }
    refresh(["country", "currency", "layout", "taxMode", "customRate", "usState", "dateAuto", "docType"].includes(el.dataset.k));
    return;
  }
  const row = el.closest(".line"); if (!row || !el.dataset.l) return;
  const l = inv.lines[+row.dataset.i];
  if (el.dataset.l === "type") { l.type = el.value; if (el.value !== "custom") { l.desc = R.lineTypes[el.value].desc; l._edit = false; } refresh(true); return; }
  l[el.dataset.l] = el.value;
  if (el.dataset.l === "amount" || el.dataset.l === "desc") {
    const t = C.taxInfo(R, inv), c = C.calcLine(l, t); const spans = row.querySelectorAll(".calc span");
    spans[0].textContent = String(l.desc).replace("\n", " "); spans[spans.length - 1].innerHTML = lineCalcText(c, t);
  }
  syncForm(); renderPreview(); saveLocalDraft();
});
$("#form").addEventListener("change", (e) => { if (e.target.dataset.k === "client.email") checkDuplicates(); });
$("#form").addEventListener("click", (e) => {
  const sb = e.target.closest("[data-seg] button");
  if (sb) {
    const k = sb.parentElement.dataset.seg; setPath(inv, k, sb.dataset.v);
    if (k === "kind" && sb.dataset.v === "B2C" && inv.taxMode === "zero") inv.taxMode = "standard";
    if (k === "kind" && sb.dataset.v === "B2B" && inv.client.vat && inv.taxMode === "standard") toast("Валідний VAT-номер → оберіть «B2B — 0% VAT»");
    if (k === "entity") { const forced = R.channelEntity[inv.payment.channel]; if (forced && forced !== sb.dataset.v) toast(inv.payment.channel + " — лише " + R.entities[forced].name); }
    if (k === "docType" && sb.dataset.v === "credit_note") inv.mode = "MULTI";
    refresh(true); return;
  }
  const del = e.target.closest("[data-del]"); if (del) { inv.lines.splice(+del.dataset.del, 1); refresh(true); return; }
  const ed = e.target.closest("[data-edit]"); if (ed) { inv.lines[+ed.dataset.edit]._edit = true; refresh(true); return; }
});
$("#addLine").onclick = () => {
  if (inv.lines.length >= R.maxPayments) return;
  const prev = inv.lines.at(-1); let date = C.todayISO();
  if (prev?.date) { const d = new Date(prev.date + "T12:00:00"); d.setDate(d.getDate() + 28); date = d.toISOString().slice(0, 10); }
  const type = inv.lines.length ? "monthly" : "initial";
  inv.lines.push({ type, desc: R.lineTypes[type].desc, date, amount: prev?.amount || "" });
  refresh(true);
};
$("#btnVies").onclick = async () => {
  const b = $("#btnVies"); b.disabled = true; b.textContent = "Перевіряю…";
  try {
    const r = await api("POST", "/vat/check", { vat: inv.client.vat, country: inv.country });
    inv.client.vatCheck = { vat: inv.client.vat, valid: r.valid, name: r.name, address: r.address, checkedAt: r.checkedAt };
    if (r.valid && r.address && !inv.client.address.trim()) inv.client.address = r.address;
    toast(r.valid ? "VAT-номер валідний" : "VAT-номер НЕ валідний");
    refresh(false);
  } catch (e) { toast(e.message); } finally { b.disabled = false; b.textContent = "Перевірити VIES"; }
};

/* ---------- save / status ---------- */
async function save(opts = {}) {
  const data = stripUI(inv);
  if (cur && savedJSON === JSON.stringify(data)) { if (!opts.silent) toast("Без змін"); return cur; }
  delete data.rules; // the server sets these
  try {
    let stored;
    if (!cur) {
      const r = await api("POST", "/invoices", { data, note: opts.note || "" });
      cur = { id: r.id, version: r.version, status: r.status, number: r.number, legacy: false, docType: data.docType };
      stored = r.data;
    } else {
      let reason = opts.reason;
      for (;;) {
        try {
          const r = await api("PUT", "/invoices/" + cur.id, { data, baseVersion: cur.version, reason, note: opts.note || "" });
          if (r.status !== cur.status && r.status === "draft") toast("Статус повернуто в «Чернетку» — потрібен новий апрув");
          Object.assign(cur, { version: r.version, status: r.status, number: r.number });
          stored = r.data;
          break;
        } catch (e) {
          if (e.code !== "reason_required") throw e;
          reason = await askText("Причина змін", esc(e.message), "Зберегти");
          if (!reason) throw Object.assign(new Error("Скасовано"), { code: "cancelled" });
        }
      }
    }
    // the server freezes the country rules into the saved data — continue from exactly what was stored
    if (stored) { const keepEdit = inv.lines.map((l) => l._edit); inv = C.normalize(stored); inv.lines.forEach((l, i) => { if (keepEdit[i]) l._edit = true; }); }
    savedJSON = JSON.stringify(stripUI(inv)); viewingVersion = null;
    if (!opts.silent) toast(cur.number != null ? `Збережено: № ${cur.number}, версія ${cur.version}` : `Чернетку збережено (версія ${cur.version})`);
    refresh(false);
    return cur;
  } catch (e) {
    if (e.code === "conflict") {
      openModal(`<h3>Хтось змінив цей інвойс</h3><p class="hint">${esc(e.message)}</p><div class="actions"><button class="btn" data-close>Залишитись</button><button class="btn primary" data-reload>Відкрити свіжу версію</button></div>`);
      $("#modal").onclick = (ev) => { if (ev.target.closest("[data-close]")) closeModal(); if (ev.target.closest("[data-reload]")) { closeModal(); openInvoice(cur.id); } };
    } else if (e.code !== "cancelled") toast("Не збережено: " + e.message);
    throw e;
  }
}
$("#btnSave").onclick = () => save().catch(() => {});

$("#statusSel").onchange = async (e) => {
  const status = e.target.value;
  if (!cur) return;
  if (isDirty()) { toast("Спершу збережіть зміни"); e.target.value = cur.status; return; }
  let comment;
  if (status === "fix") { comment = await askText("Що треба виправити?", "Коментар потрапить у лог.", "Зберегти"); if (comment == null) { e.target.value = cur.status; return; } }
  try {
    await api("POST", `/invoices/${cur.id}/status`, { status, comment });
    cur.status = status; toast("Статус: " + STATUSES[status]); refresh(false);
  } catch (err) { toast(err.message); e.target.value = cur.status; }
};

$("#btnNew").onclick = () => { if (!locked() && isDirty() && !confirm("Є незбережені зміни. Почати новий документ?")) return; newInvoice(); };
function newInvoice(data) {
  inv = C.normalize(data || C.blank()); cur = null; viewingVersion = null; dupFor = null; dupInfo = "";
  savedJSON = data ? null : JSON.stringify(stripUI(inv));
  closeDrawer(); refresh(true); showTab("editor");
  if (data) checkDuplicates();
}

async function openInvoice(id, v) {
  try {
    const r = await api("GET", "/invoices/" + id);
    const x = r.invoice;
    if (!r.versions.length) { toast("У цього запису немає даних для редагування"); return; }
    const ver = v ? r.versions.find((q) => q.v === v) : r.versions[0];
    inv = C.normalize(ver.data);
    cur = { id: x.id, version: x.current_version, status: x.status, number: x.number, legacy: x.legacy, docType: x.doc_type };
    savedJSON = JSON.stringify(stripUI(C.normalize(r.versions[0].data)));
    viewingVersion = v && v !== x.current_version ? v : null;
    dupFor = null; closeDrawer(); refresh(true); showTab("editor"); checkDuplicates();
    if (viewingVersion) toast(`Відкрито версію ${v}. «Зберегти» зробить її поточною.`);
  } catch (e) { toast(e.message); }
}

/* ---------- generate ---------- */
$("#btnGen").onclick = async () => {
  if (C.checks(R, inv).some((c) => c[0] === "error")) return;
  const btn = $("#btnGen"); btn.disabled = true; btn.textContent = "Генерую…";
  try {
    await save({ silent: true });
    const prep = await api("POST", `/invoices/${cur.id}/prepare`, { version: cur.version });
    cur.number = prep.number;
    const docs = C.documents(R, prep.data, prep.number); // render exactly the saved version
    const files = docs.map((D) => ({ number: D.number, name: D.number + "_Invoice.pdf", blob: P.toPDF(P.layout(D), D.number) }));
    const payload = await Promise.all(files.map(async (f) => ({ number: f.number, pdf: await blobToBase64(f.blob) })));
    await api("POST", `/invoices/${cur.id}/documents`, { version: cur.version, files: payload });
    R.nextNumber = Math.max(R.nextNumber, prep.number + 1);
    refresh(false);
    if (files.length === 1) { download(files[0].name, files[0].blob); toast(`${files[0].name} готовий — надішліть на апрув`); }
    else showFilesModal(files, prep.number);
  } catch (e) { if (e.code !== "cancelled") toast("PDF не створено: " + e.message); }
  finally { btn.textContent = "Згенерувати PDF"; renderPreview(); }
};
function showFilesModal(files, number) {
  openModal(`<h3>${files.length} PDF для № ${esc(number)}</h3><p class="hint">Усі файли збережені в архіві. Завантажте окремо або одним архівом.</p>
    <div style="display:flex;flex-direction:column;gap:6px;margin-top:10px">${files.map((f, i) => `<button class="btn" data-f="${i}" style="text-align:left">${esc(f.name)}</button>`).join("")}</div>
    <div class="actions"><button class="btn" data-close>Закрити</button><button class="btn primary" data-zip>Усі одним .zip</button></div>`);
  $("#modal").onclick = async (e) => {
    if (e.target.closest("[data-close]")) return closeModal();
    const f = e.target.closest("[data-f]"); if (f) return download(files[+f.dataset.f].name, files[+f.dataset.f].blob);
    if (e.target.closest("[data-zip]")) { const z = new JSZip(); files.forEach((x) => z.file(x.name, x.blob)); download(number + "_Invoices.zip", await z.generateAsync({ type: "blob" })); }
  };
}

/* ---------- text for the user (no PDF) ---------- */
function userText(d) {
  const p = d.payment, t = C.taxInfo(R, d);
  const ch = p.channel || "";
  const method = ch === "PayPal" ? "PayPal" : ch.startsWith("ApplePay") ? "Apple Pay (card)" : "Card";
  const brand = ch.replace(/^(ApplePay|Card)\s*/, "");
  const blocks = d.lines.map((l, i) => {
    const c = C.calcLine(l, t); const r = [];
    if (d.lines.length > 1) r.push(`Payment ${i + 1}`);
    r.push(`Date and amount of the charge: ${P.fmtLong(l.date)} — ${money(Math.abs(c.gross))} ${t.currency}`);
    if (p.plan && l.type !== "pdfguide") r.push(`Subscription type: ${p.plan} (auto-renewing)`);
    if (l.type === "pdfguide") r.push("Purchase: Additional PDF-Guide (one-time)");
    r.push(`Payment method: ${method}`);
    if (ch !== "PayPal") { if (brand) r.push(`Card type: ${brand}`); if (p.last4) r.push(`Last 4 digits of the card: ${p.last4}`); }
    r.push("Status: Paid");
    if (ch === "PayPal" && p.paypalId) r.push(`PayPal Invoice ID: ${p.paypalId}`);
    return r.join("\n");
  });
  return `Here are the details of your payment${d.lines.length > 1 ? "s" : ""}:\n\n` + blocks.join("\n\n");
}
$("#btnUser").onclick = () => {
  openModal(`<h3>Повідомлення юзеру (без PDF)</h3><textarea id="mText" readonly>${esc(userText(stripUI(inv)))}</textarea><div class="actions"><button class="btn" data-close>Закрити</button><button class="btn primary" data-copy>Скопіювати</button></div>`);
  $("#modal").onclick = async (e) => {
    if (e.target.closest("[data-close]")) return closeModal();
    if (e.target.closest("[data-copy]")) { let ok = false; try { await navigator.clipboard.writeText($("#mText").value); ok = true; } catch (_) {} toast(ok ? "Скопійовано" : "Виділіть текст і скопіюйте вручну"); }
  };
};

/* ---------- archive ---------- */
let arcOffset = 0, arcTimer = 0;
async function renderArchive() {
  const qs = new URLSearchParams({ limit: 100, offset: arcOffset });
  if ($("#q").value.trim()) qs.set("q", $("#q").value.trim());
  if ($("#fStatus").value) qs.set("status", $("#fStatus").value);
  if ($("#fType").value) qs.set("type", $("#fType").value);
  if ($("#fMine").checked) qs.set("mine", "1");
  try {
    const r = await api("GET", "/invoices?" + qs);
    $("#count").textContent = `${r.total} записів`;
    $("#tbody").innerHTML = r.rows.map((x) => `<tr data-id="${x.id}" tabindex="0">
      <td class="no">${x.number != null ? esc(x.number) : '<span class="sub">чернетка</span>'}${x.mode === "SINGLE" && x.doc_type !== "credit_note" ? `<div class="sub">${esc(x.pay_count)} PDF</div>` : ""}${x.doc_type === "credit_note" ? `<div class="sub">КН до ${esc(x.credit_for || "")}</div>` : ""}</td>
      <td>${esc(x.client_name || "—")}<div class="sub">${esc(x.client_email || "")}${x.kind === "B2B" ? " · B2B" : ""}</div></td>
      <td>${esc(x.country || "")}<div class="sub">${esc(x.channel || "")}</div></td>
      <td>${esc(fmtShort(x.invoice_date))}</td>
      <td class="num">${money(x.gross || 0)} ${esc(x.currency || "")}</td>
      <td>${pill(x.status)}</td>
      <td class="sub">${esc(fmtWhen(x.updated_at))}<br>${esc(who(x.updated_by || x.created_by))}</td></tr>`).join("");
    $("#empty").hidden = r.rows.length > 0;
    $("#empty").innerHTML = r.total ? "" : 'Нічого не знайдено. <button class="link-btn" id="goNew">Створити інвойс</button>';
    $("#goNew")?.addEventListener("click", () => newInvoice());
    pager($("#pager"), arcOffset, r.total, (o) => { arcOffset = o; renderArchive(); });
  } catch (e) { toast(e.message); }
}
function pager(el, offset, total, go) {
  el.innerHTML = total > 100 ? `<span class="sub">${offset + 1}–${Math.min(offset + 100, total)} з ${total}</span><button class="btn sm" data-p="-1" ${offset ? "" : "disabled"}>‹ Назад</button><button class="btn sm" data-p="1" ${offset + 100 < total ? "" : "disabled"}>Далі ›</button>` : "";
  el.onclick = (e) => { const b = e.target.closest("[data-p]"); if (b) go(Math.max(0, offset + 100 * +b.dataset.p)); };
}
const arcSoon = () => { clearTimeout(arcTimer); arcTimer = setTimeout(() => { arcOffset = 0; renderArchive(); }, 250); };
$("#q").oninput = arcSoon; $("#fStatus").onchange = arcSoon; $("#fType").onchange = arcSoon; $("#fMine").onchange = arcSoon;
$("#tbody").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-id]"); if (tr) openDrawer(+tr.dataset.id); });
$("#tbody").addEventListener("keydown", (e) => { if (e.key === "Enter") { const tr = e.target.closest("tr[data-id]"); if (tr) openDrawer(+tr.dataset.id); } });

async function openDrawer(id) {
  let r;
  try { r = await api("GET", "/invoices/" + id); } catch (e) { return toast(e.message); }
  const x = r.invoice, live = r.documents.filter((d) => !d.superseded), old = r.documents.filter((d) => d.superseded);
  const canEdit = !x.legacy && x.status !== "void";
  const docLi = (d, cls) => `<li class="${cls || ""}"><div><b>${esc(d.number)}_Invoice.pdf</b><div class="sub">${esc(fmtShort(d.doc_date))} · ${money(d.gross || 0)} ${esc(d.currency || "")}${d.version ? " · v" + d.version : ""} · ${esc(fmtWhen(d.created_at))} ${esc(who(d.created_by))}</div></div>
    <div class="row">${d.has_pdf ? `<a class="btn sm" href="/api/documents/${d.id}/pdf?inline=1" target="_blank" rel="noopener">Відкрити</a><a class="btn sm" href="/api/documents/${d.id}/pdf">PDF</a>` : d.drive_file_id ? `<a class="btn sm" href="/api/documents/${d.id}/pdf" target="_blank" rel="noopener">Google Drive</a>` : ""}
    ${!cls && x.doc_type !== "credit_note" && !x.legacy && x.status !== "void" ? `<button class="btn sm" data-cn="${esc(d.number)}">Кредит-нота</button>` : ""}</div></li>`;
  $("#drawer").innerHTML = `<div class="row" style="justify-content:space-between"><h3>${x.number != null ? "№ " + esc(x.number) : "Чернетка"}</h3><button class="icon-btn" data-x aria-label="Закрити">×</button></div>
  <div class="row" style="margin-top:8px">${pill(x.status)}${x.doc_type === "credit_note" ? `<span class="pill cn">кредит-нота до ${esc(x.credit_for || "")}</span>` : ""}<span class="sub">${esc((R.entities[x.entity] || {}).name || "")}</span></div>
  ${x.void_reason ? `<div class="alert error" style="margin-top:10px"><span class="dot"></span><span>Анульовано: ${esc(x.void_reason)}</span></div>` : ""}
  <dl class="kv"><dt>Клієнт</dt><dd>${esc(x.client_name || "—")}${x.kind === "B2B" ? " · B2B" : ""}</dd><dt>Email</dt><dd>${esc(x.client_email || "—")}</dd>
  ${x.client_vat ? `<dt>VAT</dt><dd>${esc(x.client_vat)}</dd>` : ""}
  <dt>Країна</dt><dd>${esc(x.country || "")} · ${esc(x.channel || "")}</dd><dt>Сума</dt><dd>${money(x.gross || 0)} ${esc(x.currency || "")}${x.vat ? ` (VAT ${money(x.vat)})` : ""}</dd>
  <dt>Платежів</dt><dd>${esc(x.pay_count ?? "")} · ${esc(x.mode || "")}${x.layout === "NO_VAT" ? " · без VAT" : ""}</dd>
  ${x.solidgate_order_id ? `<dt>Solidgate</dt><dd>${esc(x.solidgate_order_id)}</dd>` : ""}
  <dt>Створено</dt><dd>${esc(fmtWhen(x.created_at))} ${esc(who(x.created_by))}</dd></dl>
  ${r.related.length ? `<p class="sub">${x.doc_type === "credit_note" ? "Інвойс" : "Кредит-ноти"}: ${r.related.map((q) => `<a href="#" data-rel="${q.id}">${esc(q.number ?? "чернетка")}</a>`).join(", ")}</p>` : ""}
  <div class="actions">${canEdit ? `<button class="btn primary" data-open>Редагувати</button>` : ""}${r.versions.length ? `<button class="btn" data-dup>Копія</button>` : ""}
    ${canEdit && x.number != null ? `<button class="btn" data-void>Анулювати</button>` : ""}${x.number == null && !x.legacy ? `<button class="btn" data-del>Видалити чернетку</button>` : ""}</div>
  <h4 style="margin:22px 0 4px;font-size:15px">Документи</h4>
  ${live.length ? `<ul class="docs">${live.map((d) => docLi(d)).join("")}</ul>` : '<p class="hint">PDF ще не генерувався.</p>'}
  ${old.length ? `<details style="margin-top:8px"><summary class="sub">Попередні PDF (${old.length})</summary><ul class="docs">${old.map((d) => docLi(d, "old")).join("")}</ul></details>` : ""}
  ${r.versions.length ? `<h4 style="margin:22px 0 4px;font-size:15px">Версії</h4><ul class="versions">${r.versions.map((v, i) => `<li class="${i === 0 ? "cur" : ""}"><div><b>Версія ${v.v}</b>${i === 0 ? ' <span class="sub">поточна</span>' : ""}<div class="sub">${esc(fmtWhen(v.created_at))} ${esc(who(v.created_by))}${v.note ? " · " + esc(v.note) : ""}</div></div>${i > 0 && canEdit ? `<button class="btn sm" data-ov="${v.v}">Відкрити</button>` : ""}</li>`).join("")}</ul>` : ""}
  <h4 style="margin:22px 0 4px;font-size:15px">Історія</h4>
  <ul class="timeline">${r.log.map((l) => `<li><span class="when">${esc(fmtWhen(l.at))}</span><span><span class="act">${esc(ACTIONS[l.action] || l.action)}</span> ${esc(l.action === "GENERATE" || l.action === "LEGACY" ? l.invoice_number || "" : "")} ${l.details && l.details.to ? "→ " + esc(STATUSES[l.details.to] || l.details.to) : ""} ${l.details && (l.details.reason || l.details.comment) ? "· " + esc(l.details.reason || l.details.comment) : ""} <span class="sub">${esc(who(l.user_email))}</span></span></li>`).join("")}</ul>`;
  $("#drawerScrim").hidden = false;
  $("#drawer").onclick = async (e) => {
    if (e.target.closest("[data-x]")) return closeDrawer();
    if (e.target.closest("[data-open]")) return openInvoice(id);
    const ov = e.target.closest("[data-ov]"); if (ov) return openInvoice(id, +ov.dataset.ov);
    const rel = e.target.closest("[data-rel]"); if (rel) { e.preventDefault(); return openDrawer(+rel.dataset.rel); }
    if (e.target.closest("[data-dup]")) { try { const c = await api("POST", `/invoices/${id}/copy`, {}); newInvoice(c.data); toast("Копія — отримає новий номер при генерації"); } catch (err) { toast(err.message); } return; }
    const cn = e.target.closest("[data-cn]");
    if (cn) { try { const c = await api("POST", `/invoices/${id}/credit-note`, { docNumber: cn.dataset.cn }); newInvoice(c.data); toast("Кредит-нота до " + cn.dataset.cn + " — перевірте суми і збережіть"); } catch (err) { toast(err.message); } return; }
    if (e.target.closest("[data-void]")) {
      const reason = await askText("Анулювати № " + x.number + "?", "Номер не звільняється, документ лишається в архіві з позначкою «Анульовано». Якщо гроші повертали — зробіть кредит-ноту.", "Анулювати");
      if (!reason) return;
      try { await api("POST", `/invoices/${id}/void`, { reason }); toast("Анульовано"); if (cur && cur.id === id) cur.status = "void"; openDrawer(id); renderArchive(); refresh(false); } catch (err) { toast(err.message); }
      return;
    }
    if (e.target.closest("[data-del]")) {
      if (!confirm("Видалити чернетку без номера?")) return;
      try { await api("DELETE", `/invoices/${id}`); toast("Чернетку видалено"); closeDrawer(); if (cur && cur.id === id) newInvoice(); renderArchive(); } catch (err) { toast(err.message); }
    }
  };
  setTimeout(() => $("#drawer [data-x]")?.focus(), 0);
}
$("#drawerScrim").addEventListener("click", (e) => { if (e.target.id === "drawerScrim") closeDrawer(); });

/* ---------- invoice log ---------- */
let logOffset = 0, logTimer = 0;
function logQuery() {
  const qs = new URLSearchParams();
  if ($("#lq").value.trim()) qs.set("q", $("#lq").value.trim());
  if ($("#lAction").value) qs.set("action", $("#lAction").value);
  if ($("#lFrom").value) qs.set("from", $("#lFrom").value);
  if ($("#lTo").value) qs.set("to", $("#lTo").value);
  return qs;
}
async function renderLog() {
  const qs = logQuery(); $("#lCsv").href = "/api/log.csv?" + qs;
  qs.set("limit", 100); qs.set("offset", logOffset);
  try {
    const r = await api("GET", "/log?" + qs);
    $("#lCount").textContent = `${r.total} записів`;
    $("#lbody").innerHTML = r.rows.map((l) => `<tr>
      <td class="sub">${esc(fmtUTC(l.at))}</td>
      <td><span class="act">${esc(ACTIONS[l.action] || l.action)}</span>${l.details && l.details.to ? `<div class="sub">→ ${esc(STATUSES[l.details.to] || l.details.to)}</div>` : ""}${l.details && (l.details.reason || l.details.comment) ? `<div class="sub">${esc(l.details.reason || l.details.comment)}</div>` : ""}</td>
      <td class="no">${l.invoice_id ? `<a href="#" data-inv="${l.invoice_id}">${esc(l.invoice_number || "—")}</a>` : esc(l.invoice_number || "")}</td>
      <td>${esc(l.customer_name || "")}<div class="sub">${esc(l.customer_email || "")}${l.customer_type ? " · " + esc(l.customer_type) : ""}</div></td>
      <td>${esc(l.country || "")}<div class="sub">${esc(l.payment_channel || "")}</div></td>
      <td><span class="sub">${esc(l.llc || "")}</span><div class="sub">${esc(l.mode || "")}${l.vat_rule ? " · " + esc(l.vat_rule) : ""}</div></td>
      <td class="num">${l.total != null ? money(l.total) + " " + esc(l.currency || "") : ""}${l.vat_amount ? `<div class="sub">VAT ${money(l.vat_amount)}</div>` : ""}</td>
      <td class="sub">${esc(who(l.user_email))}</td></tr>`).join("");
    $("#lempty").hidden = r.rows.length > 0; $("#lempty").textContent = "Записів немає.";
    pager($("#lpager"), logOffset, r.total, (o) => { logOffset = o; renderLog(); });
  } catch (e) { toast(e.message); }
}
const logSoon = () => { clearTimeout(logTimer); logTimer = setTimeout(() => { logOffset = 0; renderLog(); }, 250); };
["#lq", "#lAction", "#lFrom", "#lTo"].forEach((s) => $(s).addEventListener("input", logSoon));
$("#lbody").addEventListener("click", (e) => { const a = e.target.closest("[data-inv]"); if (a) { e.preventDefault(); openDrawer(+a.dataset.inv); } });

/* ---------- settings ---------- */
let ctDraft = null;
function renderSettings() {
  const admin = ME.role === "admin";
  $("#sStart").value = R.startNumber; $("#sTerms").value = R.terms;
  $("#adminHint").textContent = admin ? "" : "Змінювати налаштування можуть лише адміністратори.";
  if (!ctDraft) ctDraft = clone(R.countries);
  const q = $("#ctQ").value.trim().toLowerCase();
  const sel = (k, v, opts) => `<select data-c="${k}">${opts.map(([a, b]) => `<option value="${a}" ${a === v ? "selected" : ""}>${b}</option>`).join("")}</select>`;
  $("#ctBody").innerHTML = ctDraft.map((c, i) => ({ c, i })).filter(({ c }) => !q || (c.code + " " + c.name + " " + (c.name_uk || "")).toLowerCase().includes(q)).map(({ c, i }) => `<tr data-i="${i}">
    <td class="code">${c._new ? `<input type="text" data-c="code" value="${esc(c.code)}" maxlength="3" style="width:70px">` : esc(c.code)}</td>
    <td><input type="text" data-c="name" value="${esc(c.name)}"><input type="text" data-c="name_uk" value="${esc(c.name_uk || "")}" placeholder="укр. назва" style="margin-top:4px"></td>
    <td><input type="number" step="0.001" data-c="rate" value="${esc(c.rate)}" style="width:90px"></td>
    <td>${sel("currency", c.currency, R.currencies.map((x) => [x, x]))}</td>
    <td>${sel("region", c.region, [["EU", "EU"], ["nonEU", "nonEU"], ["UK", "UK"]])}</td>
    <td>${sel("layout", c.layout, [["VAT", "з VAT"], ["NO_VAT", "без VAT"]])}</td>
    <td>${sel("rule", c.rule || "", [["", "—"], ["alert", "Alert (legal)"], ["escalate", "Кейс-бай-кейс"]])}</td></tr>`).join("");
  $$("#view-settings input, #view-settings select, #view-settings textarea, #ctAdd, #ctSave, #sSaveGen, #legacyGo").forEach((el) => { if (el.id !== "ctQ") el.disabled = !admin; });
}
$("#ctQ").oninput = renderSettings;
$("#ctBody").addEventListener("input", (e) => {
  const tr = e.target.closest("tr"); const c = ctDraft[+tr.dataset.i], k = e.target.dataset.c;
  c[k] = k === "rate" ? parseFloat(e.target.value) || 0 : k === "code" ? e.target.value.toUpperCase() : e.target.value;
});
$("#ctAdd").onclick = () => { ctDraft.unshift({ code: "", name: "", name_uk: "", rate: 0, currency: "EUR", region: "nonEU", layout: "NO_VAT", rule: "", _new: true }); $("#ctQ").value = ""; renderSettings(); $("#ctBody input")?.focus(); };
$("#ctSave").onclick = async () => {
  const list = ctDraft.filter((c) => c.code && c.name).map(({ _new, ...c }) => c);
  try { await api("PUT", "/countries", { list }); await loadReference(); ctDraft = null; fillSelects(); renderSettings(); refresh(true); toast("Таблицю збережено"); }
  catch (e) { toast("Не збережено: " + e.message); }
};
$("#sSaveGen").onclick = async () => {
  try { await api("PUT", "/settings/general", { startNumber: $("#sStart").value, terms: $("#sTerms").value }); await loadReference(); refresh(false); toast("Збережено"); }
  catch (e) { toast("Не збережено: " + e.message); }
};

$("#legacyGo").onclick = async () => {
  const f = $("#legacyFile").files[0];
  if (!f) return toast("Оберіть CSV-файл");
  const b = $("#legacyGo"); b.disabled = true; b.textContent = "Імпортую…";
  try {
    const r = await api("POST", "/admin/import-legacy", { csv: await f.text() });
    $("#legacyRes").textContent = `Рядків у файлі: ${r.rows}. Імпортовано: ${r.imported}, пропущено (вже були): ${r.skipped}. Нових записів в архіві: ${r.invoices}, PDF-посилань: ${r.documents}.` +
      (r.startNumber ? ` Нові номери починаються з ${r.startNumber}.` : "") +
      (r.suspicious ? ` Увага: номер ${r.suspicious} схожий на опечатку — його не враховано для нумерації.` : "") +
      (r.conflicts.length ? ` Конфлікт номерів (вже створені тут): ${r.conflicts.join(", ")} — ці записи не перезаписано.` : "");
    await loadReference(); refresh(false);
  } catch (e) { $("#legacyRes").textContent = "Помилка: " + e.message; }
  finally { b.disabled = ME.role !== "admin"; b.textContent = "Імпортувати"; }
};

/* ---------- tabs & boot ---------- */
function showTab(t) {
  $$("nav.tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === t)));
  $$(".view").forEach((v) => (v.hidden = v.id !== "view-" + t));
  if (t === "archive") renderArchive();
  if (t === "log") renderLog();
  if (t === "settings") renderSettings();
  window.scrollTo(0, 0);
}
$$("nav.tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
$("#modalScrim").addEventListener("click", (e) => { if (e.target.id === "modalScrim") closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeModal(); closeDrawer(); } });

async function loadReference() { R = await api("GET", "/reference"); }

(async () => {
  try {
    [ME] = await Promise.all([api("GET", "/me"), loadReference()]);
  } catch (e) {
    if (e.message !== "not signed in") { $("#banner").hidden = false; $("#banner").textContent = "Сервер недоступний: " + e.message; }
    return;
  }
  $("#me").innerHTML = `${ME.picture ? `<img src="${esc(ME.picture)}" alt="">` : ""}<span>${esc(ME.name || ME.email)}</span><button type="button" id="logout">Вийти</button>`;
  $("#logout").onclick = async () => { await fetch("/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {}); location.href = "/auth/login"; };
  fillSelects();
  if (!loadLocalDraft()) { inv = C.blank(); savedJSON = JSON.stringify(stripUI(inv)); }
  refresh(true);
  if (cur) { // the saved invoice may have moved on (another person, another tab)
    try {
      const r = await api("GET", "/invoices/" + cur.id);
      Object.assign(cur, { status: r.invoice.status, number: r.invoice.number, legacy: r.invoice.legacy });
      if (r.invoice.current_version !== cur.version) {
        if (isDirty()) toast("Цей інвойс змінили в іншому місці. Ваші незбережені зміни лишились — при збереженні буде запропоновано відкрити свіжу версію.");
        else { toast("Цей інвойс змінили в іншому місці — відкриваю свіжу версію"); openInvoice(cur.id); }
      } else refresh(false);
    } catch (e) {
      if (e.status === 404) { toast("Збережений інвойс не знайдено — це тепер новий документ"); cur = null; savedJSON = null; refresh(false); }
      else toast("Не вдалося оновити інвойс з сервера: " + e.message);
    }
  }
  const id = new URLSearchParams(location.search).get("invoice"); if (id) openDrawer(+id);
})();
})();

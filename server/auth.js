"use strict";
/*
 * "Sign in with Google", limited to work accounts.
 *   ALLOWED_DOMAINS  comma-separated, e.g. "skelar.tech,riseguide.com" (required)
 *   ADMIN_EMAILS     comma-separated; these users can change settings and countries
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET   from Google Cloud → Credentials
 *   PUBLIC_URL       e.g. https://rise-invoices-production.up.railway.app
 */
const crypto = require("crypto");
const express = require("express");
const { OAuth2Client } = require("google-auth-library");
const { query } = require("./db");

const list = (v) => String(v || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const ALLOWED_DOMAINS = list(process.env.ALLOWED_DOMAINS);
const ADMIN_EMAILS = list(process.env.ADMIN_EMAILS);
const PUBLIC_URL = String(process.env.PUBLIC_URL || "").replace(/\/$/, "");
// On Railway we are always in production mode, whatever NODE_ENV says.
const IS_PROD = process.env.NODE_ENV === "production" || !!process.env.RAILWAY_ENVIRONMENT_NAME || PUBLIC_URL.startsWith("https://");
// Local testing only: skip Google and sign in as this email. Needs ENABLE_DEV_LOGIN=true and is impossible in production.
const DEV_LOGIN_EMAIL = !IS_PROD && process.env.ENABLE_DEV_LOGIN === "true" ? String(process.env.DEV_LOGIN_EMAIL || "").trim().toLowerCase() : "";

/*
 * TEMPORARY password sign-in (instead of Google), switched on when LOGIN_USERS is set.
 *   LOGIN_USERS  "email:password, email2:password2"  (split on the FIRST ":"; passwords must not contain commas)
 * Removing someone from LOGIN_USERS signs them out within a minute.
 * To go back to Google sign-in: delete LOGIN_USERS and set the Google variables.
 */
function parseLoginUsers(v) {
  const users = new Map();
  for (const entry of String(v || "").split(/[,\n]/)) {
    const i = entry.indexOf(":");
    if (i < 1) continue;
    const email = entry.slice(0, i).trim().toLowerCase();
    const password = entry.slice(i + 1).trim();
    if (email.includes("@") && password) users.set(email, password);
  }
  return users;
}
const LOGIN_USERS = parseLoginUsers(process.env.LOGIN_USERS);
const PASSWORD_MODE = LOGIN_USERS.size > 0;
const MIN_PASSWORD_LENGTH = 12;
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
function passwordMatches(email, password) {
  const expected = LOGIN_USERS.get(email);
  // compare hashes in constant time; still do the work for unknown emails
  const ok = crypto.timingSafeEqual(sha(expected === undefined ? crypto.randomBytes(16).toString("hex") : expected), sha(password));
  return ok && expected !== undefined;
}
// Simple brute-force protection: 8 failed attempts per IP or per email → wait 15 minutes.
const FAIL_LIMIT = 8, FAIL_WINDOW = 15 * 60 * 1000;
const failures = new Map();
function tooManyFailures(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > FAIL_WINDOW) { failures.delete(key); return false; }
  return f.count >= FAIL_LIMIT;
}
function recordFailure(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > FAIL_WINDOW) failures.set(key, { first: Date.now(), count: 1 });
  else f.count++;
}

function oauthClient() {
  return new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, PUBLIC_URL + "/auth/callback");
}

function domainAllowed(email) {
  const domain = email.split("@")[1] || "";
  return ALLOWED_DOMAINS.includes(domain);
}

async function upsertUser({ email, name, picture }) {
  const role = ADMIN_EMAILS.includes(email) ? "admin" : "member";
  const { rows } = await query(
    `INSERT INTO users (email, name, picture, role, last_login) VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, picture = EXCLUDED.picture, last_login = now(),
       role = CASE WHEN users.role = 'disabled' THEN 'disabled' ELSE $4 END  -- ADMIN_EMAILS is the source of truth
     RETURNING email, name, picture, role`,
    [email, name || "", picture || "", role]
  );
  return rows[0];
}

const router = express.Router();

function loginForm(error, email) {
  return page("Rise Invoices — вхід", `</p>
<form method="post" action="/auth/login" style="display:grid;gap:12px;margin-top:8px">
  ${error ? `<div style="color:#b42318">${escapeHtml(error)}</div>` : ""}
  <label>Робоча пошта<br><input name="email" type="email" required autocomplete="username" value="${escapeHtml(email || "")}" style="width:100%;padding:8px;font:inherit;box-sizing:border-box"></label>
  <label>Пароль<br><input name="password" type="password" required autocomplete="current-password" style="width:100%;padding:8px;font:inherit;box-sizing:border-box"></label>
  <button type="submit" style="padding:10px;font:inherit;cursor:pointer">Увійти</button>
</form><p>`);
}

router.get("/auth/login", (req, res) => {
  if (DEV_LOGIN_EMAIL) return res.redirect("/auth/dev");
  if (PASSWORD_MODE) {
    if (req.session && req.session.user) return res.redirect("/");
    return res.send(loginForm());
  }
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(500).send("GOOGLE_CLIENT_ID is not set.");
  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state;
  const url = oauthClient().generateAuthUrl({
    scope: ["openid", "email", "profile"],
    state,
    prompt: "select_account",
    hd: ALLOWED_DOMAINS.length === 1 ? ALLOWED_DOMAINS[0] : undefined,
  });
  res.redirect(url);
});

router.post("/auth/login", express.urlencoded({ extended: false, limit: "10kb" }), async (req, res, next) => {
  if (!PASSWORD_MODE) return res.status(404).end();
  try {
    const email = String((req.body && req.body.email) || "").trim().toLowerCase();
    const password = String((req.body && req.body.password) || "");
    const ipKey = "ip:" + req.ip, emailKey = "email:" + email;
    if (tooManyFailures(ipKey) || tooManyFailures(emailKey)) {
      return res.status(429).send(loginForm("Забагато невдалих спроб. Спробуйте через 15 хвилин.", email));
    }
    if (!passwordMatches(email, password)) {
      recordFailure(ipKey); recordFailure(emailKey);
      console.warn("password login failed for", email || "(empty)", "from", req.ip);
      return res.status(401).send(loginForm("Невірна пошта або пароль.", email));
    }
    failures.delete(emailKey);
    const user = await upsertUser({ email, name: email.split("@")[0], picture: "" });
    if (user.role === "disabled") return res.status(403).send(page("Доступ вимкнено", "Зверніться до адміністратора."));
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.user = user;
      req.session.save(() => res.redirect("/"));
    });
  } catch (e) { next(e); }
});

router.get("/auth/callback", async (req, res) => {
  if (PASSWORD_MODE) return res.redirect("/auth/login");
  try {
    if (!req.query.state || req.query.state !== req.session.oauthState) return res.status(400).send("Login expired — please try again.");
    delete req.session.oauthState;
    const client = oauthClient();
    const { tokens } = await client.getToken(String(req.query.code || ""));
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GOOGLE_CLIENT_ID });
    const p = ticket.getPayload();
    const email = String(p.email || "").toLowerCase();
    // hd = Google Workspace domain; personal Google accounts that merely use a work address have no hd
    if (!p.email_verified || !domainAllowed(email) || !p.hd || !ALLOWED_DOMAINS.includes(String(p.hd).toLowerCase())) {
      return res.status(403).send(page("Немає доступу", `Акаунт ${escapeHtml(email)} не з робочого домену. <a href="/auth/login">Увійти іншим акаунтом</a>`));
    }
    const user = await upsertUser({ email, name: p.name, picture: p.picture });
    if (user.role === "disabled") return res.status(403).send(page("Доступ вимкнено", "Зверніться до адміністратора."));
    req.session.regenerate((err) => {
      if (err) return res.status(500).send(page("Помилка входу", "Спробуйте ще раз: <a href=\"/auth/login\">увійти</a>"));
      req.session.user = user;
      req.session.save(() => res.redirect("/"));
    });
  } catch (e) {
    console.error("login failed", e);
    res.status(500).send(page("Помилка входу", "Спробуйте ще раз: <a href=\"/auth/login\">увійти</a>"));
  }
});

router.get("/auth/dev", (req, res, next) => {
  if (!DEV_LOGIN_EMAIL) return res.status(404).end();
  upsertUser({ email: DEV_LOGIN_EMAIL, name: "Dev user" }).then((user) => {
    req.session.user = user;
    res.redirect("/");
  }).catch(next);
});

router.post("/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

/** API guard: signed in, and the account is still active. */
function requireUser(req, res, next) {
  checkUser(req, res, next).catch(next);
}
async function checkUser(req, res, next) {
  const u = req.session && req.session.user;
  if (!u) return res.status(401).json({ error: "not_signed_in" });
  // re-check role at most once a minute so a disabled user is cut off quickly
  if (!req.session.checkedAt || Date.now() - req.session.checkedAt > 60000) {
    const { rows } = await query("SELECT email, name, picture, role FROM users WHERE email = $1", [u.email]);
    if (!rows[0] || rows[0].role === "disabled" || (PASSWORD_MODE && !LOGIN_USERS.has(u.email))) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: "not_signed_in" });
    }
    req.session.user = rows[0];
    req.session.checkedAt = Date.now();
  }
  req.user = req.session.user;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") return res.status(403).json({ error: "admin_only", message: "Лише для адміністраторів." });
  next();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function page(title, body) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<body style="font:16px system-ui;max-width:520px;margin:15vh auto;padding:0 16px"><h1 style="font-size:22px">${title}</h1><p>${body}</p></body>`;
}

module.exports = { router, requireUser, requireAdmin, page, IS_PROD, DEV_LOGIN_EMAIL, ALLOWED_DOMAINS, PASSWORD_MODE, LOGIN_USERS, MIN_PASSWORD_LENGTH };

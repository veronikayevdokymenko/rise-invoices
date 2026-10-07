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

router.get("/auth/login", (req, res) => {
  if (DEV_LOGIN_EMAIL) return res.redirect("/auth/dev");
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

router.get("/auth/callback", async (req, res) => {
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
    if (!rows[0] || rows[0].role === "disabled") {
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

module.exports = { router, requireUser, requireAdmin, page, IS_PROD, DEV_LOGIN_EMAIL, ALLOWED_DOMAINS };

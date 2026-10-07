"use strict";
const path = require("path");
const express = require("express");
const session = require("express-session");
const PgStore = require("connect-pg-simple")(session);
const helmet = require("helmet");
const { pool, migrate, seed } = require("./db");
const auth = require("./auth");
const api = require("./api");

const PORT = Number(process.env.PORT) || 3000;

async function main() {
  if (auth.IS_PROD) {
    const required = auth.PASSWORD_MODE
      ? ["SESSION_SECRET"]
      : ["SESSION_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "PUBLIC_URL", "ALLOWED_DOMAINS"];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length) {
      console.error("Missing environment variables:", missing.join(", "),
        auth.PASSWORD_MODE ? "" : "(or set LOGIN_USERS to use temporary password sign-in instead of Google)");
      process.exit(1);
    }
    if (auth.PASSWORD_MODE) {
      const weak = [...auth.LOGIN_USERS].filter(([, p]) => p.length < auth.MIN_PASSWORD_LENGTH).map(([e]) => e);
      if (weak.length) {
        console.error(`LOGIN_USERS: passwords must be at least ${auth.MIN_PASSWORD_LENGTH} characters. Too short for: ${weak.join(", ")}`);
        process.exit(1);
      }
      if (process.env.SESSION_SECRET.length < 32) {
        console.error("SESSION_SECRET must be at least 32 characters.");
        process.exit(1);
      }
      console.warn(`TEMPORARY password sign-in is on for ${auth.LOGIN_USERS.size} user(s): ${[...auth.LOGIN_USERS.keys()].join(", ")}`);
    }
  } else if (auth.DEV_LOGIN_EMAIL) {
    console.warn("DEV LOGIN ENABLED for " + auth.DEV_LOGIN_EMAIL + " — local testing only.");
  }
  if (!auth.IS_PROD && !process.env.SESSION_SECRET) {
    console.warn("SESSION_SECRET not set — using a temporary one (fine for local testing only).");
  }

  await migrate();
  await seed();

  const app = express();
  app.set("trust proxy", 1); // Railway sits in front of the app (HTTPS)
  app.disable("x-powered-by");

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        "font-src": ["'self'", "data:", "https://fonts.gstatic.com"],
        "img-src": ["'self'", "data:", "blob:", "https://lh3.googleusercontent.com"],
        "connect-src": ["'self'"],
        "frame-src": ["'self'", "blob:"],
        "object-src": ["'self'", "blob:"],
        "form-action": ["'self'", "https://accounts.google.com"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));

  app.get("/healthz", async (req, res) => {
    try { await pool.query("SELECT 1"); res.json({ ok: true }); } catch (e) { res.status(503).json({ ok: false }); }
  });

  // Front end + libraries served from our own domain (no CDNs).
  const nm = (p) => path.join(__dirname, "..", "node_modules", p);
  app.get("/vendor/jspdf.umd.min.js", (req, res) => res.sendFile(nm("jspdf/dist/jspdf.umd.min.js")));
  app.get("/vendor/jszip.min.js", (req, res) => res.sendFile(nm("jszip/dist/jszip.min.js")));
  app.get("/shared/calc.js", (req, res) => res.sendFile(path.join(__dirname, "..", "shared", "calc.js")));
  app.use(express.static(path.join(__dirname, "..", "public"), { maxAge: "5m", index: "index.html" }));

  app.use(session({
    store: new PgStore({ pool, tableName: "sessions", pruneSessionInterval: 3600 }),
    secret: process.env.SESSION_SECRET || require("crypto").randomBytes(32).toString("hex"),
    name: "rise_inv",
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: "lax", secure: auth.IS_PROD, maxAge: 12 * 60 * 60 * 1000 },
  }));

  app.use(auth.router);

  // Changes must come from our own page: JSON body + custom header (simple CSRF protection).
  app.use("/api", (req, res, next) => {
    if (req.method !== "GET" && req.get("X-Requested-With") !== "rise-invoices") return res.status(403).json({ error: "csrf" });
    next();
  });
  app.use("/api", express.json({ limit: "15mb" }), api.router);
  app.use("/api", (req, res) => res.status(404).json({ error: "not_found" }));

  app.listen(PORT, () => console.log(`Rise Invoices listening on :${PORT}`));
}

process.on("unhandledRejection", (e) => console.error("unhandled rejection", e));

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

-- Rise Invoices — initial schema

CREATE TABLE IF NOT EXISTS users (
  email        TEXT PRIMARY KEY,
  name         TEXT NOT NULL DEFAULT '',
  picture      TEXT NOT NULL DEFAULT '',
  role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin', 'disabled')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login   TIMESTAMPTZ
);

-- Small key/value settings: start number, payment terms, reference data overrides
CREATE TABLE IF NOT EXISTS settings (
  key          TEXT PRIMARY KEY,
  value        JSONB NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   TEXT
);

-- Countries (seeded from the VAT_RULES tab, editable by admins)
CREATE TABLE IF NOT EXISTS countries (
  code         TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  name_uk      TEXT,
  rate         NUMERIC(6,3) NOT NULL DEFAULT 0,      -- percent, e.g. 20 or 25.5
  currency     TEXT NOT NULL DEFAULT 'EUR',
  region       TEXT NOT NULL DEFAULT 'nonEU' CHECK (region IN ('EU', 'nonEU', 'UK')),
  layout       TEXT NOT NULL DEFAULT 'NO_VAT' CHECK (layout IN ('VAT', 'NO_VAT')),
  rule         TEXT NOT NULL DEFAULT '',             -- '', alert, escalate
  rate_note    TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   TEXT
);

-- One row per invoice "case" (an invoice or a credit note).
-- number is assigned by the server at first PDF generation, never by the browser.
CREATE TABLE IF NOT EXISTS invoices (
  id              BIGSERIAL PRIMARY KEY,
  number          INTEGER UNIQUE,                  -- base number (SINGLE docs are number-1, number-2 …)
  doc_type        TEXT NOT NULL DEFAULT 'invoice' CHECK (doc_type IN ('invoice', 'credit_note')),
  credit_for      TEXT,                            -- credit note → document number it corrects
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'review', 'fix', 'approved', 'sent', 'void', 'legacy')),
  legacy          BOOLEAN NOT NULL DEFAULT false,  -- imported from the Google Sheet
  current_version INTEGER NOT NULL DEFAULT 0,
  -- denormalised summary of the current version, for search and the archive list
  kind            TEXT, entity TEXT, mode TEXT, layout TEXT,
  client_name     TEXT, client_email TEXT, client_vat TEXT,
  country         TEXT, currency TEXT, channel TEXT, pay_count INTEGER,
  invoice_date    DATE,
  net             NUMERIC(14,2), vat NUMERIC(14,2), gross NUMERIC(14,2),
  vat_rule        TEXT,
  solidgate_order_id TEXT,
  void_reason     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      TEXT
);
CREATE INDEX IF NOT EXISTS invoices_email_idx   ON invoices (lower(client_email));
CREATE INDEX IF NOT EXISTS invoices_updated_idx ON invoices (updated_at DESC);
CREATE INDEX IF NOT EXISTS invoices_status_idx  ON invoices (status);

-- Every save is a new version; versions are never changed.
CREATE TABLE IF NOT EXISTS invoice_versions (
  invoice_id   BIGINT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  v            INTEGER NOT NULL,
  data         JSONB NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   TEXT,
  PRIMARY KEY (invoice_id, v)
);

-- Generated PDFs. A regenerated PDF gets a new row; the old one stays (superseded).
CREATE TABLE IF NOT EXISTS documents (
  id           BIGSERIAL PRIMARY KEY,
  invoice_id   BIGINT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  version      INTEGER,
  number       TEXT NOT NULL,                    -- 10711 or 10711-3
  doc_date     DATE,
  net          NUMERIC(14,2), vat NUMERIC(14,2), gross NUMERIC(14,2), currency TEXT,
  pdf          BYTEA,                            -- null for legacy rows
  sha256       TEXT,
  drive_file_id TEXT,                            -- legacy: Google Drive PDF id
  superseded   BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   TEXT
);
CREATE INDEX IF NOT EXISTS documents_invoice_idx ON documents (invoice_id);
CREATE INDEX IF NOT EXISTS documents_number_idx  ON documents (number);

-- Invoice log: one row per action. Append-only (enforced by trigger below).
-- The first columns mirror the INVOICE_LOG tab of the Google Sheet.
CREATE TABLE IF NOT EXISTS invoice_log (
  id              BIGSERIAL PRIMARY KEY,
  at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_email      TEXT,
  action          TEXT NOT NULL,
  invoice_id      BIGINT,
  invoice_number  TEXT,              -- document number (10711-3) or base number
  customer_name   TEXT, customer_email TEXT, country TEXT, payment_channel TEXT,
  customer_type   TEXT, pay_count INTEGER, llc TEXT, mode TEXT,
  invoice_date    DATE,
  amount          NUMERIC(14,2), vat_amount NUMERIC(14,2), total NUMERIC(14,2),
  currency        TEXT, vat_rule TEXT, client_vat TEXT,
  details         JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS invoice_log_at_idx     ON invoice_log (at DESC);
CREATE INDEX IF NOT EXISTS invoice_log_number_idx ON invoice_log (invoice_number);
CREATE INDEX IF NOT EXISTS invoice_log_invoice_idx ON invoice_log (invoice_id);

CREATE OR REPLACE FUNCTION invoice_log_readonly() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'invoice_log is append-only';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS invoice_log_no_update ON invoice_log;
CREATE TRIGGER invoice_log_no_update BEFORE UPDATE OR DELETE ON invoice_log
  FOR EACH ROW EXECUTE FUNCTION invoice_log_readonly();

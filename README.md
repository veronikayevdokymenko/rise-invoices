# Rise Invoices

The web version of the **INVOICE 2.0** Google Sheet. It provides an invoice editor, a shared archive, an invoice log and credit notes, protected by Google sign-in.
It runs on Railway (Node.js + PostgreSQL).

## What's inside

| Folder | What it is |
|---|---|
| `server/` | The backend: sign-in, API, invoice numbering, VIES check, Google-Sheet import |
| `shared/calc.js` | **All business rules** (VAT, notes, seller tax IDs, SINGLE/MULTI, credit notes). The browser and server use the same file |
| `public/` | The interface (Ukrainian), PDF layout, fonts |
| `migrations/` | Database tables. They are created automatically on start |
| `data/reference.json` | Countries, legal entities, payment channels and texts, taken from the sheet |
| `test/` | Automated checks (`npm test`) |

## How it behaves, compared to the sheet

- **Numbers** are given by the server **at the first PDF generation**, so abandoned drafts don't burn numbers. SINGLE series get `10712-1`, `10712-2`, and so on, like in the sheet.
- **Every save is a version**, and old versions can be opened.
- **Changing an approved or sent invoice** asks for a reason and sends the invoice back to "Draft" for a new legal approval.
- **Issued invoices are never deleted.**
  - To cancel one, use **Анулювати** (void). The number stays used and the reason is logged.
  - When money was refunded, make a **Кредит-нота** (credit note) from a document in the archive. It gets its own number, the title "Credit Note for Invoice X", negative amounts, and the same VAT rate as the original.
  - Drafts without a number can be deleted.
- **The tax rate is frozen into each saved version.** If an admin changes a country's rate later, documents already issued don't change.
- **The invoice log** records every action: who, when, the number, the amounts, and the same columns as INVOICE_LOG. It cannot be edited or deleted, even from the database. You can export it to CSV from the "Лог" tab.
- **PDFs are stored in the database**, so you can download any of them again from the archive. Invoices imported from the sheet link to their Google Drive PDFs.
- **The VIES check** works like in the sheet ("Перевірити VIES" button). Notion, UK VAT and AU ABN links are under "Посилання".

---

## Deploy (stages 3–4)

### 1. Put the code on GitHub

1. github.com → **New repository** → name it `rise-invoices` → **Private** → Create.
2. On the empty repo page, click **uploading an existing file**.
3. Drag in **everything from this folder** (not the folder itself) → **Commit changes**.
   - Hidden files like `.gitignore` and `.env.example` may not show in Finder/Explorer. That's fine, they are optional.

### 2. Create the Railway project

1. railway.app → **New Project** → **Deploy from GitHub repo** → pick `rise-invoices`.
   - The first deploy will fail with "DATABASE_URL is not set". That's expected.
2. In the project: **+ Create** (or **+ New**) → **Database** → **PostgreSQL**.
3. Click the `rise-invoices` service → **Settings** → **Networking** → **Generate Domain**.
   - Copy the address, e.g. `https://rise-invoices-production.up.railway.app`.

### 3. Create the Google sign-in key

In console.cloud.google.com, in the `rise-invoices` project from stage 1:

1. **APIs & Services → Credentials → + Create credentials → OAuth client ID**.
2. Application type: **Web application**. Name: `Rise Invoices`.
3. **Authorized redirect URIs → + Add URI**: your Railway address + `/auth/callback`
   - e.g. `https://rise-invoices-production.up.railway.app/auth/callback`
4. **Create**, then copy the **Client ID** and **Client secret**.

### 4. Add the variables in Railway

Click the `rise-invoices` service → **Variables** → **+ New Variable** for each:

| Name | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}`. Railway suggests it as you type. |
| `NODE_ENV` | `production` |
| `PUBLIC_URL` | the Railway address, **without** a trailing `/` |
| `GOOGLE_CLIENT_ID` | from step 3 |
| `GOOGLE_CLIENT_SECRET` | from step 3 |
| `SESSION_SECRET` | any long random string (40+ characters, e.g. from a password generator) |
| `ALLOWED_DOMAINS` | your Google Workspace domain, e.g. `skelar.tech` (comma-separated if several) |
| `ADMIN_EMAILS` | who can change settings, the country table and import: e.g. `nika@skelar.tech` |

Railway redeploys automatically. Open the address and sign in with your work account.

### 5. Import the Google Sheet history

1. In INVOICE 2.0, open the **INVOICE_LOG** tab → **File → Download → Comma-separated values (.csv)**.
2. In the app: **Налаштування → Імпорт з Google-таблиці** → choose the file → **Імпортувати**.
3. The result shows how many rows came in and the number the app will continue from.
   - It is the last sheet number + 1.
   - Importing the same file again is safe: rows that are already in are skipped.

### 6. Going live (avoid double numbering)

While testing, the sheet and the app give out numbers independently. Before real use:

1. **Delete the test data.** Pick one:
   - Railway → Postgres → **Database** tab (or "Data"), run:
     ```sql
     TRUNCATE invoice_log, documents, invoice_versions, invoices RESTART IDENTITY;
     ```
   - Or delete the Postgres service, add a new one, and set `DATABASE_URL` again.
2. Stop creating invoices in the sheet.
3. Import the final INVOICE_LOG CSV (step 5) and check the "starts from" number.
4. From now on, invoices are made only in the app.

---

## Run on your own computer (optional)

You need Node.js 20+ and PostgreSQL.

```bash
npm install
cp .env.example .env        # fill in DATABASE_URL; for a quick test also ENABLE_DEV_LOGIN=true
npm run dev                 # http://localhost:3000
TEST_URL=http://localhost:3000 npm test
```

## Please double-check with legal / the sheet

- **UK VAT numbers** of the legal entities. The `Invoice` tab prints `GB465794147` / `GB497179039`, but the `storage` and `Credit Note` tabs show them without `GB`. The app uses the `Invoice` tab version.
- **LLC_RULES** only has the PayPal column filled in (PayPal → Celeb). All other channels are a manual choice, as in the sheet.
- **Rates that differ between the sheet and the old HTML tool:** Brazil, Iceland, Switzerland.
  - All three are "no VAT" countries, so the rate isn't printed.
  - The sheet values were used.
- **Country warnings** came from the HTML tool: USA "Alert", Australia and Brazil "case-by-case". Edit them in Налаштування → Країни.

## Next stage: Solidgate

`payment.solidgateOrderId` is already stored and searchable. Stage 6 adds a server-side lookup that fills the amount, date, currency, card brand/last 4 and status from Solidgate.
The secret key will live only in Railway variables (`SOLIDGATE_PUBLIC_KEY`, `SOLIDGATE_SECRET_KEY`).

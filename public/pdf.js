/*
 * Invoice layout engine — one layout feeds both the on-screen preview (SVG) and the PDF (jsPDF),
 * so what you see is exactly what gets generated. Ported from the "Rise Invoices" tool and
 * extended with the Google Sheet rules (per-country tax ID, GST labels, credit notes).
 */
(function () {
  "use strict";
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const fmtLong = (iso) => { if (!iso) return ""; const [y, m, d] = iso.split("-"); return String(+d).padStart(2, "0") + " " + MONTHS[+m - 1] + " " + y; };
  const fmtShort = (iso) => { if (!iso) return ""; const [y, m, d] = iso.split("-"); return d + "." + m + "." + y; };
  const money = (n) => (Math.round(n * 100) / 100).toFixed(2);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let mdoc = null;
  function newDoc() {
    const { jsPDF } = window.jspdf;
    const d = new jsPDF({ unit: "pt", format: "a4", compress: true });
    d.addFileToVFS("R.ttf", window.INVOICE_FONTS.reg); d.addFont("R.ttf", "IS", "normal");
    d.addFileToVFS("B.ttf", window.INVOICE_FONTS.bold); d.addFont("B.ttf", "IS", "bold");
    d.setFont("IS", "normal");
    return d;
  }
  function wrapText(str, size, bold, width) {
    if (!mdoc) mdoc = newDoc();
    mdoc.setFont("IS", bold ? "bold" : "normal"); mdoc.setFontSize(size);
    return mdoc.splitTextToSize(String(str || ""), width);
  }

  /**
   * D = one document from InvoiceCalc.documents().
   * Everything must fit on ONE page: if the natural layout spills over (many payments), the table
   * rows and the gaps are compressed step by step until the totals, note and payment terms fit.
   */
  function layout(D) {
    for (let k = 1; k >= 0.55; k = Math.round((k - 0.05) * 100) / 100) {
      const pages = layoutAt(D, k);
      if (pages.length === 1) return pages;
    }
    return layoutAt(D, 0.55);
  }

  function layoutAt(D, k) {
    const tight = k < 1;
    const t = D.tax;
    const pages = [[]]; let P = pages[0];
    const T = (x, y, str, o = {}) => P.push({ t: "text", x, y, str: String(str), size: o.size || 9.5, bold: !!o.bold, align: o.align || "left", color: o.color || "#000000" });
    const R = (x, y, w, h, o = {}) => P.push({ t: "rect", x, y, w, h, fill: o.fill || null, stroke: o.stroke || null, lw: o.lw || 0.5 });
    const L = (x1, y1, x2, y2, lw = 0.5) => P.push({ t: "line", x1, y1, x2, y2, lw });
    const newPage = () => { P = []; pages.push(P); };
    const E = D.entity;

    // logo (image from logo.js; falls back to the old drawn mark if it is missing)
    if (window.INVOICE_LOGO) P.push({ t: "img", x: 52, y: 71, w: 37, h: 37 });
    else {
      R(52, 71, 37, 37, { fill: "#111111" });
      T(70.5, 93, ".RiSE", { size: 10.5, bold: true, align: "center", color: "#FFFFFF" });
    }

    // seller block (Invoice!B7:B12)
    const sl = [[E.name, 1], ["Address:", 1], ...E.address.map((a) => [a, 0])];
    if (t.sellerTaxId) sl.push([t.sellerTaxId, 1]);
    const y0 = 121, lh = 11.3;
    sl.forEach((l, i) => T(52, y0 + i * lh, l[0], { bold: !!l[1] }));

    // title / number / date (Invoice!G10:H12)
    const b = Math.max(0, sl.length - 3);
    if (t.credit) {
      T(545, y0 + (b - 1) * lh, "Credit Note", { bold: true, align: "right", size: 11 });
      T(545, y0 + b * lh, "for Invoice " + (D.creditFor || ""), { align: "right" });
    } else {
      T(422, y0 + b * lh, t.title, { bold: true });
    }
    T(422, y0 + (b + 1) * lh, "Number:", { bold: true }); T(545, y0 + (b + 1) * lh, D.number, { align: "right" });
    T(422, y0 + (b + 2) * lh, "Date:", { bold: true }); T(545, y0 + (b + 2) * lh, fmtShort(D.date), { align: "right" });

    // bill to
    T(52, 257, "BILL TO", { bold: true });
    const y = 284; const bl = [];
    if (D.client.name) bl.push([D.client.name, 1]);
    if (D.client.email) bl.push([D.client.email, 1]);
    if (D.client.address) String(D.client.address).split("\n").forEach((p) => wrapText(p, 9.5, false, 430).forEach((s) => bl.push([s, 0])));
    if (D.client.vat) bl.push([(/^(VAT|ABN|GST|ARN|Tax)/i.test(D.client.vat) ? "" : "VAT: ") + D.client.vat, 1]);
    bl.forEach((l, i) => T(52, y + i * 11.5, l[0], { bold: !!l[1] }));
    const lastBill = y + Math.max(0, bl.length - 1) * 11.5;

    // table
    const xs = t.novat ? [50, 72.5, 218.6, 258.7, 354.5, 440] : [50, 72.5, 218.6, 258.7, 354.5, 419.2, 469.6, 547.2];
    const split2 = (s) => { const i = s.indexOf(", "); return i < 0 ? [s] : [s.slice(0, i + 1), s.slice(i + 2)]; };
    const splitGross = (s) => { const m = s.match(/^(Amount \(inc\.)\s(.*)$/); return m ? [m[1], m[2]] : [s]; };
    const heads = t.novat
      ? [["#"], ["Item & Description"], ["QTY"], ["Date"], split2(t.heads.total)]
      : [["#"], ["Item & Description"], ["QTY"], ["Date"], split2(t.heads.amount), [t.heads.tax], splitGross(t.heads.gross)];
    const W = xs.at(-1) - xs[0];
    const header = (top) => {
      R(xs[0], top, W, 39, { fill: "#EFE7E5" });
      xs.forEach((x) => L(x, top, x, top + 39)); L(xs[0], top, xs.at(-1), top); L(xs[0], top + 39, xs.at(-1), top + 39);
      heads.forEach((h, i) => { const cx = (xs[i] + xs[i + 1]) / 2; h.forEach((s, k) => T(cx, top + 35 - (h.length - 1 - k) * 10, s, { bold: true, size: 8.8, align: "center" })); });
      return top + 39;
    };
    let yy = header(tight ? lastBill + 26 : Math.max(352, lastBill + 35));
    const RL = 9.8 * k, FS = Math.max(6, 8.5 * k), PAD = 4 * k;
    D.lines.forEach((l, i) => {
      const dl = []; String(l.desc || "").split("\n").forEach((p) => wrapText(p, FS, false, xs[2] - xs[1] - 6).forEach((s) => dl.push(s)));
      const h = Math.max(1, dl.length) * RL + PAD;
      if (yy + h > 790) { newPage(); yy = header(60); }
      xs.forEach((x) => L(x, yy, x, yy + h)); L(xs[0], yy + h, xs.at(-1), yy + h);
      const base = yy + h - 3 * k, cx = (k) => (xs[k] + xs[k + 1]) / 2;
      T(cx(0), base, String(i + 1), { bold: true, size: FS, align: "center" });
      dl.forEach((s, k) => T(cx(1), base - (dl.length - 1 - k) * RL, s, { size: FS, align: "center" }));
      T(cx(2), base, "1", { size: FS, align: "center" });
      T(cx(3), base, fmtLong(l.date), { size: FS, align: "center" });
      if (t.novat) T(cx(4), base, money(l.gross), { size: FS, align: "center" });
      else {
        T(cx(4), base, money(l.net), { size: FS, align: "center" });
        T(cx(5), base, money(l.vat), { size: FS, align: "center" });
        T(cx(6), base, money(l.gross), { size: FS, align: "center" });
      }
      yy += h;
    });

    // totals
    if (t.novat) {
      if (yy + 39 + 14 > 800) { newPage(); yy = 60; } else yy += 39;
      L(xs[3], yy, xs[5], yy, 0.9);
      T(xs[3] + 3, yy + 9.8, "TOTAL", { bold: true, size: 10 });
      T((xs[4] + xs[5]) / 2, yy + 9.8, money(D.gross), { bold: true, size: 10, align: "center" });
      yy += 13; L(xs[3], yy, xs[5], yy, 0.9);
    } else {
      if (!tight && yy + 47 + 33 <= 805) yy += 47; else if (yy + 18 + 33 <= 812) yy += 18; else { newPage(); yy = 60; }
      const x0 = 354.5, x1 = 547.2, cv = 508.4;
      const rate = (Math.round(t.rate * 1000) / 1000) + "%";
      const rows = [["SUBTOTAL", null, D.net], [t.taxLabel, rate, D.vat], [t.totalLabel, null, D.gross]];
      L(x0, yy, x1, yy, 0.9);
      rows.forEach((r) => {
        T(357, yy + 8.6, r[0], { bold: true });
        if (r[1]) T(467, yy + 8.6, r[1], { bold: true, align: "right" });
        T(cv, yy + 8.6, money(r[2]), { bold: true, align: "center" });
        yy += 11; L(x0, yy, x1, yy, 0.9);
      });
    }

    // note + payment terms
    const note = t.note;
    const termLines = String(D.terms || "").split("\n").flatMap((p) => wrapText(p, 8, false, 495));
    const noteLines = note ? wrapText(note, note.length > 80 ? 7 : 8, false, 495) : [];
    let ny = tight ? yy + 24 : Math.max(yy + 90, 620);
    let fy = noteLines.length ? ny + (noteLines.length - 1) * 10 + (tight ? 18 : 31) : tight ? yy + 30 : Math.max(yy + 110, 648);
    if (fy + termLines.length * 10 > 815) { newPage(); ny = 80; fy = noteLines.length ? ny + (noteLines.length - 1) * 10 + 31 : 80; }
    noteLines.forEach((s, k) => T(52, ny + k * 10, s, { size: note.length > 80 ? 7 : 8 }));
    termLines.forEach((s, k) => T(52, fy + k * 10, s, { size: 8 }));
    return pages;
  }

  function toSVG(ops) {
    let s = '<svg viewBox="0 0 595.28 841.89" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Попередній перегляд документа"><rect width="595.28" height="841.89" fill="#fff"/>';
    for (const o of ops) {
      if (o.t === "rect") s += `<rect x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" fill="${o.fill || "none"}" ${o.stroke ? `stroke="${o.stroke}" stroke-width="${o.lw}"` : ""}/>`;
      else if (o.t === "img") s += `<image href="${window.INVOICE_LOGO}" x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}"/>`;
      else if (o.t === "line") s += `<line x1="${o.x1}" y1="${o.y1}" x2="${o.x2}" y2="${o.y2}" stroke="#000" stroke-width="${o.lw}"/>`;
      else s += `<text x="${o.x}" y="${o.y}" font-family="InvoiceSans, Arial, sans-serif" font-size="${o.size}" font-weight="${o.bold ? 700 : 400}" fill="${o.color}" text-anchor="${o.align === "center" ? "middle" : o.align === "right" ? "end" : "start"}" xml:space="preserve">${esc(o.str)}</text>`;
    }
    return s + "</svg>";
  }

  function toPDF(pages, title) {
    const d = newDoc();
    pages.forEach((ops, i) => {
      if (i) d.addPage();
      for (const o of ops) {
        if (o.t === "rect") {
          if (o.fill) d.setFillColor(o.fill);
          if (o.stroke) { d.setDrawColor(o.stroke); d.setLineWidth(o.lw); }
          d.rect(o.x, o.y, o.w, o.h, o.fill && o.stroke ? "FD" : o.fill ? "F" : "S");
        } else if (o.t === "img") { d.addImage(window.INVOICE_LOGO, "JPEG", o.x, o.y, o.w, o.h); }
        else if (o.t === "line") { d.setDrawColor("#000000"); d.setLineWidth(o.lw); d.line(o.x1, o.y1, o.x2, o.y2); }
        else { d.setFont("IS", o.bold ? "bold" : "normal"); d.setFontSize(o.size); d.setTextColor(o.color); d.text(o.str, o.x, o.y, { align: o.align }); }
      }
    });
    d.setProperties({ title: title || "Invoice" });
    return d.output("blob");
  }

  window.InvoicePDF = { layout, toSVG, toPDF, fmtLong, fmtShort, money, esc };
})();

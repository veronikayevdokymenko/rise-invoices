"use strict";
/* EU VAT number check through the European Commission VIES SOAP service
 * (ported from ValidateEuVatFromSetup in the Google Sheet script). */

const EU3 = {
  AUT: "AT", BEL: "BE", BGR: "BG", HRV: "HR", CYP: "CY", CZE: "CZ", DNK: "DK", EST: "EE", FIN: "FI", FRA: "FR",
  DEU: "DE", GRC: "EL", HUN: "HU", IRL: "IE", ITA: "IT", LVA: "LV", LTU: "LT", LUX: "LU", MLT: "MT", NLD: "NL",
  POL: "PL", PRT: "PT", ROU: "RO", SVK: "SK", SVN: "SI", ESP: "ES", SWE: "SE",
};
const EU2 = new Set(Object.values(EU3).concat(["GR"]));

function parseVat(vatInput, country) {
  const raw = String(vatInput || "").toUpperCase().replace(/[\s.\-_/]/g, "");
  if (/^[A-Z]{2}/.test(raw) && EU2.has(raw.slice(0, 2))) {
    const cc = raw.slice(0, 2) === "GR" ? "EL" : raw.slice(0, 2);
    return { countryCode: cc, vatNumber: raw.slice(2) };
  }
  return { countryCode: EU3[String(country || "").toUpperCase()] || "", vatNumber: raw };
}

const tag = (xml, name) => {
  const m = String(xml || "").match(new RegExp("<(?:\\w+:)?" + name + ">([\\s\\S]*?)<\\/(?:\\w+:)?" + name + ">", "i"));
  return m ? m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&") : "";
};
const clean = (s) => { s = String(s || "").trim(); return !s || s === "---" ? "" : s.replace(/\s+/g, " "); };
const xmlEsc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));

async function checkVat(vatInput, country) {
  if (!String(vatInput || "").trim()) throw new Error("VAT-номер порожній.");
  const p = parseVat(vatInput, country);
  if (!p.countryCode || !p.vatNumber) throw new Error("Невірний формат або країна не з ЄС.");
  const body =
    '<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:ec.europa.eu:taxud:vies:services:checkVat:types">' +
    "<soapenv:Header/><soapenv:Body><urn:checkVat><urn:countryCode>" + xmlEsc(p.countryCode) + "</urn:countryCode><urn:vatNumber>" +
    xmlEsc(p.vatNumber) + "</urn:vatNumber></urn:checkVat></soapenv:Body></soapenv:Envelope>";
  const res = await fetch("https://ec.europa.eu/taxation_customs/vies/services/checkVatService", {
    method: "POST", headers: { "Content-Type": "text/xml; charset=utf-8" }, body, signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  const fault = tag(text, "faultstring");
  if (res.status !== 200 || !tag(text, "valid")) {
    if (fault.includes("MS_MAX_CONCURRENT_REQ") || fault.includes("GLOBAL_MAX_CONCURRENT_REQ") || fault.includes("MS_UNAVAILABLE"))
      throw new Error("VIES зараз перевантажений — спробуйте пізніше.");
    throw new Error(fault || "VIES HTTP " + res.status);
  }
  return {
    valid: tag(text, "valid").toLowerCase() === "true",
    countryCode: tag(text, "countryCode") || p.countryCode,
    vatNumber: tag(text, "vatNumber") || p.vatNumber,
    name: clean(tag(text, "name")),
    address: clean(tag(text, "address")),
    checkedAt: new Date().toISOString(),
  };
}

module.exports = { checkVat, parseVat };

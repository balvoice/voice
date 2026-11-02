/* BalVoice — minimal Excel (.xlsx) reader.
 *
 * Reads the first worksheet of an .xlsx file into an array of rows (arrays of
 * strings), in the browser, with no third-party library. Supports shared
 * strings, inline strings, numbers, and booleans — enough for contact lists.
 *
 * An .xlsx file is a ZIP archive of XML files. This reader:
 *   1. finds the ZIP central directory and lists the entries,
 *   2. inflates the entries it needs with the browser's DecompressionStream,
 *   3. resolves the first sheet via xl/workbook.xml and its relationships,
 *   4. parses xl/sharedStrings.xml and the sheet XML with DOMParser.
 *
 * Safety limits guard against oversized or malicious files (zip bombs).
 *
 *   BalVoiceXLSX.readRows(file) -> Promise<string[][]>
 *   BalVoiceXLSX.supported      -> boolean
 */
(function () {
  "use strict";

  const MAX_ENTRY_BYTES = 40 * 1024 * 1024; // uncompressed size limit per XML part
  const MAX_ROWS = 50000;
  const MAX_COLS = 50;
  const supported = typeof DecompressionStream === "function" && typeof DOMParser === "function";

  function fail(msg) { const e = new Error(msg); e.userMessage = msg; throw e; }

  /* ZIP --------------------------------------------------------------------- */
  function listEntries(buf) {
    const view = new DataView(buf);
    // End of central directory record: signature 0x06054b50, within the last 64 KB.
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) fail("This file is not a valid Excel workbook. Save it again as .xlsx or CSV.");
    const count = view.getUint16(eocd + 10, true);
    let p = view.getUint32(eocd + 16, true);
    const entries = {};
    const dec = new TextDecoder();
    for (let n = 0; n < count; n++) {
      if (p + 46 > buf.byteLength || view.getUint32(p, true) !== 0x02014b50) fail("This workbook appears to be damaged.");
      const method = view.getUint16(p + 10, true);
      const csize = view.getUint32(p + 20, true);
      const usize = view.getUint32(p + 24, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const offset = view.getUint32(p + 42, true);
      const name = dec.decode(new Uint8Array(buf, p + 46, nameLen));
      entries[name] = { method, csize, usize, offset };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  async function readEntry(buf, entries, name) {
    const e = entries[name];
    if (!e) return null;
    if (e.usize > MAX_ENTRY_BYTES) fail("This workbook is too large to process. Split it into smaller files.");
    const view = new DataView(buf);
    if (view.getUint32(e.offset, true) !== 0x04034b50) fail("This workbook appears to be damaged.");
    const start = e.offset + 30 + view.getUint16(e.offset + 26, true) + view.getUint16(e.offset + 28, true);
    const data = new Uint8Array(buf, start, e.csize);
    let bytes;
    if (e.method === 0) bytes = data;
    else if (e.method === 8) {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      const reader = stream.getReader();
      const chunks = []; let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_ENTRY_BYTES) { reader.cancel(); fail("This workbook is too large to process. Split it into smaller files."); }
        chunks.push(value);
      }
      bytes = new Uint8Array(total);
      let o = 0; chunks.forEach(c => { bytes.set(c, o); o += c.length; });
    } else fail("This workbook uses an unsupported compression format. Save it again as .xlsx or CSV.");
    return new TextDecoder().decode(bytes);
  }

  /* XML helpers ------------------------------------------------------------- */
  function parseXML(text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) fail("This workbook appears to be damaged.");
    return doc;
  }
  // Namespace-agnostic element lookup (sheets use the spreadsheetml namespace).
  const byTag = (node, tag) => node.getElementsByTagNameNS("*", tag);
  const textOf = el => {
    // Rich text runs: concatenate every <t>, skipping phonetic <rPh> runs.
    let s = "";
    const ts = byTag(el, "t");
    for (let i = 0; i < ts.length; i++) {
      if (ts[i].parentNode && ts[i].parentNode.localName === "rPh") continue;
      s += ts[i].textContent;
    }
    return s;
  };
  function colIndex(ref) {
    const m = /^([A-Z]+)/.exec(ref || "");
    if (!m) return -1;
    let n = 0;
    for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }
  function numberToText(v) {
    const n = Number(v);
    if (!isFinite(n)) return v;
    // Whole numbers (such as phone numbers stored as numbers) without exponent or decimals.
    if (Number.isInteger(n) || Math.abs(n) >= 1e9) return BigInt(Math.round(n)).toString();
    return String(n);
  }

  /* Workbook ---------------------------------------------------------------- */
  function firstSheetPath(workbookXML, relsXML) {
    const fallback = "xl/worksheets/sheet1.xml";
    if (!workbookXML || !relsXML) return fallback;
    const sheet = byTag(parseXML(workbookXML), "sheet")[0];
    if (!sheet) return fallback;
    const rid = sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") || sheet.getAttribute("r:id");
    const rels = parseXML(relsXML).getElementsByTagName("Relationship");
    for (let i = 0; i < rels.length; i++) {
      if (rels[i].getAttribute("Id") === rid) {
        let target = rels[i].getAttribute("Target") || "";
        target = target.replace(/^\//, "");
        return target.indexOf("xl/") === 0 ? target : "xl/" + target.replace(/^\.\//, "");
      }
    }
    return fallback;
  }

  async function readRows(file) {
    if (!supported) fail("This browser cannot read Excel files. Please save the file as CSV, or use a recent version of Chrome, Edge, Firefox, or Safari.");
    const buf = await file.arrayBuffer();
    const head = new Uint8Array(buf, 0, Math.min(8, buf.byteLength));
    if (head[0] === 0xD0 && head[1] === 0xCF) fail("Older .xls files are not supported. Open the file in Excel and save it as .xlsx or CSV.");
    if (!(head[0] === 0x50 && head[1] === 0x4B)) fail("This file is not a valid Excel workbook. Save it again as .xlsx or CSV.");

    const entries = listEntries(buf);
    if (!entries["xl/workbook.xml"]) fail("This file is not an Excel workbook. Save it again as .xlsx or CSV.");
    const [wb, rels, ss] = await Promise.all([
      readEntry(buf, entries, "xl/workbook.xml"),
      readEntry(buf, entries, "xl/_rels/workbook.xml.rels"),
      readEntry(buf, entries, "xl/sharedStrings.xml")
    ]);
    const sheetXML = await readEntry(buf, entries, firstSheetPath(wb, rels));
    if (!sheetXML) fail("The first worksheet in this workbook could not be found.");

    const shared = [];
    if (ss) {
      const sis = byTag(parseXML(ss), "si");
      for (let i = 0; i < sis.length; i++) shared.push(textOf(sis[i]));
    }

    const rows = [];
    const rowEls = byTag(parseXML(sheetXML), "row");
    for (let r = 0; r < rowEls.length && rows.length < MAX_ROWS; r++) {
      const out = [];
      const cells = byTag(rowEls[r], "c");
      for (let c = 0; c < cells.length; c++) {
        const cell = cells[c];
        let idx = colIndex(cell.getAttribute("r"));
        if (idx < 0) idx = out.length;
        if (idx >= MAX_COLS) continue;
        const type = cell.getAttribute("t");
        const vEl = byTag(cell, "v")[0];
        const v = vEl ? vEl.textContent : "";
        let value = "";
        if (type === "s") value = shared[parseInt(v, 10)] || "";
        else if (type === "inlineStr") value = textOf(cell);
        else if (type === "b") value = v === "1" ? "TRUE" : "FALSE";
        else if (type === "str" || type === "e") value = v;
        else value = v === "" ? "" : numberToText(v);
        while (out.length < idx) out.push("");
        out[idx] = String(value).trim();
      }
      if (out.some(x => x !== "")) rows.push(out);
    }
    return rows;
  }

  window.BalVoiceXLSX = { readRows, supported };
})();

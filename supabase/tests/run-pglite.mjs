// Runs SQL files on PGlite statement by statement and prints each result row.
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import fs from "fs";

function split(sql) {
  const out = []; let cur = "", i = 0, dollar = null, q = false, line = false, block = 0;
  while (i < sql.length) {
    const ch = sql[i], two = sql.slice(i, i + 2);
    if (line) { cur += ch; if (ch === "\n") line = false; i++; continue; }
    if (block) { cur += ch; if (two === "*/") { cur += "/"; i += 2; block = 0; continue; } i++; continue; }
    if (dollar) { if (sql.startsWith(dollar, i)) { cur += dollar; i += dollar.length; dollar = null; continue; } cur += ch; i++; continue; }
    if (q) { cur += ch; if (ch === "'") q = false; i++; continue; }
    if (two === "--") { line = true; cur += ch; i++; continue; }
    if (two === "/*") { block = 1; cur += two; i += 2; continue; }
    if (ch === "'") { q = true; cur += ch; i++; continue; }
    if (ch === "$") { const m = sql.slice(i).match(/^\$[A-Za-z_]*\$/); if (m) { dollar = m[0]; cur += dollar; i += dollar.length; continue; } }
    if (ch === ";") { if (cur.trim()) out.push(cur); cur = ""; i++; continue; }
    cur += ch; i++;
  }
  if (cur.trim()) out.push(cur);
  return out.filter(s => s.replace(/--.*$/gm, "").trim());
}

const db = new PGlite({ extensions: { pgcrypto } });
let fails = 0;
for (const f of process.argv.slice(2)) {
  const verbose = /test/.test(f);
  for (const stmt of split(fs.readFileSync(f, "utf8"))) {
    try {
      const res = await db.query(stmt);
      if (verbose) for (const row of res.rows) {
        const v = Object.values(row).map(x => x === null ? "" : String(x)).join("|");
        if (v && /^(ok|FAIL)/.test(v)) { console.log(v); if (v.startsWith("FAIL")) fails++; }
      }
    } catch (e) {
      console.log("ERROR in " + f.split("/").pop() + ": " + e.message + "\n  at: " + stmt.trim().slice(0, 160));
      try { await db.query("rollback"); } catch (_) {}
      fails++;
      if (!verbose) process.exit(1);
    }
  }
}
console.log(fails ? fails + " problem(s)" : "all passed");
process.exit(fails ? 1 : 0);

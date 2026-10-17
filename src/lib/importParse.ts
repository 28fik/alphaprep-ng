// Browser-side readers for question imports. Pure functions with no imports so they can be tested in Node.
// They only EXTRACT text. Validation, duplicate detection and saving happen on the server.

export interface RawQuestion {
  subject?: string;
  topic?: string;
  year?: string;
  question?: string;
  option_a?: string;
  option_b?: string;
  option_c?: string;
  option_d?: string;
  answer?: string;
  explanation?: string;
  source?: string;
  low_confidence?: boolean;
}

// ---- CSV (RFC 4180: quotes, escaped quotes, commas and newlines inside quotes) ----------------
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") inQuotes = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

const HEADER_ALIASES: Record<string, keyof RawQuestion> = {
  subject: "subject", topic: "topic", year: "year", examyear: "year",
  question: "question", questiontext: "question", q: "question",
  optiona: "option_a", a: "option_a", optionb: "option_b", b: "option_b", optionc: "option_c", c: "option_c", optiond: "option_d", d: "option_d",
  answer: "answer", correct: "answer", correctoption: "answer", correctanswer: "answer", ans: "answer", key: "answer",
  explanation: "explanation", solution: "explanation", source: "source",
};

/** Turn a table (first row = headers) into question rows. Unknown columns are ignored. */
export function rowsFromTable(table: string[][]): { rows: RawQuestion[]; unknownColumns: string[]; missingColumns: string[] } {
  if (table.length === 0) return { rows: [], unknownColumns: [], missingColumns: ["question"] };
  const map: (keyof RawQuestion | null)[] = table[0].map((h) => HEADER_ALIASES[h.toLowerCase().replace(/[^a-z]/g, "")] ?? null);
  const unknownColumns = table[0].filter((_, i) => !map[i] && table[0][i].trim() !== "");
  const have = new Set(map.filter(Boolean));
  const missingColumns = (["question", "option_a", "option_b", "option_c", "option_d"] as const).filter((k) => !have.has(k));
  const rows = table.slice(1).map((cells) => {
    const r: RawQuestion = {};
    cells.forEach((v, i) => { const k = map[i]; if (k && k !== "low_confidence") r[k] = v; });
    return r;
  });
  return { rows, unknownColumns, missingColumns };
}

// ---- pasted / extracted plain text ----------------------------------------------------------------
const Q_START = /^\s*(?:q(?:uestion)?\.?\s*)?(\d{1,4})\s*[.):\-]\s+(\S.*)$/i;
const OPT = /^\s*\(?([A-Da-d])\s*[.):]\s*(.*)$/;
const ANS = /^\s*(?:the\s+)?(?:correct\s+)?(?:answer|ans)\s*(?:is)?\s*[:=.\-)]*\s*\(?([A-Da-d])\)?(?![A-Za-z])/i;
const EXPL = /^\s*(?:explanation|solution|reason)\s*[:\-]\s*(.*)$/i;
const KEY_HEAD = /^\s*(?:answers?|answer\s*key|key)\s*[:\-]?\s*$/i;

interface Draft { number: number; text: string; opts: string[]; answer?: string; explanation: string; inExpl: boolean }

/** Parses "1. Question / A. ... D. ... / Answer: B". An optional answer key list at the end ("1.B 2.C") is applied by number. */
export function parsePastedText(input: string, defaults: { subject?: string; topic?: string; year?: string; source?: string } = {}): { rows: RawQuestion[]; notes: string[] } {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const drafts: Draft[] = [];
  let cur: Draft | null = null;
  const notes: string[] = [];
  let keyStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (KEY_HEAD.test(line) && drafts.length > 0) { keyStart = i + 1; break; }
    const q = Q_START.exec(line);
    const startsNew = q && (!cur || cur.opts.length > 0 || cur.answer !== undefined);
    if (startsNew && q) {
      cur = { number: Number(q[1]), text: q[2].trim(), opts: [], explanation: "", inExpl: false };
      drafts.push(cur);
      continue;
    }
    if (!cur) continue; // text before the first question (titles, instructions) is ignored
    const a = ANS.exec(line);
    if (a && cur.opts.length >= 2) { cur.answer = a[1].toUpperCase(); cur.inExpl = false; continue; }
    const ex = EXPL.exec(line);
    if (ex) { cur.explanation = ex[1].trim(); cur.inExpl = true; continue; }
    const o = OPT.exec(line);
    if (o && !cur.inExpl && o[1].toUpperCase() === "ABCD"[cur.opts.length]) { cur.opts.push(o[2].trim()); continue; }
    // continuation line
    const t = line.trim();
    if (cur.inExpl) cur.explanation += " " + t;
    else if (cur.opts.length > 0) cur.opts[cur.opts.length - 1] += " " + t;
    else cur.text += " " + t;
  }

  if (keyStart >= 0) {
    const keyText = lines.slice(keyStart).join(" ");
    const pairs = [...keyText.matchAll(/(\d{1,4})\s*[.):\-]?\s*([A-Da-d])(?![A-Za-z])/g)];
    const byNumber = new Map(pairs.map((m) => [Number(m[1]), m[2].toUpperCase()]));
    let applied = 0;
    for (const d of drafts) {
      const k = byNumber.get(d.number);
      if (k && !d.answer) { d.answer = k; applied++; }
    }
    notes.push(`Answer key list found: matched ${applied} of ${drafts.length} questions by number.`);
  }

  const rows = drafts.map<RawQuestion>((d) => ({
    subject: defaults.subject, topic: defaults.topic, year: defaults.year, source: defaults.source,
    question: d.text, option_a: d.opts[0] ?? "", option_b: d.opts[1] ?? "", option_c: d.opts[2] ?? "", option_d: d.opts[3] ?? "",
    answer: d.answer ?? "", explanation: d.explanation,
  }));
  if (rows.length === 0) notes.push("No questions were recognised. Check the format: a numbered question, options A-D, then Answer: X.");
  return { rows, notes };
}

// ---- Excel (.xlsx) without any library: ZIP + DEFLATE (built into browsers) + small XML reader ----------------
const dec = new TextDecoder();

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzip(buf: Uint8Array): Promise<Map<string, Uint8Array>> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("This does not look like an Excel (.xlsx) file.");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = new Map<string, Uint8Array>();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("Corrupt Excel file.");
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    if (!/^xl\/(worksheets\/sheet\d+\.xml|sharedStrings\.xml|workbook\.xml|_rels\/workbook\.xml\.rels)$/.test(name)) continue;
    if (usize > 40_000_000) throw new Error("Excel sheet is too large.");
    const lnlen = dv.getUint16(off + 26, true), lelen = dv.getUint16(off + 28, true);
    const raw = buf.subarray(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize);
    files.set(name, method === 0 ? raw : method === 8 ? await inflateRaw(raw) : (() => { throw new Error("Unsupported Excel compression."); })());
  }
  return files;
}

const unxml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, "&");

const textOf = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join("");

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/[0-9]/g, "")) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Reads the FIRST worksheet of an .xlsx file as rows of text. Formulas are read as their cached values. */
export async function readXlsx(bytes: Uint8Array): Promise<string[][]> {
  const files = await unzip(bytes);
  const shared = files.has("xl/sharedStrings.xml")
    ? [...dec.decode(files.get("xl/sharedStrings.xml")!).matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]))
    : [];
  let sheetPath = "xl/worksheets/sheet1.xml";
  const wb = files.get("xl/workbook.xml"), rels = files.get("xl/_rels/workbook.xml.rels");
  if (wb && rels) {
    const rid = /<sheet\b[^>]*r:id="([^"]+)"/.exec(dec.decode(wb))?.[1];
    if (rid) {
      for (const m of dec.decode(rels).matchAll(/<Relationship\b[^>]*>/g)) {
        if (new RegExp(`Id="${rid}"`).test(m[0])) {
          const t = /Target="([^"]+)"/.exec(m[0])?.[1];
          if (t) sheetPath = t.startsWith("/") ? t.slice(1) : "xl/" + t.replace(/^\.\//, "");
        }
      }
    }
  }
  const sheet = files.get(sheetPath) ?? files.get("xl/worksheets/sheet1.xml");
  if (!sheet) throw new Error("No worksheet found in this Excel file.");
  const out: string[][] = [];
  for (const rm of dec.decode(sheet).matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells: string[] = [];
    for (const cm of (rm[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], inner = cm[2] ?? "";
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const idx = ref ? colIndex(ref) : cells.length;
      let v = "";
      if (type === "s") v = shared[Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1])] ?? "";
      else if (type === "inlineStr") v = textOf(inner);
      else v = unxml(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "");
      while (cells.length < idx) cells.push("");
      cells[idx] = v;
    }
    if (cells.some((c) => c.trim() !== "")) out.push(cells);
  }
  return out;
}

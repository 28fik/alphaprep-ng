import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { itemsToLines, pdfToText } from "../src/lib/pdfText.ts";
import { parsePastedText } from "../src/lib/importParse.ts";

test("itemsToLines: orders by position and merges items on the same line", () => {
  const items = [
    { str: "world", transform: [1, 0, 0, 1, 80, 700] },
    { str: "Second line", transform: [1, 0, 0, 1, 10, 680] },
    { str: "Hello", transform: [1, 0, 0, 1, 10, 700.5] },
    { str: "  ", transform: [1, 0, 0, 1, 10, 600] },
  ];
  assert.deepEqual(itemsToLines(items), ["Hello world", "Second line"]);
});

test("text PDF -> questions (real pdf.js parsing a generated PDF)", async (t) => {
  let pdfjs: any;
  try {
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch {
    try { pdfjs = await import("/opt/npm-tools/node_modules/pdfjs-dist/legacy/build/pdf.min.mjs"); } catch { pdfjs = null; }
  }
  if (!pdfjs) {
    t.skip("pdfjs-dist is not installed here (run npm install)");
    return;
  }
  const bytes = new Uint8Array(readFileSync(new URL("./fixtures/q.pdf", import.meta.url)));
  const { text, pages, looksScanned } = await pdfToText(pdfjs, bytes);
  assert.equal(pages, 2);
  assert.equal(looksScanned, false);
  const { rows } = parsePastedText(text, { subject: "physics" });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.answer), ["B", "B", "C"]);
  assert.equal(rows[2].option_c, "Abuja");
});

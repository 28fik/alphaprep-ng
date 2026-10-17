import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseCsv, parsePastedText, readXlsx, rowsFromTable } from "../src/lib/importParse.ts";

test("csv: quotes, escaped quotes, commas and newlines inside cells, CRLF, BOM, blank lines", () => {
  const t = parseCsv('﻿a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n\r\n1,2,3');
  assert.deepEqual(t, [["a", "b", "c"], ["x, y", 'say "hi"', "line1\nline2"], ["1", "2", "3"]]);
  assert.deepEqual(parseCsv(""), []);
  assert.deepEqual(parseCsv("a,b\n1,"), [["a", "b"], ["1", ""]]);
});

test("table mapping: header aliases, unknown/missing columns reported", () => {
  const r = rowsFromTable(parseCsv("Subject,Question,A,B,C,D,Correct Answer,Colour\nphysics,What?,1,2,3,4,B,red"));
  assert.deepEqual(r.rows[0], { subject: "physics", question: "What?", option_a: "1", option_b: "2", option_c: "3", option_d: "4", answer: "B" });
  assert.deepEqual(r.unknownColumns, ["Colour"]);
  assert.deepEqual(r.missingColumns, []);
  assert.deepEqual(rowsFromTable(parseCsv("question,a\nx,y")).missingColumns, ["option_b", "option_c", "option_d"]);
  assert.equal(rowsFromTable([]).rows.length, 0);
});

test("pasted text: numbered questions, A-D options, answers, explanations, multi-line text", () => {
  const text = `PHYSICS 2019 PAPER
Instructions: answer all.

1. What is the unit of force?
A. Joule
B. Newton
C. Watt
D. Pascal
Answer: B
Explanation: F = ma, so the unit is kg m/s2.
It is named after Isaac Newton.

2) A body moves at constant velocity.
Its acceleration is
(a) zero
(b) constant
(c) increasing
(d) decreasing
Ans: (A)

Q3. No answer given here
A) one
B) two
C) three
D) four
`;
  const { rows } = parsePastedText(text, { subject: "physics", year: "2019" });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].question, "What is the unit of force?");
  assert.deepEqual([rows[0].option_a, rows[0].option_b, rows[0].option_c, rows[0].option_d], ["Joule", "Newton", "Watt", "Pascal"]);
  assert.equal(rows[0].answer, "B");
  assert.equal(rows[0].explanation, "F = ma, so the unit is kg m/s2. It is named after Isaac Newton.");
  assert.equal(rows[1].question, "A body moves at constant velocity. Its acceleration is");
  assert.equal(rows[1].answer, "A");
  assert.equal(rows[2].answer, ""); // never invented
  assert.equal(rows[0].subject, "physics");
  assert.equal(rows[0].year, "2019");
});

test("pasted text: trailing answer-key list is matched by question number", () => {
  const text = `1. First?
A. a1
B. b1
C. c1
D. d1
2. Second?
A. a2
B. b2
C. c2
D. d2
3. Third?
A. a3
B. b3
C. c3
D. d3

ANSWERS
1. C  2.A  3 - D`;
  const { rows, notes } = parsePastedText(text);
  assert.deepEqual(rows.map((r) => r.answer), ["C", "A", "D"]);
  assert.ok(notes[0].includes("3 of 3"));
});

test("pasted text: option letters out of order are not mistaken for options; nothing recognised gives a note", () => {
  const { rows } = parsePastedText("1. Pick one\nB. wrong start\nA. first\nB. second\nC. third\nD. fourth");
  assert.equal(rows[0].option_a, "first");
  assert.ok(rows[0].question.includes("B. wrong start"));
  const none = parsePastedText("just some words");
  assert.equal(none.rows.length, 0);
  assert.equal(none.notes.length, 1);
});

test("xlsx: reads shared strings, numbers, empty cells, entities and only the first sheet", async () => {
  const bytes = new Uint8Array(readFileSync(new URL("./fixtures/q.xlsx", import.meta.url)));
  const t = await readXlsx(bytes);
  assert.equal(t.length, 3);
  assert.deepEqual(t[0].slice(0, 4), ["Subject", "Topic", "Year", "Question"]);
  assert.equal(t[1][2], "2019");
  assert.equal(t[1][3], "Solve 2x + 3 = 11 & check <ok>");
  assert.equal(t[1][9], "2x = 8 → x = 4");
  assert.equal(t[2][1] ?? "", ""); // blank cell kept in position
  assert.equal(t[2][3], "Unit of force?");
  const r = rowsFromTable(t);
  assert.equal(r.rows[1].option_b, "Newton");
  await assert.rejects(() => readXlsx(new Uint8Array([1, 2, 3, 4, 5])), /Excel/);
});

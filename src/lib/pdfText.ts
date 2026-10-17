// PDF -> text, entirely in the browser (nothing is uploaded). Heavy libraries are loaded only when needed.

export interface PdfTextItem { str: string; transform: number[]; hasEOL?: boolean }
export interface PdfJsLike {
  getDocument(src: { data: Uint8Array }): { promise: Promise<{ numPages: number; getPage(n: number): Promise<any> }> };
  GlobalWorkerOptions?: { workerSrc: string };
}

/** Rebuild reading-order lines from positioned text items. */
export function itemsToLines(items: PdfTextItem[]): string[] {
  const lines: { y: number; parts: { x: number; s: string }[] }[] = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4], y = it.transform[5];
    let line = lines.find((l) => Math.abs(l.y - y) < 3);
    if (!line) { line = { y, parts: [] }; lines.push(line); }
    line.parts.push({ x, s: it.str });
  }
  lines.sort((a, b) => b.y - a.y); // PDF origin is bottom-left: higher y = higher on the page
  return lines.map((l) => l.parts.sort((a, b) => a.x - b.x).map((p) => p.s).join(" ").replace(/\s+/g, " ").trim());
}

export async function pdfToText(pdfjs: PdfJsLike, bytes: Uint8Array, onProgress?: (page: number, total: number) => void) {
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  if (doc.numPages > 200) throw new Error("This PDF has more than 200 pages. Split it into smaller files.");
  const pages: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    pages.push(itemsToLines(content.items as PdfTextItem[]).join("\n"));
    onProgress?.(n, doc.numPages);
  }
  const chars = pages.reduce((t, p) => t + p.length, 0);
  return { text: pages.join("\n"), pages: doc.numPages, looksScanned: chars / Math.max(1, doc.numPages) < 40 };
}

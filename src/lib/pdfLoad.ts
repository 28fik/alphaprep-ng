// Browser-only loaders (kept apart from pdfText.ts so the pure text code can be tested in Node).
import type { PdfJsLike } from "./pdfText";

export async function loadPdfJs(): Promise<PdfJsLike> {
  const pdfjs: any = await import("pdfjs-dist");
  const worker: any = await import("pdfjs-dist/build/pdf.worker.min.mjs?url"); // Vite turns this into a hashed file URL
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
}

/**
 * OCR for scanned PDFs (slow, runs on the device; accuracy varies). Returns the text and the mean confidence
 * so the import can mark everything 'needs review' when recognition is poor.
 */
export async function ocrPdf(bytes: Uint8Array, onProgress?: (message: string) => void): Promise<{ text: string; confidence: number }> {
  const pdfjs: any = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  if (doc.numPages > 30) throw new Error("OCR is limited to 30 pages at a time. Split the PDF into smaller parts.");
  const { createWorker }: any = await import("tesseract.js");
  const worker = await createWorker("eng");
  const texts: string[] = [];
  let conf = 0;
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      onProgress?.(`Reading page ${n} of ${doc.numPages}…`);
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext("2d")!, viewport }).promise;
      const { data } = await worker.recognize(canvas);
      texts.push(data.text);
      conf += data.confidence;
    }
  } finally {
    await worker.terminate();
  }
  return { text: texts.join("\n"), confidence: conf / doc.numPages };
}

/**
 * Reads the text layer of a PDF in the browser with pdf.js. Loaded only when a
 * PDF is dropped. The worker runs from a blob made from the bundled worker
 * source, so it needs no file of its own and nothing is fetched from elsewhere.
 */
let ready: Promise<typeof import('pdfjs-dist')> | null = null;

function load() {
  ready ??= (async () => {
    const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?raw')]);
    const url = URL.createObjectURL(new Blob([worker.default], { type: 'text/javascript' }));
    pdfjs.GlobalWorkerOptions.workerPort = new Worker(url, { type: 'module' });
    return pdfjs;
  })();
  return ready;
}

/** Gives up rather than hanging when the browser refuses to start the PDF worker. */
export function pdfText(bytes: Uint8Array, timeoutMs = 30_000): Promise<string> {
  return Promise.race([
    readPdf(bytes),
    new Promise<string>((_, reject) => setTimeout(() => reject(new Error('PDF reading did not finish here. Copy the text into the notes instead.')), timeoutMs)),
  ]);
}

async function readPdf(bytes: Uint8Array): Promise<string> {
  const pdfjs = await load();
  const task = pdfjs.getDocument({ data: bytes, disableFontFace: true });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    let line = '';
    const lines: string[] = [];
    for (const item of content.items) {
      if (!('str' in item)) continue;
      line += item.str;
      if (item.hasEOL) {
        lines.push(line);
        line = '';
      } else line += ' ';
    }
    if (line.trim()) lines.push(line);
    pages.push(lines.map((l) => l.replace(/\s+/g, ' ').trim()).join('\n'));
  }
  await task.destroy();
  return pages.join('\n\n');
}

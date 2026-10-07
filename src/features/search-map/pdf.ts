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

export async function pdfText(bytes: Uint8Array): Promise<string> {
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

import { strFromU8, unzipSync } from 'fflate';

/**
 * Text extraction for intake documents, done on the planner's own computer.
 * Nothing here sends a file anywhere. PDF reading needs a browser (see
 * src/features/search-map/pdf.ts) and is passed in, so this module stays pure
 * and testable.
 */
export type DocKind = 'text' | 'docx' | 'pdf' | 'unsupported';

const TEXT_EXT = ['txt', 'md', 'csv', 'json', 'eml', 'log', 'rtf'];

export function docKind(fileName: string, mime = ''): DocKind {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (ext === 'docx' || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (TEXT_EXT.includes(ext) || mime.startsWith('text/')) return 'text';
  return 'unsupported';
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m),
  );

/** Body text of a Word .docx: paragraphs on their own lines, tabs and breaks kept, everything else dropped. */
export function docxText(bytes: Uint8Array): string {
  const files = unzipSync(bytes, { filter: (f) => f.name === 'word/document.xml' });
  const xml = files['word/document.xml'];
  if (!xml) throw new Error('not a Word document (no word/document.xml)');
  return decode(
    strFromU8(xml)
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:(?:br|cr)\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Plain text from an RTF file, roughly: control words and groups removed. */
export function rtfText(rtf: string): string {
  return rtf
    .replace(/\\par[d]? ?/g, '\n')
    .replace(/\{\\\*[^{}]*\}/g, '')
    .replace(/\\'[0-9a-f]{2}/gi, (h) => String.fromCharCode(parseInt(h.slice(2), 16)))
    .replace(/\\[a-z]+-?\d* ?/gi, '')
    .replace(/[{}]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface ReadDoc {
  name: string;
  kind: DocKind;
  text: string;
  /** Why nothing was read, when nothing was. */
  problem?: string;
}

/** Reads one file's text. `pdf` is the browser's PDF reader; leave it out where there is none. */
export async function readDocument(
  file: { name: string; type?: string; arrayBuffer(): Promise<ArrayBuffer> },
  pdf?: (bytes: Uint8Array) => Promise<string>,
): Promise<ReadDoc> {
  const kind = docKind(file.name, file.type);
  const base = { name: file.name, kind };
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (kind === 'unsupported') return { ...base, text: '', problem: 'This file type cannot be read. Use PDF, Word (.docx) or text.' };
    if (kind === 'docx') return { ...base, text: docxText(bytes) };
    if (kind === 'pdf') {
      if (!pdf) return { ...base, text: '', problem: 'PDF reading is not available here.' };
      const text = await pdf(bytes);
      return text.trim() ? { ...base, text } : { ...base, text: '', problem: 'No text found. It may be a scanned image, which needs to be typed in.' };
    }
    const raw = new TextDecoder().decode(bytes);
    return { ...base, text: file.name.toLowerCase().endsWith('.rtf') ? rtfText(raw) : raw };
  } catch (e) {
    return { ...base, text: '', problem: e instanceof Error ? e.message : String(e) };
  }
}

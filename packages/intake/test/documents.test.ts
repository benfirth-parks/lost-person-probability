import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { docKind, docxText, readDocument, rtfText } from '../src/documents.ts';

// A minimal Word document, built by hand. Invented exercise text.
const DOC_XML =
  '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>' +
  '<w:p><w:r><w:t>Last seen at Exercise Lake</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>51.2034, -115.6120</w:t><w:tab/><w:t>heading N &amp; E</w:t></w:r></w:p>' +
  '</w:body></w:document>';
const DOCX = zipSync({ 'word/document.xml': strToU8(DOC_XML), '[Content_Types].xml': strToU8('<Types/>') });

const fileOf = (name: string, bytes: Uint8Array, type = '') => ({ name, type, arrayBuffer: async () => bytes.slice().buffer });

describe('documents', () => {
  it('knows which files it can read', () => {
    expect(['a.pdf', 'b.DOCX', 'c.txt', 'd.eml', 'e.jpg', 'f.doc'].map((n) => docKind(n))).toEqual(['pdf', 'docx', 'text', 'text', 'unsupported', 'unsupported']);
  });

  it('reads Word paragraphs, tabs and entities', () => {
    expect(docxText(DOCX)).toBe('Last seen at Exercise Lake\n51.2034, -115.6120\theading N & E');
  });

  it('refuses a zip that is not a Word document', () => {
    expect(() => docxText(zipSync({ 'a.txt': strToU8('x') }))).toThrow(/not a Word document/);
  });

  it('strips RTF control words', () => {
    expect(rtfText('{\\rtf1\\ansi{\\fonttbl\\f0 Arial;}\\f0\\fs24 Last seen\\par heading north\\par}')).toBe('Arial;Last seen\nheading north');
  });

  it('reads text files, and explains what it cannot read', async () => {
    expect((await readDocument(fileOf('notes.txt', strToU8('IPP 51.2, -115.6')))).text).toBe('IPP 51.2, -115.6');
    expect((await readDocument(fileOf('n.docx', DOCX))).text).toContain('Exercise Lake');
    expect((await readDocument(fileOf('photo.jpg', new Uint8Array([1])))).problem).toMatch(/cannot be read/);
    expect((await readDocument(fileOf('scan.pdf', new Uint8Array([1])), async () => '  '))).toMatchObject({ text: '', problem: expect.stringMatching(/scanned image/) });
    expect((await readDocument(fileOf('x.pdf', new Uint8Array([1])))).problem).toMatch(/not available/);
  });
});

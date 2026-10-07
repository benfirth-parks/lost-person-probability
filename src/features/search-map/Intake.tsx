import { useMemo, useState } from 'react';
import {
  AI_READER_NOT_APPROVED,
  LOCAL_READER,
  readDocument,
  readIncident,
  redactIncidentText,
  type IntakeFields,
  type IntakeReader,
  type ReadDoc,
} from '../../../packages/intake/src/index.ts';
import { pdfText } from './pdf.ts';

const FIELD_LABEL: Record<keyof IntakeFields, string> = {
  lat: 'Latitude',
  lng: 'Longitude',
  pointKind: 'Point',
  travelBearingDeg: 'Direction of travel',
  subjectCategory: 'Subject category',
  terrain: 'Terrain',
};

const unit = (k: keyof IntakeFields) => (k === 'travelBearingDeg' ? '°' : '');

/**
 * Intake: typed notes and dropped documents. Documents are read on this
 * computer; their text is cleaned here before any reader sees it, and the
 * reader's answer only becomes form values when the planner says so. Nothing
 * typed or dropped is stored or put in the CalTopo file.
 */
export function Intake({ onUse, readers = [LOCAL_READER, AI_READER_NOT_APPROVED] }: { onUse: (fields: IntakeFields) => void; readers?: IntakeReader[] }) {
  const [notes, setNotes] = useState('');
  const [docs, setDocs] = useState<ReadDoc[]>([]);
  const [busy, setBusy] = useState('');
  const [readerName, setReaderName] = useState((readers.find((r) => r.enabled) ?? readers[0]!).name);
  const [result, setResult] = useState<{ fields: IntakeFields; discarded: string[] } | null>(null);
  const [error, setError] = useState('');
  const reader = readers.find((r) => r.name === readerName) ?? readers[0]!;

  const allText = [notes, ...docs.filter((d) => d.text).map((d) => d.text)].filter((t) => t.trim()).join('\n\n');
  const cleaned = useMemo(() => redactIncidentText(allText), [allText]);
  const removed = cleaned.removed;
  const removedCount = removed.name + removed.phone + removed.email + removed.health;

  async function addFiles(files: FileList | File[]) {
    setResult(null);
    const list = [...files];
    for (const [i, f] of list.entries()) {
      setBusy(`Reading ${f.name} (${i + 1} of ${list.length})`);
      const doc = await readDocument(f, pdfText);
      setDocs((cur) => [...cur.filter((d) => d.name !== doc.name), doc]);
    }
    setBusy('');
  }

  async function read() {
    setError('');
    setResult(null);
    setBusy(`Reading with ${reader.name}`);
    try {
      setResult(await readIncident(allText, reader));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }

  const entries = result ? (Object.entries(result.fields) as Array<[keyof IntakeFields, unknown]>) : [];
  return (
    <section className="sm-intake" aria-labelledby="sm-intake-h">
      <h3 id="sm-intake-h">1 · Incident details</h3>
      <label className="field" htmlFor="sm-notes">
        Notes in your own words
        <textarea id="sm-notes" rows={4} value={notes} placeholder="e.g. Overdue hiker, last seen at the trailhead 51.2034, -115.6120, heading northeast toward the ridge." onChange={(e) => { setNotes(e.target.value); setResult(null); }} />
      </label>
      <div
        className="sm-drop"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void addFiles(e.dataTransfer.files);
        }}
      >
        <label htmlFor="sm-files">
          <b>Add documents</b> (PDF, Word .docx or text). Drop them here or
          <span className="sm-pick"> choose files</span>.
        </label>
        <input id="sm-files" type="file" multiple accept=".pdf,.docx,.txt,.md,.csv,.eml,.rtf,application/pdf,text/plain" onChange={(e) => e.target.files && void addFiles(e.target.files)} />
      </div>
      {docs.length > 0 && (
        <ul className="sm-docs">
          {docs.map((d) => (
            <li key={d.name}>
              <span className="sm-doc-name">{d.name}</span>
              {d.problem ? <span className="sm-doc-bad">{d.problem}</span> : <span className="meta">{d.text.length.toLocaleString()} characters read</span>}
              <button type="button" className="link" onClick={() => { setDocs((cur) => cur.filter((x) => x.name !== d.name)); setResult(null); }} aria-label={`Remove ${d.name}`}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <div className="sm-row">
        <label className="field" htmlFor="sm-reader">
          Read by
          <select id="sm-reader" value={readerName} onChange={(e) => { setReaderName(e.target.value); setResult(null); }}>
            {readers.map((r) => <option key={r.name} value={r.name} disabled={!r.enabled}>{r.name}</option>)}
          </select>
        </label>
        <button type="button" onClick={read} disabled={!allText.trim() || !reader.enabled || !!busy}>Read details</button>
      </div>
      {busy && <p className="cap" role="status">{busy}…</p>}
      {allText.trim() && (
        <details className="sm-sent">
          <summary>What the reader sees{removedCount ? ` (${removedCount} removed)` : ''}</summary>
          <p>{cleaned.text}</p>
          <p className="cap">Removed: {removed.name} name-like, {removed.phone + removed.email} contact, {removed.health} health. Only the planning point, its kind, the direction of travel, an activity category and the terrain can come back.</p>
        </details>
      )}
      {error && <p className="cap sm-doc-bad" role="alert">{error}</p>}
      {result && (
        <div className="sm-proposal" aria-live="polite">
          {entries.length ? (
            <>
              <b>Found:</b>
              <ul>{entries.map(([k, v]) => <li key={k}>{FIELD_LABEL[k]}: {String(v)}{unit(k)}</li>)}</ul>
              <button type="button" className="primary" onClick={() => onUse(result.fields)}>Use these in the form</button>
            </>
          ) : (
            <p>Nothing usable found. Fill the form below.</p>
          )}
          {result.discarded.length > 0 && <p className="cap">Ignored: {result.discarded.join(', ')}.</p>}
        </div>
      )}
    </section>
  );
}

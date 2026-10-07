import { useState } from 'react';
import { BehaviourTable, CSV_HEADER, EXERCISE_TABLE, LPB_TABLE, parseBehaviourCsv, type TableProblem } from '../../../packages/behaviour/src/index.ts';

export const BUILT_IN_TABLES: BehaviourTable[] = [LPB_TABLE, EXERCISE_TABLE];

const KEY = 'lppm.behaviourTable.v1';

/** The table last loaded on this computer, if any. Browser storage only; it never leaves this computer. */
export function loadSavedTable(): BehaviourTable | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const t = BehaviourTable.safeParse(JSON.parse(raw));
    return t.success ? t.data : null;
  } catch {
    return null;
  }
}

function save(t: BehaviourTable | null) {
  try {
    if (t) localStorage.setItem(KEY, JSON.stringify(t));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked: the table still works until the page is closed */
  }
}

/** Shows which table the rings come from, lets the planner switch tables, and load their own from CSV. */
export function BehaviourTablePanel({ table, onChange }: { table: BehaviourTable; onChange: (t: BehaviourTable) => void }) {
  const [saved, setSaved] = useState<BehaviourTable | null>(loadSavedTable);
  const tables = [...BUILT_IN_TABLES, ...(saved ? [saved] : [])];
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [source, setSource] = useState('');
  const [kind, setKind] = useState<'published' | 'agency'>('published');
  const [unit, setUnit] = useState<'km' | 'mi'>('km');
  const [csv, setCsv] = useState(`${CSV_HEADER}\n`);
  const [problems, setProblems] = useState<TableProblem[]>([]);

  function load() {
    const r = parseBehaviourCsv(csv, { name, source, kind }, unit);
    if (!r.ok) return setProblems(r.problems);
    if (!name.trim() || !source.trim()) return setProblems([{ line: 0, message: 'give the table a name and its full source' }]);
    setProblems([]);
    save(r.table);
    setSaved(r.table);
    onChange(r.table);
    setOpen(false);
  }

  const exercise = table.kind === 'exercise';
  return (
    <div className={`sm-table ${exercise ? 'is-exercise' : ''}`}>
      <label className="field" htmlFor="bt-pick">Behaviour table
        <select id="bt-pick" value={table.name} onChange={(e) => onChange(tables.find((t) => t.name === e.target.value)!)}>
          {tables.map((t) => <option key={t.name} value={t.name}>{t.name} ({t.entries.length} rows)</option>)}
        </select>
      </label>
      <p className="cap">{table.source}</p>
      <div className="sm-row">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Close' : 'Load rows from a source'}</button>
        {saved && <button type="button" onClick={() => { save(null); setSaved(null); if (table === saved) onChange(LPB_TABLE); }}>Remove {saved.name}</button>}
      </div>
      {open && (
        <div className="sm-table-load">
          <p className="cap">
            One row per subject category and terrain, in this column order: <code>{CSV_HEADER}</code>. Ring distances are the 25%, 50%, 75% and 95% find distances from the
            planning point. Leave the dispersion columns empty where the source has none. Use <code>any</code> as the terrain for a row that applies everywhere. The table is
            kept in this browser only.
          </p>
          <div className="sm-row">
            <label className="field" htmlFor="bt-name">Table name
              <input id="bt-name" value={name} maxLength={80} placeholder="e.g. Lost Person Behavior, hiker and hunter" onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field" htmlFor="bt-kind">Kind
              <select id="bt-kind" value={kind} onChange={(e) => setKind(e.target.value as 'published' | 'agency')}>
                <option value="published">Published research</option>
                <option value="agency">Agency case history</option>
              </select>
            </label>
            <label className="field" htmlFor="bt-unit">Distances in
              <select id="bt-unit" value={unit} onChange={(e) => setUnit(e.target.value as 'km' | 'mi')}>
                <option value="km">km</option>
                <option value="mi">miles</option>
              </select>
            </label>
          </div>
          <label className="field" htmlFor="bt-source">Full source (author, title, edition, table numbers, or dataset and date)
            <input id="bt-source" value={source} maxLength={300} onChange={(e) => setSource(e.target.value)} />
          </label>
          <label className="field" htmlFor="bt-csv">Rows (paste from a spreadsheet saved as CSV)
            <textarea id="bt-csv" rows={6} value={csv} spellCheck={false} onChange={(e) => setCsv(e.target.value)} />
          </label>
          {problems.length > 0 && (
            <ul className="sm-doc-bad" role="alert">
              {problems.map((p, i) => <li key={i}>{p.line ? `Line ${p.line}: ` : ''}{p.message}</li>)}
            </ul>
          )}
          <button type="button" className="primary" onClick={load}>Use this table</button>
        </div>
      )}
    </div>
  );
}

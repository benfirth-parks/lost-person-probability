import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router';
import { CASE_CODE, INFORMATION_CUTOFF, LAST_SEEN_AT } from '../../packages/exercises/alpine-ex-01.ts';
import { IncidentsPage } from '../features/incidents/IncidentsPage.tsx';
import { clock } from '../features/workspace/format.ts';
import { useWorkspace, useWorkspaceState, WorkspaceContext, type Role } from '../features/workspace/useWorkspace.ts';
import { WorkspacePage } from '../features/workspace/WorkspacePage.tsx';
import { SearchMapPage } from '../features/search-map/SearchMapPage.tsx';
import { AdminPage } from './AdminPage.tsx';

function Toast() {
  const t = useWorkspace().toast;
  return <ToastView key={t?.n ?? 0} text={t?.text ?? ''} bad={t?.bad ?? false} />;
}

function ToastView({ text, bad }: { text: string; bad: boolean }) {
  const [show, setShow] = useState(Boolean(text));
  useEffect(() => {
    if (!text) return;
    const h = setTimeout(() => setShow(false), 3200);
    return () => clearTimeout(h);
  }, [text]);
  return (
    <div className={`toast ${show && text ? 'show' : ''} ${bad ? 'bad' : ''}`} role="status" aria-live="polite">
      {text}
    </div>
  );
}

export function App() {
  const ws = useWorkspaceState();
  return (
    <WorkspaceContext.Provider value={ws}>
      <BrowserRouter>
        <div className="wrap">
          <header className="bar">
            <h1>Lost-Person Probability Mapper</h1>
            <span className="mode">Training · authored exercise</span>
            <nav className="nav" aria-label="Main">
              <NavLink to="/incidents">Cases</NavLink>
              <NavLink to={`/incident/${CASE_CODE}/map`}>Map workspace</NavLink>
              <NavLink to="/tools/search-map">Search map</NavLink>
              <NavLink to="/admin">Administration</NavLink>
            </nav>
            <div className="facts">
              <span>Case <b>{CASE_CODE}</b></span>
              <span>Last seen <b>{clock(LAST_SEEN_AT)}</b></span>
              <span>Cutoff <b>{clock(INFORMATION_CUTOFF)}</b></span>
            </div>
            <label className="role" htmlFor="role">
              Signed in as
              <select id="role" value={ws.role} onChange={(e) => ws.actions.setRole(e.target.value as Role)}>
                <option value="planner_trainee">Planner trainee</option>
                <option value="evaluator">Evaluator</option>
              </select>
            </label>
          </header>
          <main>
            <Routes>
              <Route path="/" element={<Navigate to={`/incident/${CASE_CODE}/map`} replace />} />
              <Route path="/incidents" element={<IncidentsPage />} />
              <Route path="/incident/:id/map" element={<WorkspacePage />} />
              <Route path="/tools/search-map" element={<SearchMapPage />} />
              <Route path="/admin" element={<AdminPage />} />
              <Route path="*" element={<p className="lede">Page not found.</p>} />
            </Routes>
          </main>
          <p className="foot">
            Research prototype for training and retrospective study only. Operational use is disabled. Terrain is synthetic, and every distance, sweep width and clue
            parameter is an exercise value, not a behavioural statistic. The map is structured evidence for a search manager and makes no command decisions.
          </p>
        </div>
        <Toast />
      </BrowserRouter>
    </WorkspaceContext.Provider>
  );
}

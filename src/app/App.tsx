import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { SearchMapPage } from '../features/search-map/SearchMapPage.tsx';

export function App() {
  return (
    <BrowserRouter>
      <div className="wrap">
        <header className="bar">
          <h1>Search Map Builder</h1>
          <span className="mode">Training · research prototype</span>
        </header>
        <main>
          <Routes>
            <Route path="/" element={<SearchMapPage />} />
            <Route path="/tools/search-map" element={<Navigate to="/" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        <p className="foot">
          Research prototype for training and retrospective study only. Operational use is disabled. The map is structured evidence for a search manager and makes no
          command decisions.
        </p>
      </div>
    </BrowserRouter>
  );
}

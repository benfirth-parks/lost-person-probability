import { EXERCISE_RINGS } from '../../packages/exercises/alpine-ex-01.ts';
import { ENGINE_VERSION, POD_MODELS } from '../../packages/probability-engine/src/index.ts';

/** Read-only view of models and flags in this build. Editing arrives with the database connection. */
export function AdminPage() {
  return (
    <section className="page">
      <h2>Administration</h2>
      <div className="admin-grid">
        <article className="item">
          <header><b>Feature flags</b></header>
          <div className="flag">
            <span>Operational incidents</span>
            <span className="chip">Disabled</span>
          </div>
          <p className="cap">Locked off in the database by a check constraint. Enabling it requires a separate security, privacy, doctrine, validation and operational-authority process.</p>
        </article>
        <article className="item">
          <header><b>Prior models</b></header>
          <p>{EXERCISE_RINGS.id}@{EXERCISE_RINGS.version} · {EXERCISE_RINGS.subjectCategory} <span className="chip warn">{EXERCISE_RINGS.status.replace('_', ' ')}</span></p>
          <p className="cap">{EXERCISE_RINGS.source}</p>
        </article>
        <article className="item">
          <header><b>POD models</b></header>
          {Object.entries(POD_MODELS).map(([id, m]) => (
            <div key={id}>
              <p><code>{id}</code></p>
              <p className="cap">{m.description}</p>
            </div>
          ))}
        </article>
        <article className="item">
          <header><b>Engine</b></header>
          <p><code>{ENGINE_VERSION}</code></p>
          <p className="cap">Recorded on every committed surface with its parameters, normalization constant, input hash, user and time.</p>
        </article>
        <article className="item">
          <header><b>Roles</b></header>
          <p className="cap">Training viewer, planner trainee, evaluator, analyst, instructor and administrator are active. Operational search manager, operational planning staff and field team lead are reserved and disabled.</p>
        </article>
      </div>
    </section>
  );
}

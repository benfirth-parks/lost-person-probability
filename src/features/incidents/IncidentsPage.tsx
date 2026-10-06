import { Link } from 'react-router';
import { CASE_CODE, INFORMATION_CUTOFF } from '../../../packages/exercises/alpine-ex-01.ts';
import { clock } from '../workspace/format.ts';
import { useWorkspace } from '../workspace/useWorkspace.ts';

/** Cases the signed-in user may open. Outcome status is never shown before reveal. */
export function IncidentsPage() {
  const w = useWorkspace();
  const evaluation = w.run?.status ?? 'not started';
  return (
    <section className="page">
      <h2>Cases</h2>
      <p className="lede">Training exercises and approved de-identified retrospective cases assigned to you. Find locations and outcomes stay hidden until an evaluation run is locked.</p>
      <div className="tablewrap">
        <table className="num cases">
          <thead>
            <tr>
              <th scope="col">Case</th>
              <th scope="col">Mode</th>
              <th scope="col">Operating area</th>
              <th scope="col">Subject category</th>
              <th scope="col">Information cutoff</th>
              <th scope="col">Evaluation</th>
              <th scope="col">Data completeness</th>
              <th scope="col">Assigned</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row"><Link to={`/incident/${CASE_CODE}/map`}>{CASE_CODE}</Link></th>
              <td><span className="chip mode">Training</span></td>
              <td>Synthetic exercise terrain</td>
              <td>Day hiker, solo</td>
              <td>18 Jul, {clock(INFORMATION_CUTOFF)}</td>
              <td>{evaluation}</td>
              <td>Exercise package</td>
              <td>trainee-01, evaluator-01</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="cap">Retrospective cases appear here once the database is connected and a de-identified case has been approved and imported.</p>
    </section>
  );
}

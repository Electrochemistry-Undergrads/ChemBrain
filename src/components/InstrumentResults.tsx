import { useId, useState, type ReactNode } from 'react';
import { INSTRUMENT_GROUPS } from '../../shared/instruments';
import { filterReportedInstruments, reportedInstruments, type ReportApproach } from '../lib/report';
import { Badge } from './ui';

export const instrumentPurpose = (purpose: string) => purpose === 'synthesis' ? 'Synthesis' : purpose === 'characterization' ? 'Characterization' : 'Purpose not specified';

export function InstrumentResults({ approaches, citations }: { approaches: ReportApproach[]; citations: (refs: string[]) => ReactNode }) {
  const id = useId();
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState('');
  const [purpose, setPurpose] = useState('');
  const rows = reportedInstruments(approaches);
  const shown = filterReportedInstruments(rows, search, group, purpose);
  const legacy = approaches.some((a) => a.equipment === undefined);
  return <section className="card report-section">
    <h2 className="card-title">Instruments in results</h2>
    <p className="hint">Search the instruments reported in the cited approaches. Synthesis equipment is separate from instruments used to characterize the material.</p>
    <div className="instrument-controls">
      <label htmlFor={`${id}-search`}>Search instruments
        <input id={`${id}-search`} type="search" placeholder="e.g. SEM, autoclave, FTIR…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </label>
      <label htmlFor={`${id}-category`}>Category
        <select id={`${id}-category`} value={group} onChange={(e) => setGroup(e.target.value)}>
          <option value="">All categories</option>
          {INSTRUMENT_GROUPS.map((g) => <option key={g}>{g}</option>)}
          <option value="other">Other equipment</option>
        </select>
      </label>
      <label htmlFor={`${id}-purpose`}>Used for
        <select id={`${id}-purpose`} value={purpose} onChange={(e) => setPurpose(e.target.value)}>
          <option value="">All purposes</option>
          <option value="synthesis">Synthesis</option>
          <option value="characterization">Characterization</option>
          <option value="unspecified">Purpose not specified</option>
        </select>
      </label>
    </div>
    <div className="row between">
      <p className="hint" role="status">{shown.length} of {rows.length} instrument entries</p>
      {(search || group || purpose) && <button className="btn btn-sm" onClick={() => { setSearch(''); setGroup(''); setPurpose(''); }}>Clear filters</button>}
    </div>
    {shown.length ? <div className="instrument-results">
      {shown.map((row, i) => <article className="instrument-result" key={i}>
        <div className="row between"><strong>{row.name}</strong><Badge tone={row.purpose === 'synthesis' ? 'good' : row.purpose === 'characterization' ? 'info' : 'neutral'}>{instrumentPurpose(row.purpose)}</Badge></div>
        <div className="row small"><span className="muted">Reported in</span>{row.approaches.map((a) => <a key={a.rank} href={`#approach-${a.rank}`}>{a.rank}. {a.name}</a>)}</div>
        <div className="small">Source passages: {citations(row.evidence)}</div>
      </article>)}
    </div> : <p className="muted small">{rows.length ? 'No matching instruments. Try another search or clear the filters.' : legacy ? 'This saved report predates instrument extraction. Run a new analysis from Workspace to populate this list.' : 'No instruments were established by the cited evidence in this report. This does not mean specialized equipment is unnecessary.'}</p>}
  </section>;
}

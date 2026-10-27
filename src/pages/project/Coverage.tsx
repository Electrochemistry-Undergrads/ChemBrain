import { Stat } from '../../components/ui';

export function Coverage({ c }: { c: Record<string, number> }) {
  return (
    <section className="coverage" aria-label="Retrieval coverage">
      <Stat label="Discovered" value={c.discovered} />
      <Stat label="Confirmed readable" value={c.confirmed_readable} hint="Open access, publisher-confirmed entitlement, or confirmed by you" />
      <Stat label="Full text retrieved" value={c.full_text_retrieved} />
      <Stat label="Parsed" value={c.parsed} />
      <Stat label="Analysed" value={c.analyzed} />
      <Stat label="Unknown access" value={c.unknown_access} />
      <Stat
        label="Blocked"
        value={c.blocked_network + c.blocked_permission + c.blocked_technical + c.abstract_only}
        hint={`Institutional network: ${c.blocked_network} · Permission: ${c.blocked_permission} · Technical: ${c.blocked_technical} · Abstract only: ${c.abstract_only}`}
      />
      <Stat
        label="Readable coverage"
        value={c.confirmed_readable ? `${c.readable_coverage_pct}%` : '—'}
        hint="Full texts retrieved among papers confirmed readable by you. Readable papers that failed to retrieve stay in the denominator."
      />
    </section>
  );
}

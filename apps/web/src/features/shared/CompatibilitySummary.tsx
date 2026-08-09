import type { CompatibilitySummary as CompatibilitySummaryView } from '../../api/client.js';

export function CompatibilitySummary({ value }: { value?: CompatibilitySummaryView }) {
  if (value === undefined) return null;
  return (
    <aside className="compatibility-summary" aria-label="Compatibility summary">
      <strong>{value.sourceFormat}</strong>
      <span>{value.unknownFieldCount} preserved fields</span>
      {value.warnings.map((warning) => <span key={warning}>{warning}</span>)}
    </aside>
  );
}

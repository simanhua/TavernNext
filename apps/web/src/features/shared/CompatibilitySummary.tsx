import type { CompatibilitySummary as CompatibilitySummaryView } from '../../api/client.js';
import { useI18n } from '../../app/i18n.js';

export function CompatibilitySummary({ value }: { value?: CompatibilitySummaryView }) {
  const { t } = useI18n();
  if (value === undefined) return null;
  return (
    <aside className="compatibility-summary" aria-label={t('Compatibility summary')}>
      <strong>{value.sourceFormat}</strong>
      <span>{t('{{count}} preserved fields', { count: value.unknownFieldCount })}</span>
      {value.warnings.map((warning) => <span key={warning}>{warning}</span>)}
    </aside>
  );
}

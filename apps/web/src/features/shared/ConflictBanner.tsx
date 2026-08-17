import { useI18n } from '../../app/i18n.js';

export function ConflictBanner({ revision, onReload, onRetry }: {
  revision: number;
  onReload: () => void;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="conflict-banner" role="alert">
      <p>{t('Server revision {{revision}} is newer. Your local draft is preserved.', { revision })}</p>
      <button type="button" onClick={onReload}>{t('Reload server version')}</button>
      <button type="button" onClick={onRetry}>{t('Retry with server revision')}</button>
    </div>
  );
}

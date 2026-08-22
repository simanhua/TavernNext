import { useEffect, useState } from 'react';
import { ApiError, api, errorCode, type ExtensionTrustReviewView } from '../../api/client.js';
import { useI18n } from '../../app/i18n.js';

export function ExtensionTrustPanel({ ownerKind, ownerId }: { ownerKind: 'character' | 'preset'; ownerId: string }) {
  const { t } = useI18n();
  const [review, setReview] = useState<ExtensionTrustReviewView>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const run = async (operation: () => Promise<ExtensionTrustReviewView>) => {
    setPending(true); setError(undefined);
    try { setReview(await operation()); }
    catch (cause) {
      const failedReview = cause instanceof ApiError ? cause.details.review : undefined;
      if (typeof failedReview === 'object' && failedReview !== null) {
        setReview(failedReview as ExtensionTrustReviewView);
      }
      setError(errorCode(cause));
    }
    finally { setPending(false); }
  };
  useEffect(() => { void run(() => api.getExtensionTrust(ownerKind, ownerId)); }, [ownerKind, ownerId]);
  return (
    <section className="preset-section" aria-label={t('Trust and remote audit')}>
      <h2>{t('Trust and remote audit')}</h2>
      {review === undefined ? <p>{t('Loading trust review…')}</p> : (
        <>
          <p>{t(review.trusted ? 'Trusted' : 'Not trusted')}</p>
          <p><code>{review.bundleDigest}</code></p>
          <h3>{t('Scripts')}</h3>
          <ul>{review.scripts.map((script) => <li key={`${script.sourceKey}:${script.order.join('.')}`}>
            #{script.order.map((ordinal) => ordinal + 1).join('.')} {script.name} · {t(script.enabled ? 'Enabled' : 'Disabled')}
          </li>)}</ul>
          <h3>{t('Static remote entries')}</h3>
          <ul>{review.remotes.map((remote) => <li key={remote.url}>
            <span>{remote.url}</span> · <span>{t(remote.fetchStatus === 'failed' ? 'Failed' : remote.fetched ? 'Fetched' : 'Not fetched')}</span>
            {remote.sha256 === null ? null : <> · <code>{remote.sha256}</code> · <span>{remote.mediaType}</span></>}
          </li>)}</ul>
          <p role="note">{t('Same-origin scripts can access TavernNext and parent page data.')}</p>
          <p role="note">{review.dynamicNetworkDisclaimer}</p>
          <div className="editor-actions">
            <button type="button" disabled={pending} onClick={() => void run(() => api.refreshExtensionTrust(ownerKind, ownerId))}>{t('Refresh remote entries')}</button>
            <button type="button" disabled={pending || review.remotes.some((remote) => !remote.fetched)} onClick={() => void run(() => api.grantExtensionTrust(ownerKind, ownerId))}>{t('Grant trust')}</button>
            <button type="button" disabled={pending || !review.trusted} onClick={() => void run(() => api.revokeExtensionTrust(ownerKind, ownerId))}>{t('Revoke trust')}</button>
          </div>
          <h3>{t('Audit events')}</h3>
          <ul>{review.auditEvents.map((event, index) => <li key={`${event.createdAt}:${index}`}>{event.event} · {event.createdAt}</li>)}</ul>
        </>
      )}
      {error === undefined ? null : <p role="alert">{t('Trust operation failed: {{error}}', { error })}</p>}
    </section>
  );
}

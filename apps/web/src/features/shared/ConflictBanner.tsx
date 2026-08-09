export function ConflictBanner({ revision, onReload, onRetry }: {
  revision: number;
  onReload: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="conflict-banner" role="alert">
      <p>Server revision {revision} is newer. Your local draft is preserved.</p>
      <button type="button" onClick={onReload}>Reload server version</button>
      <button type="button" onClick={onRetry}>Retry with server revision</button>
    </div>
  );
}

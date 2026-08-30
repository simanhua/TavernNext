export type RuntimePanelIconKind = 'configuration' | 'memory' | 'inspector';

export function RuntimePanelIcon({ kind }: { kind: RuntimePanelIconKind }) {
  return (
    <svg
      className="runtime-panel-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {kind === 'configuration' ? (
        <>
          <path d="M5 4v5h14V4M5 4h3v3h3V4h2v3h3V4h3" />
          <path d="M7 9v8l-2 3h14l-2-3V9" />
        </>
      ) : kind === 'memory' ? (
        <>
          <path d="M12 3 21 12 12 21 3 12Z" />
          <circle cx="12" cy="12" r="2.5" />
        </>
      ) : (
        <>
          <circle cx="12" cy="12" r="8.5" />
          <circle cx="12" cy="12" r="4.5" />
          <circle cx="12" cy="12" r="1" />
        </>
      )}
    </svg>
  );
}

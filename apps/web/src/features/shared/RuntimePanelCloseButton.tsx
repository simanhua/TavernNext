export function RuntimePanelCloseButton({ label, text }: { label: string; text: string }) {
  return (
    <button
      type="button"
      className="runtime-panel-close"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const panel = event.currentTarget.closest('details');
        if (panel === null) return;
        panel.open = false;
        panel.querySelector<HTMLElement>('summary')?.focus();
      }}
    >
      <span aria-hidden="true">×</span>
      <span>{text}</span>
    </button>
  );
}

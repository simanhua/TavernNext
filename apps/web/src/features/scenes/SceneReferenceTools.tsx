import type { SceneReferenceKind } from '@tavernnext/domain';
import { useI18n } from '../../app/i18n.js';
import { useDraggableFloating } from '../shared/useDraggableFloating.js';

export function SceneReferenceTools({ onOpen }: { onOpen(kind: SceneReferenceKind): void }) {
  const { t } = useI18n();
  const floating = useDraggableFloating<HTMLElement>();
  return (
    <nav
      ref={floating.ref}
      style={floating.style}
      className="scene-reference-tools"
      aria-label={t('Runtime references')}
      {...floating.dragProps}
    >
      <button type="button" onClick={() => onOpen('preset')}>{t('View Preset')}</button>
      <button type="button" onClick={() => onOpen('worldbook')}>{t('View Worldbooks')}</button>
    </nav>
  );
}

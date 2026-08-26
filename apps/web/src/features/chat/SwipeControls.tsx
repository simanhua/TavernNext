import type { MessageView } from '../../api/client.js';
import { useI18n } from '../../app/i18n.js';

interface SwipeControlsProps {
  message: MessageView;
  selectionDisabled: boolean;
  generationDisabled: boolean;
  onSelect(variantId: string): void;
  onGenerate(mode: 'swipe' | 'regenerate'): void;
}

export function SwipeControls({ message, selectionDisabled, generationDisabled, onSelect, onGenerate }: SwipeControlsProps) {
  const { t } = useI18n();
  if (message.role !== 'assistant' || message.variants.length === 0) return null;
  const variants = [...message.variants].sort((left, right) => left.ordinal - right.ordinal
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id));
  const activeIndex = Math.max(0, variants.findIndex((variant) => variant.id === message.activeVariantId));
  const previous = variants[activeIndex - 1];
  const next = variants[activeIndex + 1];
  return (
    <div className="swipe-controls" aria-label={t('Response variants')}>
      <button
        type="button"
        aria-label={t('Previous variant')}
        disabled={selectionDisabled || previous === undefined}
        onClick={() => previous !== undefined && onSelect(previous.id)}
      >←</button>
      <span aria-live="polite">{activeIndex + 1} / {variants.length}</span>
      <button
        type="button"
        aria-label={t('Next variant')}
        disabled={selectionDisabled || next === undefined}
        onClick={() => next !== undefined && onSelect(next.id)}
      >→</button>
      <button type="button" disabled={generationDisabled} onClick={() => onGenerate('swipe')}>{t('Swipe response')}</button>
      <button type="button" disabled={generationDisabled} onClick={() => onGenerate('regenerate')}>{t('Regenerate response')}</button>
    </div>
  );
}

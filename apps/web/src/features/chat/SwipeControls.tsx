import type { MessageView } from '../../api/client.js';

interface SwipeControlsProps {
  message: MessageView;
  selectionDisabled: boolean;
  generationDisabled: boolean;
  onSelect(variantId: string): void;
  onGenerate(mode: 'swipe' | 'regenerate' | 'continue'): void;
}

export function SwipeControls({ message, selectionDisabled, generationDisabled, onSelect, onGenerate }: SwipeControlsProps) {
  if (message.role !== 'assistant' || message.variants.length === 0) return null;
  const activeIndex = Math.max(0, message.variants.findIndex((variant) => variant.id === message.activeVariantId));
  const previous = message.variants[activeIndex - 1];
  const next = message.variants[activeIndex + 1];
  return (
    <div className="swipe-controls" aria-label="Response variants">
      <button
        type="button"
        aria-label="Previous variant"
        disabled={selectionDisabled || previous === undefined}
        onClick={() => previous !== undefined && onSelect(previous.id)}
      >←</button>
      <span aria-live="polite">{activeIndex + 1} / {message.variants.length}</span>
      <button
        type="button"
        aria-label="Next variant"
        disabled={selectionDisabled || next === undefined}
        onClick={() => next !== undefined && onSelect(next.id)}
      >→</button>
      <button type="button" disabled={generationDisabled} onClick={() => onGenerate('swipe')}>Swipe response</button>
      <button type="button" disabled={generationDisabled} onClick={() => onGenerate('regenerate')}>Regenerate response</button>
      <button type="button" disabled={generationDisabled} onClick={() => onGenerate('continue')}>Continue response</button>
    </div>
  );
}

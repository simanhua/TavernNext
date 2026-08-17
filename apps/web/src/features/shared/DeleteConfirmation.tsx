import * as Dialog from '@radix-ui/react-dialog';
import { useI18n } from '../../app/i18n.js';

export function DeleteConfirmation({ noun, open, pending, onOpenChange, onConfirm }: {
  noun: string;
  open: boolean;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const translatedNoun = t(noun);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content" aria-describedby={undefined}>
          <Dialog.Title>{t('Delete {{noun}}?', { noun: translatedNoun })}</Dialog.Title>
          <p>{t('This action cannot be undone.')}</p>
          <div className="dialog-actions">
            <Dialog.Close asChild><button type="button">{t('Cancel')}</button></Dialog.Close>
            <button type="button" disabled={pending} onClick={onConfirm}>{t('Confirm delete {{noun}}', { noun: translatedNoun })}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

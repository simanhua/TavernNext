import * as Dialog from '@radix-ui/react-dialog';

export function DeleteConfirmation({ noun, open, pending, onOpenChange, onConfirm }: {
  noun: string;
  open: boolean;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content" aria-describedby={undefined}>
          <Dialog.Title>Delete {noun}?</Dialog.Title>
          <p>This action cannot be undone.</p>
          <div className="dialog-actions">
            <Dialog.Close asChild><button type="button">Cancel</button></Dialog.Close>
            <button type="button" disabled={pending} onClick={onConfirm}>Confirm delete {noun}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

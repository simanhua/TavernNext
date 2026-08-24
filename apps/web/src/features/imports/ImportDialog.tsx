import * as Dialog from '@radix-ui/react-dialog';
import { useId, useRef, useState } from 'react';
import { api, errorCode, type ImportPreview as ImportPreviewData, type ImportReceipt } from '../../api/client.js';
import { ImportPreview } from './ImportPreview.js';
import { useI18n } from '../../app/i18n.js';
import { ExtensionTrustPanel } from '../extensions/ExtensionTrustPanel.js';

export interface ImportDialogProps {
  open: boolean;
  expectedKind: 'character' | 'persona' | 'preset' | 'worldbook' | 'chat';
  title: string;
  onOpenChange: (open: boolean) => void;
  onCommitted: (receipt: ImportReceipt) => void;
  commitImport?: (inspectionToken: string) => Promise<ImportReceipt>;
}

export function ImportDialog({ open, expectedKind, title, onOpenChange, onCommitted, commitImport = api.commitImport }: ImportDialogProps) {
  const { t } = useI18n();
  const inputId = useId();
  const [preview, setPreview] = useState<ImportPreviewData>();
  const [inspectError, setInspectError] = useState<string>();
  const [commitError, setCommitError] = useState<string>();
  const [inspecting, setInspecting] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [committed, setCommitted] = useState<ImportReceipt>();
  const inspectionEpoch = useRef(0);
  const committingRef = useRef(false);

  const reset = () => {
    inspectionEpoch.current += 1;
    committingRef.current = false;
    setPreview(undefined);
    setInspectError(undefined);
    setCommitError(undefined);
    setInspecting(false);
    setCommitting(false);
    setCommitted(undefined);
  };
  const changeOpen = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };
  const inspect = async (file: File | undefined) => {
    if (file === undefined || inspecting) return;
    const operation = ++inspectionEpoch.current;
    setInspecting(true);
    setInspectError(undefined);
    setCommitError(undefined);
    setPreview(undefined);
    try {
      const result = await api.inspectImport(file);
      if (inspectionEpoch.current === operation) setPreview(result);
    } catch (error) {
      if (inspectionEpoch.current === operation) setInspectError(errorCode(error));
    } finally {
      if (inspectionEpoch.current === operation) setInspecting(false);
    }
  };
  const commit = async () => {
    const inspected = preview;
    if (inspected === undefined) return;
    const token = inspected.inspectionToken;
    if (token === undefined || committingRef.current || inspected.blockingErrors.length > 0 || inspected.detected.kind !== expectedKind) return;
    const operation = ++inspectionEpoch.current;
    committingRef.current = true;
    setCommitting(true);
    setCommitError(undefined);
    try {
      const receipt = await commitImport(token);
      if (inspectionEpoch.current !== operation) return;
      onCommitted(receipt);
      if ((expectedKind === 'character' || expectedKind === 'preset') && receipt.entityId !== undefined) {
        setCommitted(receipt);
        setPreview(undefined);
      } else {
        changeOpen(false);
      }
    } catch (error) {
      if (inspectionEpoch.current !== operation) return;
      setCommitError(errorCode(error));
    } finally {
      if (inspectionEpoch.current === operation) {
        committingRef.current = false;
        setCommitting(false);
      }
    }
  };
  const canCommit = preview?.inspectionToken !== undefined
    && preview.blockingErrors.length === 0
    && preview.detected.kind === expectedKind
    && !inspecting
    && !committing;

  return (
    <Dialog.Root open={open} onOpenChange={changeOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content" aria-describedby={undefined}>
          <Dialog.Title>{title}</Dialog.Title>
          {committed === undefined ? <><label
            className="import-drop-zone"
            data-testid="import-drop-zone"
            htmlFor={inputId}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              void inspect(event.dataTransfer.files[0]);
            }}
          >
            {t('Choose a file')}
            <input id={inputId} aria-label={t('Choose a file')} type="file" onChange={(event) => void inspect(event.target.files?.[0])} />
            <span>{t('or drag and drop it here')}</span>
          </label>
          {inspecting ? <p role="status">{t('Inspecting locally staged upload…')}</p> : null}
          {inspectError === undefined ? null : <p role="alert">{inspectError}</p>}
          {preview === undefined ? null : <ImportPreview preview={preview} expectedKind={expectedKind} />}
          {commitError === undefined ? null : <p role="alert">{commitError}</p>}
          <div className="dialog-actions">
            <button type="button" onClick={() => changeOpen(false)}>{t('Cancel import')}</button>
            <button type="button" disabled={!canCommit} onClick={() => void commit()}>{t(committing ? 'Committing…' : 'Commit import')}</button>
          </div></> : <>
            <p role="status">{t('Import complete. Review executable resources once before using them automatically.')}</p>
            <ExtensionTrustPanel
              ownerKind={expectedKind as 'character' | 'preset'}
              ownerId={committed.entityId!}
              autoRefresh
              onReview={(review) => {
                if (review.scripts.length === 0 && review.remotes.length === 0) changeOpen(false);
              }}
              onTrusted={() => changeOpen(false)}
            />
            <div className="dialog-actions">
              <button type="button" onClick={() => changeOpen(false)}>{t('Finish without granting trust')}</button>
            </div>
          </>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

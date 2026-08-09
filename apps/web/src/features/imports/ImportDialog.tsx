import * as Dialog from '@radix-ui/react-dialog';
import { useId, useRef, useState } from 'react';
import { api, errorCode, type ImportPreview as ImportPreviewData, type ImportReceipt } from '../../api/client.js';
import { ImportPreview } from './ImportPreview.js';

export interface ImportDialogProps {
  open: boolean;
  expectedKind: 'character' | 'persona' | 'preset' | 'worldbook' | 'chat';
  title: string;
  onOpenChange: (open: boolean) => void;
  onCommitted: (receipt: ImportReceipt) => void;
}

export function ImportDialog({ open, expectedKind, title, onOpenChange, onCommitted }: ImportDialogProps) {
  const inputId = useId();
  const [preview, setPreview] = useState<ImportPreviewData>();
  const [inspectError, setInspectError] = useState<string>();
  const [commitError, setCommitError] = useState<string>();
  const [inspecting, setInspecting] = useState(false);
  const [committing, setCommitting] = useState(false);
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
      const receipt = await api.commitImport(token);
      if (inspectionEpoch.current !== operation) return;
      onCommitted(receipt);
      changeOpen(false);
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
          <label
            className="import-drop-zone"
            data-testid="import-drop-zone"
            htmlFor={inputId}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              void inspect(event.dataTransfer.files[0]);
            }}
          >
            Choose a file
            <input id={inputId} aria-label="Choose a file" type="file" onChange={(event) => void inspect(event.target.files?.[0])} />
            <span>or drag and drop it here</span>
          </label>
          {inspecting ? <p role="status">Inspecting locally staged upload…</p> : null}
          {inspectError === undefined ? null : <p role="alert">{inspectError}</p>}
          {preview === undefined ? null : <ImportPreview preview={preview} expectedKind={expectedKind} />}
          {commitError === undefined ? null : <p role="alert">{commitError}</p>}
          <div className="dialog-actions">
            <button type="button" onClick={() => changeOpen(false)}>Cancel import</button>
            <button type="button" disabled={!canCommit} onClick={() => void commit()}>{committing ? 'Committing…' : 'Commit import'}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

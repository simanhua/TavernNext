// @vitest-environment jsdom

import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { useState } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderWithApp } from '../../test/render.js';
import { ImportDialog } from './ImportDialog.js';

const validPreview = {
  source: { fileName: 'aster.png', mediaType: 'image/png', size: 321, sha256: 'a'.repeat(64) },
  detected: { container: 'png', kind: 'character', version: 'v3', candidates: ['character'] },
  normalizedPreview: {
    character: {
      name: 'Aster', alternateGreetings: ['Welcome'], tags: ['archivist'],
      characterBook: { entries: [{ id: 1 }, { id: 2 }] },
      extensions: { rawPayload: 'must-not-render-import-raw-payload' },
    },
    auxiliaryAssets: [{ path: 'portrait.webp' }],
    stagedPath: 'C:\\private\\stage\\original.bin',
  },
  warnings: [{ code: 'future_field_preserved', message: 'One future field will be preserved.' }],
  blockingErrors: [],
  inspectionToken: 'opaque-token',
  expiresAt: '2026-08-08T00:15:00.000Z',
};

let inspectRequests = 0;
let commitRequests = 0;
let commitMode: 'ok' | 'expired' = 'ok';
let holdInspection = false;
let releaseInspection: (() => void) | undefined;
let holdCommit = false;
let releaseCommit: (() => void) | undefined;

const server = setupServer(
  http.post('/api/imports/inspect', async ({ request }) => {
    inspectRequests += 1;
    if (holdInspection) await new Promise<void>((resolve) => { releaseInspection = resolve; });
    const form = await request.formData();
    const file = form.get('file');
    if (file === null || typeof file === 'string') return HttpResponse.json({ error: 'import_file_required' }, { status: 400 });
    if (file.name === 'broken.charx') {
      return HttpResponse.json({
        source: { fileName: file.name, mediaType: file.type, size: file.size, sha256: 'b'.repeat(64) },
        detected: { container: 'zip', kind: 'unknown', candidates: [] },
        normalizedPreview: null,
        warnings: [],
        blockingErrors: [{ code: 'corrupt_zip', message: 'Archive central directory is corrupt.', path: 'central-directory' }],
      }, { status: 422 });
    }
    return HttpResponse.json({ ...validPreview, source: { ...validPreview.source, fileName: file.name } });
  }),
  http.post('/api/imports/commit', async ({ request }) => {
    commitRequests += 1;
    expect(await request.json()).toEqual({ inspectionToken: 'opaque-token' });
    if (holdCommit) await new Promise<void>((resolve) => { releaseCommit = resolve; });
    if (commitMode === 'expired') {
      return HttpResponse.json({ error: 'inspection_token_expired' }, { status: 410 });
    }
    return HttpResponse.json({
      artifactId: '018f0000-0000-7000-8000-000000000801',
      entityId: '018f0000-0000-7000-8000-000000000802',
      assetPath: 'assets/imports/018f0000-0000-7000-8000-000000000801',
    }, { status: 201 });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup();
  inspectRequests = 0;
  commitRequests = 0;
  commitMode = 'ok';
  holdInspection = false;
  releaseInspection = undefined;
  holdCommit = false;
  releaseCommit = undefined;
  server.resetHandlers();
});
afterAll(() => server.close());

function Harness({ onCommitted = () => undefined }: { onCommitted?: (entityId?: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open import</button>
      <ImportDialog
        open={open}
        expectedKind="character"
        title="Import Character"
        onOpenChange={setOpen}
        onCommitted={(receipt) => onCommitted(receipt.entityId)}
      />
    </>
  );
}

describe('ImportDialog', () => {
  it('discards an in-flight inspection result when cancelled and cannot reuse its token after reopening', async () => {
    const user = userEvent.setup();
    holdInspection = true;
    renderWithApp(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open import' }));
    await user.upload(screen.getByLabelText('Choose a file'), new File(['png'], 'aster.png', { type: 'image/png' }));
    expect(await screen.findByRole('status')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Cancel import' }));
    releaseInspection?.();

    await user.click(screen.getByRole('button', { name: 'Open import' }));
    await waitFor(() => expect(inspectRequests).toBe(1));
    expect(screen.queryByText('Aster')).toBeNull();
    expect((screen.getByRole('button', { name: 'Commit import' }) as HTMLButtonElement).disabled).toBe(true);
    expect(commitRequests).toBe(0);
  });

  it('inspects a Character V3 PNG, cancels without commit, then commits once after a fresh inspection', async () => {
    const user = userEvent.setup();
    const committed = vi.fn();
    renderWithApp(<Harness onCommitted={committed} />);

    await user.click(screen.getByRole('button', { name: 'Open import' }));
    const input = screen.getByLabelText('Choose a file');
    await user.upload(input, new File([new Uint8Array([137, 80, 78, 71])], 'aster.png', { type: 'image/png' }));

    expect(await screen.findByText('Character · PNG · V3')).not.toBeNull();
    expect(screen.getByText('Aster')).not.toBeNull();
    expect(screen.getByText('1 alternate greeting')).not.toBeNull();
    expect(screen.getByText('1 tag')).not.toBeNull();
    expect(screen.getByText('2 embedded worldbook entry')).not.toBeNull();
    expect(screen.getByText('1 auxiliary asset')).not.toBeNull();
    expect(screen.queryByText('must-not-render-import-raw-payload')).toBeNull();
    expect(screen.queryByText('C:\\private\\stage\\original.bin')).toBeNull();
    expect(screen.getByText('One future field will be preserved.')).not.toBeNull();
    expect(screen.queryByText('opaque-token')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Cancel import' }));
    expect(commitRequests).toBe(0);
    expect(committed).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Open import' }));
    await user.upload(screen.getByLabelText('Choose a file'), new File(['png'], 'aster.png', { type: 'image/png' }));
    await screen.findByText('Character · PNG · V3');
    await user.dblClick(screen.getByRole('button', { name: 'Commit import' }));

    await waitFor(() => expect(commitRequests).toBe(1));
    expect(inspectRequests).toBe(2);
    expect(committed).toHaveBeenCalledWith('018f0000-0000-7000-8000-000000000802');
  });

  it('accepts drag and drop but keeps commit disabled for a corrupt archive', async () => {
    const user = userEvent.setup();
    renderWithApp(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open import' }));

    const file = new File(['broken'], 'broken.charx', { type: 'application/zip' });
    fireEvent.drop(screen.getByTestId('import-drop-zone'), { dataTransfer: { files: [file] } });

    expect((await screen.findByRole('alert')).textContent).toContain('Archive central directory is corrupt.');
    expect(screen.getByText('central-directory')).not.toBeNull();
    expect((screen.getByRole('button', { name: 'Commit import' }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
    expect(commitRequests).toBe(0);
  });

  it('shows an expired or replayed-token failure without re-inspecting or auto-committing', async () => {
    const user = userEvent.setup();
    commitMode = 'expired';
    renderWithApp(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open import' }));
    await user.upload(screen.getByLabelText('Choose a file'), new File(['png'], 'aster.png', { type: 'image/png' }));
    await user.click(await screen.findByRole('button', { name: 'Commit import' }));

    expect((await screen.findByRole('alert')).textContent).toContain('inspection_token_expired');
    expect(inspectRequests).toBe(1);
    expect(commitRequests).toBe(1);
    expect((screen.getByRole('button', { name: 'Commit import' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('rejects two same-tick commit clicks synchronously', async () => {
    const user = userEvent.setup();
    holdCommit = true;
    renderWithApp(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open import' }));
    await user.upload(screen.getByLabelText('Choose a file'), new File(['png'], 'aster.png', { type: 'image/png' }));
    const commit = await screen.findByRole('button', { name: 'Commit import' });

    act(() => {
      commit.click();
      commit.click();
    });
    await waitFor(() => expect(commitRequests).toBe(1));
    releaseCommit?.();
  });

  it('ignores a late commit result after cancel and reopen', async () => {
    const user = userEvent.setup();
    const committed = vi.fn();
    holdCommit = true;
    renderWithApp(<Harness onCommitted={committed} />);
    await user.click(screen.getByRole('button', { name: 'Open import' }));
    await user.upload(screen.getByLabelText('Choose a file'), new File(['png'], 'aster.png', { type: 'image/png' }));
    await user.click(await screen.findByRole('button', { name: 'Commit import' }));
    await waitFor(() => expect(commitRequests).toBe(1));
    await user.click(screen.getByRole('button', { name: 'Cancel import' }));
    await user.click(screen.getByRole('button', { name: 'Open import' }));

    releaseCommit?.();
    await act(async () => { await Promise.resolve(); });
    expect(committed).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Import Character' })).not.toBeNull();
    expect((screen.getByRole('button', { name: 'Commit import' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

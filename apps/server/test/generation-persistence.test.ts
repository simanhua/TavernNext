import { afterEach, describe, expect, it } from 'vitest';
import { canonicalHash } from '../src/services/prompt-snapshot-service.js';
import type { Repositories } from '../src/db/repositories.js';
import {
  capturedProvider,
  closePromptIntegrationContexts,
  createPromptIntegrationContext,
  previewPayload,
  requestGeneration,
  requestPreview,
  seedFullPromptGraph,
  unitTokenizerRuntime,
} from './prompt-integration-fixtures.js';

afterEach(closePromptIntegrationContexts);

function parseEventNames(payload: string): string[] {
  return payload.trim().split(/\r?\n\r?\n/).filter(Boolean).map((frame) => {
    const line = frame.split(/\r?\n/).find((candidate) => candidate.startsWith('event: '));
    if (line === undefined) throw new Error(`Malformed SSE frame: ${frame}`);
    return line.slice('event: '.length);
  });
}

function runtimeStates(repositories: Repositories): Array<{ conversationId: string; revision: number; timedState: unknown }> {
  return repositories.worldbookRuntimeStates.list();
}

function createSignedPayload(
  repositories: Repositories,
  sourceSnapshotId: string,
  id: string,
  payload: Record<string, unknown>,
) {
  const source = repositories.generationSnapshots.get(sourceSnapshotId);
  if (source === undefined) throw new Error('Missing source snapshot fixture.');
  return repositories.generationSnapshots.create({
    id,
    conversationId: source.conversationId,
    conversationRevision: source.conversationRevision,
    payload: structuredClone(payload),
  });
}

describe('generation persistence and snapshot trust boundary', () => {
  it('rolls back terminal completion when timed-state persistence faults in the same durable transaction', async () => {
    const provider = capturedProvider([
      { type: 'delta', text: 'Completed before injected fault' },
      { type: 'completed', finishReason: 'stop' },
    ]);
    const { app, database, repositories } = await createPromptIntegrationContext({ provider });
    seedFullPromptGraph(repositories, 'chat');
    const preview = (await requestPreview(app)).json();
    database.sqlite.exec(`
      CREATE TABLE terminal_status_audit (status TEXT NOT NULL);
      CREATE TRIGGER audit_terminal_status AFTER UPDATE OF status ON message_variants
      WHEN NEW.status IN ('completed', 'failed')
      BEGIN INSERT INTO terminal_status_audit(status) VALUES (NEW.status); END;
      CREATE TRIGGER fail_runtime_state BEFORE INSERT ON worldbook_runtime_states
      BEGIN SELECT RAISE(ABORT, 'injected timed-state fault'); END;
    `);

    const response = await requestGeneration(app, preview.snapshotId);

    expect(parseEventNames(response.payload)).toEqual(['started', 'delta', 'failed']);
    expect(database.sqlite.prepare('SELECT status FROM terminal_status_audit ORDER BY rowid').all())
      .toEqual([{ status: 'failed' }]);
    expect(runtimeStates(repositories)).toEqual([]);
    expect(repositories.messageVariants.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: 'Completed before injected fault', status: 'failed' }),
    ]));
  });

  it('rejects mismatched, hash-tampered, malformed, and unsupported snapshots fail-closed', async () => {
    const provider = capturedProvider();
    const { app, database, repositories } = await createPromptIntegrationContext({ provider });
    seedFullPromptGraph(repositories, 'chat');
    const mismatchPreview = (await requestPreview(app)).json();
    const mismatch = await requestGeneration(app, mismatchPreview.snapshotId, { userText: 'Different input' });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json()).toEqual({ error: 'snapshot_mismatch' });

    const tamperedPreview = (await requestPreview(app)).json();
    const row = database.sqlite.prepare('SELECT payload FROM generation_snapshots WHERE id = ?').get(tamperedPreview.snapshotId);
    const entity = JSON.parse(String(row?.payload));
    entity.payload.compiledRequest.messages[0].content = 'TAMPERED';
    database.sqlite.prepare('UPDATE generation_snapshots SET payload = ? WHERE id = ?')
      .run(JSON.stringify(entity), tamperedPreview.snapshotId);
    const tampered = await requestGeneration(app, tamperedPreview.snapshotId);
    expect(tampered.statusCode).toBe(409);
    expect(tampered.json()).toEqual({ error: 'snapshot_invalid' });

    const unsupportedPreview = (await requestPreview(app)).json();
    const unsupportedPayload = structuredClone(unsupportedPreview) as Record<string, unknown>;
    delete unsupportedPayload.snapshotId;
    unsupportedPayload.schemaVersion = 999;
    const unsupportedSnapshot = createSignedPayload(
      repositories, unsupportedPreview.snapshotId,
      '018f1000-0000-7000-8000-000000000301', unsupportedPayload,
    );
    const unsupported = await requestGeneration(app, unsupportedSnapshot.id);
    expect(unsupported.statusCode).toBe(409);
    expect(unsupported.json()).toEqual({ error: 'snapshot_unsupported' });

    const legacyPreview = (await requestPreview(app)).json();
    const legacyPayload = structuredClone(legacyPreview) as Record<string, unknown>;
    delete legacyPayload.snapshotId;
    legacyPayload.schemaVersion = 1;
    const { payloadHash: ignoredLegacyHash, ...legacyWithoutHash } = legacyPayload;
    void ignoredLegacyHash;
    legacyPayload.payloadHash = canonicalHash(legacyWithoutHash);
    const legacySnapshot = createSignedPayload(
      repositories, legacyPreview.snapshotId,
      '018f1000-0000-7000-8000-000000000302', legacyPayload,
    );
    const legacy = await requestGeneration(app, legacySnapshot.id);
    expect(legacy.statusCode).toBe(409);
    expect(legacy.json()).toEqual({ error: 'snapshot_unsupported' });

    const malformedPreview = (await requestPreview(app)).json();
    const malformedSnapshot = createSignedPayload(
      repositories, malformedPreview.snapshotId,
      '018f1000-0000-7000-8000-000000000303', { schemaVersion: 3 },
    );
    const malformed = await requestGeneration(app, malformedSnapshot.id);
    expect(malformed.statusCode).toBe(409);
    expect(malformed.json()).toEqual({ error: 'snapshot_invalid' });

    const malformedEntityPreview = (await requestPreview(app)).json();
    database.sqlite.prepare('UPDATE generation_snapshots SET payload = ? WHERE id = ?')
      .run('{}', malformedEntityPreview.snapshotId);
    const malformedEntityResponse = await requestGeneration(app, malformedEntityPreview.snapshotId);
    expect(malformedEntityResponse.statusCode).toBe(409);
    expect(malformedEntityResponse.json()).toEqual({ error: 'snapshot_invalid' });
    expect(provider.chat).toEqual([]);
    expect(provider.text).toEqual([]);
    expect(repositories.messages.list()).toHaveLength(2);
    expect(runtimeStates(repositories)).toEqual([]);
  });

  it('replays the self-contained v3 artifact after tokenizer/compiler runtime becomes unavailable', async () => {
    const provider = capturedProvider([{ type: 'completed', finishReason: 'stop' }]);
    let runtimeAvailable = true;
    let runtimeCalls = 0;
    const delegate = unitTokenizerRuntime();
    const tokenizerRuntime = unitTokenizerRuntime({
      selectTokenizer(input) {
        runtimeCalls += 1;
        if (!runtimeAvailable) throw new Error('tokenizer runtime unavailable after preview');
        return delegate.selectTokenizer(input);
      },
      async countText(text, decision) {
        runtimeCalls += 1;
        if (!runtimeAvailable) throw new Error('tokenizer runtime unavailable after preview');
        return delegate.countText(text, decision);
      },
      async countMessages(messages, decision) {
        runtimeCalls += 1;
        if (!runtimeAvailable) throw new Error('tokenizer runtime unavailable after preview');
        return delegate.countMessages(messages, decision);
      },
    });
    const { app, repositories } = await createPromptIntegrationContext({ provider, tokenizerRuntime });
    seedFullPromptGraph(repositories, 'chat');
    const preview = (await requestPreview(app)).json();
    expect(preview.schemaVersion).toBe(3);
    const callsAfterPreview = runtimeCalls;
    runtimeAvailable = false;

    const response = await requestGeneration(app, preview.snapshotId);

    expect(response.statusCode).toBe(200);
    expect(runtimeCalls).toBe(callsAfterPreview);
    expect(provider.chat).toEqual([preview.compiledRequest]);
  });

  it.each([
    ['token ledger', (payload: Record<string, unknown>) => {
      payload.tokenBreakdown = [{ source: 7, includedTokens: 0, omittedTokens: 0 }];
    }],
    ['Worldbook ledger', (payload: Record<string, unknown>) => {
      (payload.worldbook as Record<string, unknown>).activated = [{ entryKey: 'incomplete' }];
    }],
    ['tokenizer decision', (payload: Record<string, unknown>) => {
      (payload.tokenizerDecision as Record<string, unknown>).warning = 42;
    }],
    ['executable audit unknown field', (payload: Record<string, unknown>) => {
      const executable = payload.executable as Record<string, unknown>;
      const character = executable.character as Record<string, unknown>;
      character.unknownExecutableField = 'hash-consistent-tamper';
    }],
    ['executable audit version', (payload: Record<string, unknown>) => {
      const executable = payload.executable as Record<string, unknown>;
      executable.schemaVersion = 999;
    }],
    ['Worldbook manifest binding', (payload: Record<string, unknown>) => {
      const executable = payload.executable as Record<string, unknown>;
      const worldbooks = executable.worldbooks as Array<Record<string, unknown>>;
      const book = worldbooks.find((candidate) => candidate.source !== 'embedded')!;
      const executableBook = book.book as Record<string, unknown>;
      const entries = executableBook.entries as Array<Record<string, unknown>>;
      entries[0]!.id = 'hash-consistent-mismatched-entry';
    }],
  ] as const)('rejects a hash-consistent malformed nested %s before provider execution', async (_label, mutate) => {
    const provider = capturedProvider();
    const { app, database, repositories } = await createPromptIntegrationContext({ provider });
    seedFullPromptGraph(repositories, 'chat');
    const preview = (await requestPreview(app)).json();
    const payload = structuredClone(preview) as Record<string, unknown>;
    delete payload.snapshotId;
    mutate(payload);
    const { payloadHash: ignoredPayloadHash, ...withoutPayloadHash } = payload;
    void ignoredPayloadHash;
    payload.payloadHash = canonicalHash(withoutPayloadHash);
    const signed = createSignedPayload(
      repositories, preview.snapshotId,
      `018f1000-0000-7000-8000-00000000031${String(_label.length % 10)}`, payload,
    );

    const response = await requestGeneration(app, signed.id);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'snapshot_invalid' });
    expect(provider.chat).toEqual([]);
    expect(provider.text).toEqual([]);
    expect(repositories.messages.list()).toHaveLength(2);
    expect(runtimeStates(repositories)).toEqual([]);
  });

  it('rejects a self-consistent manifest that omits a current executable Worldbook relation', async () => {
    const provider = capturedProvider();
    const { app, database, repositories } = await createPromptIntegrationContext({ provider });
    seedFullPromptGraph(repositories, 'chat');
    const preview = (await requestPreview(app)).json();
    const payload = structuredClone(preview) as Record<string, unknown>;
    delete payload.snapshotId;
    const manifest = payload.entityRevisions as Record<string, unknown>;
    const books = manifest.worldbooks as Array<Record<string, unknown>>;
    const omitted = books.shift()!;
    const executable = payload.executable as Record<string, unknown>;
    executable.entityRevisions = structuredClone(manifest);
    executable.worldbooks = (executable.worldbooks as Array<Record<string, unknown>>)
      .filter((book) => book.source === 'embedded' || book.id !== omitted.id);
    const { payloadHash: ignoredPayloadHash, ...withoutPayloadHash } = payload;
    void ignoredPayloadHash;
    payload.payloadHash = canonicalHash(withoutPayloadHash);
    const signed = createSignedPayload(
      repositories, preview.snapshotId,
      '018f1000-0000-7000-8000-000000000320', payload,
    );

    const response = await requestGeneration(app, signed.id);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'snapshot_stale' });
    expect(provider.chat).toEqual([]);
    expect(provider.text).toEqual([]);
    expect(repositories.messages.list()).toHaveLength(2);
  });

  it('accepts the existing generation API by atomically creating the same immutable snapshot', async () => {
    const provider = capturedProvider([{ type: 'completed', finishReason: 'stop' }]);
    const { app, repositories } = await createPromptIntegrationContext({ provider });
    seedFullPromptGraph(repositories, 'chat');

    const response = await requestGeneration(app);

    expect(response.statusCode).toBe(200);
    expect(provider.chat).toHaveLength(1);
    expect(repositories.generationSnapshots.list()).toHaveLength(1);
    const snapshot = repositories.generationSnapshots.list()[0]!;
    expect(snapshot.payload).toMatchObject({
      input: previewPayload(),
      compiledRequest: provider.chat[0],
      compiledRequestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
});

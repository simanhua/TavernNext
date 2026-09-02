import { describe, expect, it } from 'vitest';
import {
  CharacterSchema,
  CompatibilityMetadataSchema,
  ConversationSchema,
  GenerationRequestSchema,
  MessageVariantSchema,
  roleplayDocumentFromMarkdown,
  roleplayDocumentPlainText,
  RoleplayDocumentSchema,
  replaceRoleplayActionOptions,
  appendRoleplayMarkdown,
  SceneManifestSchema,
} from '../src/index.js';

describe('domain contracts', () => {
  it('makes the Roleplay Document canonical and derives the plain assistant projection', () => {
    const base = {
      id: '018f0000-0000-7000-8000-000000000006',
      revision: 0,
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:00:00.000Z',
      messageId: '018f0000-0000-7000-8000-000000000007',
      ordinal: 0,
      content: 'First\n\nSecond',
      status: 'completed',
    };
    expect(MessageVariantSchema.parse(base).document).toEqual(
      roleplayDocumentFromMarkdown(base.content),
    );
    const document = {
      version: 1 as const,
      blocks: [
        { type: 'markdown' as const, content: 'First' },
        { type: 'markdown' as const, content: '\n\nSecond' },
      ],
    };
    expect(roleplayDocumentPlainText(document)).toBe(base.content);
    const withView = RoleplayDocumentSchema.parse({
      version: 1,
      blocks: [
        { type: 'markdown', content: 'Before ' },
        {
          type: 'scene-view', viewId: '018f0000-0000-7000-8000-000000000008',
          sceneId: '018f0000-0000-7000-8000-000000000009', sceneVersion: '1.0.0',
          sceneDigest: 'a'.repeat(64), kind: 'combat', schemaVersion: 1,
          rendererId: 'combat-v1', sourceStateRevision: 4, props: { hp: 7 },
        },
        { type: 'markdown', content: 'after' },
      ],
    });
    expect(roleplayDocumentPlainText(withView)).toBe('Before after');
    const withOptions = replaceRoleplayActionOptions(withView, [
      { id: 'option-1', kind: 'smooth', text: 'Observe the gate.' },
      { id: 'option-2', kind: 'smooth', text: 'Ask the guide.' },
      { id: 'option-3', kind: 'engage', text: 'Challenge the warning.' },
      { id: 'option-4', kind: 'advance', text: 'Enter the city at dawn.' },
      { id: 'option-5', kind: 'mainline', text: 'Follow the hidden clue.' },
      { id: 'option-6', kind: 'twist', text: 'Trust the unexpected rival.' },
      { id: 'option-7', kind: 'dark', text: 'Take the forbidden road.' },
    ]);
    expect(withOptions.blocks.at(-1)).toMatchObject({ type: 'action-options', options: expect.any(Array) });
    expect(roleplayDocumentPlainText(withOptions)).toBe('Before after');
    expect(replaceRoleplayActionOptions(withOptions, []).blocks).toEqual(withView.blocks);
    expect(appendRoleplayMarkdown(withView, ' continued').blocks).toEqual([
      ...withView.blocks.slice(0, -1),
      { type: 'markdown', content: 'after continued' },
    ]);
    expect(MessageVariantSchema.parse({ ...base, document }).content).toBe(base.content);
    expect(MessageVariantSchema.safeParse({ ...base, document, content: 'diverged' }).success).toBe(false);
    const legacyUnboundedContent = 'x'.repeat(4 * 1024 * 1024 + 1);
    expect(roleplayDocumentPlainText(roleplayDocumentFromMarkdown(legacyUnboundedContent)))
      .toHaveLength(legacyUnboundedContent.length);
  });

  it('retains unknown compatibility fields verbatim', () => {
    const metadata = CompatibilityMetadataSchema.parse({
      sourceFormat: 'st-character-v3',
      rawPayload: { future: true },
      unknownFields: { future: true },
      compatWarnings: [],
      parserVersion: '1',
    });

    expect(metadata.unknownFields).toEqual({ future: true });
  });

  it('accepts every planned generation mode', () => {
    expect(GenerationRequestSchema.parse({
      conversationId: '018f0000-0000-7000-8000-000000000001',
      conversationRevision: 3,
      mode: 'swipe',
    }).mode).toBe('swipe');
  });

  it('keeps the Worldbook depth prompt in a dedicated typed Character field', () => {
    const character = CharacterSchema.parse({
      id: '018f0000-0000-7000-8000-000000000002', revision: 0,
      createdAt: '2026-08-08T00:00:00.000Z', updatedAt: '2026-08-08T00:00:00.000Z',
      name: 'Aster', description: '', personality: '', scenario: '', firstMessage: '',
      alternateGreetings: [], tags: [], depthPrompt: 'Depth only',
      extensions: { depth_prompt: ['malformed legacy value'], arbitrary_export_field: { keep: true } },
    });

    expect(character.depthPrompt).toBe('Depth only');
    expect(character.extensions).toEqual({
      depth_prompt: ['malformed legacy value'], arbitrary_export_field: { keep: true },
    });
  });

  it('defaults to large reasoning-capable token budgets and rejects values above the UI limits', () => {
    const base = {
      id: '018f0000-0000-7000-8000-000000000003', revision: 0,
      createdAt: '2026-08-08T00:00:00.000Z', updatedAt: '2026-08-08T00:00:00.000Z',
      characterId: '018f0000-0000-7000-8000-000000000004',
      personaId: '018f0000-0000-7000-8000-000000000005', title: 'Large context chat',
    };
    expect(ConversationSchema.parse(base)).toMatchObject({
      maxPromptTokens: 128_000,
      maxResponseTokens: 32_768,
    });
    expect(ConversationSchema.safeParse({ ...base, maxPromptTokens: 1_000_001 }).success).toBe(false);
    expect(ConversationSchema.safeParse({ ...base, maxResponseTokens: 384_001 }).success).toBe(false);
  });

  it('accepts only declared browser-ready Scene SDK v2 module assets', () => {
    const manifest = {
      id: '018f2000-0000-7000-8000-000000000001',
      slug: 'top-level-scene',
      version: '2.0.0',
      name: 'Top-level Scene',
      summary: '',
      description: '',
      author: 'TavernNext',
      minimumTavernNextVersion: '1.0.0',
      sceneSdkVersion: 2,
      frontendEntry: 'frontend/app.js',
      frontendStyles: ['frontend/styles.css'],
      setupSchema: {},
      stateSchema: {},
      files: ['frontend/app.js', 'frontend/styles.css'],
    };
    expect(SceneManifestSchema.parse(manifest)).toMatchObject({ sceneSdkVersion: 2, agentTools: [], sceneViews: [] });
    const tool = {
      name: 'scene_open_gate',
      description: 'Open one Scene gate.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['gate'],
        properties: { gate: { type: 'string' } },
      },
    };
    expect(SceneManifestSchema.parse({ ...manifest, agentTools: [tool] }).agentTools).toEqual([tool]);
    expect(SceneManifestSchema.safeParse({ ...manifest, agentTools: [tool, tool] }).success).toBe(false);
    expect(SceneManifestSchema.safeParse({
      ...manifest, agentTools: [{ ...tool, parameters: { type: 'string' } }],
    }).success).toBe(false);
    const view = {
      kind: 'combat', schemaVersion: 1,
      projection: { hook: 'projectSceneView', schema: { type: 'object' } },
      renderer: { id: 'combat-v1' },
    } as const;
    expect(SceneManifestSchema.parse({ ...manifest, sceneViews: [view] }).sceneViews).toEqual([view]);
    expect(SceneManifestSchema.safeParse({ ...manifest, sceneViews: [view, view] }).success).toBe(false);
    expect(SceneManifestSchema.safeParse({ ...manifest, sceneSdkVersion: 1 }).success).toBe(false);
    expect(SceneManifestSchema.safeParse({ ...manifest, frontendEntry: 'frontend/index.html' }).success).toBe(false);
    expect(SceneManifestSchema.safeParse({ ...manifest, frontendEntry: '../app.js' }).success).toBe(false);
    expect(SceneManifestSchema.safeParse({ ...manifest, files: ['frontend/app.js'] }).success).toBe(false);
  });
});

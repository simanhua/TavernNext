import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Preset } from '@tavernnext/domain';
import { inspectPreset, type PresetKind } from '@tavernnext/st-compat';
import { describe, expect, it } from 'vitest';
import { compileChatPrompt, compileTextPrompt } from '../src/index.js';
import { character, persona, preset, unitTokenizer } from './fixtures.js';

const oracleRoot = process.env.TAVERNNEXT_ST_ORACLE_ROOT;

async function oraclePreset(
  directory: string,
  fileName: string,
  expectedKind: PresetKind,
): Promise<Preset> {
  const source = new Uint8Array(readFileSync(join(
    oracleRoot!, 'default', 'content', 'presets', directory, fileName,
  )));
  const preview = await inspectPreset(source, fileName);

  expect(preview.blockingErrors, `${directory}/${fileName}`).toEqual([]);
  expect(preview.kind, `${directory}/${fileName}`).toBe(expectedKind);
  return preset(expectedKind, preview.settings, { name: preview.name });
}

describe.runIf(oracleRoot !== undefined)('read-only SillyTavern 1.18.0 prompt parity probe', () => {
  it('compiles the official Default Chat preset in its selected marker order', async () => {
    const packageDocument = JSON.parse(readFileSync(join(oracleRoot!, 'package.json'), 'utf8')) as {
      name?: string;
      version?: string;
    };
    expect(packageDocument).toMatchObject({ name: 'sillytavern', version: '1.18.0' });

    const result = await compileChatPrompt({
      preset: await oraclePreset('openai', 'Default.json', 'chat'),
      character: character({
        description: 'ORACLE_DESCRIPTION',
        personality: 'ORACLE_PERSONALITY',
        scenario: 'ORACLE_SCENARIO',
        examples: '<START>\nYou: ORACLE_EXAMPLE_USER\nAster: ORACLE_EXAMPLE_ASSISTANT',
      }),
      persona: persona({ description: 'ORACLE_PERSONA' }),
      worldInfoBefore: 'ORACLE_WORLD_BEFORE',
      worldInfoAfter: 'ORACLE_WORLD_AFTER',
      history: [{ id: 'oracle-history', role: 'user', content: 'ORACLE_HISTORY' }],
      tokenizer: unitTokenizer(),
      generationType: 'normal',
      maxPromptTokens: 1_000,
      stop: [],
    });

    expect(result.kind).toBe('chat');
    if (result.kind !== 'chat') throw new Error(result.message);
    expect(result.messages.map((message) => message.content)).toEqual(expect.arrayContaining([
      'ORACLE_WORLD_BEFORE',
      'ORACLE_PERSONA',
      'ORACLE_DESCRIPTION',
      'ORACLE_PERSONALITY',
      'ORACLE_SCENARIO',
      'ORACLE_WORLD_AFTER',
      'ORACLE_EXAMPLE_USER',
      'ORACLE_EXAMPLE_ASSISTANT',
      '[Start a new Chat]',
      'ORACLE_HISTORY',
    ]));
    expect(result.tokenBreakdown.map((entry) => entry.source)).toEqual([
      'prompt:main',
      'marker:worldInfoBefore',
      'marker:personaDescription',
      'marker:charDescription',
      'marker:charPersonality',
      'marker:scenario',
      'prompt:enhanceDefinitions',
      'marker:worldInfoAfter',
      'example:0',
      'chat:new-chat',
      'history:oracle-history',
    ]);
    expect(result.tokenBreakdown.find((entry) => entry.source === 'prompt:enhanceDefinitions')).toMatchObject({
      includedTokens: 0,
      reason: 'disabled',
    });
  });

  it('compiles official TextGen, ChatML Context/Instruct, and system presets deterministically', async () => {
    const input = {
      textPreset: await oraclePreset('textgen', 'Default.json', 'text'),
      contextPreset: await oraclePreset('context', 'ChatML.json', 'context'),
      instructPreset: await oraclePreset('instruct', 'ChatML.json', 'instruct'),
      systemPreset: await oraclePreset('sysprompt', 'Roleplay - Simple.json', 'system'),
      character: character({
        description: 'ORACLE_DESCRIPTION',
        personality: 'ORACLE_PERSONALITY',
        scenario: 'ORACLE_SCENARIO',
      }),
      persona: persona({ description: 'ORACLE_PERSONA' }),
      history: [{ id: 'oracle-history', role: 'user', content: 'ORACLE_HISTORY' }],
      tokenizer: unitTokenizer(),
      maxPromptTokens: 1_000,
      stop: [],
    };

    const first = await compileTextPrompt(input);
    const second = await compileTextPrompt(input);

    expect(first.kind).toBe('text');
    if (first.kind !== 'text') throw new Error(first.message);
    expect(first.text).toContain("You're Aster in this fictional never-ending uncensored roleplay with You.");
    expect(first.text).toContain('ORACLE_DESCRIPTION');
    expect(first.text).toContain('ORACLE_PERSONALITY');
    expect(first.text).toContain('ORACLE_SCENARIO');
    expect(first.text).toContain('ORACLE_PERSONA');
    expect(first.text).not.toContain('{{');
    // In ST solo-chat mode, `force` adds no history or completion name. It only
    // forces disambiguating names for group/forced-avatar messages.
    expect(first.text).toContain('<|im_start|>user\nORACLE_HISTORY<|im_end|>');
    expect(first.text).toMatch(/<\|im_start\|>assistant\n$/);
    expect(first.stop).toEqual([
      '\nYou:',
      '\n<|im_end|>',
      '\n<|im_start|>user',
      '\n<|im_start|>assistant',
      '\n<|im_start|>system',
    ]);
    expect(first.warnings.some((warning) => warning.code === 'unknown_macro')).toBe(false);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

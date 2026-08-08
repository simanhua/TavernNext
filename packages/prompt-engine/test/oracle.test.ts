import { describe, expect, it } from 'vitest';
import { compileChatPrompt, compileTextPrompt } from '../src/index.js';
import {
  loadSillyTavern118Oracle,
  SILLY_TAVERN_118_FIXTURE,
} from './st-1.18-oracle-harness.js';
import { character, persona, preset, unitTokenizer } from './fixtures.js';

const oracleRoot = process.env.TAVERNNEXT_ST_ORACLE_ROOT;

describe.runIf(oracleRoot !== undefined)('read-only SillyTavern 1.18.0 prompt parity oracle', () => {
  it('matches complete Chat requests for DEFAULT, CONTENT+squash+duplicate, and COMPLETION names', async () => {
    const oracle = await loadSillyTavern118Oracle(oracleRoot!);
    expect(oracle.provenance).toMatchObject({
      packageName: 'sillytavern',
      version: '1.18.0',
      execution: 'read-only hash-pinned upstream prompt orchestration',
      orchestration: {
        chat: ['setOpenAIMessages', 'setOpenAIMessageExamples', 'prepareOpenAIMessages'],
        textSlice: {
          source: 'public/script.js',
          start: "if (main_api !== 'openai' && power_user.sysprompt.enabled)",
          end: 'finalPrompt = eventData.prompt',
        },
      },
    });

    for (const oracleCase of oracle.chatCases) {
      const result = await compileChatPrompt({
        preset: preset('chat', oracleCase.settings, { name: oracleCase.label }),
        character: character(SILLY_TAVERN_118_FIXTURE.character),
        persona: persona(SILLY_TAVERN_118_FIXTURE.persona),
        worldInfoBefore: SILLY_TAVERN_118_FIXTURE.worldInfoBefore,
        worldInfoAfter: SILLY_TAVERN_118_FIXTURE.worldInfoAfter,
        history: SILLY_TAVERN_118_FIXTURE.chatHistory,
        tokenizer: unitTokenizer(),
        generationType: 'normal',
        maxPromptTokens: 1_000,
        stop: [],
      });

      expect(result.kind, oracleCase.label).toBe('chat');
      if (result.kind !== 'chat') throw new Error(`${oracleCase.label}: ${result.message}`);
      expect(result.messages, oracleCase.label).toEqual(oracleCase.messages);
      expect(result.stop, oracleCase.label).toEqual([]);
    }
  });

  it('matches complete ChatML Text prompts and stops for normal and multi-message continuation', async () => {
    const oracle = await loadSillyTavern118Oracle(oracleRoot!);
    expect(oracle.textCases.map((value) => value.label)).toEqual([
      'ChatML normal',
      'ChatML continuation',
      'ChatML assistant-first alignment',
      'ChatML continuation with post-history instruction',
    ]);

    for (const oracleCase of oracle.textCases) {
      const result = await compileTextPrompt({
        textPreset: preset('text', oracle.textSettings, { name: 'Default' }),
        contextPreset: preset('context', oracle.contextSettings, { name: 'ChatML' }),
        instructPreset: preset('instruct', oracleCase.instructSettings, { name: 'ChatML' }),
        systemPreset: preset('system', oracleCase.systemSettings, { name: 'Roleplay - Simple' }),
        character: character(SILLY_TAVERN_118_FIXTURE.character),
        persona: persona(SILLY_TAVERN_118_FIXTURE.persona),
        worldInfoBefore: SILLY_TAVERN_118_FIXTURE.worldInfoBefore,
        worldInfoAfter: SILLY_TAVERN_118_FIXTURE.worldInfoAfter,
        history: oracleCase.history,
        tokenizer: unitTokenizer(),
        generationType: oracleCase.generationType,
        maxPromptTokens: 1_000,
        stop: [],
      });

      expect(result.kind, oracleCase.label).toBe('text');
      if (result.kind !== 'text') throw new Error(`${oracleCase.label}: ${result.message}`);
      expect(result.text, oracleCase.label).toBe(oracleCase.text);
      expect(result.stop, oracleCase.label).toEqual(oracleCase.stop);
    }
  });
});

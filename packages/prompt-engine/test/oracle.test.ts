import { describe, expect, it } from 'vitest';
import { compileChatPrompt } from '../src/index.js';
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

  it('matches upstream Author Note preset overrides and relative placement beside an absolute main prompt', async () => {
    const oracle = await loadSillyTavern118Oracle(oracleRoot!);
    const roles = ['system', 'user', 'assistant'] as const;

    for (const oracleCase of oracle.authorNoteCases) {
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
        worldInfoPlacements: {
          beforeCharacter: SILLY_TAVERN_118_FIXTURE.worldInfoBefore,
          afterCharacter: SILLY_TAVERN_118_FIXTURE.worldInfoAfter,
          examplesBefore: [],
          examplesAfter: [],
          authorNote: {
            before: [],
            content: oracleCase.authorNote.content,
            after: [],
            position: oracleCase.authorNote.position,
            depth: oracleCase.authorNote.depth,
            role: roles[oracleCase.authorNote.role],
          },
          atDepth: [],
          outlets: {},
        },
      });

      expect(result.kind, oracleCase.label).toBe('chat');
      if (result.kind !== 'chat') throw new Error(`${oracleCase.label}: ${result.message}`);
      expect(result.messages, oracleCase.label).toEqual(oracleCase.messages);
    }
  });

});

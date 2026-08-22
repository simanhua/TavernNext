import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { decodeInspectedCharacter } from '@tavernnext/st-compat';
import { runRegexScripts, TavernRegexSchema } from '@tavernnext/extension-runtime';
import { describe, expect, it } from 'vitest';
import { loadSillyTavernRegexOracle } from './st-regex-oracle-harness.js';

const oracleRoot = process.env.TAVERNNEXT_ST_ORACLE_ROOT;
const cardPath = process.env.TAVERNNEXT_REGEX_CARD_PATH;
const presetPath = process.env.TAVERNNEXT_REGEX_PRESET_PATH;

const corpus = [
  '<updatevariable>foo: bar</updatevariable>',
  '<update>incomplete',
  '<StatusPlaceHolderImpl/>',
  '【首页】',
  '<customized>custom start</customized>',
  '<state_bar>HP: 9</state_bar>',
  '<style>.x{color:red}</style><div>visible</div>',
  '<action_info>craft sword</action_info>',
  '<char_info>name: Aster</char_info>',
  '<tp>noon / archive</tp>body',
  '<Disclaimer>discard</Disclaimer><!-- note -->body',
  '<action_options>1. Go\n2. Stay</action_options>',
  '<summary>Earlier events</summary>',
  '极其危险，由于暴雨。',
];

describe.runIf(oracleRoot !== undefined && cardPath !== undefined && presetPath !== undefined)(
  'read-only SillyTavern 1.18.0 regex parity oracle',
  () => {
    it('matches all 12 example-card and 9 target-Preset rules across the compatibility corpus', () => {
      const oracle = loadSillyTavernRegexOracle(oracleRoot!);
      expect(oracle.provenance).toMatchObject({
        packageName: 'sillytavern', version: '1.18.0',
        source: 'public/scripts/extensions/regex/engine.js',
        declarations: ['RegexProvider', 'sanitizeRegexMacro', 'runRegexScript', 'filterString', 'regexFromString'],
      });
      const decoded = decodeInspectedCharacter(
        new Uint8Array(readFileSync(cardPath!)), basename(cardPath!), undefined, 'png',
      );
      const cardRules = (decoded.character.extensions.regex_scripts ?? []) as unknown[];
      const presetJson = JSON.parse(readFileSync(presetPath!, 'utf8')) as { extensions?: { regex_scripts?: unknown[] } };
      const presetRules = presetJson.extensions?.regex_scripts ?? [];
      expect(cardRules).toHaveLength(12);
      expect(presetRules).toHaveLength(9);

      for (const [owner, values] of [['character', cardRules], ['preset', presetRules]] as const) {
        values.forEach((rawRule, index) => {
          const rule = TavernRegexSchema.parse(rawRule);
          for (const input of corpus) {
            const context = {
              placement: rule.placement[0] ?? 2,
              isMarkdown: rule.markdownOnly,
              isPrompt: !rule.markdownOnly && rule.promptOnly,
              values: { user: 'Traveler', char: 'Aster' },
            };
            expect(runRegexScripts(input, [rule], context).value, `${owner} rule ${index}: ${rule.scriptName}`)
              .toBe(oracle.runRegexScript(rawRule as Record<string, unknown>, input));
          }
        });
      }
    });
  },
);

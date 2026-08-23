import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { applySPresetPromptHook } from '../src/spreset.js';

describe('SPreset ChatSquash hook', () => {
  it('squashes role runs, honors separators and stop strings, then runs the trusted post-script', () => {
    const result = applySPresetPromptHook({
      kind: 'chat',
      messages: [
        { role: 'system', content: '<|no-trans|>KEEP-SEPARATE' },
        { role: 'user', content: '<|placeholder|>' },
        { role: 'assistant', content: 'Old answer' },
        { role: 'user', content: 'Latest input' },
      ],
      stop: ['old-stop'],
      spreset: { ChatSquash: {
        enabled: true, role: 'user', user_prefix: '\n\nHuman:', user_suffix: '<u>',
        char_prefix: '\n\nAssistant:', char_suffix: '<a>', prefix_system: '', suffix_system: '',
        enable_squashed_separator: true, squashed_separator_regex: false,
        squashed_separator_string: '<|no-trans|>', enable_stop_string: true, stop_string: 'Participant:',
        squashed_post_script_enable: true,
        squashed_post_script: "content => content.replaceAll('Human:', 'Participant:').replaceAll('<|placeholder|>', '')",
      } },
    }, (source, content) => Function('content', `return (${source})(content);`)(content));

    expect(result.messages).toEqual([
      { role: 'system', content: 'KEEP-SEPARATE' },
      { role: 'user', content: 'Participant:<u>\n\nAssistant:Old answer<a>\n\nParticipant:Latest input<u>' },
    ]);
    expect(result.stop).toEqual(['old-stop', 'Participant:']);
  });

  it('matches regex separators against content rather than requiring the pattern text literally', () => {
    const result = applySPresetPromptHook({
      kind: 'chat', messages: [
        { role: 'system', content: 'before<@Cut_900>' },
        { role: 'user', content: 'after' },
      ], stop: [], spreset: { ChatSquash: {
        enabled: true, role: 'user', prefix_system: '', suffix_system: '',
        user_prefix: 'User:', user_suffix: '', char_prefix: 'Assistant:', char_suffix: '',
        enable_squashed_separator: true, squashed_separator_regex: true,
        squashed_separator_string: '<@Cut_\\d+>',
      } },
    });

    expect(result.messages).toEqual([
      { role: 'system', content: 'before' },
      { role: 'user', content: 'User:after' },
    ]);
  });

  const targetPreset = process.env.TAVERNNEXT_REGEX_PRESET_PATH;
  it.runIf(targetPreset !== undefined && existsSync(targetPreset))('matches the configured target Preset golden for a fixed prompt history', () => {
    const preset = JSON.parse(readFileSync(targetPreset!, 'utf8')) as { extensions: { SPreset: Record<string, unknown> } };
    const result = applySPresetPromptHook({
      kind: 'chat',
      messages: [
        { role: 'system', content: '<additional_settings>WORLD BLOCK\n\n[Start]</additional_settings><|ws_slot|><@Cut_900>' },
        { role: 'system', content: '<additional_settings>INFO BLOCK</additional_settings><|ai_slot|><@Cut_2>' },
        { role: 'system', content: '<additional_settings>RULE BLOCK</additional_settings><|ac_slot|>' },
        { role: 'user', content: '<|placeholder|>' },
        { role: 'assistant', content: 'Earlier answer' },
        { role: 'user', content: 'Latest question' },
      ],
      stop: ['old'], spreset: preset.extensions.SPreset,
    }, (source, content) => Function('content', `return (${source})(content);`)(content));
    const golden = JSON.stringify({ messages: result.messages, stop: result.stop });

    expect(createHash('sha256').update(golden).digest('hex'))
      .toBe('54067d05e1307e006ff26aaa1224727d08ef87833bbc82d6b0446a5b29e8e412');
  });
});

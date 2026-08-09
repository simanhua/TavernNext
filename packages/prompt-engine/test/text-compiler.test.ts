import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compileTextPrompt } from '../src/index.js';
import { character, persona, preset, unitTokenizer } from './fixtures.js';

const golden = JSON.parse(readFileSync(
  new URL('../../../tests/fixtures/prompts/text-golden.json', import.meta.url),
  'utf8',
)) as { expected: { text: string; stop: string[] } };

function textInputs() {
  return {
    textPreset: preset('text', { temperature: 0.7, custom_system_prompt: 'SYSTEM LEAK' }),
    contextPreset: preset('context', {
      story_string: '<STORY>\n{{system}}\n{{description}}\n{{personality}}\n{{scenario}}\n{{persona}}\n</STORY>\n',
      example_separator: '<EXAMPLE>',
      chat_start: '<CHAT>',
      use_stop_strings: true,
      names_as_stop_strings: true,
      always_force_name2: true,
    }),
    instructPreset: preset('instruct', {
      input_sequence: '<U {{name}}>',
      output_sequence: '<A {{name}}>',
      system_sequence: '<S {{name}}>',
      last_input_sequence: '<LU {{name}}>',
      last_output_sequence: '<LA {{name}}>',
      input_suffix: '</U>\n',
      output_suffix: '</A>\n',
      system_suffix: '</S>\n',
      stop_sequence: ['<STOP>', '<A Aster>'],
      story_string_prefix: '<SYS>',
      story_string_suffix: '</SYS>\n',
      names_behavior: 'always',
      sequences_as_stop_strings: true,
      macro: true,
      wrap: true,
    }),
    systemPreset: preset('system', { content: 'Base {{char}}', post_history: 'Base post' }),
  };
}

describe('Text preset compiler', () => {
  it('matches the static story/context/instruct/name/separator/suffix/stop golden', async () => {
    const calls: Array<{ kind: 'text' | 'messages'; value: unknown }> = [];
    const input = {
      character: character({
        examples: '<START>\nYou: Demo question\nAster: Demo answer',
        systemPrompt: 'Card for {{char}} ({{original}})',
        postHistoryInstructions: 'After {{user}} ({{original}})',
      }),
      persona: persona(),
      ...textInputs(),
      history: [
        { id: 'h1', role: 'user', content: 'Old' },
        { id: 'h2', role: 'assistant', content: 'Mid' },
        { id: 'h3', role: 'user', content: 'New' },
      ],
      maxPromptTokens: 100,
      stop: [],
      tokenizer: unitTokenizer(calls),
    };
    const before = JSON.stringify(input, (_key, value) => typeof value === 'function' ? '[function]' : value);

    const result = await compileTextPrompt(input);

    expect(result.kind).toBe('text');
    if (result.kind !== 'text') throw new Error(result.message);
    expect(result.text).toBe(golden.expected.text);
    expect(result.stop).toEqual(golden.expected.stop);
    expect(result.text).not.toContain('SYSTEM LEAK');
    expect(calls.every((call) => call.kind === 'text')).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(
      result.tokenBreakdown.filter((entry) => entry.includedTokens > 0 || entry.omittedTokens > 0).length,
    );
    expect(JSON.stringify(input, (_key, value) => typeof value === 'function' ? '[function]' : value)).toBe(before);
  });

  it('removes the oldest eligible history first and keeps an exact-boundary suffix', async () => {
    const result = await compileTextPrompt({
      character: character(), persona: persona(), maxPromptTokens: 4, stop: [],
      tokenizer: {
        countText: async (text: string) => text === '' ? 0 : text.split('\n').length,
        countMessages: async () => 0,
      },
      textPreset: preset('text', { temperature: 1 }),
      contextPreset: preset('context', { story_string: 'SYS', always_force_name2: true }),
      history: [
        { id: 'old', role: 'user', content: 'old' },
        { id: 'middle', role: 'assistant', content: 'middle' },
        { id: 'new', role: 'user', content: 'new' },
      ],
    });

    expect(result.kind).toBe('text');
    if (result.kind !== 'text') throw new Error(result.message);
    expect(result.text).toBe('SYS\nYou: new\nAster:');
    expect(result.tokenBreakdown.find((entry) => entry.source === 'history:middle')).toMatchObject({
      omittedTokens: 1, reason: 'history_budget',
    });
  });

  it('allows a truly empty prompt at zero budget but rejects negative and immutable overflow', async () => {
    const empty = {
      character: character({ description: '', personality: '', scenario: '', systemPrompt: '' }),
      persona: persona({ description: '' }),
      tokenizer: unitTokenizer(),
      textPreset: preset('text', {}),
      contextPreset: preset('context', { story_string: '', always_force_name2: false }),
      history: [], stop: [],
    };

    expect(await compileTextPrompt({ ...empty, maxPromptTokens: 0 })).toMatchObject({ kind: 'text', text: '', totalTokens: 0 });
    expect(await compileTextPrompt({ ...empty, maxPromptTokens: -1 })).toMatchObject({ kind: 'error', target: 'text', code: 'invalid_budget' });
    expect(await compileTextPrompt({
      ...empty,
      maxPromptTokens: 0,
      contextPreset: preset('context', { story_string: 'required' }),
    })).toMatchObject({ kind: 'error', target: 'text', code: 'context_overflow' });
  });

  it('matches ST solo-chat force naming for examples and the generation trigger', async () => {
    const result = await compileTextPrompt({
      character: character({ examples: '<START>\nYou: Demo question\nAster: Demo answer' }),
      persona: persona(),
      tokenizer: unitTokenizer(),
      maxPromptTokens: 20,
      stop: [],
      textPreset: preset('text', {}),
      contextPreset: preset('context', { story_string: '', always_force_name2: true }),
      instructPreset: preset('instruct', {
        input_sequence: '<U>',
        output_sequence: '<A>',
        system_sequence: '<S>',
        input_suffix: '</U>\n',
        output_suffix: '</A>\n',
        names_behavior: 'force',
        wrap: true,
      }),
      history: [],
    });

    expect(result.kind).toBe('text');
    if (result.kind !== 'text') throw new Error(result.message);
    expect(result.text).toBe('<U>\nYou: Demo question</U>\n<A>\nDemo answer</A>\n\n<A>\n');
  });

  it('keeps raw example dialogue when the Instruct preset skips example formatting', async () => {
    const result = await compileTextPrompt({
      character: character({ examples: '<START>\nYou: Raw question\nAster: Raw answer' }),
      persona: persona(),
      tokenizer: unitTokenizer(),
      maxPromptTokens: 20,
      stop: [],
      textPreset: preset('text', {}),
      contextPreset: preset('context', { story_string: '', example_separator: '***' }),
      instructPreset: preset('instruct', {
        input_sequence: '<U>', output_sequence: '', system_sequence: '', skip_examples: true,
      }),
      history: [],
    });

    if (result.kind !== 'text') throw new Error(result.message);
    expect(result.kind).toBe('text');
    expect(result.text).toBe('***\nYou: Raw question\nAster: Raw answer\n');
  });

  it('does not synthesize example suffix newlines when macro expansion is disabled', async () => {
    const result = await compileTextPrompt({
      character: character({ examples: '<START>\nYou: question\nAster: answer' }),
      persona: persona(), tokenizer: unitTokenizer(), maxPromptTokens: 20, stop: [],
      textPreset: preset('text', {}), contextPreset: preset('context', { story_string: '' }),
      instructPreset: preset('instruct', {
        input_sequence: '<U>', output_sequence: '<A>', system_sequence: '',
        input_suffix: '', output_suffix: '', names_behavior: 'force', macro: false, wrap: true,
      }),
      history: [],
    });

    expect(result.kind).toBe('text');
    if (result.kind !== 'text') throw new Error(result.message);
    expect(result.text).toBe('<U>\nYou: question<A>\nanswer\n<A>\n');
  });

  it('continues the newest assistant with last-output framing, no suffix, and PHI immediately before it', async () => {
    const result = await compileTextPrompt({
      character: character(), persona: persona(), tokenizer: unitTokenizer(), maxPromptTokens: 30, stop: [],
      textPreset: preset('text', {}), contextPreset: preset('context', { story_string: '' }),
      instructPreset: preset('instruct', {
        input_sequence: '<U>', last_input_sequence: '<LU>',
        output_sequence: '<O>', first_output_sequence: '<FO>', last_output_sequence: '<LO>',
        system_sequence: '<S>', input_suffix: '</U>', output_suffix: '</O>', wrap: true,
      }),
      systemPreset: preset('system', { content: '', post_history: 'PHI' }),
      generationType: 'continue',
      history: [
        { id: 'greeting', role: 'assistant', content: 'greet' },
        { id: 'question', role: 'user', content: 'question' },
        { id: 'partial', role: 'assistant', content: 'partial' },
      ],
    });

    expect(result.kind).toBe('text');
    if (result.kind !== 'text') throw new Error(result.message);
    expect(result.text).toBe('<FO>\ngreet</O><U>\nquestion</U><LU>\nPHI</U><LO>\npartial');
    expect(result.tokenBreakdown.find((entry) => entry.source === 'generation:trigger')).toBeUndefined();
  });

  it('cuts the suffix for a one-message continuation without adding a generation trigger', async () => {
    const result = await compileTextPrompt({
      character: character(), persona: persona(), tokenizer: unitTokenizer(), maxPromptTokens: 10, stop: [],
      textPreset: preset('text', {}), contextPreset: preset('context', { story_string: '' }),
      instructPreset: preset('instruct', {
        input_sequence: '<U>', output_sequence: '<O>', first_output_sequence: '<FO>',
        last_output_sequence: '<LO>', system_sequence: '', output_suffix: '</O>', wrap: true,
      }),
      generationType: 'continue',
      history: [{ id: 'partial', role: 'assistant', content: 'partial' }],
    });

    if (result.kind !== 'text') throw new Error(result.message);
    expect(result.kind).toBe('text');
    expect(result.text).toBe('<LO>\npartial');
  });

  it('keeps an empty continuation empty and emits exact normal no-history separators', async () => {
    const common = {
      character: character(), persona: persona(), tokenizer: unitTokenizer(), maxPromptTokens: 10, stop: [],
      textPreset: preset('text', {}), contextPreset: preset('context', { story_string: '' }), history: [],
    };
    const continued = await compileTextPrompt({
      ...common,
      instructPreset: preset('instruct', {
        input_sequence: '', output_sequence: '<O>', last_output_sequence: '<LO>', system_sequence: '', wrap: true,
      }),
      generationType: 'continue',
    });
    const instructNormal = await compileTextPrompt({
      ...common,
      instructPreset: preset('instruct', {
        input_sequence: '', output_sequence: '<O>', last_output_sequence: '<LO>', system_sequence: '', wrap: true,
      }),
    });
    const plainNormal = await compileTextPrompt({
      ...common,
      contextPreset: preset('context', { story_string: '', always_force_name2: true }),
    });

    if (continued.kind !== 'text') throw new Error(continued.message);
    expect(continued).toMatchObject({ kind: 'text', text: '' });
    expect(instructNormal).toMatchObject({ kind: 'text', text: '\n<LO>\n' });
    expect(plainNormal).toMatchObject({ kind: 'text', text: '\nAster:' });
  });

  it('uses the actual message name and removes the final newline outside Instruct mode', async () => {
    const result = await compileTextPrompt({
      character: character(), persona: persona(), tokenizer: unitTokenizer(), maxPromptTokens: 10, stop: [],
      textPreset: preset('text', {}), contextPreset: preset('context', { story_string: '' }),
      history: [{ id: 'named', role: 'assistant', name: 'Guest', content: 'hello' }],
    });

    expect(result.kind).toBe('text');
    if (result.kind !== 'text') throw new Error(result.message);
    expect(result.text).toBe('Guest: hello');
  });

  it('formats post-history instructions as the newest user message and applies last-input sequencing', async () => {
    const result = await compileTextPrompt({
      character: character(), persona: persona(), tokenizer: unitTokenizer(), maxPromptTokens: 20, stop: [],
      textPreset: preset('text', {}),
      contextPreset: preset('context', { story_string: '' }),
      instructPreset: preset('instruct', {
        input_sequence: '<U>', last_input_sequence: '<LI>', output_sequence: '<A>', system_sequence: '<S>',
        input_suffix: ';', output_suffix: ';', system_suffix: ';', wrap: false,
      }),
      systemPreset: preset('system', { content: '', post_history: 'PHI' }),
      history: [{ id: 'question', role: 'user', content: 'question' }],
    });

    expect(result.kind).toBe('text');
    if (result.kind !== 'text') throw new Error(result.message);
    expect(result.text).toBe('<U>question;<LI>PHI;<A>');
  });

  it('prepends the first-input-formatted user alignment only when retained history starts with a non-user', async () => {
    const base = {
      character: character(), persona: persona(), tokenizer: unitTokenizer(), maxPromptTokens: 20, stop: [],
      textPreset: preset('text', {}), contextPreset: preset('context', { story_string: '' }),
      instructPreset: preset('instruct', {
        input_sequence: '<U>', first_input_sequence: '<FI>', output_sequence: '<A>', system_sequence: '<S>',
        input_suffix: ';', output_suffix: ';', system_suffix: ';', user_alignment_message: 'ALIGN {{char}}', wrap: false,
      }),
    };
    const assistantFirst = await compileTextPrompt({
      ...base, history: [{ id: 'answer', role: 'assistant', content: 'answer' }],
    });
    const userFirst = await compileTextPrompt({
      ...base, history: [{ id: 'question', role: 'user', content: 'question' }],
    });

    expect(assistantFirst).toMatchObject({ kind: 'text', text: '<FI>ALIGN Aster;<A>answer;<A>' });
    expect(userFirst).toMatchObject({ kind: 'text', text: '<FI>question;<A>' });
  });

  it('matches ST alignment fallback when no history fits but the newest original message is a user', async () => {
    const result = await compileTextPrompt({
      character: character(), persona: persona(), maxPromptTokens: 2, stop: [],
      tokenizer: {
        countText: async (text: string) => text.length,
        countMessages: async () => 0,
      },
      textPreset: preset('text', {}), contextPreset: preset('context', { story_string: '' }),
      instructPreset: preset('instruct', {
        input_sequence: '', output_sequence: '', system_sequence: '', user_alignment_message: 'a', wrap: false,
      }),
      history: [{ id: 'newest', role: 'user', content: 'h' }],
    });

    expect(result).toMatchObject({ kind: 'text', text: '' });
    expect(result.tokenBreakdown.find((entry) => entry.source === 'instruct:user-alignment')).toMatchObject({
      includedTokens: 0, reason: 'not_applicable',
    });
  });

  it('injects an IN_CHAT story at the configured history depth and role without story wrappers', async () => {
    const result = await compileTextPrompt({
      character: character(), persona: persona(), tokenizer: unitTokenizer(), maxPromptTokens: 30, stop: [],
      textPreset: preset('text', {}),
      contextPreset: preset('context', {
        story_string: 'STORY', story_string_position: 1, story_string_depth: 1, story_string_role: 2,
      }),
      instructPreset: preset('instruct', {
        input_sequence: '<U>', last_input_sequence: '<LU>', output_sequence: '<A>', system_sequence: '<S>',
        input_suffix: ';', output_suffix: ';', system_suffix: ';',
        story_string_prefix: '<SYS>', story_string_suffix: '</SYS>', wrap: false,
      }),
      history: [
        { id: 'old', role: 'user', content: 'old' },
        { id: 'middle', role: 'assistant', content: 'middle' },
        { id: 'new', role: 'user', content: 'new' },
      ],
    });

    expect(result.kind).toBe('text');
    if (result.kind !== 'text') throw new Error(result.message);
    expect(result.text).toBe('<U>old;<A>middle;<A>STORY;<LU>new;<A>');
    expect(result.text).not.toContain('<SYS>');
  });

  it('matches ST wrapped stop selection and macro-disabled name substitution', async () => {
    const result = await compileTextPrompt({
      character: character(),
      persona: persona(),
      tokenizer: unitTokenizer(),
      maxPromptTokens: 20,
      stop: [],
      textPreset: preset('text', {}),
      contextPreset: preset('context', { story_string: '' }),
      instructPreset: preset('instruct', {
        input_sequence: '<U {{name}} {{char}}>',
        output_sequence: '<A {{name}} {{char}}>',
        system_sequence: '<S {{name}} {{char}}>',
        stop_sequence: '{{char}}',
        macro: false,
        sequences_as_stop_strings: true,
        wrap: true,
      }),
      history: [],
    });

    expect(result.kind).toBe('text');
    if (result.kind !== 'text') throw new Error(result.message);
    expect(result.stop).toEqual([
      '\n{{char}}',
      '\n<U You {{char}}>',
      '\n<A Aster {{char}}>',
      '\n<S System {{char}}>',
    ]);
  });

  it('uses first-message and last-user Instruct sequence overrides', async () => {
    const result = await compileTextPrompt({
      character: character(),
      persona: persona(),
      tokenizer: unitTokenizer(),
      maxPromptTokens: 10,
      stop: [],
      textPreset: preset('text', {}),
      contextPreset: preset('context', { story_string: '' }),
      instructPreset: preset('instruct', {
        input_sequence: '<I>',
        output_sequence: '<O>',
        system_sequence: '<S>',
        first_input_sequence: '<FI>',
        first_output_sequence: '<FO>',
        last_input_sequence: '<LI>',
        last_output_sequence: '<LO>',
        input_suffix: ';',
        output_suffix: ';',
        names_behavior: 'force',
        wrap: false,
      }),
      history: [
        { id: 'first', role: 'assistant', content: 'old' },
        { id: 'last-user', role: 'user', content: 'new' },
      ],
    });

    expect(result.kind).toBe('text');
    if (result.kind !== 'text') throw new Error(result.message);
    expect(result.text).toBe('<FO>old;<LI>new;<LO>');
  });

  it('orders single-line, mode-sensitive name, and custom stop strings like ST', async () => {
    const result = await compileTextPrompt({
      character: character(),
      persona: persona(),
      tokenizer: unitTokenizer(),
      maxPromptTokens: 10,
      stop: ['CUSTOM', '\nYou:'],
      textPreset: preset('text', {}),
      contextPreset: preset('context', {
        story_string: '',
        names_as_stop_strings: true,
        single_line: true,
      }),
      generationType: 'continue',
      history: [{ id: 'last', role: 'user', content: 'last' }],
    });

    expect(result.kind).toBe('text');
    if (result.kind !== 'text') throw new Error(result.message);
    expect(result.stop).toEqual(['\n', '\nYou:', '\nAster:', 'CUSTOM']);
  });

  it('renders ST Context if blocks and trim without leaking control directives', async () => {
    const result = await compileTextPrompt({
      character: character({ description: 'shown', personality: '' }),
      persona: persona(),
      tokenizer: unitTokenizer(),
      maxPromptTokens: 10,
      stop: [],
      textPreset: preset('text', {}),
      contextPreset: preset('context', {
        story_string: '{{#if description}}D={{description}}\n{{/if}}{{#if personality}}P={{personality}}\n{{/if}}{{trim}}',
      }),
      history: [],
    });

    expect(result.kind).toBe('text');
    if (result.kind !== 'text') throw new Error(result.message);
    expect(result.text).toBe('D=shown\n');
    expect(result.warnings).toEqual([]);
  });

  it('preserves an unknown Context block helper literally and warns', async () => {
    const result = await compileTextPrompt({
      character: character(),
      persona: persona(),
      tokenizer: unitTokenizer(),
      maxPromptTokens: 10,
      stop: [],
      textPreset: preset('text', {}),
      contextPreset: preset('context', { story_string: '{{#future value}}keep {{char}}{{/future}}' }),
      history: [],
    });

    expect(result.kind).toBe('text');
    if (result.kind !== 'text') throw new Error(result.message);
    expect(result.text).toBe('{{#future value}}keep Aster{{/future}}\n');
    expect(result.warnings).toContainEqual({
      code: 'unknown_story_helper',
      macro: 'future',
      message: 'Unknown story helper {{#future}} was left unchanged.',
      source: 'context:story-string',
    });
  });

  it('surfaces tokenizer failure and counts Unicode through the supplied tokenizer', async () => {
    const unicodeCalls: string[] = [];
    const unicode = await compileTextPrompt({
      character: character({ description: '猫🙂', personality: '', scenario: '' }),
      persona: persona({ description: '' }),
      tokenizer: {
        countText: async (text) => { unicodeCalls.push(text); return Array.from(text).length; },
        countMessages: async () => 0,
      },
      textPreset: preset('text', {}), contextPreset: preset('context', { story_string: '{{description}}' }),
      history: [], stop: [], maxPromptTokens: 3,
    });
    const failed = await compileTextPrompt({
      character: character(), persona: persona(),
      tokenizer: { countText: async () => { throw new Error('broken'); }, countMessages: async () => 0 },
      textPreset: preset('text', {}), contextPreset: preset('context', { story_string: 'x' }),
      history: [], stop: [], maxPromptTokens: 10,
    });

    expect(unicode).toMatchObject({ kind: 'text', text: '猫🙂\n', totalTokens: 3 });
    expect(unicodeCalls.length).toBeGreaterThan(0);
    expect(unicodeCalls).toContain('猫🙂\n');
    expect(unicodeCalls.every((value) => value === '' || value === '猫🙂\n')).toBe(true);
    expect(failed).toMatchObject({ kind: 'error', target: 'text', code: 'tokenizer_error' });
  });

  it('returns a typed warning and zero tokenizer calls when budget search input exceeds safe limits', async () => {
    let tokenizerCalls = 0;
    const history = Array.from({ length: 101 }, (_value, index) => ({
      id: `history-${index}`,
      role: 'user',
      content: `message-${index}`,
    }));
    const result = await compileTextPrompt({
      character: character(), persona: persona(), maxPromptTokens: 10, stop: [], history,
      tokenizer: {
        countText: async () => {
          tokenizerCalls += 1;
          return 0;
        },
        countMessages: async () => 0,
      },
      textPreset: preset('text', {}),
      contextPreset: preset('context', { story_string: '' }),
    });

    expect(result).toMatchObject({
      kind: 'error',
      target: 'text',
      code: 'budget_search_limit',
      totalTokens: 0,
      warnings: [{
        code: 'budget_search_limit',
        source: 'token-budget',
        message: 'Prompt budget search exceeds the safe evaluation limit.',
      }],
    });
    expect(tokenizerCalls).toBe(0);
    expect(result.tokenBreakdown).toHaveLength(101);
    expect(result.tokenBreakdown.every((entry) => entry.reason === 'budget_search_limit')).toBe(true);
  });

  it('omits unsupported roles with warnings and is deterministic on repeat', async () => {
    const input = {
      character: character({ description: '', personality: '', scenario: '' }), persona: persona({ description: '' }),
      tokenizer: unitTokenizer(), textPreset: preset('text', {}),
      contextPreset: preset('context', { story_string: '' }),
      history: [{ id: 'bad', role: 'tool', content: 'leak' }], stop: [], maxPromptTokens: 10,
    };
    const first = await compileTextPrompt(input);
    const second = await compileTextPrompt(input);

    expect(first).toMatchObject({ kind: 'text', text: '', warnings: [{ code: 'unsupported_role' }] });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('places every Worldbook target in Text output while retaining named outlets out of band', async () => {
    const result = await compileTextPrompt({
      character: character({ examples: '<START>\nYou: CARD-EXAMPLE\nAster: CARD-ANSWER' }),
      persona: persona(), ...textInputs(), maxPromptTokens: 10_000, tokenizer: unitTokenizer(),
      history: [
        { id: 'old', role: 'user', content: 'OLD' },
        { id: 'new', role: 'assistant', content: 'NEW' },
      ],
      worldInfoPlacements: {
        beforeCharacter: 'WI-BEFORE', afterCharacter: 'WI-AFTER',
        examplesBefore: [
          { source: 'wi:em-top-second', content: '<START>\nYou: EM-TOP-SECOND\nAster: EM-TOP-SECOND-A' },
          { source: 'wi:em-top-first', content: '<START>\nYou: EM-TOP-FIRST\nAster: EM-TOP-FIRST-A' },
        ],
        examplesAfter: [
          { source: 'wi:em-bottom-second', content: '<START>\nYou: EM-BOTTOM-SECOND\nAster: EM-BOTTOM-SECOND-A' },
          { source: 'wi:em-bottom-first', content: '<START>\nYou: EM-BOTTOM-FIRST\nAster: EM-BOTTOM-FIRST-A' },
        ],
        authorNote: {
          before: [
            { source: 'wi:an-top-second', content: 'AN-TOP-SECOND' },
            { source: 'wi:an-top-first', content: 'AN-TOP-FIRST' },
          ],
          content: 'CONFIGURED-AUTHOR-NOTE',
          after: [
            { source: 'wi:an-bottom-second', content: 'AN-BOTTOM-SECOND' },
            { source: 'wi:an-bottom-first', content: 'AN-BOTTOM-FIRST' },
          ],
          position: 1,
          depth: 2,
          role: 'system',
        },
        atDepth: [
          { source: 'wi:depth-system-second', content: 'DEPTH-SYSTEM-SECOND', depth: 1, role: 'system' },
          { source: 'wi:depth-system-first', content: 'DEPTH-SYSTEM-FIRST', depth: 1, role: 'system' },
          { source: 'wi:depth-user', content: 'DEPTH-USER', depth: 1, role: 'user' },
          { source: 'wi:depth-assistant', content: 'DEPTH-ASSISTANT', depth: 1, role: 'assistant' },
        ],
        outlets: { sidebar: [{ source: 'wi:outlet', content: 'OUTLET-ONLY' }] },
      },
    });

    expect(result.kind).toBe('text');
    if (result.kind !== 'text') throw new Error(result.message);
    expect(result.text).toContain('WI-BEFORE');
    expect(result.text).toContain('WI-AFTER');
    expect(result.text.indexOf('EM-TOP-FIRST')).toBeLessThan(result.text.indexOf('EM-TOP-SECOND'));
    expect(result.text.indexOf('EM-TOP-SECOND')).toBeLessThan(result.text.indexOf('CARD-EXAMPLE'));
    expect(result.text.indexOf('CARD-EXAMPLE')).toBeLessThan(result.text.indexOf('EM-BOTTOM-SECOND'));
    expect(result.text.indexOf('EM-BOTTOM-SECOND')).toBeLessThan(result.text.indexOf('EM-BOTTOM-FIRST'));
    expect(result.text).toContain('AN-TOP-SECOND\nAN-TOP-FIRST\nCONFIGURED-AUTHOR-NOTE\nAN-BOTTOM-SECOND\nAN-BOTTOM-FIRST');
    expect(result.text).toContain('DEPTH-SYSTEM-SECOND\nDEPTH-SYSTEM-FIRST');
    expect(result.text.indexOf('DEPTH-SYSTEM-SECOND')).toBeGreaterThan(result.text.indexOf('OLD'));
    expect(result.text.indexOf('DEPTH-SYSTEM-FIRST')).toBeLessThan(result.text.indexOf('NEW'));
    expect(result.text).toContain('DEPTH-USER');
    expect(result.text).toContain('DEPTH-ASSISTANT');
    expect(result.text).not.toContain('OUTLET-ONLY');
    expect(result.worldInfoOutlets).toEqual({ sidebar: 'OUTLET-ONLY' });
  });

  it.each([
    [2, 'AN-TOP\nACTUAL-NOTE\nAN-BOTTOM<MAIN>'],
    [0, '<MAIN>AN-TOP\nACTUAL-NOTE\nAN-BOTTOM'],
  ] as const)('maps configured relative Author Note position %s to the exact Text story anchor', async (position, expected) => {
    const result = await compileTextPrompt({
      character: character({ description: '', personality: '', scenario: '' }),
      persona: persona({ description: '' }), tokenizer: unitTokenizer(), maxPromptTokens: 1_000,
      textPreset: preset('text', {}),
      contextPreset: preset('context', { story_string: '{{anchorBefore}}<MAIN>{{anchorAfter}}' }),
      history: [],
      worldInfoPlacements: {
        beforeCharacter: '', afterCharacter: '', examplesBefore: [], examplesAfter: [], atDepth: [], outlets: {},
        authorNote: {
          before: [{ source: 'wi:an-top', content: 'AN-TOP' }], content: 'ACTUAL-NOTE',
          after: [{ source: 'wi:an-bottom', content: 'AN-BOTTOM' }],
          position, depth: 99, role: 'assistant',
        },
      },
    });

    expect(result.kind).toBe('text');
    if (result.kind !== 'text') throw new Error(result.message);
    expect(result.text).toBe(expected);
  });
});

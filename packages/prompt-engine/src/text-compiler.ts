import { allocateGroupedPromptBudget, type PromptBudgetBlock } from './budget.js';
import { expandMacros } from './macros.js';
import { booleanSetting, sanitizedPresetSettings, stringSetting } from './preset-settings.js';
import { appendWarnings, compilationFailure, stableStops } from './shared.js';
import type {
  CompileTextPromptInput,
  TextPromptCompilationResult,
  PromptHistoryMessage,
  PromptRole,
  PromptWarning,
  TokenOmissionReason,
} from './types.js';

interface TextBlock extends PromptBudgetBlock<string> {}

interface ExampleMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ConversationItem {
  source: string;
  role?: PromptRole;
  name?: string | null;
  content: string;
  policy: TextBlock['policy'];
  omitReason?: TokenOmissionReason;
}

function role(value: string): PromptRole | undefined {
  return value === 'system' || value === 'user' || value === 'assistant' ? value : undefined;
}

function contextStoryRole(value: unknown): PromptRole {
  return value === 1 ? 'user' : value === 2 ? 'assistant' : 'system';
}

function exampleGroups(raw: string, user: string, character: string): ExampleMessage[][] {
  if (raw.trim() === '' || raw.trim() === '<START>') return [];
  const source = /^\s*<START>/i.test(raw) ? raw : `<START>\n${raw.trim()}`;
  return source.split(/<START>/i).slice(1).flatMap((block) => {
    const lines = block.replace(/\r/g, '').trim().split('\n');
    const messages: ExampleMessage[] = [];
    let current: ExampleMessage | undefined;
    for (const line of lines) {
      if (line.startsWith(`${user}:`)) {
        if (current) messages.push(current);
        current = { role: 'user', content: line.slice(user.length + 1).trimStart() };
      } else if (line.startsWith(`${character}:`)) {
        if (current) messages.push(current);
        current = { role: 'assistant', content: line.slice(character.length + 1).trimStart() };
      } else if (current) {
        current.content += `\n${line}`;
      }
    }
    if (current) messages.push(current);
    return messages.length === 0 ? [] : [messages];
  });
}

function rawExampleGroups(raw: string): string[] {
  if (raw.trim() === '' || raw.trim() === '<START>') return [];
  const source = /^\s*<START>/i.test(raw) ? raw : `<START>\n${raw.trim()}`;
  return source.split(/<START>/i).slice(1)
    .map((block) => block.replace(/\r/g, '').replace(/^\n/, '').trimEnd())
    .filter((block) => block !== '');
}

function asStopList(value: unknown): string[] {
  if (typeof value === 'string') return value === '' ? [] : [value];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry !== '') : [];
}

function renderStoryControlFlow(
  template: string,
  values: Readonly<Record<string, string>>,
  warnings: PromptWarning[],
): string {
  const normalizedValues = new Map(
    Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]),
  );
  let output = template;
  const ifBlock = /(?<!\\)\{\{#if\s+([A-Za-z][\w.-]*)\s*\}\}((?:(?!\{\{#if\b)[\s\S])*?)(?<!\\)\{\{\/if\s*\}\}/gi;
  for (let depth = 0; depth < 32; depth += 1) {
    let replaced = false;
    output = output.replace(ifBlock, (_literal, rawName: string, body: string) => {
      replaced = true;
      return (normalizedValues.get(rawName.toLowerCase()) ?? '') === '' ? '' : body;
    });
    if (!replaced) break;
  }

  const seenHelpers = new Set<string>();
  for (const match of output.matchAll(/(?<!\\)\{\{#([A-Za-z][\w.-]*)(?:\s+[^}]*)?\}\}/g)) {
    const helper = match[1]!.toLowerCase();
    if (helper === 'if' || seenHelpers.has(helper)) continue;
    seenHelpers.add(helper);
    warnings.push({
      code: 'unknown_story_helper',
      macro: helper,
      message: `Unknown story helper {{#${helper}}} was left unchanged.`,
      source: 'context:story-string',
    });
  }

  return output.replace(/(?:\r?\n)*(?<!\\)\{\{trim\}\}(?:\r?\n)*/gi, '');
}

export async function compileTextPrompt(input: CompileTextPromptInput): Promise<TextPromptCompilationResult> {
  const warnings: PromptWarning[] = [];
  let textSettings: Record<string, unknown>;
  let context: Record<string, unknown>;
  let instruct: Record<string, unknown> | undefined;
  let system: Record<string, unknown> | undefined;
  try {
    textSettings = sanitizedPresetSettings(input.textPreset, 'text');
    context = sanitizedPresetSettings(input.contextPreset, 'context');
    instruct = input.instructPreset === undefined ? undefined : sanitizedPresetSettings(input.instructPreset, 'instruct');
    system = input.systemPreset === undefined ? undefined : sanitizedPresetSettings(input.systemPreset, 'system');
  } catch (error) {
    return compilationFailure({
      target: 'text', code: 'invalid_preset', stop: stableStops(input.stop), warnings,
      message: error instanceof Error ? error.message : 'Text preset inputs are invalid.',
    });
  }
  void textSettings;

  let macroFailed = false;
  const expand = (value: string, source: string, values?: Readonly<Record<string, string>>): string => {
    const result = expandMacros(value, { character: input.character, persona: input.persona, values }, input.macroLimits);
    appendWarnings(warnings, result.warnings, source);
    macroFailed ||= result.limitExceeded !== undefined;
    return result.text;
  };
  const sequence = (key: string, name: string): string => {
    const raw = instruct === undefined ? '' : stringSetting(instruct, key);
    if (raw === '') return '';
    return booleanSetting(instruct!, 'macro')
      ? expand(raw, `instruct:${key}`, { name })
      : raw;
  };

  const baseSystem = expand(stringSetting(system ?? {}, 'content'), 'system:content');
  const systemContent = input.character.systemPrompt === ''
    ? baseSystem
    : expand(input.character.systemPrompt, 'character:systemPrompt', { original: baseSystem });
  const basePost = expand(stringSetting(system ?? {}, 'post_history'), 'system:post-history');
  const postHistory = input.character.postHistoryInstructions === ''
    ? basePost
    : expand(input.character.postHistoryInstructions, 'character:postHistoryInstructions', { original: basePost });

  const storyValues = {
    system: systemContent,
    wiBefore: input.worldInfoBefore ?? '',
    wiAfter: input.worldInfoAfter ?? '',
    loreBefore: input.worldInfoBefore ?? '',
    loreAfter: input.worldInfoAfter ?? '',
    anchorBefore: input.anchorBefore ?? '',
    anchorAfter: input.anchorAfter ?? '',
  };
  const storyTemplate = renderStoryControlFlow(
    stringSetting(context, 'story_string'),
    {
      ...storyValues,
      description: input.character.description,
      personality: input.character.personality,
      scenario: input.character.scenario,
      persona: input.persona.description,
      char: input.character.name,
      user: input.persona.name,
    },
    warnings,
  );
  let story = expand(storyTemplate, 'context:story-string', storyValues);
  story = story.replace(/^\n+/, '');
  const storyInChat = context.story_string_position === 1;
  const storyPrefix = instruct === undefined || storyInChat ? '' : sequence('story_string_prefix', 'System');
  const storySuffix = instruct === undefined || storyInChat ? '' : sequence('story_string_suffix', 'System');
  if (story !== '' && !story.endsWith('\n') && !storyInChat
    && (instruct === undefined || (booleanSetting(instruct, 'wrap') && storySuffix === ''))) {
    story += '\n';
  }
  if (instruct !== undefined && story !== '' && !storyInChat) {
    const separator = booleanSetting(instruct, 'wrap') ? '\n' : '';
    if (storyPrefix !== '') story = `${storyPrefix}${separator}${story}`;
    if (storySuffix !== '') story += storySuffix;
  }

  const blocks: TextBlock[] = [];
  const add = (source: string, value: string, policy: TextBlock['policy'], omitReason?: TokenOmissionReason): number | undefined => {
    if (value === '') return undefined;
    blocks.push({ source, value, policy, ...(omitReason === undefined ? {} : { omitReason }) });
    return blocks.length - 1;
  };
  if (!storyInChat) add('context:story-string', story, 'immutable');

  const namesBehavior = instruct === undefined ? 'none' : stringSetting(instruct, 'names_behavior') || 'force';
  const wrap = instruct !== undefined && booleanSetting(instruct, 'wrap');
  const includeName = namesBehavior === 'always';
  const formatMessage = (
    message: { role: PromptRole; content: string },
    options: { example?: boolean; first?: boolean; lastUser?: boolean; name?: string | null } = {},
  ): string => {
    if (instruct === undefined) {
      if (message.role === 'system') return `${message.content}\n`;
      const name = message.role === 'user' ? input.persona.name : input.character.name;
      return `${name}: ${message.content}\n`;
    }
    const defaultName = message.role === 'user' ? input.persona.name : message.role === 'assistant' ? input.character.name : 'System';
    const name = options.name === null ? '' : options.name ?? defaultName;
    const sequenceName = name || 'System';
    const prefixKey = message.role === 'user'
      ? options.lastUser && stringSetting(instruct, 'last_input_sequence') !== ''
        ? 'last_input_sequence'
        : options.first && stringSetting(instruct, 'first_input_sequence') !== ''
          ? 'first_input_sequence'
          : 'input_sequence'
      : message.role === 'assistant'
        ? options.first && stringSetting(instruct, 'first_output_sequence') !== ''
          ? 'first_output_sequence'
          : 'output_sequence'
        : booleanSetting(instruct, 'system_same_as_user') ? 'input_sequence' : 'system_sequence';
    const suffixKey = message.role === 'user'
      ? 'input_suffix'
      : message.role === 'assistant' ? 'output_suffix' : booleanSetting(instruct, 'system_same_as_user') ? 'input_suffix' : 'system_suffix';
    const prefix = sequence(prefixKey, sequenceName);
    let suffix = sequence(suffixKey, sequenceName);
    if (suffix === '' && wrap) suffix = '\n';
    const forceExampleUserName = namesBehavior === 'force' && options.example === true && message.role === 'user';
    const named = message.role !== 'system' && name !== '' && (includeName || forceExampleUserName)
      ? `${name}: ${message.content}`
      : message.content;
    return [prefix, `${named}${suffix}`].filter((part) => part !== '').join(wrap ? '\n' : '');
  };

  const expandedExamples = expand(input.character.examples, 'character:examples');
  const exampleSeparator = expand(stringSetting(context, 'example_separator'), 'context:example-separator');
  if (instruct !== undefined && booleanSetting(instruct, 'skip_examples')) {
    rawExampleGroups(expandedExamples).forEach((raw, index) => {
      add(`example:${index}`, `${exampleSeparator === '' ? '' : `${exampleSeparator}\n`}${raw}`, 'optional');
    });
  } else {
    exampleGroups(expandedExamples, input.persona.name, input.character.name).forEach((messages, index) => {
      const formatted = messages.map((message) => formatMessage(message, { example: true })).join('');
      add(`example:${index}`, `${exampleSeparator === '' ? '' : `${exampleSeparator}\n`}${formatted}`, 'optional');
    });
  }

  const chatStart = expand(stringSetting(context, 'chat_start'), 'context:chat-start');
  add('context:chat-start', chatStart === '' ? '' : `${chatStart}\n`, 'immutable');

  let alignmentBlockIndex: number | undefined;
  if (instruct !== undefined && stringSetting(instruct, 'user_alignment_message') !== '') {
    const alignment = expand(stringSetting(instruct, 'user_alignment_message'), 'instruct:user-alignment');
    alignmentBlockIndex = add(
      'instruct:user-alignment',
      formatMessage({ role: 'user', content: alignment }, { first: true }),
      'immutable',
    );
  }

  const conversation: ConversationItem[] = input.history.map((message: PromptHistoryMessage, index) => {
    const source = `history:${message.id ?? index}`;
    const messageRole = role(message.role);
    if (messageRole === undefined) {
      warnings.push({ code: 'unsupported_role', message: `History role ${message.role} is not supported.`, source });
      return { source, content: message.content, policy: 'history', omitReason: 'unsupported_role' };
    }
    return { source, role: messageRole, content: message.content, policy: 'history' };
  });
  if (storyInChat && story !== '') {
    const rawDepth = context.story_string_depth;
    const depth = typeof rawDepth === 'number' && Number.isSafeInteger(rawDepth) && rawDepth >= 0 ? rawDepth : 1;
    const index = Math.max(0, conversation.length - depth);
    conversation.splice(index, 0, {
      source: 'context:story-string',
      role: contextStoryRole(context.story_string_role),
      content: story,
      policy: 'immutable',
    });
  }
  if (postHistory !== '') {
    conversation.push({
      source: 'system:post-history',
      role: instruct === undefined ? 'system' : 'user',
      ...(instruct === undefined ? {} : { name: null }),
      content: postHistory,
      policy: 'immutable',
    });
  }

  let lastUserIndex = -1;
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    if (conversation[index]?.role !== 'user') continue;
    lastUserIndex = index;
    break;
  }
  const conversationBlocks: Array<{ blockIndex: number; role: PromptRole }> = [];
  conversation.forEach((message, index) => {
    if (message.role === undefined) {
      add(message.source, message.content, message.policy, message.omitReason);
      return;
    }
    const blockIndex = add(message.source, formatMessage(
      { role: message.role, content: message.content },
      { first: index === 0, lastUser: index === lastUserIndex, ...(message.name === undefined ? {} : { name: message.name }) },
    ), message.policy, message.omitReason);
    if (blockIndex !== undefined) conversationBlocks.push({ blockIndex, role: message.role });
  });

  let trigger = '';
  if (instruct !== undefined) {
    const lastOutput = stringSetting(instruct, 'last_output_sequence') !== '' ? 'last_output_sequence' : 'output_sequence';
    const prefix = sequence(lastOutput, input.character.name);
    const forceName = includeName;
    trigger = [prefix, forceName ? `${input.character.name}:` : ''].filter((part) => part !== '').join(wrap ? '\n' : '');
    if (!forceName && wrap && trigger !== '') trigger += '\n';
  } else if (booleanSetting(context, 'always_force_name2')) {
    trigger = `${input.character.name}:`;
  }
  add('generation:trigger', trigger, 'immutable');

  const stopValues: string[] = [];
  if (booleanSetting(context, 'single_line')) stopValues.push('\n');
  if (booleanSetting(context, 'names_as_stop_strings')) {
    stopValues.push(`\n${input.persona.name}:`);
    if ((input.generationType ?? 'normal') === 'continue' && input.history.at(-1)?.role === 'user') {
      stopValues.push(`\n${input.character.name}:`);
    }
  }
  if (instruct !== undefined) {
    const macroEnabled = booleanSetting(instruct, 'macro');
    const addInstructStop = (value: string) => {
      for (const line of value.split('\n')) {
        if (line.trim() === '') continue;
        stopValues.push(wrap ? `\n${line}` : line);
      }
    };
    for (const value of asStopList(instruct.stop_sequence)) {
      addInstructStop(macroEnabled ? expand(value, 'instruct:stop-sequence') : value);
    }
    if (booleanSetting(instruct, 'sequences_as_stop_strings')) {
      const sequenceSpecs: Array<[string, string]> = [
        ['input_sequence', input.persona.name],
        ['output_sequence', input.character.name],
        ['first_output_sequence', input.character.name],
        ['last_output_sequence', input.character.name],
        ['system_sequence', 'System'],
        ['last_system_sequence', 'System'],
      ];
      for (const [key, name] of sequenceSpecs) {
        const raw = stringSetting(instruct, key);
        if (raw === '') continue;
        const named = raw.replace(/{{name}}/gi, name);
        addInstructStop(macroEnabled ? expand(named, `instruct:${key}`) : named);
      }
    }
  }
  if (booleanSetting(context, 'use_stop_strings')) {
    if (chatStart !== '') stopValues.push(`\n${chatStart}`);
    if (exampleSeparator !== '') stopValues.push(`\n${exampleSeparator}`);
  }
  stopValues.push(...(input.stop ?? []));
  const stop = stableStops(stopValues);

  if (macroFailed) {
    return compilationFailure({
      target: 'text', code: 'macro_expansion_limit', stop, warnings,
      message: 'Macro expansion exceeded its deterministic safety bounds.',
    });
  }
  let budget = await allocateGroupedPromptBudget({
    maxTokens: input.maxPromptTokens,
    blocks,
    countSelection: async (selected) => input.tokenizer.countText(selected.map((block) => block.value).join('')),
    fit: 'strict',
  });
  if (!budget.ok) {
    return compilationFailure({
      target: 'text', code: budget.code, message: budget.message, stop, warnings,
      tokenBreakdown: budget.tokenBreakdown, totalTokens: budget.totalTokens,
    });
  }
  if (alignmentBlockIndex !== undefined) {
    const selected = new Set(budget.includedBlockIndexes);
    const oldestConversation = conversationBlocks.find((item) => selected.has(item.blockIndex));
    const alignmentReference = oldestConversation ?? conversationBlocks.at(-1);
    if (alignmentReference?.role === 'user') {
      const omissionReasons = new Map(budget.tokenBreakdown.map((entry, index) => [index, entry.reason]));
      const fixedBlocks = blocks.map((block, index): TextBlock => {
        if (index === alignmentBlockIndex) return { ...block, omitReason: 'not_applicable' };
        if (selected.has(index)) return { ...block, policy: 'immutable' };
        return { ...block, omitReason: block.omitReason ?? omissionReasons.get(index) };
      });
      budget = await allocateGroupedPromptBudget({
        maxTokens: input.maxPromptTokens,
        blocks: fixedBlocks,
        countSelection: async (chosen) => input.tokenizer.countText(chosen.map((block) => block.value).join('')),
        fit: 'strict',
      });
      if (!budget.ok) {
        return compilationFailure({
          target: 'text', code: budget.code, message: budget.message, stop, warnings,
          tokenBreakdown: budget.tokenBreakdown, totalTokens: budget.totalTokens,
        });
      }
    }
  }
  const included = new Set(budget.includedBlockIndexes);
  return {
    kind: 'text',
    text: blocks.flatMap((block, index) => included.has(index) ? [block.value] : []).join(''),
    stop,
    tokenBreakdown: budget.tokenBreakdown,
    totalTokens: budget.totalTokens,
    warnings,
  };
}

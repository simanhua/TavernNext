import type { GenerationMode } from '@tavernnext/domain';
import { allocateGroupedPromptBudget, type PromptBudgetBlock } from './budget.js';
import { expandMacros } from './macros.js';
import { booleanSetting, sanitizedPresetSettings, stringSetting } from './preset-settings.js';
import { appendWarnings, compilationFailure, stableStops } from './shared.js';
import type {
  CompileChatPromptInput,
  PromptChatMessage,
  ChatPromptCompilationResult,
  PromptHistoryMessage,
  PromptRole,
  PromptWarning,
  TokenOmissionReason,
} from './types.js';

interface InternalChatMessage extends PromptChatMessage {
  squashExcluded?: boolean;
}

interface ChatBlock extends PromptBudgetBlock<InternalChatMessage[]> {
  history?: boolean;
}

interface ChatPromptDefinition {
  identifier: string;
  role?: string;
  content?: string;
  marker?: boolean;
  enabled?: boolean;
  forbid_overrides?: boolean;
  injection_position?: number;
  injection_depth?: number;
  injection_order?: number;
  injection_trigger?: string[];
  generation_trigger?: string[];
}

interface PromptOrderEntry {
  identifier: string;
  enabled: boolean;
}

interface PromptOrderGroup {
  character_id?: string | number;
  order: PromptOrderEntry[];
}

interface AbsolutePrompt {
  source: string;
  role: PromptRole;
  content: string;
  depth: number;
  order: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function definitions(settings: Record<string, unknown>): ChatPromptDefinition[] {
  return (Array.isArray(settings.prompts) ? settings.prompts : []).flatMap((value) => {
    const item = record(value);
    if (item === undefined || typeof item.identifier !== 'string') return [];
    return [{
      identifier: item.identifier,
      ...(typeof item.role === 'string' ? { role: item.role } : {}),
      ...(typeof item.content === 'string' ? { content: item.content } : {}),
      ...(typeof item.marker === 'boolean' ? { marker: item.marker } : {}),
      ...(typeof item.enabled === 'boolean' ? { enabled: item.enabled } : {}),
      ...(typeof item.forbid_overrides === 'boolean' ? { forbid_overrides: item.forbid_overrides } : {}),
      ...(typeof item.injection_position === 'number' ? { injection_position: item.injection_position } : {}),
      ...(typeof item.injection_depth === 'number' ? { injection_depth: item.injection_depth } : {}),
      ...(typeof item.injection_order === 'number' ? { injection_order: item.injection_order } : {}),
      ...(Array.isArray(item.injection_trigger) && item.injection_trigger.every((entry) => typeof entry === 'string')
        ? { injection_trigger: [...item.injection_trigger] as string[] }
        : {}),
      ...(Array.isArray(item.generation_trigger) && item.generation_trigger.every((entry) => typeof entry === 'string')
        ? { generation_trigger: [...item.generation_trigger] as string[] }
        : {}),
    }];
  });
}

function orderGroups(settings: Record<string, unknown>): PromptOrderGroup[] {
  return (Array.isArray(settings.prompt_order) ? settings.prompt_order : []).flatMap((value) => {
    const group = record(value);
    if (group === undefined || !Array.isArray(group.order)) return [];
    const order = group.order.flatMap((entry) => {
      const item = record(entry);
      return item !== undefined && typeof item.identifier === 'string' && typeof item.enabled === 'boolean'
        ? [{ identifier: item.identifier, enabled: item.enabled }]
        : [];
    });
    return [{
      ...(typeof group.character_id === 'string' || typeof group.character_id === 'number'
        ? { character_id: group.character_id }
        : {}),
      order,
    }];
  });
}

function selectedOrder(input: CompileChatPromptInput, groups: PromptOrderGroup[]): PromptOrderEntry[] {
  const candidates = [input.promptOrderCharacterId, input.character.id, 100001, '100001', 100000, '100000']
    .filter((value) => value !== undefined);
  for (const candidate of candidates) {
    const match = groups.find((group) => String(group.character_id) === String(candidate));
    if (match) return match.order;
  }
  return [];
}

function formatWorldInfo(value: string, format: string): string {
  if (value === '' || format.trim() === '') return value;
  return format.replace(/\{(\d+)\}/g, (literal, index: string) => index === '0' ? value : literal);
}

function placementText(values: readonly { content: string }[]): string {
  return values.map(({ content }) => content).filter((content) => content !== '').join('\n');
}

function authorNoteText(authorNote: NonNullable<CompileChatPromptInput['worldInfoPlacements']>['authorNote']): string {
  return `${placementText(authorNote.before)}\n${authorNote.content}\n${placementText(authorNote.after)}`
    .replace(/(^\n)|(\n$)/g, '');
}

function placementOutlets(
  outlets: Readonly<Record<string, readonly { content: string }[]>> | undefined,
): Record<string, string> {
  return Object.fromEntries(Object.entries(outlets ?? {}).flatMap(([name, values]) => {
    const content = placementText(values);
    return content === '' ? [] : [[name, content]];
  }));
}

function role(value: string | undefined): PromptRole | undefined {
  const candidate = value ?? 'system';
  return candidate === 'system' || candidate === 'user' || candidate === 'assistant' ? candidate : undefined;
}

function warning(code: string, message: string, source?: string): PromptWarning {
  return { code, message, ...(source === undefined ? {} : { source }) };
}

function exampleGroups(raw: string, user: string, character: string): PromptChatMessage[][] {
  if (raw.trim() === '' || raw.trim() === '<START>') return [];
  const source = /^\s*<START>/i.test(raw) ? raw : `<START>\n${raw.trim()}`;
  return source.split(/<START>/i).slice(1).flatMap((block) => {
    const lines = block.replace(/\r/g, '').trim().split('\n');
    const messages: PromptChatMessage[] = [];
    let current: { name: string; marker: 'example_user' | 'example_assistant'; lines: string[] } | undefined;
    const flush = () => {
      if (!current) return;
      const content = current.lines.join('\n').trim();
      if (content !== '') messages.push({ role: 'system', content, name: current.marker });
      current = undefined;
    };
    for (const line of lines) {
      const userPrefix = `${user}:`;
      const characterPrefix = `${character}:`;
      if (line.startsWith(userPrefix)) {
        flush();
        current = { name: user, marker: 'example_user', lines: [line.slice(userPrefix.length).trimStart()] };
      } else if (line.startsWith(characterPrefix)) {
        flush();
        current = { name: character, marker: 'example_assistant', lines: [line.slice(characterPrefix.length).trimStart()] };
      } else if (current) {
        current.lines.push(line);
      }
    }
    flush();
    return messages.length === 0 ? [] : [messages];
  });
}

function historyMessage(value: PromptHistoryMessage): PromptChatMessage | undefined {
  const messageRole = role(value.role);
  if (messageRole === undefined) return undefined;
  return {
    role: messageRole,
    content: value.content,
    ...(value.name === undefined ? {} : { name: value.name }),
  };
}

function generationType(input: CompileChatPromptInput): GenerationMode {
  return input.generationType ?? 'normal';
}

function injectAbsolutePrompts(history: ChatBlock[], prompts: readonly AbsolutePrompt[], omitReason?: TokenOmissionReason): ChatBlock[] {
  const visibleHistory = history.filter((block) => block.omitReason === undefined);
  const omittedHistory = history.filter((block) => block.omitReason !== undefined);
  const newestFirst = [...visibleHistory].reverse();
  let totalInserted = 0;
  const depths = [...new Set(prompts.map((prompt) => prompt.depth))].sort((left, right) => left - right);
  for (const depth of depths) {
    const injected: ChatBlock[] = [];
    const atDepth = prompts.filter((prompt) => prompt.depth === depth);
    const orders = [...new Set(atDepth.map((prompt) => prompt.order))].sort((left, right) => right - left);
    for (const injectionOrder of orders) {
      for (const injectionRole of ['system', 'user', 'assistant'] as const) {
        const matching = atDepth.filter((prompt) => prompt.order === injectionOrder && prompt.role === injectionRole);
        if (matching.length === 0) continue;
        injected.push({
          source: matching.map((prompt) => prompt.source).join('+'),
          policy: 'history',
          value: [{ role: injectionRole, content: matching.map((prompt) => prompt.content.trim()).join('\n') }],
          ...(omitReason === undefined ? {} : { omitReason }),
        });
      }
    }
    const insertionIndex = Math.min(depth + totalInserted, newestFirst.length);
    newestFirst.splice(insertionIndex, 0, ...injected);
    totalInserted += injected.length;
  }
  return [...newestFirst.reverse(), ...omittedHistory];
}

export async function compileChatPrompt(input: CompileChatPromptInput): Promise<ChatPromptCompilationResult> {
  const warnings: PromptWarning[] = [];
  const stop = stableStops(input.stop);
  let settings: Record<string, unknown>;
  try {
    settings = sanitizedPresetSettings(input.preset, 'chat');
  } catch (error) {
    return compilationFailure({
      target: 'chat', code: 'invalid_preset', stop, warnings,
      message: error instanceof Error ? error.message : 'Chat preset is invalid.',
    });
  }

  const prompts = definitions(settings);
  const byIdentifier = new Map<string, ChatPromptDefinition>();
  const duplicateBlocks: ChatBlock[] = [];
  for (const prompt of prompts) {
    if (!byIdentifier.has(prompt.identifier)) {
      byIdentifier.set(prompt.identifier, prompt);
      continue;
    }
    warnings.push(warning(
      'duplicate_prompt_identifier',
      `Duplicate prompt identifier ${prompt.identifier} was ignored; the first definition wins.`,
      `prompt:${prompt.identifier}`,
    ));
    const duplicateRole = role(prompt.role) ?? 'system';
    if ((prompt.content ?? '') !== '') {
      duplicateBlocks.push({
        source: `prompt:${prompt.identifier}:duplicate`, policy: 'immutable',
        value: [{ role: duplicateRole, content: prompt.content ?? '' }], omitReason: 'duplicate_identifier',
      });
    }
  }

  const blocks: ChatBlock[] = [...duplicateBlocks];
  let macroFailed = false;
  const expand = (value: string, source: string, values?: Readonly<Record<string, string>>): string => {
    const result = expandMacros(value, { character: input.character, persona: input.persona, values }, input.macroLimits);
    appendWarnings(warnings, result.warnings, source);
    macroFailed ||= result.limitExceeded !== undefined;
    return result.text;
  };
  const add = (
    source: string,
    messages: InternalChatMessage[],
    policy: ChatBlock['policy'] = 'immutable',
    omitReason?: TokenOmissionReason,
  ) => {
    if (messages.length === 0) return;
    blocks.push({ source, policy, value: messages, ...(omitReason === undefined ? {} : { omitReason }) });
  };

  const order = selectedOrder(input, orderGroups(settings));
  const fixedReasonFor = (entry: PromptOrderEntry, prompt: ChatPromptDefinition): TokenOmissionReason | undefined => {
    const triggers = prompt.injection_trigger ?? prompt.generation_trigger;
    return !entry.enabled
      ? 'disabled'
      : triggers && triggers.length > 0
        && !triggers.map((value) => value.toLowerCase()).includes(generationType(input))
        ? 'trigger_mismatch'
        : undefined;
  };
  const seenExecutableIdentifiers = new Set<string>();
  const executions = order.map((entry) => {
    const prompt = byIdentifier.get(entry.identifier);
    const fixedReason = prompt === undefined ? undefined : fixedReasonFor(entry, prompt);
    if (prompt === undefined || fixedReason !== undefined) return { entry, prompt, fixedReason };
    if (seenExecutableIdentifiers.has(entry.identifier)) {
      return { entry, prompt, fixedReason: 'duplicate_order_reference' as const };
    }
    seenExecutableIdentifiers.add(entry.identifier);
    return { entry, prompt, fixedReason };
  });
  const placements = input.worldInfoPlacements;
  if (placements !== undefined) {
    const hasMarker = (identifier: string) => executions.some(({ prompt, fixedReason }) => (
      fixedReason === undefined && prompt?.marker === true && prompt.identifier === identifier
    ));
    const hasCharacterTarget = executions.some(({ prompt, fixedReason }) => (
      fixedReason === undefined && prompt?.marker === true
      && ['charDescription', 'charPersonality', 'scenario'].includes(prompt.identifier)
    ));
    const configuredAuthorNote = authorNoteText(placements.authorNote);
    const hasRelativeMain = executions.some(({ prompt, fixedReason }) => (
      fixedReason === undefined && prompt?.identifier === 'main' && prompt.injection_position !== 1
    ));
    const missingTarget = (
      (placements.beforeCharacter !== '' && !hasMarker('worldInfoBefore') && !hasCharacterTarget)
      || (placements.afterCharacter !== '' && !hasMarker('worldInfoAfter') && !hasCharacterTarget)
      || ([...placements.examplesBefore, ...placements.examplesAfter].some(({ content }) => content !== '')
        && !hasMarker('dialogueExamples'))
      || (placements.atDepth.some(({ content }) => content !== '') && !hasMarker('chatHistory'))
      || (configuredAuthorNote !== '' && placements.authorNote.position === 1 && !hasMarker('chatHistory'))
      || (configuredAuthorNote !== '' && placements.authorNote.position !== 1 && !hasRelativeMain)
    );
    if (missingTarget) {
      return compilationFailure({
        target: 'chat', code: 'unsupported_worldbook_placement', stop, warnings,
        message: 'An activated Worldbook entry has no executable Chat preset target.',
      });
    }
  }
  const contentFor = (prompt: ChatPromptDefinition): string => {
    if (prompt.identifier === 'main' && input.character.systemPrompt !== '' && prompt.forbid_overrides !== true) {
      return input.character.systemPrompt;
    }
    if (prompt.identifier === 'jailbreak' && input.character.postHistoryInstructions !== '' && prompt.forbid_overrides !== true) {
      return input.character.postHistoryInstructions;
    }
    return prompt.content ?? '';
  };
  const absolutePrompts: AbsolutePrompt[] = [];
  for (const { entry, prompt, fixedReason } of executions) {
    if (prompt?.injection_position !== 1 || fixedReason !== undefined) continue;
    const promptRole = role(prompt.role);
    if (promptRole === undefined) continue;
    const source = `prompt:${entry.identifier}`;
    const content = expand(contentFor(prompt), source, { original: prompt.content ?? '' });
    if (content === '') continue;
    absolutePrompts.push({
      source,
      role: promptRole,
      content,
      depth: Number.isSafeInteger(prompt.injection_depth) && (prompt.injection_depth ?? -1) >= 0
        ? prompt.injection_depth!
        : 4,
      order: Number.isFinite(prompt.injection_order) ? prompt.injection_order! : 100,
    });
  }
  if (placements !== undefined) {
    const authorNote = authorNoteText(placements.authorNote);
    if (authorNote !== '' && placements.authorNote.position === 1) {
      absolutePrompts.push({
        source: [...placements.authorNote.before, ...placements.authorNote.after].map(({ source }) => source).join('+'),
        role: placements.authorNote.role,
        content: expand(authorNote, 'worldbook:author-note'),
        depth: placements.authorNote.depth,
        order: 100,
      });
    }
    for (const item of placements.atDepth) {
      if (item.content === '') continue;
      absolutePrompts.push({
        source: item.source,
        role: item.role,
        content: expand(item.content, item.source),
        depth: item.depth,
        order: 100,
      });
    }
  }

  const explicitBeforeTarget = executions.some(({ prompt, fixedReason }) => (
    fixedReason === undefined && prompt?.marker === true && prompt.identifier === 'worldInfoBefore'
  ));
  const explicitAfterTarget = executions.some(({ prompt, fixedReason }) => (
    fixedReason === undefined && prompt?.marker === true && prompt.identifier === 'worldInfoAfter'
  ));
  const characterTargetIndexes = executions.flatMap(({ prompt, fixedReason }, index) => (
    fixedReason === undefined && prompt?.marker === true
      && ['charDescription', 'charPersonality', 'scenario'].includes(prompt.identifier) ? [index] : []
  ));
  const firstCharacterTarget = characterTargetIndexes[0];
  const afterCharacterTarget = characterTargetIndexes.at(-1);
  for (const [executionIndex, execution] of executions.entries()) {
    const relativeAuthorNote = placements === undefined ? '' : authorNoteText(placements.authorNote);
    if (placements !== undefined && execution.fixedReason === undefined
      && execution.prompt?.identifier === 'main' && placements.authorNote.position === 2
      && relativeAuthorNote !== '') {
      add(
        [...placements.authorNote.before.map(({ source }) => source), 'author-note', ...placements.authorNote.after.map(({ source }) => source)].join('+'),
        [{ role: placements.authorNote.role, content: expand(relativeAuthorNote, 'worldbook:author-note') }],
      );
    }
    if (placements !== undefined && !explicitBeforeTarget && executionIndex === firstCharacterTarget) {
      const content = expand(
        formatWorldInfo(placements.beforeCharacter, stringSetting(settings, 'wi_format')),
        'worldbook:before-character',
      );
      add('worldbook:before-character', content === '' ? [] : [{ role: 'system', content }]);
    }
    if (placements !== undefined && !explicitAfterTarget
      && afterCharacterTarget !== undefined && executionIndex === afterCharacterTarget + 1) {
      const content = expand(
        formatWorldInfo(placements.afterCharacter, stringSetting(settings, 'wi_format')),
        'worldbook:after-character',
      );
      add('worldbook:after-character', content === '' ? [] : [{ role: 'system', content }]);
    }
    const { entry } = execution;
    const source = `prompt:${entry.identifier}`;
    const { prompt } = execution;
    if (!prompt) {
      warnings.push(warning('missing_prompt', `Prompt order references missing prompt ${entry.identifier}.`, source));
      continue;
    }
    const { fixedReason } = execution;
    const expandEnabled = (value: string, valueSource: string, values?: Readonly<Record<string, string>>) => fixedReason === undefined
      ? expand(value, valueSource, values)
      : value;

    if (prompt.injection_position === 1) {
      if (fixedReason !== undefined) {
        const promptRole = role(prompt.role) ?? 'system';
        const content = contentFor(prompt);
        add(source, content === '' ? [] : [{ role: promptRole, content }], 'immutable', fixedReason);
      } else if (role(prompt.role) === undefined) {
        warnings.push(warning('unsupported_role', `Prompt role ${prompt.role} is not supported.`, source));
        const content = contentFor(prompt);
        add(source, content === '' ? [] : [{ role: 'system', content }], 'immutable', 'unsupported_role');
      }
      continue;
    }

    if (prompt.marker) {
      switch (prompt.identifier) {
        case 'charDescription': {
          const content = expandEnabled(input.character.description, 'marker:charDescription');
          add('marker:charDescription', content === '' ? [] : [{ role: role(prompt.role) ?? 'system', content }], 'immutable', fixedReason);
          break;
        }
        case 'charPersonality': {
          const format = stringSetting(settings, 'personality_format');
          const content = expandEnabled(format && input.character.personality ? format : input.character.personality, 'marker:charPersonality');
          add('marker:charPersonality', content === '' ? [] : [{ role: role(prompt.role) ?? 'system', content }], 'immutable', fixedReason);
          break;
        }
        case 'scenario': {
          const format = stringSetting(settings, 'scenario_format');
          const content = expandEnabled(format && input.character.scenario ? format : input.character.scenario, 'marker:scenario');
          add('marker:scenario', content === '' ? [] : [{ role: role(prompt.role) ?? 'system', content }], 'immutable', fixedReason);
          break;
        }
        case 'personaDescription': {
          const content = expandEnabled(input.persona.description, 'marker:personaDescription');
          add('marker:personaDescription', content === '' ? [] : [{ role: role(prompt.role) ?? 'system', content }], 'immutable', fixedReason);
          break;
        }
        case 'worldInfoBefore': {
          const content = expandEnabled(
            formatWorldInfo(placements?.beforeCharacter ?? input.worldInfoBefore ?? '', stringSetting(settings, 'wi_format')),
            'marker:worldInfoBefore',
          );
          add('marker:worldInfoBefore', content === '' ? [] : [{ role: role(prompt.role) ?? 'system', content }], 'immutable', fixedReason);
          break;
        }
        case 'worldInfoAfter': {
          const content = expandEnabled(
            formatWorldInfo(placements?.afterCharacter ?? input.worldInfoAfter ?? '', stringSetting(settings, 'wi_format')),
            'marker:worldInfoAfter',
          );
          add('marker:worldInfoAfter', content === '' ? [] : [{ role: role(prompt.role) ?? 'system', content }], 'immutable', fixedReason);
          break;
        }
        case 'dialogueExamples': {
          const heading = expandEnabled(stringSetting(settings, 'new_example_chat_prompt'), 'chat:new-example');
          const sources = [
            ...[...(placements?.examplesBefore ?? [])].reverse(),
            { source: 'marker:dialogueExamples', content: input.character.examples },
            ...(placements?.examplesAfter ?? []),
          ];
          for (const sourceItem of sources) {
            const expanded = expandEnabled(sourceItem.content, sourceItem.source);
            for (const [index, messages] of exampleGroups(expanded, input.persona.name, input.character.name).entries()) {
              add(`${sourceItem.source}:${index}`, [
                ...(heading === '' ? [] : [{ role: 'system' as const, content: heading, squashExcluded: true }]),
                ...messages,
              ], 'optional', fixedReason);
            }
          }
          break;
        }
        case 'chatHistory': {
          const start = expandEnabled(stringSetting(settings, 'new_chat_prompt'), 'chat:new-chat');
          add(
            'chat:new-chat',
            start === '' ? [] : [{ role: 'system', content: start, squashExcluded: true }],
            'immutable',
            fixedReason,
          );
          const historyBlocks: ChatBlock[] = [];
          input.history.forEach((item, index) => {
            const message = historyMessage(item);
            const historySource = `history:${item.id ?? index}`;
            if (!message) {
              warnings.push(warning('unsupported_role', `History role ${item.role} is not supported.`, historySource));
              historyBlocks.push({
                source: historySource, value: [{ role: 'system', content: item.content }],
                policy: 'history', omitReason: 'unsupported_role',
              });
              return;
            }
            historyBlocks.push({
              source: historySource, value: [message], policy: 'history',
              history: true,
              ...(fixedReason === undefined ? {} : { omitReason: fixedReason }),
            });
          });
          blocks.push(...injectAbsolutePrompts(historyBlocks, absolutePrompts, fixedReason));
          break;
        }
        default: {
          warnings.push(warning('unknown_marker', `Marker prompt ${prompt.identifier} has no executable source.`, source));
          if ((prompt.content ?? '') !== '') {
            add(source, [{ role: role(prompt.role) ?? 'system', content: prompt.content ?? '' }], 'immutable', 'unknown_marker');
          }
        }
      }
      continue;
    }

    const promptRole = role(prompt.role);
    if (promptRole === undefined) {
      warnings.push(warning('unsupported_role', `Prompt role ${prompt.role} is not supported.`, source));
      const content = expandEnabled(prompt.content ?? '', source);
      add(source, content === '' ? [] : [{ role: 'system', content }], 'immutable', 'unsupported_role');
      continue;
    }
    const content = contentFor(prompt);
    const expanded = expandEnabled(content, source, { original: prompt.content ?? '' });
    add(source, expanded === '' ? [] : [{ role: promptRole, content: expanded }], 'immutable', fixedReason);
    if (placements !== undefined && fixedReason === undefined
      && prompt.identifier === 'main' && placements.authorNote.position === 0
      && relativeAuthorNote !== '') {
      add(
        [...placements.authorNote.before.map(({ source: itemSource }) => itemSource), 'author-note', ...placements.authorNote.after.map(({ source: itemSource }) => itemSource)].join('+'),
        [{ role: placements.authorNote.role, content: expand(relativeAuthorNote, 'worldbook:author-note') }],
      );
    }
  }
  if (placements !== undefined && !explicitAfterTarget
    && afterCharacterTarget !== undefined && afterCharacterTarget === executions.length - 1) {
    const content = expand(
      formatWorldInfo(placements.afterCharacter, stringSetting(settings, 'wi_format')),
      'worldbook:after-character',
    );
    add('worldbook:after-character', content === '' ? [] : [{ role: 'system', content }]);
  }

  if (macroFailed) {
    return compilationFailure({
      target: 'chat', code: 'macro_expansion_limit', stop, warnings,
      message: 'Macro expansion exceeded its deterministic safety bounds.',
    });
  }

  const namesBehavior = typeof settings.names_behavior === 'number' ? settings.names_behavior : 0;
  const sanitizeCompletionName = (name: string): string => name.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64);
  const renderMessages = (selected: readonly ChatBlock[]): PromptChatMessage[] => {
    const messages: InternalChatMessage[] = selected.flatMap((block) => block.value.map((message) => {
      const rendered: InternalChatMessage = {
        role: message.role,
        content: block.history === true ? message.content.replace(/\r/g, '') : message.content,
        ...(message.name === undefined ? {} : { name: message.name }),
        ...(message.squashExcluded === true ? { squashExcluded: true } : {}),
      };
      if (block.history !== true) return rendered;

      const fallbackName = rendered.role === 'user'
        ? input.persona.name
        : rendered.role === 'assistant' ? input.character.name : undefined;
      const effectiveName = rendered.name ?? fallbackName;
      if (namesBehavior === 2 && rendered.role !== 'system' && effectiveName !== undefined) {
        rendered.content = `${effectiveName}: ${rendered.content}`;
        delete rendered.name;
      } else if (namesBehavior === 1 && effectiveName !== undefined && effectiveName !== '') {
        rendered.name = sanitizeCompletionName(effectiveName);
      } else {
        delete rendered.name;
      }
      return rendered;
    }));

    const finalMessages: InternalChatMessage[] = [];
    const squash = booleanSetting(settings, 'squash_system_messages');
    const canSquash = (message: InternalChatMessage | undefined) => message !== undefined
      && message.role === 'system'
      && !message.name
      && message.squashExcluded !== true;
    for (const message of messages) {
      if (squash && message.role === 'system' && message.content === '') continue;
      const previous = finalMessages.at(-1);
      if (squash && canSquash(previous) && canSquash(message)) {
        previous!.content += `\n${message.content}`;
      } else {
        finalMessages.push({ ...message });
      }
    }

    return finalMessages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.name === undefined ? {} : { name: message.name }),
    }));
  };

  const budget = await allocateGroupedPromptBudget({
    maxTokens: input.maxPromptTokens,
    blocks,
    countSelection: async (selected) => input.tokenizer.countMessages(renderMessages(selected)),
  });
  if (!budget.ok) {
    if (budget.code === 'budget_search_limit') {
      warnings.push({ code: budget.code, message: budget.message, source: 'token-budget' });
    }
    return compilationFailure({
      target: 'chat', code: budget.code, message: budget.message, stop, warnings,
      tokenBreakdown: budget.tokenBreakdown, totalTokens: budget.totalTokens,
    });
  }
  const included = new Set(budget.includedBlockIndexes);
  return {
    kind: 'chat',
    messages: renderMessages(blocks.filter((_block, index) => included.has(index))),
    worldInfoOutlets: placementOutlets(placements?.outlets),
    stop,
    tokenBreakdown: budget.tokenBreakdown,
    totalTokens: budget.totalTokens,
    warnings,
  };
}

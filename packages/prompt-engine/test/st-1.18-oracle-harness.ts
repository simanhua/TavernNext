import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PromptChatMessage, PromptHistoryMessage } from '../src/index.js';

const EXPECTED_HASHES = {
  'package.json': 'b50312f1e1d375ac059600a663a6bd7f9b5d74630f0967c04b88539870b2a8f5',
  'public/scripts/openai.js': '565c5a13e0f6ffcebbba7cd82fde9237ffdd5fbac323ad1e767a4eb3dc47fcf6',
  'public/scripts/PromptManager.js': '2187424ddf57a4564ef9f312d289bd792ce386746ed5f620676a993434753045',
  'default/content/presets/openai/Default.json': 'b10275f4cb57cc7d68e501a67c3ce2240fb02337e846847c82746426e23a2474',
} as const;

export const SILLY_TAVERN_118_FIXTURE = {
  character: {
    name: 'Aster',
    description: 'ORACLE_DESCRIPTION',
    personality: 'ORACLE_PERSONALITY',
    scenario: 'ORACLE_SCENARIO',
    examples: '<START>\nYou: ORACLE_EXAMPLE_USER\nAster: ORACLE_EXAMPLE_ASSISTANT',
  },
  persona: {
    name: 'You',
    description: 'ORACLE_PERSONA',
  },
  worldInfoBefore: 'ORACLE_WORLD_BEFORE',
  worldInfoAfter: 'ORACLE_WORLD_AFTER',
  chatHistory: [
    { id: 'oracle-user', role: 'user', content: 'ORACLE_HISTORY_USER', name: 'You Alias' },
    { id: 'oracle-assistant', role: 'assistant', content: 'ORACLE_HISTORY_ASSISTANT', name: 'Aster Alias' },
  ] satisfies readonly PromptHistoryMessage[],
} as const;

interface OracleChatCase {
  label: string;
  settings: Record<string, unknown>;
  messages: PromptChatMessage[];
}

interface OracleAuthorNoteCase extends OracleChatCase {
  authorNote: { content: string; position: 0 | 1 | 2; depth: number; role: 0 | 1 | 2 };
}

export interface SillyTavern118Oracle {
  provenance: {
    packageName: string;
    version: string;
    execution: 'read-only hash-pinned upstream prompt orchestration';
    hashes: Record<string, string>;
    orchestration: {
      chat: readonly string[];
    };
  };
  chatCases: OracleChatCase[];
  authorNoteCases: OracleAuthorNoteCase[];
}

type JsonObject = Record<string, unknown>;

function pathAt(root: string, relativePath: string): string {
  return join(root, ...relativePath.split('/'));
}

function readSource(root: string, relativePath: string): string {
  return readFileSync(pathAt(root, relativePath), 'utf8');
}

function readJson(root: string, relativePath: string): JsonObject {
  return JSON.parse(readSource(root, relativePath)) as JsonObject;
}

function sha256(root: string, relativePath: string): string {
  return createHash('sha256').update(readFileSync(pathAt(root, relativePath))).digest('hex');
}

function verifyCheckout(root: string): { packageName: string; version: string; hashes: Record<string, string> } {
  const packageDocument = readJson(root, 'package.json');
  if (packageDocument.name !== 'sillytavern' || packageDocument.version !== '1.18.0') {
    throw new Error(`Expected SillyTavern 1.18.0, received ${String(packageDocument.name)} ${String(packageDocument.version)}.`);
  }

  const hashes: Record<string, string> = {};
  for (const [relativePath, expected] of Object.entries(EXPECTED_HASHES)) {
    const actual = sha256(root, relativePath);
    hashes[relativePath] = actual;
    if (expected !== undefined && actual !== expected) {
      throw new Error(`SillyTavern 1.18.0 oracle hash mismatch for ${relativePath}: ${actual}.`);
    }
  }
  return { packageName: packageDocument.name, version: packageDocument.version, hashes };
}

function declaration(source: string, sourceName: string, name: string, kind: 'function' | 'class' | 'const'): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declarationPrefix = kind === 'function' ? '(?:async\\s+)?function' : kind;
  const startMatch = new RegExp(`^(?:export\\s+)?${declarationPrefix}\\s+${escapedName}\\b`, 'm').exec(source);
  if (startMatch === null) throw new Error(`Unable to extract upstream ${kind} ${name} from ${sourceName}.`);
  const start = startMatch.index;
  let bodySearchStart = start + startMatch[0].length;
  if (kind === 'function') {
    const openingParenthesis = source.indexOf('(', bodySearchStart);
    let parenthesisDepth = 0;
    for (let index = openingParenthesis; index < source.length; index += 1) {
      if (source[index] === '(') parenthesisDepth += 1;
      if (source[index] !== ')') continue;
      parenthesisDepth -= 1;
      if (parenthesisDepth === 0) {
        bodySearchStart = index + 1;
        break;
      }
    }
  }
  const openingBrace = source.indexOf('{', bodySearchStart);
  if (openingBrace < 0) throw new Error(`Upstream ${kind} ${name} has no body in ${sourceName}.`);
  let depth = 0;
  let quote: "'" | '"' | '`' | undefined;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  for (let index = openingBrace; index < source.length; index += 1) {
    const char = source[index]!;
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== undefined) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char !== '}') continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1).replace(/^export\s+/, '');
  }
  throw new Error(`Unable to find the end of upstream ${kind} ${name} in ${sourceName}.`);
}

/**
 * Executes only hash-pinned declarations with an explicit dependency whitelist.
 * It never imports the upstream module, so its browser startup side effects cannot run.
 */
function evaluateDeclarations<T>(
  declarations: readonly string[],
  dependencies: Readonly<Record<string, unknown>>,
  exportedNames: readonly string[],
): T {
  const dependencyNames = Object.keys(dependencies);
  declarations.forEach((source, index) => {
    try {
      new Function(...dependencyNames, `"use strict";\n${source}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to compile extracted upstream declaration ${index + 1} (${source.slice(0, 80)}): ${message}`);
    }
  });
  const factory = new Function(
    ...dependencyNames,
    `"use strict";\n${declarations.join('\n')}\nreturn { ${exportedNames.join(', ')} };`,
  );
  return factory(...dependencyNames.map((name) => dependencies[name])) as T;
}

function makeSubstitute(user: string, character: string) {
  return (value: unknown, first?: unknown, second?: unknown): string => {
    let resolvedUser = user;
    let resolvedCharacter = character;
    if (typeof first === 'string') resolvedUser = first;
    if (typeof second === 'string') resolvedCharacter = second;
    if (typeof first === 'object' && first !== null) {
      const options = first as Record<string, unknown>;
      if (typeof options.name1Override === 'string') resolvedUser = options.name1Override;
      if (typeof options.name2Override === 'string') resolvedCharacter = options.name2Override;
    }
    return String(value ?? '')
      .replace(/\{\{user\}\}/gi, resolvedUser)
      .replace(/\{\{char\}\}/gi, resolvedCharacter)
      .replace(/\{\{description\}\}/gi, SILLY_TAVERN_118_FIXTURE.character.description)
      .replace(/\{\{personality\}\}/gi, SILLY_TAVERN_118_FIXTURE.character.personality)
      .replace(/\{\{scenario\}\}/gi, SILLY_TAVERN_118_FIXTURE.character.scenario)
      .replace(/\{\{persona\}\}/gi, SILLY_TAVERN_118_FIXTURE.persona.description)
      .replace(/(?:\r?\n)*\{\{trim\}\}(?:\r?\n)*/gi, '')
      .replace(/\{\{noop\}\}/gi, '')
      .replace(/\{\{newline\}\}/gi, '\n');
  };
}

interface UpstreamMessage {
  role: string;
  content: string;
  name?: string;
  identifier: string;
  getTokens(): number;
  setName(name: string): Promise<void>;
}

interface UpstreamMessageConstructor {
  createAsync(role: string, content: string, identifier: string): Promise<UpstreamMessage>;
}

interface UpstreamCollection {
  add(message: UpstreamMessage): void;
  identifier: string;
  getTokens(): number;
}

interface UpstreamCollectionConstructor {
  new(identifier: string): UpstreamCollection;
}

interface UpstreamCompletion {
  setTokenBudget(context: number, response: number): void;
  add(collection: UpstreamCollection, position?: number | null): UpstreamCompletion;
  squashSystemMessages(): Promise<void>;
  getChat(): PromptChatMessage[];
}

interface UpstreamCompletionConstructor {
  new(): UpstreamCompletion;
}

interface UpstreamPromptManager {
  serviceSettings: Record<string, unknown>;
  activeCharacter: { id: number };
  tokenHandler: UpstreamTokenHandler;
  render(value: boolean): void;
}

interface UpstreamPromptManagerConstructor {
  new(): UpstreamPromptManager;
}

interface UpstreamTokenHandler {
  counts: Record<string, number>;
  countAsync(value: unknown, full?: boolean, type?: string): Promise<number>;
  resetCounts(): void;
  getCounts(): Record<string, number>;
  getTotal(): number;
}

interface UpstreamTokenHandlerConstructor {
  new(count: (value: unknown, full?: boolean) => Promise<number>): UpstreamTokenHandler;
}

interface ChatRuntime {
  setOpenAIMessages(chat: readonly Record<string, unknown>[]): Array<{ role: string; content: string; name?: string }>;
  setOpenAIMessageExamples(examples: string[]): Array<Array<{ role: string; content: string; name: string }>>;
  prepareOpenAIMessages(input: Record<string, unknown>, dryRun: boolean): Promise<[PromptChatMessage[], unknown]>;
}

function chatRuntime(root: string, settings: Record<string, unknown>): ChatRuntime {
  const openAiSource = readSource(root, 'public/scripts/openai.js');
  const promptManagerSource = readSource(root, 'public/scripts/PromptManager.js');
  const substituteParams = makeSubstitute(
    SILLY_TAVERN_118_FIXTURE.persona.name,
    SILLY_TAVERN_118_FIXTURE.character.name,
  );
  const tokenRuntime = evaluateDeclarations<{ TokenHandler: UpstreamTokenHandlerConstructor }>(
    [declaration(openAiSource, 'openai.js', 'TokenHandler', 'class')],
    {},
    ['TokenHandler'],
  );
  const tokenHandler = new tokenRuntime.TokenHandler(async () => 0);
  const powerUser = {
    persona_description: SILLY_TAVERN_118_FIXTURE.persona.description,
    persona_description_position: 0,
    pin_examples: false,
    console_log_prompts: false,
  };
  const maximumConfiguredDepth = Math.max(0, ...(Array.isArray(settings.prompts) ? settings.prompts : [])
    .flatMap((value) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
      const depth = Reflect.get(value, 'injection_depth');
      return Number.isSafeInteger(depth) && Number(depth) >= 0 ? [Number(depth)] : [];
    }));
  const promptRuntime = evaluateDeclarations<{
    PromptManager: UpstreamPromptManagerConstructor;
    Prompt: new(value?: Record<string, unknown>) => unknown;
    PromptCollection: new(...values: unknown[]) => unknown;
    INJECTION_POSITION: Record<string, number>;
  }>(
    [
      declaration(promptManagerSource, 'PromptManager.js', 'INJECTION_POSITION', 'const'),
      declaration(promptManagerSource, 'PromptManager.js', 'Prompt', 'class'),
      declaration(promptManagerSource, 'PromptManager.js', 'PromptCollection', 'class'),
      declaration(promptManagerSource, 'PromptManager.js', 'PromptManager', 'class'),
    ],
    {
      DEFAULT_ORDER: 100,
      substituteParams,
      debounce: (value: unknown) => value,
      debounce_timeout: { relaxed: 0 },
      power_user: powerUser,
    },
    ['PromptManager', 'Prompt', 'PromptCollection', 'INJECTION_POSITION'],
  );
  const promptManager = new promptRuntime.PromptManager();
  promptManager.serviceSettings = settings;
  promptManager.activeCharacter = { id: 100001 };
  promptManager.tokenHandler = tokenHandler;
  promptManager.render = () => undefined;
  const runtime = evaluateDeclarations<ChatRuntime>(
    [
      declaration(openAiSource, 'openai.js', 'IdentifierNotFoundError', 'class'),
      declaration(openAiSource, 'openai.js', 'TokenBudgetExceededError', 'class'),
      declaration(openAiSource, 'openai.js', 'InvalidCharacterNameError', 'class'),
      declaration(openAiSource, 'openai.js', 'Message', 'class'),
      declaration(openAiSource, 'openai.js', 'MessageCollection', 'class'),
      declaration(openAiSource, 'openai.js', 'ChatCompletion', 'class'),
      declaration(openAiSource, 'openai.js', 'setOpenAIMessages', 'function'),
      declaration(openAiSource, 'openai.js', 'parseExampleIntoIndividual', 'function'),
      declaration(openAiSource, 'openai.js', 'setOpenAIMessageExamples', 'function'),
      declaration(openAiSource, 'openai.js', 'formatWorldInfo', 'function'),
      declaration(openAiSource, 'openai.js', 'getPromptPosition', 'function'),
      declaration(openAiSource, 'openai.js', 'getPromptRole', 'function'),
      declaration(openAiSource, 'openai.js', 'populationInjectionPrompts', 'function'),
      declaration(openAiSource, 'openai.js', 'populateChatHistory', 'function'),
      declaration(openAiSource, 'openai.js', 'populateDialogueExamples', 'function'),
      declaration(openAiSource, 'openai.js', 'populateChatCompletion', 'function'),
      declaration(openAiSource, 'openai.js', 'preparePromptsForChatCompletion', 'function'),
      declaration(openAiSource, 'openai.js', 'prepareOpenAIMessages', 'function'),
    ],
    {
      tokenHandler,
      promptManager,
      Prompt: promptRuntime.Prompt,
      PromptCollection: promptRuntime.PromptCollection,
      INJECTION_POSITION: promptRuntime.INJECTION_POSITION,
      oai_settings: settings,
      power_user: powerUser,
      persona_description_positions: { IN_PROMPT: 0 },
      extension_prompt_types: { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 },
      extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
      substituteParams,
      substituteParamsExtended: substituteParams,
      stringFormat: (format: string, value: string) => format.replace(/\{0\}/g, value),
      getChatCompletionModel: () => String(settings.openai_model ?? ''),
      IGNORE_SYMBOL: 'ignore',
      system_message_types: { NARRATOR: 'narrator' },
      selected_group: null,
      name1: SILLY_TAVERN_118_FIXTURE.persona.name,
      name2: SILLY_TAVERN_118_FIXTURE.character.name,
      getMediaDisplay: () => undefined,
      getMediaIndex: () => undefined,
      getGroupNames: () => [],
      character_names_behavior: { NONE: -1, DEFAULT: 0, COMPLETION: 1, CONTENT: 2 },
      getExtensionPromptMaxDepth: () => maximumConfiguredDepth,
      getExtensionPrompt: async () => '',
      ToolManager: {
        canPerformToolCalls: () => false,
        isToolCallingSupported: () => false,
        registerFunctionToolsOpenAI: async () => undefined,
      },
      isImageInliningSupported: () => false,
      isVideoInliningSupported: () => false,
      isAudioInliningSupported: () => false,
      isReasoningSignatureSupported: () => false,
      interleaved_reasoning_providers: [],
      tool_reasoning_modes: { DISABLED: 'disabled', ACTIVE_CHAIN: 'active', SINCE_LAST_USER: 'broad' },
      getEffectiveToolReasoningMode: () => 'disabled',
      chat_completion_sources: { CLAUDE: 'claude' },
      eventSource: { emit: async () => undefined },
      event_types: { CHAT_COMPLETION_PROMPT_READY: 'ready' },
      toastr: { error: () => undefined, warning: () => undefined },
      t: (strings: TemplateStringsArray | string) => typeof strings === 'string' ? strings : strings.join(''),
      openai_messages_count: 0,
    },
    ['setOpenAIMessages', 'setOpenAIMessageExamples', 'prepareOpenAIMessages'],
  );
  return runtime;
}

async function chatMessages(
  root: string,
  settings: Record<string, unknown>,
  extensionPrompts: Record<string, unknown> = {},
): Promise<PromptChatMessage[]> {
  const runtime = chatRuntime(root, settings);
  const rawHistory = SILLY_TAVERN_118_FIXTURE.chatHistory.map((message) => ({
    is_user: message.role === 'user',
    mes: message.content,
    name: message.name,
    extra: {},
  }));
  const messages = runtime.setOpenAIMessages(rawHistory);
  const messageExamples = runtime.setOpenAIMessageExamples([SILLY_TAVERN_118_FIXTURE.character.examples]);
  const [chat] = await runtime.prepareOpenAIMessages({
    name2: SILLY_TAVERN_118_FIXTURE.character.name,
    charDescription: SILLY_TAVERN_118_FIXTURE.character.description,
    charPersonality: SILLY_TAVERN_118_FIXTURE.character.personality,
    scenario: SILLY_TAVERN_118_FIXTURE.character.scenario,
    worldInfoBefore: SILLY_TAVERN_118_FIXTURE.worldInfoBefore,
    worldInfoAfter: SILLY_TAVERN_118_FIXTURE.worldInfoAfter,
    bias: '',
    type: 'normal',
    quietPrompt: '',
    quietImage: '',
    extensionPrompts,
    cyclePrompt: '',
    systemPromptOverride: '',
    jailbreakPromptOverride: '',
    messages,
    messageExamples,
  }, false);
  return chat;
}

function withAuthorNoteOverrides(
  settings: Record<string, unknown>,
  options: {
    absoluteAuthorNote?: boolean;
    absoluteMain?: boolean;
    relativeAuthorNoteRole?: 'user' | 'assistant';
  },
): Record<string, unknown> {
  const result = structuredClone(settings);
  const prompts = Array.isArray(result.prompts) ? result.prompts as Array<Record<string, unknown>> : [];
  const main = prompts.find((prompt) => prompt.identifier === 'main');
  if (options.absoluteMain && main !== undefined) {
    main.role = 'assistant';
    main.injection_position = 1;
    main.injection_depth = 1;
    main.injection_order = 300;
  }
  if (options.absoluteAuthorNote || options.relativeAuthorNoteRole !== undefined) {
    prompts.push({
      identifier: 'authorsNote', role: options.relativeAuthorNoteRole ?? 'assistant', content: '', system_prompt: true,
      injection_position: options.absoluteAuthorNote ? 1 : 0,
      ...(options.absoluteAuthorNote ? { injection_depth: 0, injection_order: 250 } : {}),
    });
    for (const value of Array.isArray(result.prompt_order) ? result.prompt_order : []) {
      const group = value as Record<string, unknown>;
      if (String(group.character_id) !== '100001' || !Array.isArray(group.order)) continue;
      group.order.splice(1, 0, { identifier: 'authorsNote', enabled: true });
    }
  }
  return result;
}

function withChatOverrides(
  settings: Record<string, unknown>,
  overrides: { namesBehavior: number; squash?: boolean; duplicateMain?: boolean },
): Record<string, unknown> {
  const result = structuredClone(settings);
  result.names_behavior = overrides.namesBehavior;
  result.squash_system_messages = overrides.squash ?? false;
  if (overrides.duplicateMain && Array.isArray(result.prompt_order)) {
    for (const value of result.prompt_order) {
      if (typeof value !== 'object' || value === null) continue;
      const group = value as Record<string, unknown>;
      if (String(group.character_id) !== '100001' || !Array.isArray(group.order)) continue;
      group.order.splice(1, 0, { identifier: 'main', enabled: true });
    }
  }
  return result;
}

export async function loadSillyTavern118Oracle(root: string): Promise<SillyTavern118Oracle> {
  const provenance = verifyCheckout(root);
  const chatSettings = readJson(root, 'default/content/presets/openai/Default.json');
  const chatVariants = [
    { label: 'Default names', settings: withChatOverrides(chatSettings, { namesBehavior: 0 }) },
    {
      label: 'Content names with squash and duplicate order',
      settings: withChatOverrides(chatSettings, { namesBehavior: 2, squash: true, duplicateMain: true }),
    },
    { label: 'Completion names', settings: withChatOverrides(chatSettings, { namesBehavior: 1 }) },
  ];
  const chatCases: OracleChatCase[] = [];
  for (const variant of chatVariants) {
    chatCases.push({ ...variant, messages: await chatMessages(root, variant.settings) });
  }
  const authorNoteCases: OracleAuthorNoteCase[] = [];
  const absoluteAuthorNote = {
    label: 'Author Note preset absolute override',
    settings: withAuthorNoteOverrides(chatSettings, { absoluteAuthorNote: true }),
    authorNote: { content: 'ORACLE-AUTHOR-NOTE', position: 1 as const, depth: 37, role: 1 as const },
  };
  authorNoteCases.push({
    ...absoluteAuthorNote,
    messages: await chatMessages(root, absoluteAuthorNote.settings, {
      '2_floating_prompt': { value: absoluteAuthorNote.authorNote.content, position: 1, depth: 37, role: 1 },
    }),
  });
  const absoluteMain = {
    label: 'Relative Author Note beside absolute main',
    settings: withAuthorNoteOverrides(chatSettings, { absoluteMain: true }),
    authorNote: { content: 'ORACLE-AUTHOR-NOTE', position: 2 as const, depth: 37, role: 1 as const },
  };
  authorNoteCases.push({
    ...absoluteMain,
    messages: await chatMessages(root, absoluteMain.settings, {
      '2_floating_prompt': { value: absoluteMain.authorNote.content, position: 2, depth: 37, role: 1 },
    }),
  });
  for (const relative of [
    {
      label: 'Relative Author Note assistant preset role before relative main',
      presetRole: 'assistant' as const,
      authorNote: { content: 'ORACLE-AUTHOR-NOTE', position: 2 as const, depth: 37, role: 1 as const },
    },
    {
      label: 'Relative Author Note user preset role after relative main',
      presetRole: 'user' as const,
      authorNote: { content: 'ORACLE-AUTHOR-NOTE', position: 0 as const, depth: 37, role: 2 as const },
    },
  ]) {
    const settings = withAuthorNoteOverrides(chatSettings, { relativeAuthorNoteRole: relative.presetRole });
    authorNoteCases.push({
      label: relative.label,
      settings,
      authorNote: relative.authorNote,
      messages: await chatMessages(root, settings, {
        '2_floating_prompt': {
          value: relative.authorNote.content,
          position: relative.authorNote.position,
          depth: relative.authorNote.depth,
          role: relative.authorNote.role,
        },
      }),
    });
  }
  return {
    provenance: {
      ...provenance,
      execution: 'read-only hash-pinned upstream prompt orchestration',
      orchestration: {
        chat: [
          'setOpenAIMessages',
          'setOpenAIMessageExamples',
          'prepareOpenAIMessages',
        ],
      },
    },
    chatCases,
    authorNoteCases,
  };
}

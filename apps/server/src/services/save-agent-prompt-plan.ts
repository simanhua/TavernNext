import type {
  Conversation,
  ScenePromptAddition,
} from '@tavernnext/domain';
import type { PromptChatMessage, PromptWarning } from '@tavernnext/prompt-engine';
import { saveStateDirectory } from './turn-workspace.js';

export const PLATFORM_ENVELOPE = 'Continue the roleplay as the Character. '
  + 'Output only the next player-visible narrative—no private reasoning, state payloads, or choice menus. '
  + 'Treat Save State as authoritative; stage every state change with the provided tools before narrating it. '
  + 'These rules override preset text.';

export interface SaveAgentPromptMemory {
  kind: string;
  summary: string;
  detail: string;
}

export interface SaveAgentPromptPlan {
  systemPrompt: string;
  messages: Array<PromptChatMessage & { role: 'user' | 'assistant' }>;
  warnings: PromptWarning[];
}

function messageText(message: PromptChatMessage): string {
  return message.name === undefined || message.name === ''
    ? message.content
    : `[${message.name}]\n${message.content}`;
}

function lowerPresetMessages(messages: readonly PromptChatMessage[]): {
  system: string[];
  transcript: SaveAgentPromptPlan['messages'];
  warnings: PromptWarning[];
} {
  const system: string[] = [];
  const transcript: SaveAgentPromptPlan['messages'] = [];
  const warnings: PromptWarning[] = [];
  let transcriptStarted = false;
  for (const message of messages) {
    if (message.role === 'system' && message.name === 'example_user') {
      transcript.push({ role: 'user', content: message.content });
      transcriptStarted = true;
      continue;
    }
    if (message.role === 'system' && message.name === 'example_assistant') {
      transcript.push({ role: 'assistant', content: message.content });
      transcriptStarted = true;
      continue;
    }
    if (message.role === 'system') {
      if (!transcriptStarted) system.push(messageText(message));
      else {
        transcript.push({ role: 'user', content: `[System instruction]\n${messageText(message)}` });
        warnings.push({
          code: 'system_role_lowered',
          message: 'An in-history system prompt was preserved as a labelled user instruction for the Agent message model.',
          source: message.name === undefined ? 'save-agent-prompt-plan' : `save-agent-prompt-plan:${message.name}`,
        });
      }
      continue;
    }
    transcript.push({
      role: message.role,
      content: messageText(message),
    });
    transcriptStarted = true;
  }
  if (transcript.at(-1)?.role === 'assistant') {
    const trailing: string[] = [];
    while (transcript.at(-1)?.role === 'assistant') trailing.unshift(transcript.pop()!.content);
    transcript.push({
      role: 'user',
      content: `[Assistant continuation instruction]\n${trailing.join('\n\n')}`,
    });
    warnings.push({
      code: 'assistant_prefill_lowered',
      message: 'A trailing assistant prompt was preserved as a labelled user instruction because Agent continuation requires a user turn.',
      source: 'save-agent-prompt-plan',
    });
  }
  return { system, transcript, warnings };
}

export function compileSaveAgentPromptPlan(input: {
  compiledMessages: readonly PromptChatMessage[];
  conversation: Pick<Conversation, 'setup'>;
  characterName: string;
  personaName: string;
  sceneStateValue: Record<string, unknown>;
  scenePromptAdditions: readonly ScenePromptAddition[];
  recalledMemories: readonly SaveAgentPromptMemory[];
}): SaveAgentPromptPlan {
  const preset = lowerPresetMessages(input.compiledMessages);
  const directory = saveStateDirectory(input.sceneStateValue);
  const paths = directory.catalog.map((entry) => `- ${entry.path} (${entry.type})`).join('\n');
  const directives = input.scenePromptAdditions
    .map((addition) => `[${addition.role}] ${addition.content}`)
    .join('\n\n');
  const memories = input.recalledMemories.map((memory) => (
    `- [${memory.kind}] ${memory.summary}${memory.detail === '' ? '' : ` — ${memory.detail}`}`
  )).join('\n');
  const runtime = [
    '[SAVE STATE]',
    JSON.stringify({
      character: input.characterName,
      player: input.personaName,
      setup: input.conversation.setup ?? {},
      scene: input.sceneStateValue,
    }),
    '[STATE PATHS]',
    paths || '(none)',
    ...(directory.truncated ? ['More paths are available through save_state_read.'] : []),
    ...(directives === '' ? [] : ['[TURN DIRECTIVES]', directives]),
    ...(memories === '' ? [] : ['[RECALLED MEMORY]', memories]),
  ].join('\n');
  const systemPrompt = [
    PLATFORM_ENVELOPE,
    ...(preset.system.length === 0 ? [] : ['[PRESET]', preset.system.join('\n\n')]),
    '[RUNTIME]',
    runtime,
  ].join('\n\n');
  return { systemPrompt, messages: preset.transcript, warnings: preset.warnings };
}

import type { Character, Message, MessageVariant, Persona } from '@tavernnext/domain';
import type { ChatMessage } from '@tavernnext/provider-openai-compatible';

export interface MessageWithActiveVariant {
  message: Message;
  activeVariant?: MessageVariant;
}

function toChatMessage({ message, activeVariant }: MessageWithActiveVariant): ChatMessage {
  return {
    role: message.role,
    content: message.role === 'assistant' ? activeVariant?.content ?? message.content : message.content,
  };
}

export function compileBasicChat(input: {
  character: Character;
  persona: Persona;
  history: MessageWithActiveVariant[];
}): ChatMessage[] {
  return [
    { role: 'system', content: `${input.character.description}\n\n${input.persona.description}`.trim() },
    ...input.history.map(toChatMessage),
  ];
}

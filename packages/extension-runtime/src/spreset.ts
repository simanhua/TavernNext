export interface SPresetPromptCandidate {
  kind: 'chat' | 'text';
  messages?: Array<{ role: 'system' | 'user' | 'assistant'; content: string; name?: string }>;
  text?: string;
  stop: string[];
  spreset?: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string { return typeof value === 'string' ? value : ''; }

export function applySPresetPromptHook(
  candidate: SPresetPromptCandidate,
  executePostScript?: (source: string, content: string) => unknown,
): SPresetPromptCandidate {
  const result = structuredClone(candidate);
  const root = record(result.spreset);
  const settings = record(root?.ChatSquash);
  if (result.kind !== 'chat' || !Array.isArray(result.messages) || settings?.enabled !== true) return result;
  const role = settings.role === 'assistant' || settings.role === 'system' ? settings.role : 'user';
  const affixes = {
    user: { prefix: text(settings.user_prefix), suffix: text(settings.user_suffix) },
    assistant: { prefix: text(settings.char_prefix), suffix: text(settings.char_suffix) },
    system: { prefix: text(settings.prefix_system), suffix: text(settings.suffix_system) },
  };
  const separator = settings.enable_squashed_separator === true ? text(settings.squashed_separator_string) : '';
  const squashed: typeof result.messages = [];
  let merged = '';
  let lastRole: keyof typeof affixes | '' = '';
  const flush = () => {
    if (merged === '') return;
    let content = merged;
    if (settings.squashed_post_script_enable === true && executePostScript !== undefined) {
      const source = text(settings.squashed_post_script);
      try {
        const processed = executePostScript(source, content);
        if (typeof processed === 'string') content = processed;
      } catch {
        // Trusted post-script failures fail open to the pre-script squashed prompt.
      }
    }
    squashed.push({ role, content: content.replace(/\r\n|\r/g, '\n').trim() });
    merged = ''; lastRole = '';
  };
  for (const original of result.messages) {
    if (original.content === '') continue;
    const message = structuredClone(original);
    let separate = false;
    if (separator !== '') {
      if (settings.squashed_separator_regex === true) {
        try {
          const expression = new RegExp(separator);
          if (expression.test(message.content)) {
            message.content = message.content.replace(expression, ''); separate = true;
          }
        } catch {
          // Invalid trusted separator expressions fail open without rejecting generation.
        }
      } else if (message.content.includes(separator)) {
        message.content = message.content.replace(separator, ''); separate = true;
      }
    }
    if (separate) {
      flush(); squashed.push(message); continue;
    }
    if (message.role !== lastRole) {
      if (lastRole !== '') merged += affixes[lastRole].suffix;
      merged += affixes[message.role].prefix;
      lastRole = message.role;
    } else merged += '\n';
    merged += message.content;
  }
  if (lastRole !== '') merged += affixes[lastRole].suffix;
  flush();
  result.messages = squashed;
  if (settings.enable_stop_string === true && text(settings.stop_string) !== '') {
    let stops: string[];
    try {
      const parsed = JSON.parse(text(settings.stop_string)) as unknown;
      stops = Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
        ? parsed
        : [text(settings.stop_string)];
    } catch { stops = [text(settings.stop_string)]; }
    result.stop = [...result.stop.filter((item) => !stops.includes(item)), ...stops];
  }
  return result;
}

import type { Character, Persona } from '@tavernnext/domain';
import type { MacroLimits, PromptWarning } from './types.js';

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_EXPANDED_LENGTH = 1_048_576;

export interface MacroContext {
  character: Character;
  persona: Persona;
  values?: Readonly<Record<string, string>>;
}

export interface MacroExpansionResult {
  text: string;
  warnings: PromptWarning[];
  limitExceeded?: 'recursion' | 'length';
}

function normalizedLimits(limits: MacroLimits | undefined): Required<MacroLimits> {
  const maxDepth = Number.isInteger(limits?.maxDepth) && Number(limits?.maxDepth) > 0
    ? Number(limits?.maxDepth)
    : DEFAULT_MAX_DEPTH;
  const maxExpandedLength = Number.isInteger(limits?.maxExpandedLength) && Number(limits?.maxExpandedLength) >= 0
    ? Number(limits?.maxExpandedLength)
    : DEFAULT_MAX_EXPANDED_LENGTH;
  return { maxDepth, maxExpandedLength };
}

function macroValues(context: MacroContext): Map<string, string> {
  const { character, persona } = context;
  const entries: Record<string, string> = {
    char: character.name,
    bot: character.name,
    name2: character.name,
    character: character.name,
    characterName: character.name,
    charName: character.name,
    user: persona.name,
    name1: persona.name,
    userName: persona.name,
    personaName: persona.name,
    description: character.description,
    personality: character.personality,
    scenario: character.scenario,
    persona: persona.description,
    charPrompt: character.systemPrompt,
    system: character.systemPrompt,
    charInstruction: character.postHistoryInstructions,
    charJailbreak: character.postHistoryInstructions,
    mesExamples: character.examples,
    mesExamplesRaw: character.examples,
    charFirstMessage: character.firstMessage,
    greeting: character.firstMessage,
    creatorNotes: character.creatorNotes,
    charVersion: character.characterVersion,
    char_version: character.characterVersion,
    noop: '',
    newline: '\n',
    trim: '',
    ...(context.values ?? {}),
  };
  return new Map(Object.entries(entries).map(([key, value]) => [key.toLowerCase(), String(value)]));
}

function restoreEscapes(text: string): string {
  return text.replace(/\\\{\{/g, '{{').replace(/\\\}\}/g, '}}');
}

function applyTrimDirective(text: string): string {
  return text.replace(/(?:\r?\n)*(?<!\\)\{\{\s*trim\s*\}\}(?:\r?\n)*/gi, '');
}

export function expandMacros(template: string, context: MacroContext, limits?: MacroLimits): MacroExpansionResult {
  const boundary = normalizedLimits(limits);
  let text = applyTrimDirective(String(template ?? ''));
  const warnings: PromptWarning[] = [];
  const unknown = new Set<string>();
  const values = macroValues(context);

  if (text.length > boundary.maxExpandedLength) {
    warnings.push({
      code: 'macro_expansion_limit',
      message: `Macro expansion exceeded ${boundary.maxExpandedLength} characters.`,
    });
    return { text: restoreEscapes(text.slice(0, boundary.maxExpandedLength)), warnings, limitExceeded: 'length' };
  }

  const seen = new Set([text]);
  for (let depth = 0; depth < boundary.maxDepth; depth += 1) {
    let replaced = false;
    text = text
      .replace(/(?<!\\)<(?:USER)>/gi, () => {
        replaced = true;
        return values.get('user') ?? '';
      })
      .replace(/(?<!\\)<(?:BOT|CHAR)>/gi, () => {
        replaced = true;
        return values.get('char') ?? '';
      })
      .replace(/(?<!\\)\{\{\s*([A-Za-z][\w.-]*)\s*\}\}/g, (literal, rawName: string) => {
        const name = rawName.toLowerCase();
        const value = values.get(name);
        if (value === undefined) {
          if (!unknown.has(name)) {
            unknown.add(name);
            warnings.push({
              code: 'unknown_macro',
              macro: name,
              message: `Unknown macro {{${name}}} was left unchanged.`,
            });
          }
          return literal;
        }
        replaced = true;
        return value;
      });
    text = applyTrimDirective(text);

    if (text.length > boundary.maxExpandedLength) {
      warnings.push({
        code: 'macro_expansion_limit',
        message: `Macro expansion exceeded ${boundary.maxExpandedLength} characters.`,
      });
      return {
        text: restoreEscapes(text.slice(0, boundary.maxExpandedLength)),
        warnings,
        limitExceeded: 'length',
      };
    }
    if (!replaced) return { text: restoreEscapes(text), warnings };
    if (seen.has(text)) {
      warnings.push({
        code: 'macro_recursion_limit',
        message: `Macro expansion did not converge within ${boundary.maxDepth} passes.`,
      });
      return { text: restoreEscapes(text), warnings, limitExceeded: 'recursion' };
    }
    seen.add(text);
  }

  const hasResolvableMacro = /(?<!\\)<(?:USER|BOT|CHAR)>/i.test(text)
    || [...text.matchAll(/(?<!\\)\{\{\s*([A-Za-z][\w.-]*)\s*\}\}/g)]
      .some((match) => values.has(match[1]!.toLowerCase()));
  if (hasResolvableMacro) {
    warnings.push({
      code: 'macro_recursion_limit',
      message: `Macro expansion did not converge within ${boundary.maxDepth} passes.`,
    });
    return { text: restoreEscapes(text), warnings, limitExceeded: 'recursion' };
  }
  return { text: restoreEscapes(text), warnings };
}

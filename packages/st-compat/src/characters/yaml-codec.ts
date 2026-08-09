import { parse as parseYaml } from 'yaml';
import { diagnostic } from '../warnings.js';
import { CharacterCodecError, decodeCharacterValue, strictCharacterText } from './json-codec.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function adaptLegacyYaml(value: unknown): unknown {
  const object = record(value);
  if (
    object === undefined
    || typeof object.name !== 'string'
    || (typeof object.context !== 'string' && typeof object.greeting !== 'string')
  ) return value;
  return {
    ...object,
    ...(typeof object.description === 'string' || typeof object.context !== 'string'
      ? {}
      : { description: object.context }),
    ...(typeof object.first_mes === 'string' || typeof object.greeting !== 'string'
      ? {}
      : { first_mes: object.greeting }),
  };
}

export function decodeCharacterYaml(bytes: Uint8Array) {
  let value: unknown;
  try {
    value = parseYaml(strictCharacterText(bytes), { maxAliasCount: 0 });
  } catch (error) {
    if (error instanceof CharacterCodecError) throw error;
    throw new CharacterCodecError(diagnostic('character_yaml_invalid', 'Character YAML is malformed or uses aliases.'));
  }
  return { ...decodeCharacterValue(adaptLegacyYaml(value)), raw: structuredClone(value) };
}

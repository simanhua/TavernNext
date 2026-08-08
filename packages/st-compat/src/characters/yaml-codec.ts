import { parse as parseYaml } from 'yaml';
import { diagnostic } from '../warnings.js';
import { CharacterCodecError, decodeCharacterValue, strictCharacterText } from './json-codec.js';

export function decodeCharacterYaml(bytes: Uint8Array) {
  let value: unknown;
  try {
    value = parseYaml(strictCharacterText(bytes), { maxAliasCount: 0 });
  } catch (error) {
    if (error instanceof CharacterCodecError) throw error;
    throw new CharacterCodecError(diagnostic('character_yaml_invalid', 'Character YAML is malformed or uses aliases.'));
  }
  return { ...decodeCharacterValue(value), raw: structuredClone(value) };
}

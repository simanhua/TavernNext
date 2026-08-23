import { useState } from 'react';
import {
  DEFAULT_REGEX_WORKER_LIMITS,
  REGEX_PLACEMENT,
  runOwnedRegexProjectionInWorker,
  TavernRegexSchema,
  type RegexWorkerFactory,
  type RegexPlacement,
  type TavernRegex,
} from '@tavernnext/extension-runtime';
import { useI18n } from '../../app/i18n.js';

const PLACEMENT_OPTIONS = [
  ['Markdown display', REGEX_PLACEMENT.MD_DISPLAY],
  ['User input', REGEX_PLACEMENT.USER_INPUT],
  ['AI output', REGEX_PLACEMENT.AI_OUTPUT],
  ['Slash command', REGEX_PLACEMENT.SLASH_COMMAND],
  ['World info', REGEX_PLACEMENT.WORLD_INFO],
  ['Reasoning', REGEX_PLACEMENT.REASONING],
] as const;

export function RegexAssetEditor({
  payload,
  ownerKind,
  onChange,
  createWorker,
}: {
  payload: unknown;
  ownerKind: 'preset' | 'character';
  onChange(value: TavernRegex): void;
  createWorker: RegexWorkerFactory;
}) {
  const { t } = useI18n();
  const parsed = TavernRegexSchema.safeParse(payload);
  const [testInput, setTestInput] = useState('');
  const [testOutput, setTestOutput] = useState('');
  const [testTrace, setTestTrace] = useState('');
  const [testing, setTesting] = useState(false);
  const [testPlacement, setTestPlacement] = useState<RegexPlacement>(REGEX_PLACEMENT.AI_OUTPUT);
  const [testMode, setTestMode] = useState<'rule' | 'normal' | 'display' | 'prompt'>('rule');
  const [testDepth, setTestDepth] = useState(0);
  const [testEdit, setTestEdit] = useState(false);
  const [testUser, setTestUser] = useState('User');
  const [testCharacter, setTestCharacter] = useState('Character');
  if (!parsed.success) return <p role="alert">{t('This regex payload is invalid. Use JSON mode to repair it.')}</p>;
  const value = parsed.data;
  const patch = (changes: Partial<TavernRegex>) => onChange({ ...value, ...changes });
  const numeric = (raw: string) => raw === '' ? null : Number.parseInt(raw, 10);
  const test = async () => {
    setTesting(true);
    try {
      const scripts = ownerKind === 'preset' ? { preset: [value], character: [] } : { preset: [], character: [value] };
      const isMarkdown = testMode === 'rule' ? value.markdownOnly : testMode === 'display';
      const isPrompt = testMode === 'rule' ? value.promptOnly && !value.markdownOnly : testMode === 'prompt';
      const result = await runOwnedRegexProjectionInWorker(testInput, scripts, {
        placement: testPlacement,
        isMarkdown,
        isPrompt,
        depth: testDepth,
        isEdit: testEdit,
        values: { user: testUser, char: testCharacter },
      }, createWorker, DEFAULT_REGEX_WORKER_LIMITS);
      setTestOutput(result.value);
      setTestTrace(result.trace.map((entry) => `${entry.owner}:${entry.scriptName || entry.scriptId} — ${entry.applied ? 'applied' : entry.reason}`).join('\n'));
    } finally {
      setTesting(false);
    }
  };
  return (
    <fieldset aria-label={t('Regex editor')}>
      <legend>{t('Regex editor')}</legend>
      <label>{t('Regex ID')}<input value={value.id} onChange={(event) => patch({ id: event.target.value })} /></label>
      <label>{t('Regex name')}<input value={value.scriptName} onChange={(event) => patch({ scriptName: event.target.value })} /></label>
      <label>{t('Find expression')}<textarea value={value.findRegex} onChange={(event) => patch({ findRegex: event.target.value })} /></label>
      <label>{t('Replacement')}<textarea value={value.replaceString} onChange={(event) => patch({ replaceString: event.target.value })} /></label>
      <label>{t('Trim strings (one per line)')}<textarea value={value.trimStrings.join('\n')} onChange={(event) => patch({ trimStrings: event.target.value.split(/\r?\n/) })} /></label>
      <fieldset><legend>{t('Placement')}</legend>{PLACEMENT_OPTIONS.map(([label, placement]) => (
        <label key={placement}>{t(label)}<input type="checkbox" checked={value.placement.includes(placement)} onChange={(event) => patch({
          placement: event.target.checked ? [...value.placement, placement] : value.placement.filter((item) => item !== placement),
        })} /></label>
      ))}</fieldset>
      <label>{t('Markdown/display only')}<input type="checkbox" checked={value.markdownOnly} onChange={(event) => patch({ markdownOnly: event.target.checked })} /></label>
      <label>{t('Prompt only')}<input type="checkbox" checked={value.promptOnly} onChange={(event) => patch({ promptOnly: event.target.checked })} /></label>
      <label>{t('Run on edit')}<input type="checkbox" checked={value.runOnEdit} onChange={(event) => patch({ runOnEdit: event.target.checked })} /></label>
      <label>{t('Find macro substitution')}<select value={value.substituteRegex} onChange={(event) => patch({ substituteRegex: Number(event.target.value) })}>
        <option value={0}>{t('Off')}</option><option value={1}>{t('Substitute')}</option><option value={2}>{t('Substitute and escape')}</option>
      </select></label>
      <label>{t('Minimum depth')}<input type="number" value={value.minDepth ?? ''} onChange={(event) => patch({ minDepth: numeric(event.target.value) })} /></label>
      <label>{t('Maximum depth')}<input type="number" value={value.maxDepth ?? ''} onChange={(event) => patch({ maxDepth: numeric(event.target.value) })} /></label>
      <label>{t('Regex test input')}<textarea value={testInput} onChange={(event) => setTestInput(event.target.value)} /></label>
      <label>{t('Regex test placement')}<select value={testPlacement} onChange={(event) => setTestPlacement(Number(event.target.value) as RegexPlacement)}>
        {PLACEMENT_OPTIONS.map(([label, placement]) => <option key={placement} value={placement}>{t(label)}</option>)}
      </select></label>
      <label>{t('Regex test mode')}<select value={testMode} onChange={(event) => setTestMode(event.target.value as typeof testMode)}>
        <option value="rule">{t('Use rule mode')}</option><option value="normal">{t('Normal')}</option>
        <option value="display">{t('Display')}</option><option value="prompt">{t('Prompt')}</option>
      </select></label>
      <label>{t('Regex test depth')}<input type="number" value={testDepth} onChange={(event) => setTestDepth(Number(event.target.value))} /></label>
      <label>{t('Regex test is edit')}<input type="checkbox" checked={testEdit} onChange={(event) => setTestEdit(event.target.checked)} /></label>
      <label>{t('Regex test user macro')}<input value={testUser} onChange={(event) => setTestUser(event.target.value)} /></label>
      <label>{t('Regex test character macro')}<input value={testCharacter} onChange={(event) => setTestCharacter(event.target.value)} /></label>
      <button type="button" disabled={testing} onClick={() => void test()}>{t('Test regex')}</button>
      <label>{t('Regex test output')}<textarea readOnly value={testOutput} /></label>
      <label>{t('Regex test trace')}<textarea readOnly value={testTrace} /></label>
    </fieldset>
  );
}

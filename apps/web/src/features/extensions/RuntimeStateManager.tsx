import { useState } from 'react';
import { api, errorCode, type RuntimeStateScopeView, type RuntimeStateView } from '../../api/client.js';
import { useI18n } from '../../app/i18n.js';

const scopes: RuntimeStateScopeView[] = [
  'global', 'character', 'preset', 'conversation', 'message-variant', 'script',
];

export function RuntimeStateManager() {
  const { t } = useI18n();
  const [scope, setScope] = useState<RuntimeStateScopeView>('global');
  const [scopeId, setScopeId] = useState('global');
  const [state, setState] = useState<RuntimeStateView>();
  const [json, setJson] = useState('{}');
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  const load = async () => {
    if (scopeId.trim() === '') return;
    setPending(true); setError(undefined);
    try {
      const value = await api.getRuntimeState(scope, scopeId.trim());
      setState(value); setJson(JSON.stringify(value.value, null, 2));
    } catch (cause) { setError(errorCode(cause)); }
    finally { setPending(false); }
  };
  const parsed = () => {
    const value = JSON.parse(json) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('runtime_state_must_be_object');
    return value as Record<string, unknown>;
  };
  const save = async (reset = false) => {
    if (scopeId.trim() === '' || state === undefined || state.scope !== scope || state.scopeId !== scopeId.trim()) return;
    let value: Record<string, unknown>;
    try { value = reset ? {} : parsed(); }
    catch { setError('invalid_json'); return; }
    setPending(true); setError(undefined);
    try {
      const saved = await api.operateRuntimeState(scope, scopeId.trim(), {
        expectedRevision: state?.revision ?? null, operation: 'replace', value,
      });
      setState(saved); setJson(JSON.stringify(saved.value, null, 2));
    } catch (cause) { setError(errorCode(cause)); }
    finally { setPending(false); }
  };
  const validate = (value: string) => {
    setJson(value);
    try { const parsedValue = JSON.parse(value); setError(typeof parsedValue === 'object' && parsedValue !== null && !Array.isArray(parsedValue) ? undefined : 'invalid_json'); }
    catch { setError('invalid_json'); }
  };

  return (
    <section className="preset-section" aria-label={t('Runtime State manager')}>
      <h2>{t('Runtime State manager')}</h2>
      <label>{t('Runtime State scope')}<select value={scope} onChange={(event) => {
        const next = event.target.value as RuntimeStateScopeView;
        setScope(next); setScopeId(next === 'global' ? 'global' : ''); setState(undefined); setJson('{}'); setError(undefined);
      }}>{scopes.map((value) => <option key={value} value={value}>{t(`Runtime scope ${value}`)}</option>)}</select></label>
      <label>{t('Scope ID')}<input value={scopeId} disabled={scope === 'global'} onChange={(event) => {
        setScopeId(event.target.value); setState(undefined); setJson('{}'); setError(undefined);
      }} /></label>
      <button type="button" disabled={pending || scopeId.trim() === ''} onClick={() => void load()}>{t('Load variables')}</button>
      <p>{t('State revision: {{revision}}', { revision: state?.revision ?? 'none' })}</p>
      <label>{t('Variables JSON')}<textarea rows={14} value={json} onChange={(event) => validate(event.target.value)} /></label>
      <div className="editor-actions">
        <button type="button" onClick={() => void navigator.clipboard.writeText(json)}>{t('Copy variables')}</button>
        <button type="button" disabled={pending || state === undefined || error === 'invalid_json'} onClick={() => void save()}>{t('Save variables')}</button>
        <button type="button" disabled={pending || state === undefined} onClick={() => void save(true)}>{t('Reset variables')}</button>
      </div>
      {error === undefined ? null : <p role="alert">{t('Runtime State error: {{error}}', { error })}</p>}
    </section>
  );
}

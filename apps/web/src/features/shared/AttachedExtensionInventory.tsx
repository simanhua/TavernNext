import type { AttachedExtensionOverviewView } from '../../api/client.js';
import { useI18n } from '../../app/i18n.js';

export function AttachedExtensionInventory({ value }: { value: AttachedExtensionOverviewView }) {
  const { t } = useI18n();
  const count = (amount: number, singular: string, plural: string) => `${amount} ${t(amount === 1 ? singular : plural)}`;
  const typeName = (type: AttachedExtensionOverviewView['resources'][number]['type']) => ({
    regex: t('Regex'), script: t('Script'), folder: t('Folder'), unknown: t('Unknown'),
  })[type];
  return (
    <section className="compatibility-summary" aria-label={t('Attached Extension Resources')}>
      <h3>{t('Attached Extension Resources')}</h3>
      <p>{t('Imported code is retained as data and is not executed.')}</p>
      <div>
        <span>{count(value.counts.regex, 'regex', 'regexes')}</span>{' · '}
        <span>{count(value.counts.scripts, 'script', 'scripts')}</span>{' · '}
        <span>{count(value.counts.folders, 'folder', 'folders')}</span>{' · '}
        <span>{count(value.counts.variableContainers, 'variable container', 'variable containers')}</span>
      </div>
      <ol>
        {value.resources.map((resource) => (
          <li key={`${resource.type}:${resource.sourceKey}:${resource.order.join('.')}`}>
            <span>
              #{resource.order.map((ordinal) => ordinal + 1).join('.')} · {typeName(resource.type)} · {resource.name} · {t(resource.enabled ? 'Enabled' : 'Disabled')}
            </span>
            {resource.diagnostics.map((diagnostic) => <code key={diagnostic}>{diagnostic}</code>)}
          </li>
        ))}
      </ol>
      {value.variables.map((variable) => (
        <p key={variable.source}>{variable.source}: {variable.keyCount} {t(variable.keyCount === 1 ? 'key' : 'keys')}</p>
      ))}
      {value.diagnostics.map((diagnostic) => <code key={diagnostic}>{diagnostic}</code>)}
    </section>
  );
}

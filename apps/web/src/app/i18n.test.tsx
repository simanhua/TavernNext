// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider, useI18n } from './i18n.js';

function LanguageHarness() {
  const { language, setLanguage, t } = useI18n();
  return (
    <div>
      <span>{t('Connection Settings')}</span>
      <select aria-label="language" value={language} onChange={(event) => setLanguage(event.target.value as 'en' | 'zh-CN')}>
        <option value="en">English</option>
        <option value="zh-CN">Chinese</option>
      </select>
    </div>
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.documentElement.lang = '';
});

describe('I18nProvider', () => {
  it('switches to Chinese and persists the selection', async () => {
    const user = userEvent.setup();
    render(<I18nProvider><LanguageHarness /></I18nProvider>);

    expect(screen.getByText('Connection Settings')).not.toBeNull();
    await user.selectOptions(screen.getByRole('combobox', { name: 'language' }), 'zh-CN');

    expect(screen.getByText('连接设置')).not.toBeNull();
    expect(window.localStorage.getItem('tavernnext.language')).toBe('zh-CN');
    expect(document.documentElement.lang).toBe('zh-CN');
  });
});

import { createBrowserRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { SceneLibraryPage } from '../features/scenes/SceneLibraryPage.js';
import { SceneDetailPage } from '../features/scenes/SceneDetailPage.js';
import { SceneRuntimePage } from '../features/scenes/SceneRuntimePage.js';
import { ChatPage } from '../features/chat/ChatPage.js';
import { SettingsPage } from '../features/settings/SettingsPage.js';
import { useI18n } from './i18n.js';
import { useTheme } from './theme.js';

function Layout({ children }: { children: ReactNode }) {
  const { language, setLanguage, t } = useI18n();
  const theme = useTheme();
  return (
    <div className="app-shell">
      <nav className="app-nav" aria-label={t('Main navigation')}>
        <div className="app-brand" aria-label="TavernNext">
          <span className="app-brand-mark" aria-hidden="true">TN</span>
          <span className="app-brand-copy">
            <strong>TavernNext</strong>
            <small>Scene Runtime</small>
          </span>
        </div>
        <div className="app-nav-links">
          <a className={window.location.pathname === '/' || window.location.pathname.startsWith('/scenes/') ? 'active' : ''} href="/" onClick={(event) => { event.preventDefault(); history.pushState(null, '', '/'); dispatchEvent(new PopStateEvent('popstate')); }}>角色卡</a>
          <a className={window.location.pathname.startsWith('/settings') ? 'active' : ''} href="/settings" onClick={(event) => { event.preventDefault(); history.pushState(null, '', '/settings'); dispatchEvent(new PopStateEvent('popstate')); }}>设置</a>
        </div>
        <div className="app-nav-actions">
          <button className="theme-toggle" type="button" aria-label={theme.scheme === 'dark' ? '切换到浅色主题' : '切换到深色主题'} onClick={theme.toggle}>
            {theme.scheme === 'dark' ? (
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.64 5.64l1.42 1.42m9.88 9.88 1.42 1.42m0-12.72-1.42 1.42M7.06 16.94l-1.42 1.42"/><circle cx="12" cy="12" r="4"/></svg>
            ) : (
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.4 15.2A8.5 8.5 0 0 1 8.8 3.6 8.5 8.5 0 1 0 20.4 15.2Z"/></svg>
            )}
          </button>
          <label className="language-switcher">
          <span>{t('Language')}</span>
          <select value={language} onChange={(event) => setLanguage(event.target.value as 'en' | 'zh-CN')}>
            <option value="en">{t('English')}</option>
            <option value="zh-CN">{t('Simplified Chinese')}</option>
          </select>
          </label>
        </div>
      </nav>
      {children}
    </div>
  );
}

export const appRoutes = [
  { path: '/', element: <Layout><SceneLibraryPage /></Layout> },
  { path: '/scenes/:sceneId', element: <Layout><SceneDetailPage /></Layout> },
  { path: '/scene-runtime/:sceneId/new', element: <SceneRuntimePage mode="setup" /> },
  { path: '/scene-runtime/:sceneId/conversations/:conversationId', element: <SceneRuntimePage mode="workspace" /> },
  { path: '/legacy-chat', element: <ChatPage /> },
  { path: '/settings', element: <Layout><SettingsPage /></Layout> },
];

export const router = createBrowserRouter(appRoutes);

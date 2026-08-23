import { NavLink, Outlet, createBrowserRouter } from 'react-router-dom';
import { ChatPage } from '../features/chat/ChatPage.js';
import { CharacterLibraryPage } from '../features/characters/CharacterLibraryPage.js';
import { PersonaManagerPage } from '../features/personas/PersonaManagerPage.js';
import { PresetManagerPage } from '../features/presets/PresetManagerPage.js';
import { ConnectionPage } from '../features/settings/ConnectionPage.js';
import { WorldbookManagerPage } from '../features/worldbooks/WorldbookManagerPage.js';
import { ExtensionResourceManagerPage } from '../features/extensions/ExtensionResourceManagerPage.js';
import { useI18n } from './i18n.js';

function Layout() {
  const { language, setLanguage, t } = useI18n();
  return (
    <div className="app-shell">
      <nav className="app-nav" aria-label={t('Main navigation')}>
        <div className="app-brand" aria-label="TavernNext">
          <span className="app-brand-mark" aria-hidden="true">T</span>
          <span className="app-brand-copy">
            <strong>TavernNext</strong>
            <small>{t('Narrative workspace')}</small>
          </span>
        </div>
        <div className="app-nav-links">
          <NavLink to="/"><span aria-hidden="true">✦</span>{t('Chat')}</NavLink>
          <NavLink to="/characters"><span aria-hidden="true">♟</span>{t('Characters')}</NavLink>
          <NavLink to="/personas"><span aria-hidden="true">◈</span>{t('Personas')}</NavLink>
          <NavLink to="/presets"><span aria-hidden="true">◇</span>{t('Presets')}</NavLink>
          <NavLink to="/worldbooks"><span aria-hidden="true">▤</span>{t('Worldbooks')}</NavLink>
          <NavLink to="/extensions"><span aria-hidden="true">⌘</span>{t('Attached Resources')}</NavLink>
          <NavLink to="/connection"><span aria-hidden="true">⚙</span>{t('Connection Settings')}</NavLink>
        </div>
        <label className="language-switcher">
          <span>{t('Language')}</span>
          <select value={language} onChange={(event) => setLanguage(event.target.value as 'en' | 'zh-CN')}>
            <option value="en">{t('English')}</option>
            <option value="zh-CN">{t('Simplified Chinese')}</option>
          </select>
        </label>
      </nav>
      <Outlet />
    </div>
  );
}

export const appRoutes = [{
  element: <Layout />,
  children: [
    { index: true, element: <ChatPage /> },
    { path: 'characters', element: <CharacterLibraryPage /> },
    { path: 'personas', element: <PersonaManagerPage /> },
    { path: 'presets', element: <PresetManagerPage /> },
    { path: 'worldbooks', element: <WorldbookManagerPage /> },
    { path: 'extensions', element: <ExtensionResourceManagerPage /> },
    { path: 'connection', element: <ConnectionPage /> },
  ],
}];

export const router = createBrowserRouter(appRoutes);

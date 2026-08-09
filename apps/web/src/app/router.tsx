import { NavLink, Outlet, createBrowserRouter } from 'react-router-dom';
import { ChatPage } from '../features/chat/ChatPage.js';
import { CharacterLibraryPage } from '../features/characters/CharacterLibraryPage.js';
import { PersonaManagerPage } from '../features/personas/PersonaManagerPage.js';
import { PresetManagerPage } from '../features/presets/PresetManagerPage.js';
import { ConnectionPage } from '../features/settings/ConnectionPage.js';
import { WorldbookManagerPage } from '../features/worldbooks/WorldbookManagerPage.js';

function Layout() {
  return (
    <div className="app-shell">
      <nav className="app-nav" aria-label="Main navigation">
        <NavLink to="/">Chat</NavLink>
        <NavLink to="/characters">Characters</NavLink>
        <NavLink to="/personas">Personas</NavLink>
        <NavLink to="/presets">Presets</NavLink>
        <NavLink to="/worldbooks">Worldbooks</NavLink>
        <NavLink to="/connection">Connection Settings</NavLink>
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
    { path: 'connection', element: <ConnectionPage /> },
  ],
}];

export const router = createBrowserRouter(appRoutes);

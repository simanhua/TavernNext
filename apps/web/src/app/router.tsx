import { NavLink, Outlet, createBrowserRouter } from 'react-router-dom';
import { ChatPage } from '../features/chat/ChatPage.js';
import { ConnectionPage } from '../features/settings/ConnectionPage.js';

function Layout() {
  return (
    <div className="app-shell">
      <nav className="app-nav" aria-label="Main navigation">
        <NavLink to="/">Chat</NavLink>
        <NavLink to="/connection">Connection</NavLink>
      </nav>
      <Outlet />
    </div>
  );
}

export const router = createBrowserRouter([{
  element: <Layout />,
  children: [
    { index: true, element: <ChatPage /> },
    { path: 'connection', element: <ConnectionPage /> },
  ],
}]);

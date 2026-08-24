// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { THEME_STORAGE_KEY, ThemeProvider, useTheme } from './theme.js';

function Harness() {
  const theme = useTheme();
  return <button type="button" onClick={theme.toggle}>{theme.scheme}</button>;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.className = '';
  document.documentElement.removeAttribute('data-theme');
});

describe('ThemeProvider', () => {
  it('defaults to dark, toggles without reload, and persists the explicit choice', async () => {
    const user = userEvent.setup();
    render(<ThemeProvider><Harness /></ThemeProvider>);
    expect(screen.getByRole('button', { name: 'dark' })).not.toBeNull();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    await user.click(screen.getByRole('button', { name: 'dark' }));
    expect(screen.getByRole('button', { name: 'light' })).not.toBeNull();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');

    cleanup();
    render(<ThemeProvider><Harness /></ThemeProvider>);
    expect(screen.getByRole('button', { name: 'light' })).not.toBeNull();
  });

  it('synchronizes theme changes received from another tab', async () => {
    render(<ThemeProvider><Harness /></ThemeProvider>);
    window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: 'light' }));
    expect(await screen.findByRole('button', { name: 'light' })).not.toBeNull();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});

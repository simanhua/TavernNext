import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';

export type ThemeScheme = 'dark' | 'light';
export const THEME_STORAGE_KEY = 'tavernnext.theme';

export const SCENE_THEME_TOKEN_NAMES = [
  '--vp-c-bg', '--vp-c-bg-alt', '--vp-c-bg-elv', '--vp-c-bg-soft',
  '--vp-c-text-1', '--vp-c-text-2', '--vp-c-text-3',
  '--vp-c-divider', '--vp-c-border',
  '--vp-c-brand-1', '--vp-c-brand-2', '--vp-c-brand-3', '--vp-c-brand-soft',
  '--vp-c-success-1', '--vp-c-success-soft', '--vp-c-warning-1', '--vp-c-warning-soft',
  '--vp-c-danger-1', '--vp-c-danger-soft', '--vp-shadow-1', '--vp-shadow-2',
] as const;

export interface SceneThemeSnapshot {
  scheme: ThemeScheme;
  tokens: Record<string, string>;
}

interface ThemeContextValue extends SceneThemeSnapshot {
  setScheme(scheme: ThemeScheme): void;
  toggle(): void;
}

function initialScheme(): ThemeScheme {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === 'light' ? 'light' : 'dark';
}

function applyScheme(scheme: ThemeScheme): void {
  document.documentElement.classList.toggle('dark', scheme === 'dark');
  document.documentElement.dataset.theme = scheme;
  document.documentElement.style.colorScheme = scheme;
}

function readTokens(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(SCENE_THEME_TOKEN_NAMES.map((name) => [name, style.getPropertyValue(name).trim()]));
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [scheme, setScheme] = useState<ThemeScheme>(() => {
    const value = initialScheme();
    applyScheme(value);
    return value;
  });
  const [tokens, setTokens] = useState<Record<string, string>>(() => readTokens());

  useLayoutEffect(() => {
    applyScheme(scheme);
    window.localStorage.setItem(THEME_STORAGE_KEY, scheme);
    setTokens(readTokens());
  }, [scheme]);

  useEffect(() => {
    const synchronize = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      setScheme(event.newValue === 'light' ? 'light' : 'dark');
    };
    window.addEventListener('storage', synchronize);
    return () => window.removeEventListener('storage', synchronize);
  }, []);

  const value = useMemo<ThemeContextValue>(() => ({
    scheme,
    tokens,
    setScheme,
    toggle: () => setScheme((current) => current === 'dark' ? 'light' : 'dark'),
  }), [scheme, tokens]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === undefined) throw new Error('ThemeProvider is missing');
  return value;
}

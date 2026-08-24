// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  openSceneWindow,
  sceneSaveWindowName,
  sceneSetupWindowName,
} from './scene-window.js';

afterEach(() => vi.restoreAllMocks());

describe('Scene window launcher', () => {
  it('uses stable names for one setup page and one page per save', () => {
    expect(sceneSetupWindowName('scene-1')).toBe('tavernnext-scene-setup-scene-1');
    expect(sceneSaveWindowName('save-1')).toBe('tavernnext-scene-save-save-1');
  });

  it('focuses an existing matching page without reloading it', () => {
    const replace = vi.fn();
    const focus = vi.fn();
    const target = { location: { href: 'http://localhost:3000/scene-runtime/scene-1/conversations/save-1', replace }, focus };
    const open = vi.spyOn(window, 'open').mockReturnValue(target as unknown as Window);

    expect(openSceneWindow('/scene-runtime/scene-1/conversations/save-1', 'save-window')).toBe(target);
    expect(open).toHaveBeenCalledWith('', 'save-window');
    expect(replace).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledOnce();
  });

  it('navigates a new named page and reports popup blocking', () => {
    const replace = vi.fn();
    const target = { location: { href: 'about:blank', replace }, focus: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValueOnce(target as unknown as Window).mockReturnValueOnce(null);

    expect(openSceneWindow('/scene-runtime/scene-1/new', 'setup-window')).toBe(target);
    expect(replace).toHaveBeenCalledWith('http://localhost:3000/scene-runtime/scene-1/new');
    expect(openSceneWindow('/scene-runtime/scene-1/new', 'setup-window')).toBeNull();
  });
});

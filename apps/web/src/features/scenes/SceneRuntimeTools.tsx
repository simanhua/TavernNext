import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../app/i18n.js';
import { AgentRunInspector } from '../chat/AgentRunInspector.js';
import { RuntimePanelIcon, type RuntimePanelIconKind } from '../shared/RuntimePanelIcon.js';
import { MemoryCenter } from './MemoryCenter.js';
import { SaveAgentConfigurationPanel } from './SaveAgentConfigurationPanel.js';

type RuntimeTool = 'configuration' | 'inspector' | 'memory';

export function SceneRuntimeTools({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeTool, setActiveTool] = useState<RuntimeTool>();
  const tools: Array<{ id: RuntimeTool; icon: RuntimePanelIconKind; label: string }> = [
    { id: 'configuration', icon: 'configuration', label: t('Save Agent configuration') },
    ...(import.meta.env.DEV
      ? [{ id: 'inspector' as const, icon: 'inspector' as const, label: t('Agent Run inspector') }]
      : []),
    { id: 'memory', icon: 'memory', label: t('Save memory') },
  ];

  useEffect(() => {
    if (!menuOpen) return;
    const pointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setMenuOpen(false);
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', pointerDown);
    document.addEventListener('keydown', keyDown);
    return () => {
      document.removeEventListener('pointerdown', pointerDown);
      document.removeEventListener('keydown', keyDown);
    };
  }, [menuOpen]);

  const selectTool = (tool: RuntimeTool) => {
    setActiveTool(tool);
    setMenuOpen(false);
  };
  const closePanel = () => setActiveTool(undefined);

  return (
    <>
      <div className="scene-runtime-tools" ref={menuRef}>
        <button
          type="button"
          className="scene-runtime-tools-trigger"
          aria-label={t('Open Save tools')}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={t('Save tools')}
          onClick={() => setMenuOpen((value) => !value)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M7 14v6" />
          </svg>
        </button>
        {menuOpen ? (
          <div className="scene-runtime-tools-menu" role="menu" aria-label={t('Save tools')}>
            <header><span>{t('Save tools')}</span><small>SCENE RUNTIME</small></header>
            {tools.map((tool) => (
              <button
                type="button"
                role="menuitem"
                key={tool.id}
                className={activeTool === tool.id ? 'active' : undefined}
                onClick={() => selectTool(tool.id)}
              >
                <span className="scene-runtime-tools-menu-icon"><RuntimePanelIcon kind={tool.icon} /></span>
                <span>{tool.label}</span>
                <i aria-hidden="true">›</i>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="scene-runtime-tool-panels">
        <SaveAgentConfigurationPanel
          conversationId={conversationId}
          open={activeTool === 'configuration'}
          onClose={closePanel}
        />
        <MemoryCenter conversationId={conversationId} open={activeTool === 'memory'} onClose={closePanel} />
        <AgentRunInspector
          conversationId={conversationId}
          open={activeTool === 'inspector'}
          onClose={closePanel}
        />
      </div>
    </>
  );
}

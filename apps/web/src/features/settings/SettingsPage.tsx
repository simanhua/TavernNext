import { useState } from 'react';
import { PersonaManagerPage } from '../personas/PersonaManagerPage.js';
import { PresetManagerPage } from '../presets/PresetManagerPage.js';
import { ConnectionPage } from './ConnectionPage.js';
import { ActivePresetConfiguration } from './GlobalGenerationConfiguration.js';

export function SettingsPage() {
  const [tab, setTab] = useState<'connection' | 'personas' | 'fallback'>('connection');
  return (
    <main className="settings-center">
      <aside className="settings-sidebar">
        <div><span className="eyebrow">TavernNext</span><h1>设置</h1></div>
        <nav aria-label="设置分区">
          <button className={tab === 'connection' ? 'active' : ''} onClick={() => setTab('connection')}>模型连接</button>
          <button className={tab === 'personas' ? 'active' : ''} onClick={() => setTab('personas')}>Persona 模板</button>
          <button className={tab === 'fallback' ? 'active' : ''} onClick={() => setTab('fallback')}>全局回退预设</button>
        </nav>
      </aside>
      <section className="settings-content">
        {tab === 'connection' ? <ConnectionPage /> : tab === 'personas' ? <PersonaManagerPage /> : <section><ActivePresetConfiguration /><PresetManagerPage /></section>}
      </section>
    </main>
  );
}

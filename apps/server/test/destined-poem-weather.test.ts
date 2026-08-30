import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// Official Scene server assets intentionally ship as native ES modules.
// @ts-expect-error The runtime asset has no declaration file.
import destinedPoem from '../assets/official-scenes/destined-poem/server/index.mjs';

const manifest = JSON.parse(readFileSync(
  new URL('../assets/official-scenes/destined-poem/manifest.json', import.meta.url),
  'utf8',
)) as {
  version: string;
  stateSchema: { properties: { 世界: { required: string[]; properties: Record<string, unknown> } } };
  agentTools: Array<{ name: string; parameters: { properties: Record<string, unknown> } }>;
};

describe('Destined Poem authoritative weather state', () => {
  it('initializes weather without making it mandatory for older Saves', async () => {
    const initialized = await destinedPoem.initializeConversation({
      setup: { opening: 'custom', origin: '梵尼亚' },
      playerProfile: { name: '旅人', description: '' },
    });

    expect(initialized.initialState.世界).toMatchObject({ 地点: '梵尼亚', 天气: '' });
    expect(manifest.version).toBe('2.17.0');
    expect(manifest.stateSchema.properties.世界.properties).toHaveProperty('天气');
    expect(manifest.stateSchema.properties.世界.required).not.toContain('天气');
    expect(manifest.agentTools.find((tool) => tool.name === 'destined_poem_travel')
      ?.parameters.properties).toHaveProperty('weather');
  });

  it('inserts missing legacy weather and replaces an existing value', async () => {
    const legacy = await destinedPoem.executeAgentTool({
      toolName: 'destined_poem_travel',
      arguments: { location: '雾晶港', time: '傍晚', weather: '细雨' },
      workspace: { state: { 世界: { 地点: '梵尼亚', 时间: '清晨' } } },
    });
    expect(legacy.statePatch).toContainEqual({ op: 'insert', path: '/世界/天气', value: '细雨' });

    const current = await destinedPoem.executeAgentTool({
      toolName: 'destined_poem_travel',
      arguments: { location: '雾晶港', weather: '晴朗' },
      workspace: { state: { 世界: { 地点: '梵尼亚', 时间: '清晨', 天气: '细雨' } } },
    });
    expect(current.statePatch).toContainEqual({ op: 'replace', path: '/世界/天气', value: '晴朗' });
    expect(current.detail).toMatchObject({ location: '雾晶港', weather: '晴朗' });
  });

  it('states that tp cannot override canonical Scene State', async () => {
    const result = await destinedPoem.beforeGeneration({ state: {}, setup: {} });
    const prompt = result.promptAdditions[0].content;
    expect(prompt).toContain('旅行、天气');
    expect(prompt).toContain('<tp> 仅为兼容展示标记');
    expect(prompt).toContain('不修改也不覆盖 Scene State');
  });
});

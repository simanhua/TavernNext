import { createHash, verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SceneCatalogSchema,
  SceneManifestSchema,
  type SceneCatalog,
  type SceneManifest,
} from '@tavernnext/domain';
import { attachedVariableValue, decodeInspectedCharacter } from '@tavernnext/st-compat';
import { strToU8, zipSync } from 'fflate';

export const DESTINED_POEM_SCENE_ID = '018f2000-0000-7000-8000-000000000001';
const GENERATED_AT = '2026-08-24T00:00:00.000Z';
const PACKAGE_URL = 'builtin:destined-poem';

// The catalog is signed offline. The public key and signature are replaced only
// when the official catalog changes; the private key is not part of TavernNext.
export const OFFICIAL_CATALOG_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAI/uXxpkXfWl75dIIqA3wgjGs/F5LuzcBKwGczI5VBM0=
-----END PUBLIC KEY-----`;
export const OFFICIAL_CATALOG_SIGNATURE_BASE64 = '4IDSoas3OI4G/H9KcFzxtNMfDjKNaYCTI5erl80Yh5Pthp/lnKAkvz45BNKsnnqkTqpsD+12Ke53GmuI8U3HBw==';

const stylesheet = `
:root{color-scheme:light;--vp-c-bg:#fff;--vp-c-bg-alt:#f6f6f7;--vp-c-bg-elv:#fff;--vp-c-bg-soft:#f6f6f7;--vp-c-text-1:#213547;--vp-c-text-2:#476582;--vp-c-text-3:rgb(60 60 67/56%);--vp-c-divider:#e2e2e3;--vp-c-border:#c2c2c4;--vp-c-brand-1:#3451b2;--vp-c-brand-2:#3a5ccc;--vp-c-brand-3:#5672cd;--vp-c-brand-soft:rgb(100 108 255/14%);--vp-c-success-1:#18794e;--vp-c-success-soft:rgb(16 185 129/14%);--vp-c-warning-1:#915930;--vp-c-warning-soft:rgb(234 179 8/14%);--vp-c-danger-1:#b8272c;--vp-c-danger-soft:rgb(244 63 94/14%);--vp-shadow-1:0 1px 2px rgb(0 0 0/4%),0 1px 6px rgb(0 0 0/4%);--vp-shadow-2:0 3px 12px rgb(0 0 0/7%)}
.dark{color-scheme:dark;--vp-c-bg:#1b1b1f;--vp-c-bg-alt:#161618;--vp-c-bg-elv:#202127;--vp-c-bg-soft:#202127;--vp-c-text-1:rgb(255 255 245/86%);--vp-c-text-2:rgb(235 235 245/60%);--vp-c-text-3:rgb(235 235 245/38%);--vp-c-divider:#2e2e32;--vp-c-border:#3c3f44;--vp-c-brand-1:#a8b1ff;--vp-c-brand-2:#5c73e7;--vp-c-brand-3:#3e63dd;--vp-c-brand-soft:rgb(100 108 255/16%);--vp-c-success-1:#3dd68c;--vp-c-success-soft:rgb(16 185 129/16%);--vp-c-warning-1:#f9b44e;--vp-c-warning-soft:rgb(234 179 8/16%);--vp-c-danger-1:#f66f81;--vp-c-danger-soft:rgb(244 63 94/16%);--vp-shadow-1:0 1px 2px rgb(0 0 0/18%),0 1px 6px rgb(0 0 0/14%);--vp-shadow-2:0 3px 12px rgb(0 0 0/24%)}
*{box-sizing:border-box}html,body{margin:0;min-width:320px;min-height:100%;font-family:Inter,ui-sans-serif,system-ui,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;color:var(--vp-c-text-1);background:var(--vp-c-bg)}button,input,textarea,select{font:inherit}button{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.55}button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--vp-c-brand-1);outline-offset:2px}
.shell{min-height:100vh;display:grid;grid-template-columns:240px minmax(0,1fr)}.sidebar{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;border-right:1px solid var(--vp-c-divider);padding:24px 16px;background:var(--vp-c-bg-alt)}.scene-brand{padding:0 10px 22px}.scene-brand strong{display:block;font-size:1rem}.scene-brand small{color:var(--vp-c-text-3)}.tabs{display:grid;gap:4px}.tabs button{display:flex;align-items:center;border:0;border-radius:8px;padding:9px 12px;text-align:left;color:var(--vp-c-text-2);background:transparent}.tabs button:hover{color:var(--vp-c-text-1);background:var(--vp-c-bg-soft)}.tabs button.active{color:var(--vp-c-brand-1);background:var(--vp-c-brand-soft)}.sidebar-foot{margin-top:auto;border-top:1px solid var(--vp-c-divider);padding:16px 10px 0;color:var(--vp-c-text-3);font-size:.78rem}.main{min-width:0;display:grid;grid-template-rows:64px minmax(0,1fr)}.top{display:flex;align-items:center;border-bottom:1px solid var(--vp-c-divider);padding:0 28px;background:color-mix(in srgb,var(--vp-c-bg) 90%,transparent);backdrop-filter:blur(10px)}.top strong{font-size:.95rem}.top .muted{margin-left:10px}.content{min-width:0;padding:28px;overflow:auto}.panel{width:100%;max-width:960px;margin:0 auto;border:1px solid var(--vp-c-divider);border-radius:12px;padding:22px;background:var(--vp-c-bg);box-shadow:var(--vp-shadow-1)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px}.card{border:1px solid var(--vp-c-divider);border-radius:10px;padding:16px;background:var(--vp-c-bg-soft)}.card p{color:var(--vp-c-text-2);line-height:1.65}.muted{color:var(--vp-c-text-2)}.stat{margin-top:4px;font-size:1.2rem;font-weight:650}.empty{padding:48px;text-align:center;color:var(--vp-c-text-3)}
.chat{min-height:calc(100vh - 120px);display:grid;grid-template-rows:minmax(0,1fr) auto}.messages{display:flex;min-height:0;flex-direction:column;gap:14px;overflow:auto;padding-bottom:22px}.message{width:min(100%,760px);border:1px solid var(--vp-c-divider);border-radius:10px;padding:14px 16px;white-space:pre-wrap;line-height:1.7;background:var(--vp-c-bg-soft)}.message.user{align-self:flex-end;border-color:color-mix(in srgb,var(--vp-c-brand-1) 36%,var(--vp-c-divider));background:var(--vp-c-brand-soft)}.message.assistant{align-self:flex-start}.message.streaming{border-color:var(--vp-c-brand-1);animation:pulse-border 1.4s ease-in-out infinite}.message menu{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0 0;padding:0}.message menu button{border:0;border-radius:6px;padding:4px 8px;color:var(--vp-c-text-2);background:transparent}.message menu button:hover{color:var(--vp-c-brand-1);background:var(--vp-c-brand-soft)}.composer-wrap{position:sticky;bottom:0;border-top:1px solid var(--vp-c-divider);padding-top:14px;background:var(--vp-c-bg)}.composer{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px}.composer textarea{min-height:72px;resize:vertical;border:1px solid var(--vp-c-border);border-radius:10px;padding:11px 12px;color:var(--vp-c-text-1);background:var(--vp-c-bg-alt)}.composer textarea:focus{border-color:var(--vp-c-brand-1);box-shadow:0 0 0 1px var(--vp-c-brand-1);outline:0}.action{align-self:stretch;border:1px solid transparent;border-radius:20px;padding:8px 15px;color:var(--vp-c-text-1);background:var(--vp-c-bg-soft)}.action.primary{color:#fff;background:var(--vp-c-brand-3)}.generation-status{min-height:24px;padding:6px 2px 0;color:var(--vp-c-text-2);font-size:.82rem}.generation-status.error{color:var(--vp-c-danger-1)}.progress{height:2px;overflow:hidden;background:var(--vp-c-brand-soft)}.progress::after{display:block;width:38%;height:100%;content:"";background:var(--vp-c-brand-1);animation:progress 1.1s ease-in-out infinite}
.setup{max-width:720px;margin:56px auto}.setup h1{margin:.2em 0;font-size:2rem;letter-spacing:-.03em}.setup label{display:grid;gap:6px;margin:16px 0;color:var(--vp-c-text-2);font-size:.88rem}.setup input,.setup textarea,.setup select{width:100%;border:1px solid var(--vp-c-border);border-radius:8px;padding:10px 11px;color:var(--vp-c-text-1);background:var(--vp-c-bg-alt)}.setup input:focus,.setup textarea:focus,.setup select:focus{border-color:var(--vp-c-brand-1);outline:0;box-shadow:0 0 0 1px var(--vp-c-brand-1)}.error{color:var(--vp-c-danger-1)}
@keyframes progress{0%{transform:translateX(-110%)}100%{transform:translateX(360%)}}@keyframes pulse-border{50%{border-color:var(--vp-c-brand-3)}}
@media(max-width:760px){.shell{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}.sidebar{position:static;width:100%;height:auto;border-right:0;border-bottom:1px solid var(--vp-c-divider);padding:12px}.scene-brand,.sidebar-foot{display:none}.tabs{display:flex;overflow-x:auto}.tabs button{white-space:nowrap}.main{grid-template-rows:52px minmax(0,1fr)}.top{padding:0 18px}.content{padding:14px}.panel{padding:16px}.chat{min-height:calc(100vh - 150px)}.message{width:100%}.composer{grid-template-columns:1fr}.composer .action{min-height:40px}.setup{margin:24px auto}}
`;

const frontendScript = `
let root;let sdk;let context;let generationView={status:'idle',streamedText:'',streamedReasoning:'',error:null};
function request(method,args=[]){const [scope,name]=method.split('.');const target=sdk?.[scope]?.[name];if(typeof target!=='function')return Promise.reject(new Error('scene_sdk_method_unknown'));return Promise.resolve(target(...args))}
function esc(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function valueAt(source,path,fallback=''){let value=source;for(const part of path.split('.'))value=value?.[part];return value??fallback}
function applyTheme(theme){if(!theme)return;document.documentElement.classList.toggle('dark',theme.scheme==='dark');document.documentElement.style.colorScheme=theme.scheme||'dark';for(const [name,value] of Object.entries(theme.tokens||{})){if(name.startsWith('--vp-'))document.documentElement.style.setProperty(name,String(value))}}
function updateGeneration(value){generationView={...generationView,...(value||{})};const active=['starting','streaming','stopping'].includes(generationView.status);const status=document.querySelector('#generation-status');const send=document.querySelector('#send');const draft=document.querySelector('#draft');if(send)send.disabled=active;if(draft)draft.disabled=active;if(status){status.className='generation-status'+(generationView.error?' error':'');status.innerHTML=generationView.error?esc(generationView.error):active?'<span>正在生成回复…</span><div class="progress"></div>':''}const messages=document.querySelector('.messages');if(!messages)return;let streaming=document.querySelector('#streaming-message');if(active&&(generationView.streamedText||generationView.streamedReasoning)){if(!streaming){streaming=document.createElement('article');streaming.id='streaming-message';streaming.className='message assistant streaming';messages.append(streaming)}streaming.textContent=generationView.streamedText||generationView.streamedReasoning}else streaming?.remove()}
function renderSetup(){root.innerHTML='<main class="panel setup"><h1>命定之诗与黄昏之歌</h1><p class="muted">在阿斯塔利亚开启一段独立命运。每次开局都会创建完全隔离的存档。</p><label>导入 Persona<select id="persona"><option value="">不导入</option></select></label><label>主角姓名<input id="name" maxlength="80" required></label><label>主角描述<textarea id="description" rows="5"></textarea></label><label>开局地点<select id="origin"><option>梵尼亚</option><option>奥古斯提姆帝国</option><option>卡拉什利亚斯</option><option>诺斯加德联盟</option><option>索伦蒂斯王国</option><option>萨赫拉联邦</option></select></label><label>存档名称<input id="title" value="新的命运"></label><button class="action primary" id="start">创建存档</button><p id="status"></p></main>';
  request('setup.listPersonas').then(items=>{const select=document.querySelector('#persona');for(const p of items){const o=document.createElement('option');o.value=p.id;o.textContent=p.name;o.dataset.description=p.description;select.append(o)}select.onchange=()=>{const p=items.find(x=>x.id===select.value);if(p){document.querySelector('#name').value=p.name;document.querySelector('#description').value=p.description}}});
  document.querySelector('#start').onclick=async()=>{const status=document.querySelector('#status');status.textContent='正在创建…';try{await request('setup.createConversation',[{title:document.querySelector('#title').value,personaTemplateId:document.querySelector('#persona').value||undefined,playerProfile:{name:document.querySelector('#name').value||'旅人',description:document.querySelector('#description').value},setup:{origin:document.querySelector('#origin').value}}])}catch(e){status.className='error';status.textContent=e.message||String(e)}}
}
let active='chat';async function renderWorkspace(){const [detail,state]=await Promise.all([request('messages.list'),request('state.get')]);const s=state.value||{};const nav=[['chat','对话'],['status','状态'],['inventory','背包'],['quests','任务'],['relationships','关系'],['map','地图']];root.innerHTML='<div class="shell"><aside class="sidebar"><div class="scene-brand"><strong>命定之诗</strong><small>Destined Journey</small></div><nav class="tabs">'+nav.map(([id,label])=>'<button data-tab="'+id+'" class="'+(active===id?'active':'')+'">'+label+'</button>').join('')+'</nav><div class="sidebar-foot">TavernNext Scene · v2.0.0</div></aside><main class="main"><header class="top"><strong>'+esc(context.playerProfile.name)+'</strong><span class="muted">'+esc(detail.conversation.title)+'</span></header><section class="content" id="content"></section></main></div>';document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{active=b.dataset.tab;renderWorkspace()});const area=document.querySelector('#content');
  if(active==='chat'){area.innerHTML='<div class="panel chat"><div class="messages">'+detail.messages.map(m=>'<article class="message '+m.role+'"><div>'+esc(m.content)+'</div><menu><button data-op="edit" data-id="'+m.id+'">编辑</button><button data-op="delete" data-id="'+m.id+'">删除</button>'+(m.role==='assistant'?'<button data-op="continue" data-id="'+m.id+'">续写</button><button data-op="regenerate" data-id="'+m.id+'">重生成</button><button data-op="swipe" data-id="'+m.id+'">换一个回复</button>':'')+'</menu></article>').join('')+'</div><div class="composer-wrap"><div class="composer"><textarea id="draft" placeholder="你准备做什么？"></textarea><button class="action primary" id="send">发送</button><button class="action" id="stop">停止</button></div><div id="generation-status" class="generation-status"></div></div></div>';document.querySelector('#send').onclick=async()=>{const draft=document.querySelector('#draft');const text=draft.value.trim();if(!text)return;updateGeneration({status:'starting',error:null,streamedText:'',streamedReasoning:''});try{await request('messages.send',[text]);draft.value='';await renderWorkspace()}catch(e){updateGeneration({status:'idle',error:e.message||String(e)})}};document.querySelector('#stop').onclick=()=>request('messages.stop').catch(e=>updateGeneration({error:e.message||String(e)}));document.querySelectorAll('[data-op]').forEach(button=>button.onclick=async()=>{const op=button.dataset.op,id=button.dataset.id;try{if(op==='edit'){const message=detail.messages.find(item=>item.id===id);const next=prompt('编辑消息',message?.content||'');if(next===null)return;await request('messages.edit',[id,next])}else if(op==='delete')await request('messages.delete',[id]);else await request('messages.'+op,[id]);await renderWorkspace()}catch(e){updateGeneration({status:'idle',error:e.message||String(e)})}});updateGeneration(generationView);return}
  if(active==='status'){const p=valueAt(s,'主角',{});area.innerHTML='<div class="panel"><h2>'+esc(context.playerProfile.name)+'</h2><div class="grid"><div class="card"><span class="muted">地点</span><div class="stat">'+esc(valueAt(s,'世界.地点','未知'))+'</div></div><div class="card"><span class="muted">时间</span><div class="stat">'+esc(valueAt(s,'世界.时间','未知'))+'</div></div><div class="card"><span class="muted">等级</span><div class="stat">'+esc(p.等级??1)+'</div></div><div class="card"><span class="muted">命运点数</span><div class="stat">'+esc(s.命运点数??0)+'</div></div></div></div>';return}
  const mapping={inventory:['背包','主角.背包'],quests:['任务','任务列表'],relationships:['关系','关系列表'],map:['地图','地图.标记']};const [title,path]=mapping[active];const data=valueAt(s,path,{});const entries=Array.isArray(data)?data.map((v,i)=>[i,v]):Object.entries(data||{});area.innerHTML='<div class="panel"><h2>'+title+'</h2>'+(entries.length?'<div class="grid">'+entries.map(([k,v])=>'<div class="card"><strong>'+esc(v?.name??k)+'</strong><p>'+esc(typeof v==='object'?v.description??JSON.stringify(v):v)+'</p></div>').join('')+'</div>':'<div class="empty">暂无内容</div>')+'</div>'}
export async function mount(input){root=input.root;sdk=input.sdk;context=await sdk.context.get();generationView={...generationView,...sdk.generation.getSnapshot()};applyTheme(sdk.theme.getSnapshot());const unsubscribeTheme=sdk.theme.subscribe(applyTheme);const unsubscribeGeneration=sdk.generation.subscribe(event=>{if(event.type==='snapshot')updateGeneration(event.value);else if(event.type==='text-delta')updateGeneration({...generationView,streamedText:generationView.streamedText+event.text});else if(event.type==='reasoning-delta')updateGeneration({...generationView,streamedReasoning:generationView.streamedReasoning+event.text})});input.mode==='setup'?renderSetup():await renderWorkspace();return()=>{unsubscribeTheme();unsubscribeGeneration();root.replaceChildren()}}
`;

const serverModule = `
import { readFile } from 'node:fs/promises';
const baseState=JSON.parse(await readFile(new URL('../content/initial-state.json',import.meta.url),'utf8'));
const clone=value=>structuredClone(value);
export default {
  async initializeConversation({setup,playerProfile}){const state=clone(baseState);state.世界??={};state.世界.地点=String(setup.origin||'梵尼亚');state.主角??={};state.主角.姓名=playerProfile.name;state.主角.描述=playerProfile.description;return{title:undefined,initialState:state,openingMessages:[{role:'assistant',content:'【首页】\\n命运的书页已经翻开。'+playerProfile.name+'在'+state.世界.地点+'醒来，远方的钟声正为一段尚未书写的旅途而鸣。'}]}}
  ,async beforeGeneration({state}){return{promptAdditions:[{role:'system',content:'<status_current_variables>\\n'+JSON.stringify(state)+'\\n</status_current_variables>\\nReply with story first. If state changes, append <UpdateVariable><JSONPatch>[RFC6902 operations]</JSONPatch></UpdateVariable>.'}]}}
  ,async afterGeneration({content}){const match=/<UpdateVariable>[\\s\\S]*?<JSONPatch>\\s*([\\s\\S]*?)\\s*<\\/JSONPatch>[\\s\\S]*?<\\/UpdateVariable>/i.exec(content);let statePatch=[];let diagnostic;try{if(match)statePatch=JSON.parse(match[1])}catch{diagnostic='invalid_scene_state_patch'}return{displayContent:content.replace(/<UpdateVariable>[\\s\\S]*?<\\/UpdateVariable>/gi,'').trim(),statePatch,...(diagnostic?{diagnostic}:{})}}
  ,async handleAction({action,state}){if(action?.type==='allocate_attribute'){const key=String(action.attribute||'');const points=Number(state?.主角?.属性点||0);if(points<1||!['力量','敏捷','体质','智力','精神'].includes(key))return{result:{ok:false}};return{statePatch:[{op:'replace',path:'/主角/属性点',value:points-1},{op:'replace',path:'/主角/属性/'+key,value:Number(state.主角.属性?.[key]||0)+1}],result:{ok:true}}}return{result:{ok:false,error:'unsupported_action'}}}
};
`;

function characterCardPath(): string {
  const candidates = [
    resolve(process.cwd(), 'example-role-card', 'v4.2.1.png'),
    resolve(process.cwd(), '..', '..', 'example-role-card', 'v4.2.1.png'),
  ];
  const found = candidates.find(existsSync);
  if (found === undefined) throw new Error('official_scene_source_missing');
  return found;
}

function initialState(cardBytes: Uint8Array): Record<string, unknown> {
  const decoded = decodeInspectedCharacter(cardBytes, 'v4.2.1.png');
  if (decoded.character === null) throw new Error('official_scene_character_invalid');
  const variables = attachedVariableValue(decoded.character.extensions) ?? {};
  const mapMarkers = Array.isArray(variables.map_markers) ? variables.map_markers : [];
  return {
    事件: { 开启: false, 结束: false, 标题: '', 阶段: '', 已完成事件: [] },
    世界: { 时间: '', 地点: '' },
    任务列表: {},
    主角: {
      姓名: '', 描述: '', 种族: '', 身份: [], 职业: [], 生命层级: '第一层级/普通', 等级: 1,
      累计经验值: 0, 升级所需经验: 120, 冒险者等级: '未评级', 属性点: 0,
      属性: { 力量: 0, 敏捷: 0, 体质: 0, 智力: 0, 精神: 0 },
      生命值上限: 0, 生命值: 0, 法力值上限: 0, 法力值: 0, 体力值上限: 0, 体力值: 0,
      状态效果: {}, 金钱: 0, 背包: {}, 技能: {},
    },
    命运点数: 0,
    关系列表: {},
    地图: { 标记: mapMarkers },
  };
}

export function destinedPoemManifest(): SceneManifest {
  return SceneManifestSchema.parse({
    id: DESTINED_POEM_SCENE_ID,
    slug: 'destined-poem',
    version: '2.0.0',
    name: '命定之诗与黄昏之歌',
    summary: '在阿斯塔利亚开启一段拥有独立状态、任务、关系与地图的命运旅程。',
    description: '完整迁移自命定之诗与黄昏之歌 v4.2 的官方 TavernNext 场景。每个存档拥有隔离的消息和世界状态。',
    author: 'The Poem of Destiny',
    minimumTavernNextVersion: '1.0.0',
    sceneSdkVersion: 2,
    frontendEntry: 'frontend/app.js',
    frontendStyles: ['frontend/styles.css'],
    serverEntry: 'server/index.mjs',
    setupSchema: { type: 'object', required: ['origin'], properties: { origin: { type: 'string', minLength: 1 } } },
    stateSchema: { type: 'object' },
    generationRecipe: { source: 'scene', outputProtocol: 'mvu-json-patch-v1' },
    files: [
      'manifest.json', 'frontend/app.js', 'frontend/styles.css',
      'server/index.mjs', 'content/initial-state.json', 'content/character.png',
    ],
  });
}

export interface OfficialScenePackage {
  manifest: SceneManifest;
  bytes: Uint8Array;
  digest: string;
}

export function buildDestinedPoemPackage(): OfficialScenePackage {
  const manifest = destinedPoemManifest();
  const cardBytes = new Uint8Array(readFileSync(characterCardPath()));
  const files: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify(manifest)),
    'frontend/app.js': strToU8(frontendScript),
    'frontend/styles.css': strToU8(stylesheet),
    'server/index.mjs': strToU8(serverModule),
    'content/initial-state.json': strToU8(JSON.stringify(initialState(cardBytes))),
    'content/character.png': cardBytes,
  };
  // ZIP stores DOS local-time fields. Constructing the same local calendar
  // value on every host keeps the signed archive digest platform-independent.
  const bytes = zipSync(files, { level: 0, mtime: new Date(1980, 0, 1, 0, 0, 0) });
  return { manifest, bytes, digest: createHash('sha256').update(bytes).digest('hex') };
}

export function unsignedOfficialCatalog(): SceneCatalog {
  const scene = buildDestinedPoemPackage();
  return SceneCatalogSchema.parse({
    version: 1,
    generatedAt: GENERATED_AT,
    scenes: [{
      sceneId: scene.manifest.id,
      version: scene.manifest.version,
      packageUrl: PACKAGE_URL,
      archiveSha256: scene.digest,
      minimumTavernNextVersion: scene.manifest.minimumTavernNextVersion,
      name: scene.manifest.name,
      summary: scene.manifest.summary,
      author: scene.manifest.author,
    }],
  });
}

export function canonicalCatalogBytes(catalog: SceneCatalog): Uint8Array {
  return strToU8(JSON.stringify(catalog));
}

export function verifiedOfficialCatalog(): SceneCatalog {
  const catalog = unsignedOfficialCatalog();
  const signature = Buffer.from(OFFICIAL_CATALOG_SIGNATURE_BASE64, 'base64');
  if (signature.byteLength !== 64 || !verify(null, canonicalCatalogBytes(catalog), OFFICIAL_CATALOG_PUBLIC_KEY_PEM, signature)) {
    throw new Error('official_catalog_signature_invalid');
  }
  return catalog;
}

export function builtInPackage(url: string): OfficialScenePackage | undefined {
  return url === PACKAGE_URL ? buildDestinedPoemPackage() : undefined;
}

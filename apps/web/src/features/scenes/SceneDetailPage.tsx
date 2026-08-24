import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, errorCode } from '../../api/client.js';
import {
  openSceneWindow,
  sceneSaveWindowName,
  sceneSetupWindowName,
  sceneRuntimeChannel,
  type SceneRuntimeSignal,
} from './scene-window.js';

export function SceneDetailPage() {
  const { sceneId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [launchError, setLaunchError] = useState(false);
  useEffect(() => {
    const channel = sceneRuntimeChannel();
    const synchronize = (event: MessageEvent<SceneRuntimeSignal>) => {
      if (event.data?.type !== 'save.changed' || event.data.sceneId !== sceneId) return;
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['scene', sceneId] }),
        queryClient.invalidateQueries({ queryKey: ['scene-conversations', sceneId] }),
        queryClient.invalidateQueries({ queryKey: ['scenes'] }),
      ]);
    };
    channel?.addEventListener('message', synchronize);
    return () => {
      channel?.removeEventListener('message', synchronize);
      channel?.close();
    };
  }, [queryClient, sceneId]);
  const scene = useQuery({ queryKey: ['scene', sceneId], queryFn: () => api.getScene(sceneId) });
  const conversations = useQuery({
    queryKey: ['scene-conversations', sceneId], queryFn: () => api.listSceneConversations(sceneId),
  });
  const launch = (url: string, name: string) => {
    const opened = openSceneWindow(url, name);
    setLaunchError(opened === null);
  };
  const uninstall = useMutation({
    mutationFn: async () => {
      if (scene.data === undefined) throw new Error('scene_not_found');
      const accepted = window.confirm(`卸载“${scene.data.manifest.name}”并永久删除 ${scene.data.conversationCount} 个存档和 ${scene.data.messageCount} 条消息？`);
      if (!accepted) return undefined;
      return api.uninstallScene(scene.data);
    },
    onSuccess: async (receipt) => {
      if (receipt === undefined) return;
      await queryClient.invalidateQueries({ queryKey: ['scenes'] });
      navigate('/');
    },
  });
  if (scene.isLoading) return <main className="scene-detail-page"><p>正在加载场景…</p></main>;
  if (scene.data === undefined) return <main className="scene-detail-page"><p role="alert">场景不存在。</p></main>;
  return (
    <main className="scene-detail-page">
      <Link to="/" className="back-link"><span aria-hidden="true">←</span> 返回角色卡</Link>
      <section className="scene-detail-hero">
        <div className="scene-detail-cover" aria-hidden="true"><span>✦</span><small>Scene Package</small></div>
        <div className="scene-detail-hero-content">
          <span className="eyebrow">{scene.data.manifest.author}<i aria-hidden="true">·</i>v{scene.data.version}</span>
          <h1>{scene.data.manifest.name}</h1>
          <p className="scene-detail-description">{scene.data.manifest.description}</p>
          <div className="scene-trust-notice">
            <span className="scene-trust-icon" aria-hidden="true">✓</span>
            <div><strong>官方完全信任场景</strong><span>前端在独立同源页面运行，可访问 TavernNext API、存储和全局对象。</span></div>
          </div>
          <div className="scene-detail-actions">
            <button className="primary-action" type="button" onClick={() => launch(`/scene-runtime/${sceneId}/new`, sceneSetupWindowName(sceneId))}>创建新存档</button>
            <span>{scene.data.conversationCount} 个存档</span>
          </div>
          {launchError ? <p className="scene-launch-error" role="alert">浏览器阻止了新标签页，请允许此站点打开弹出式窗口后重试。</p> : null}
        </div>
      </section>
      <section className="scene-saves-section">
        <header className="scene-section-header"><div><span className="eyebrow">Saved Sessions</span><h2>存档</h2></div><span className="scene-save-count">{conversations.data?.length ?? 0}</span></header>
        <div className="save-list">
          {(conversations.data ?? []).map((conversation) => (
            <button type="button" key={conversation.id} onClick={() => launch(`/scene-runtime/${sceneId}/conversations/${conversation.id}`, sceneSaveWindowName(conversation.id))}>
              <span className="save-list-primary"><strong>{conversation.title}</strong><small>{conversation.playerProfile?.name ?? '旅人'}</small></span>
              <span className="save-list-meta"><time>{new Date(conversation.updatedAt).toLocaleString()}</time><i aria-hidden="true">→</i></span>
            </button>
          ))}
          {conversations.data?.length === 0 ? <p className="empty-state">还没有存档，从自定义开局开始。</p> : null}
        </div>
      </section>
      <section className="danger-zone">
        <div><span className="eyebrow">Danger Zone</span><h2>卸载场景</h2><p>卸载会在创建数据库备份后级联删除全部存档。</p>{uninstall.error ? <p role="alert">卸载失败：{errorCode(uninstall.error)}</p> : null}</div>
        <button type="button" disabled={uninstall.isPending} onClick={() => uninstall.mutate()}>卸载并删除存档</button>
      </section>
    </main>
  );
}

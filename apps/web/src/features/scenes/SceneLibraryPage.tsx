import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, errorCode } from '../../api/client.js';

export function SceneLibraryPage() {
  const queryClient = useQueryClient();
  const installed = useQuery({ queryKey: ['scenes'], queryFn: api.listScenes });
  const catalog = useQuery({ queryKey: ['scene-catalog'], queryFn: api.listSceneCatalog });
  const install = useMutation({
    mutationFn: api.installScene,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['scenes'] }),
        queryClient.invalidateQueries({ queryKey: ['scene-catalog'] }),
      ]);
    },
  });
  return (
    <main className="scene-library-page">
      <header className="scene-library-hero">
        <div><span className="eyebrow">TavernNext Scenes</span><h1>角色卡</h1></div>
        <p>每张卡都是一个拥有专属页面、规则和隔离存档的角色扮演场景。</p>
      </header>
      <section>
        <h2>已安装</h2>
        {installed.isLoading ? <p>正在读取场景…</p> : null}
        <div className="scene-card-grid">
          {(installed.data ?? []).map((scene) => (
            <Link className="scene-card" to={`/scenes/${scene.id}`} key={scene.id}>
              <div className="scene-card-cover"><span>✦</span></div>
              <div><small>{scene.manifest.author}</small><h3>{scene.manifest.name}</h3><p>{scene.manifest.summary}</p><strong>{scene.conversationCount} 个存档</strong></div>
            </Link>
          ))}
          {installed.data?.length === 0 ? <p className="empty-state">尚未安装场景，请从官方目录选择。</p> : null}
        </div>
      </section>
      <section>
        <h2>官方目录</h2>
        <div className="scene-card-grid">
          {(catalog.data ?? []).map((scene) => (
            <article className="scene-card" key={scene.sceneId}>
              <div className="scene-card-cover catalog"><span>♜</span></div>
              <div><small>{scene.author} · v{scene.version}</small><h3>{scene.name}</h3><p>{scene.summary}</p><button type="button" disabled={scene.installed || install.isPending} onClick={() => install.mutate(scene.sceneId)}>{scene.installed ? '已安装' : '安装官方场景'}</button></div>
            </article>
          ))}
        </div>
        {catalog.error ? <p role="alert">目录加载失败：{errorCode(catalog.error)}</p> : null}
        {install.error ? <p role="alert">安装失败：{errorCode(install.error)}</p> : null}
      </section>
    </main>
  );
}

import type {
  SceneFrontendCleanup,
  SceneFrontendModule,
  SceneGenerationEvent,
  SceneGenerationSnapshot,
  SceneRuntimeMode,
  SceneSdkV2,
  SceneThemeSnapshot,
} from '@tavernnext/domain';
import { roleplayDocumentPlainText } from '@tavernnext/domain';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, type MessageView } from '../../api/client.js';
import { useTheme } from '../../app/theme.js';
import { useGeneration } from '../chat/useGeneration.js';
import {
  announceSceneChanged,
  sceneRuntimeChannel,
  sceneSaveWindowName,
  type SceneRuntimeSignal,
} from './scene-window.js';
import { mountSceneStatusRail } from './status-rail.js';
import { SaveAgentConfigurationPanel } from './SaveAgentConfigurationPanel.js';

type LeaseState = 'checking' | 'active' | 'duplicate';

class SceneSdkError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
    readonly latest?: unknown,
  ) {
    super(code);
    this.name = 'SceneSdkError';
  }
}

function activeContent(message: MessageView): string {
  if (message.role !== 'assistant') return message.content;
  const variant = message.variants.find((candidate) => candidate.id === message.activeVariantId)
    ?? message.variants[0];
  return variant?.document === undefined ? variant?.content ?? message.content : roleplayDocumentPlainText(variant.document);
}

function generationSnapshot(value: ReturnType<ReturnType<typeof useGeneration>['getSnapshot']>): SceneGenerationSnapshot {
  return {
    status: value.status,
    streamedText: value.streamedText,
    streamedReasoning: value.streamedReasoning,
    error: value.error,
    activities: value.activities,
    viewPlaceholders: value.viewPlaceholders,
  };
}

function asSdkError(error: unknown, latest?: unknown): SceneSdkError {
  if (error instanceof SceneSdkError) return error;
  if (error instanceof ApiError) return new SceneSdkError(error.code, error.status, latest);
  return new SceneSdkError(error instanceof Error ? error.message : 'scene_sdk_error', undefined, latest);
}

function useRuntimeLease(key: string, conversationId?: string): LeaseState {
  const [state, setState] = useState<LeaseState>('checking');
  useEffect(() => {
    setState('checking');
    let release: (() => void) | undefined;
    let cancelled = false;
    const channel = sceneRuntimeChannel();
    const focusCurrent = (event: MessageEvent<SceneRuntimeSignal>) => {
      if (event.data?.type === 'focus' && conversationId !== undefined
        && event.data.conversationId === conversationId) window.focus();
    };
    channel?.addEventListener('message', focusCurrent);
    const locks = navigator.locks;
    if (locks === undefined) {
      setState('active');
      return () => {
        channel?.removeEventListener('message', focusCurrent);
        channel?.close();
      };
    }
    const acquire = window.setTimeout(() => {
      if (cancelled) return;
      void locks.request(`tavernnext-scene-runtime:${key}`, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
        if (cancelled) return;
        if (lock === null) {
          setState('duplicate');
          if (conversationId !== undefined) channel?.postMessage({ type: 'focus', conversationId } satisfies SceneRuntimeSignal);
          return;
        }
        setState('active');
        await new Promise<void>((resolve) => { release = resolve; });
      });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(acquire);
      release?.();
      channel?.removeEventListener('message', focusCurrent);
      channel?.close();
    };
  }, [conversationId, key]);
  return state;
}

export function SceneRuntimePage({ mode }: { mode: SceneRuntimeMode }) {
  const { sceneId = '', conversationId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const theme = useTheme();
  const generation = useGeneration();
  const mountRef = useRef<HTMLDivElement>(null);
  const generationListeners = useRef(new Set<(event: SceneGenerationEvent) => void>());
  const themeListeners = useRef(new Set<(snapshot: SceneThemeSnapshot) => void>());
  const [moduleError, setModuleError] = useState<string>();
  const lease = useRuntimeLease(
    mode === 'setup' ? `setup:${sceneId}` : `save:${conversationId ?? ''}`,
    conversationId,
  );
  const scene = useQuery({ queryKey: ['scene', sceneId], queryFn: () => api.getScene(sceneId) });
  const personas = useQuery({
    queryKey: ['personas'], queryFn: api.listPersonas, enabled: mode === 'setup',
  });
  const detail = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => api.getConversationMessages(conversationId!),
    enabled: mode === 'workspace' && conversationId !== undefined,
  });
  const state = useQuery({
    queryKey: ['scene-state', conversationId],
    queryFn: () => api.getSceneState(conversationId!),
    enabled: mode === 'workspace' && conversationId !== undefined,
  });
  const latest = useRef({ scene: scene.data, personas: personas.data, detail: detail.data, state: state.data, theme, generation });
  latest.current = { scene: scene.data, personas: personas.data, detail: detail.data, state: state.data, theme, generation };

  const refresh = async () => {
    if (conversationId === undefined) return;
    const [freshDetail, freshState] = await Promise.all([
      api.getConversationMessages(conversationId),
      api.getSceneState(conversationId),
    ]);
    queryClient.setQueryData(['conversation', conversationId], freshDetail);
    queryClient.setQueryData(['scene-state', conversationId], freshState);
    latest.current = { ...latest.current, detail: freshDetail, state: freshState };
    await queryClient.invalidateQueries({ queryKey: ['scene-conversations', sceneId] });
    announceSceneChanged(sceneId, conversationId);
  };

  const sdk = useMemo<SceneSdkV2>(() => {
    const requireSetup = () => {
      if (mode !== 'setup') throw new SceneSdkError('scene_sdk_method_unavailable');
    };
    const requireWorkspace = () => {
      const current = latest.current;
      if (mode !== 'workspace' || conversationId === undefined || current.detail === undefined) {
        throw new SceneSdkError('scene_sdk_context_unavailable');
      }
      if (current.detail.conversation.sceneId !== sceneId) throw new SceneSdkError('scene_save_mismatch', 404);
      return current.detail;
    };
    const findMessage = (messageId: string) => {
      const message = requireWorkspace().messages.find((item) => item.id === messageId);
      if (message === undefined) throw new SceneSdkError('message_not_found', 404);
      return message;
    };
    const refreshAfterConflict = async (error: unknown): Promise<never> => {
      if (error instanceof ApiError && error.status === 409) {
        await refresh().catch(() => undefined);
        throw asSdkError(error, latest.current.detail ?? latest.current.state);
      }
      throw asSdkError(error);
    };
    const generate = async (messageId: string, generationMode: 'continue' | 'regenerate' | 'swipe') => {
      const current = requireWorkspace();
      const message = findMessage(messageId);
      const result = await latest.current.generation.start(current.conversation, {
        mode: generationMode,
        target: message,
        baseContent: activeContent(message),
      });
      await refresh();
      return result;
    };
    return {
      version: 2,
      mode,
      sceneId,
      ...(conversationId === undefined ? {} : { conversationId }),
      context: {
        get: async () => {
          const current = latest.current;
          if (current.scene === undefined) throw new SceneSdkError('scene_sdk_context_unavailable');
          const conversation = current.detail?.conversation;
          return {
            mode,
            scene: current.scene.manifest,
            ...(conversation === undefined ? {} : { conversation }),
            playerProfile: conversation?.playerProfile ?? { name: '', description: '' },
          };
        },
      },
      setup: {
        listPersonas: async () => { requireSetup(); return latest.current.personas ?? []; },
        createConversation: async (input) => {
          requireSetup();
          try {
            const conversation = await api.createSceneConversation(sceneId, input);
            window.name = sceneSaveWindowName(conversation.id);
            announceSceneChanged(sceneId, conversation.id);
            navigate(`/scene-runtime/${sceneId}/conversations/${conversation.id}`, { replace: true });
            return conversation;
          } catch (error) {
            throw asSdkError(error);
          }
        },
      },
      messages: {
        list: async () => {
          const current = requireWorkspace();
          return {
            conversation: current.conversation,
            messages: current.messages.map((message) => ({ ...message, content: activeContent(message) })),
          };
        },
        send: async (text) => {
          const current = requireWorkspace();
          const normalized = text.trim();
          if (normalized === '') throw new SceneSdkError('invalid_user_text', 400);
          const result = await latest.current.generation.start(current.conversation, { mode: 'normal', userText: normalized });
          await refresh();
          return result;
        },
        stop: async () => latest.current.generation.stop(),
        edit: async (messageId, content) => {
          try { const result = await api.updateMessage(findMessage(messageId), content); await refresh(); return result; }
          catch (error) { return refreshAfterConflict(error); }
        },
        delete: async (messageId) => {
          try { await api.deleteMessage(findMessage(messageId)); await refresh(); }
          catch (error) { return refreshAfterConflict(error); }
        },
        switchVariant: async (messageId, variantId) => {
          try { const result = await api.switchActiveVariant(findMessage(messageId), variantId); await refresh(); return result; }
          catch (error) { return refreshAfterConflict(error); }
        },
        continue: (messageId) => generate(messageId, 'continue'),
        regenerate: (messageId) => generate(messageId, 'regenerate'),
        swipe: (messageId) => generate(messageId, 'swipe'),
      },
      state: {
        get: async () => {
          requireWorkspace();
          return latest.current.state ?? api.getSceneState(conversationId!);
        },
        patch: async (operations) => {
          requireWorkspace();
          try {
            const current = latest.current.state ?? await api.getSceneState(conversationId!);
            const result = await api.patchSceneState(conversationId!, current.revision, operations);
            queryClient.setQueryData(['scene-state', conversationId], result.state);
            latest.current = { ...latest.current, state: result.state };
            announceSceneChanged(sceneId, conversationId!);
            return result;
          } catch (error) {
            return refreshAfterConflict(error);
          }
        },
      },
      scene: {
        action: async (action) => {
          requireWorkspace();
          try {
            const result = await api.runSceneAction(conversationId!, action);
            queryClient.setQueryData(['scene-state', conversationId], result.state);
            latest.current = { ...latest.current, state: result.state };
            announceSceneChanged(sceneId, conversationId!);
            return result;
          } catch (error) {
            return refreshAfterConflict(error);
          }
        },
        assetUrl: (path) => {
          const current = latest.current.scene;
          if (current === undefined || !current.manifest.files.includes(path)) throw new SceneSdkError('scene_asset_not_found', 404);
          return `/api/scenes/${encodeURIComponent(sceneId)}/assets/${path}`;
        },
      },
      generation: {
        getSnapshot: () => generationSnapshot(latest.current.generation.getSnapshot()),
        subscribe: (listener) => {
          generationListeners.current.add(listener);
          listener({ type: 'snapshot', value: generationSnapshot(latest.current.generation.getSnapshot()) });
          return () => generationListeners.current.delete(listener);
        },
        stop: async () => latest.current.generation.stop(),
      },
      theme: {
        getSnapshot: () => ({ scheme: latest.current.theme.scheme, tokens: latest.current.theme.tokens }),
        subscribe: (listener) => {
          themeListeners.current.add(listener);
          listener({ scheme: latest.current.theme.scheme, tokens: latest.current.theme.tokens });
          return () => themeListeners.current.delete(listener);
        },
      },
      ui: {
        statusRail: { mount: mountSceneStatusRail },
      },
    };
  }, [conversationId, mode, navigate, queryClient, sceneId]);

  useEffect(() => generation.subscribeEvents((event) => {
    for (const listener of generationListeners.current) listener(event);
  }), [generation.subscribeEvents]);

  useEffect(() => {
    const snapshot = { scheme: theme.scheme, tokens: theme.tokens } satisfies SceneThemeSnapshot;
    for (const listener of themeListeners.current) listener(snapshot);
  }, [theme.scheme, theme.tokens]);

  const ready = lease === 'active'
    && scene.data !== undefined
    && (mode === 'setup' ? personas.data !== undefined : detail.data !== undefined && state.data !== undefined)
    && (mode !== 'workspace' || detail.data?.conversation.sceneId === sceneId);

  useEffect(() => {
    if (!ready || mountRef.current === null || scene.data === undefined) return;
    let cancelled = false;
    let cleanup: SceneFrontendCleanup | undefined;
    const links = scene.data.manifest.frontendStyles.map((path) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `/api/scenes/${encodeURIComponent(sceneId)}/assets/${path}?digest=${scene.data!.archiveDigest}`;
      link.dataset.sceneRuntimeStyle = sceneId;
      document.head.append(link);
      return link;
    });
    const entryUrl = `/api/scenes/${encodeURIComponent(sceneId)}/assets/${scene.data.manifest.frontendEntry}?digest=${scene.data.archiveDigest}`;
    setModuleError(undefined);
    void import(/* @vite-ignore */ entryUrl).then(async (loaded: unknown) => {
      const module = loaded as Partial<SceneFrontendModule>;
      if (typeof module.mount !== 'function') throw new Error('scene_frontend_mount_missing');
      const result = await module.mount({ root: mountRef.current!, mode, sdk });
      if (typeof result === 'function') {
        if (cancelled) await result();
        else cleanup = result;
      }
    }).catch((error: unknown) => {
      if (!cancelled) setModuleError(error instanceof Error ? error.message : 'scene_frontend_load_failed');
    });
    return () => {
      cancelled = true;
      void cleanup?.();
      for (const link of links) link.remove();
      if (mountRef.current !== null) mountRef.current.replaceChildren();
    };
  }, [mode, ready, scene.data, sceneId, sdk]);

  useEffect(() => {
    if (scene.data === undefined) return;
    document.title = mode === 'workspace' && detail.data !== undefined
      ? `${detail.data.conversation.title} · ${scene.data.manifest.name}`
      : `创建存档 · ${scene.data.manifest.name}`;
  }, [detail.data, mode, scene.data]);

  if (lease === 'duplicate') {
    return <main className="scene-standalone-status"><h1>存档已在另一标签页打开</h1><p>已请求聚焦现有页面。</p><button type="button" onClick={() => window.close()}>关闭此页</button></main>;
  }
  if (lease === 'checking' || scene.isLoading || (mode === 'setup' ? personas.isLoading : detail.isLoading || state.isLoading)) {
    return <main className="scene-standalone-status"><p>正在加载场景…</p></main>;
  }
  if (scene.error !== null || scene.data === undefined || (mode === 'workspace' && (
    detail.data === undefined || state.data === undefined || detail.data.conversation.sceneId !== sceneId
  ))) {
    return <main className="scene-standalone-status"><h1>无法加载场景</h1><p role="alert">场景或存档不存在，或者存档不属于该场景。</p></main>;
  }
  return (
    <main className="scene-standalone-page">
      {moduleError === undefined ? null : <div className="scene-runtime-error" role="alert">场景前端加载失败：{moduleError}</div>}
      {mode === 'workspace' && conversationId !== undefined
        ? <SaveAgentConfigurationPanel conversationId={conversationId} />
        : null}
      <div ref={mountRef} className="scene-runtime-root" />
    </main>
  );
}

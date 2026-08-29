import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.js';

export function MemoryCenter({ conversationId }: { conversationId: string }) {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const baseKey = ['memory-center', conversationId] as const;
  const key = [...baseKey, page] as const;
  const memory = useQuery({ queryKey: key, queryFn: () => api.getMemoryCenter(conversationId, page) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: baseKey });
  const update = useMutation({
    mutationFn: ({ id, pinned, excluded }: { id: string; pinned: boolean; excluded: boolean }) => {
      const item = memory.data?.memories.find((candidate) => candidate.id === id);
      if (item === undefined) throw new Error('memory_not_found');
      return api.updateMemory(item, { pinned, excluded });
    },
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => {
      const item = memory.data?.memories.find((candidate) => candidate.id === id);
      if (item === undefined) throw new Error('memory_not_found');
      return api.deleteMemory(item);
    },
    onSuccess: refresh,
  });
  const rebuild = useMutation({
    mutationFn: () => api.rebuildMemoryIndex(conversationId),
    onSuccess: refresh,
  });
  const toggle = useMutation({
    mutationFn: () => api.updateMemorySettings(
      conversationId,
      memory.data?.configuration?.revision ?? null,
      memory.data?.configuration?.enabled === false,
    ),
    onSuccess: refresh,
  });
  const retry = useMutation({ mutationFn: api.retryMemoryJob, onSuccess: refresh });
  const backfill = useMutation({ mutationFn: () => api.backfillMemory(conversationId), onSuccess: refresh });

  return (
    <details className="scene-memory-center">
      <summary>Save memory</summary>
      {memory.isLoading ? <p>Loading memory…</p> : memory.error !== null ? <p role="alert">Memory unavailable.</p> : <div>
        <header className="memory-center-header">
          <span>{memory.data?.configuration?.enabled === false ? 'Disabled' : 'Enabled'}</span>
          <button type="button" onClick={() => {
            const enabling = memory.data?.configuration?.enabled === false;
            if (enabling && window.confirm('Backfill completed turns that have no Save Memory?')) backfill.mutate();
            toggle.mutate();
          }} disabled={toggle.isPending || backfill.isPending}>
            {memory.data?.configuration?.enabled === false ? 'Enable memory' : 'Disable memory'}
          </button>
          <button type="button" onClick={() => rebuild.mutate()} disabled={rebuild.isPending}>Rebuild index</button>
        </header>
        <p className="muted">Embedding: {memory.data?.embedding.configured
          ? `${memory.data.embedding.model ?? 'configured'}${memory.data.embedding.enabled ? '' : ' (disabled)'}`
          : 'not configured — BM25 fallback active'}</p>
        {(memory.data?.jobs ?? []).filter((job) => job.status === 'failed').map((job) => (
          <p role="alert" key={job.id}>{job.kind}: {job.lastError ?? 'failed'}{' '}
            <button type="button" onClick={() => retry.mutate(job.id)}>Retry</button>
          </p>
        ))}
        <div className="memory-center-list">
          {(memory.data?.memories ?? []).map((item) => (
            <article key={item.id} className="memory-center-card">
              <small>{item.tier} · {item.kind} · {item.status}</small>
              <p>{item.summary}</p>
              {item.detail === '' ? null : <p className="muted">{item.detail}</p>}
              <menu>
                <button type="button" onClick={() => update.mutate({
                  id: item.id, pinned: !item.pinned, excluded: item.excluded,
                })}>{item.pinned ? 'Unpin' : 'Pin'}</button>
                <button type="button" onClick={() => update.mutate({
                  id: item.id, pinned: item.pinned, excluded: !item.excluded,
                })}>{item.excluded ? 'Include' : 'Exclude'}</button>
                <button type="button" onClick={() => remove.mutate(item.id)}>Delete</button>
              </menu>
            </article>
          ))}
          {(memory.data?.memories.length ?? 0) === 0 ? <p>No memory captured yet.</p> : null}
        </div>
        {(memory.data?.pagination.totalPages ?? 0) > 1 ? <nav className="memory-center-pagination">
          <button type="button" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>←</button>
          <span>{page} / {memory.data?.pagination.totalPages ?? 1}</span>
          <button type="button" aria-label="Next page" disabled={page >= (memory.data?.pagination.totalPages ?? 1)} onClick={() => setPage((value) => value + 1)}>→</button>
        </nav> : null}
      </div>}
    </details>
  );
}

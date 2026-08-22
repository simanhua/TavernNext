import { randomUUID } from 'node:crypto';
import type { PromptChatMessage } from '@tavernnext/prompt-engine';
import {
  canonicalHash,
  PromptSnapshotError,
  type PromptSnapshotInput,
  type PromptSnapshotPayload,
  type PromptSnapshotService,
} from './prompt-snapshot-service.js';

const CANDIDATE_TTL_MS = 60_000;

interface CandidateRecord {
  candidateId: string;
  expiresAt: number;
  used: boolean;
  input: PromptSnapshotInput;
  payload: PromptSnapshotPayload;
}

export interface GenerationCandidate extends PromptSnapshotPayload {
  candidateId: string;
  expiresAt: string;
  executableDigest: string;
}

export function createGenerationCandidateService(promptSnapshots: PromptSnapshotService) {
  const candidates = new Map<string, CandidateRecord>();
  const tombstones = new Map<string, number>();
  const activeByConversation = new Map<string, string>();
  const remove = (candidate: CandidateRecord) => {
    candidates.delete(candidate.candidateId);
    if (activeByConversation.get(candidate.input.conversationId) === candidate.candidateId) {
      activeByConversation.delete(candidate.input.conversationId);
    }
  };
  const sweep = () => {
    const now = Date.now();
    for (const candidate of candidates.values()) if (candidate.expiresAt <= now) remove(candidate);
    for (const [id, expiresAt] of tombstones) if (expiresAt <= now) tombstones.delete(id);
  };
  return {
    async create(input: PromptSnapshotInput): Promise<GenerationCandidate> {
      sweep();
      if (activeByConversation.has(input.conversationId)) throw new PromptSnapshotError('revision_conflict');
      const candidateId = randomUUID();
      activeByConversation.set(input.conversationId, candidateId);
      let preview;
      try { preview = await promptSnapshots.createCandidate(input); }
      catch (error) {
        if (activeByConversation.get(input.conversationId) === candidateId) activeByConversation.delete(input.conversationId);
        throw error;
      }
      const { snapshotId: _unused, ...payload } = preview;
      const record: CandidateRecord = {
        candidateId,
        expiresAt: Date.now() + CANDIDATE_TTL_MS,
        used: false,
        input: structuredClone(input),
        payload: structuredClone(payload),
      };
      candidates.set(candidateId, record);
      return {
        candidateId,
        expiresAt: new Date(record.expiresAt).toISOString(),
        executableDigest: canonicalHash(payload.executable),
        ...structuredClone(payload),
      };
    },
    async seal(candidateId: string, patch: { messages?: PromptChatMessage[]; text?: string; stop?: string[] }) {
      const candidate = candidates.get(candidateId);
      sweep();
      if (tombstones.has(candidateId)) throw new PromptSnapshotError('snapshot_mismatch');
      if (candidate === undefined) throw new PromptSnapshotError('not_found');
      if (candidate.expiresAt <= Date.now()) {
        remove(candidate);
        throw new PromptSnapshotError('snapshot_stale');
      }
      candidate.used = true;
      activeByConversation.delete(candidate.input.conversationId);
      candidates.delete(candidateId);
      tombstones.set(candidateId, Date.now() + CANDIDATE_TTL_MS);
      const snapshotId = randomUUID();
      return promptSnapshots.sealCandidate(candidate.input, snapshotId, candidate.payload, patch);
    },
    discard(candidateId: string): boolean {
      const candidate = candidates.get(candidateId);
      if (candidate === undefined || candidate.used) return false;
      remove(candidate);
      return true;
    },
  };
}

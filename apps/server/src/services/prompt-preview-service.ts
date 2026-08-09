import type { PromptSnapshotInput, PromptSnapshotPreview, PromptSnapshotService } from './prompt-snapshot-service.js';

export interface PromptPreviewService {
  preview(input: PromptSnapshotInput): Promise<PromptSnapshotPreview>;
}

export function createPromptPreviewService(snapshotService: PromptSnapshotService): PromptPreviewService {
  return {
    preview(input) {
      return snapshotService.createPreview(input);
    },
  };
}

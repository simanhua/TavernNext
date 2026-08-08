import type { FastifyInstance } from 'fastify';
import type { ImportService } from '../services/import-service.js';
import { ImportCommitError, ImportQuotaError, ImportTokenError } from '../services/import-service.js';

export function registerImportRoutes(app: FastifyInstance, imports: ImportService): void {
  app.post('/api/imports/inspect', async (request, reply) => {
    if (!request.isMultipart()) return reply.code(415).send({ error: 'multipart_required' });
    let artifact: { fileName: string; mediaType: string; bytes: Uint8Array };
    try {
      const file = await request.file();
      if (file === undefined || file.filename.trim() === '') return reply.code(400).send({ error: 'import_file_required' });
      artifact = {
        fileName: file.filename,
        mediaType: file.mimetype,
        bytes: new Uint8Array(await file.toBuffer()),
      };
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
      if (code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: 'upload_too_large' });
      return reply.code(400).send({ error: 'invalid_multipart_upload' });
    }
    try {
      const preview = await imports.inspect(artifact);
      return reply.code(preview.blockingErrors.length > 0 ? 422 : 200).send(preview);
    } catch (error) {
      if (error instanceof ImportQuotaError) return reply.code(error.statusCode).send({ error: error.code });
      return reply.code(500).send({ error: 'import_inspection_failed' });
    }
  });

  app.post('/api/imports/commit', async (request, reply) => {
    const body = request.body;
    const token = typeof body === 'object' && body !== null && 'inspectionToken' in body
      ? (body as { inspectionToken?: unknown }).inspectionToken
      : undefined;
    if (typeof token !== 'string' || token === '') return reply.code(400).send({ error: 'inspection_token_required' });
    try {
      return reply.code(201).send(imports.commit(token));
    } catch (error) {
      if (error instanceof ImportTokenError) return reply.code(error.statusCode).send({ error: error.code });
      if (error instanceof ImportCommitError) return reply.code(500).send({ error: 'import_commit_failed' });
      throw error;
    }
  });
}

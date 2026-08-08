import { exportWorldbook } from '@tavernnext/st-compat';
import type { FastifyInstance } from 'fastify';
import type { Repositories } from '../db/repositories.js';
import { normalizedWorldbookFromRows } from '../services/worldbook-import-handler.js';

function rfc5987(value: string): string {
  const attrChar = /^[A-Za-z0-9!#$&+.^_`|~-]$/;
  return [...Buffer.from(value, 'utf8')]
    .map((byte) => {
      const character = String.fromCharCode(byte);
      return attrChar.test(character) ? character : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('');
}

function attachmentHeader(fileName: string): string {
  const clean = fileName
    .replace(/[\u0000-\u001f\u007f-\u009f/\\]/g, '_')
    .replace(/\.\.+/g, '_');
  const fallback = clean.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const base = `attachment; filename="${fallback}"`;
  return clean === fallback ? base : `${base}; filename*=UTF-8''${rfc5987(clean)}`;
}

export function registerWorldbookExportRoutes(app: FastifyInstance, repositories: Repositories): void {
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    '/api/worldbooks/:id/export',
    async (request, reply) => {
      if (request.query.format !== 'st-native') {
        return reply.code(400).send({ error: 'invalid_worldbook_export_format' });
      }
      const worldbook = repositories.worldbooks.get(request.params.id);
      if (worldbook === undefined) return reply.code(404).send({ error: 'not_found' });
      try {
        const artifact = await exportWorldbook(normalizedWorldbookFromRows(
          worldbook,
          repositories.worldbookEntries.listByWorldbookId(worldbook.id),
        ));
        reply.header('Content-Type', artifact.contentType);
        reply.header('Content-Disposition', attachmentHeader(artifact.fileName));
        return reply.send(Buffer.from(artifact.bytes));
      } catch {
        return reply.code(400).send({ error: 'worldbook_export_unavailable' });
      }
    },
  );
}

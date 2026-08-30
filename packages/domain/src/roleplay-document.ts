import { z } from 'zod';

export const RoleplayMarkdownBlockSchema = z.object({
  type: z.literal('markdown'),
  content: z.string(),
}).strict();

export const RoleplaySceneViewBlockSchema = z.object({
  type: z.literal('scene-view'),
  viewId: z.string().uuid(),
  sceneId: z.string().uuid(),
  sceneVersion: z.string().min(1),
  sceneDigest: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.string().min(1).max(64),
  schemaVersion: z.number().int().positive(),
  rendererId: z.string().min(1).max(96),
  sourceStateRevision: z.number().int().nonnegative(),
  props: z.record(z.string(), z.unknown()),
}).strict();

export const RoleplayDocumentBlockSchema = z.discriminatedUnion('type', [
  RoleplayMarkdownBlockSchema,
  RoleplaySceneViewBlockSchema,
]);

export const RoleplayDocumentSchema = z.object({
  version: z.literal(1),
  blocks: z.array(RoleplayDocumentBlockSchema).max(4_096),
}).strict();

export type RoleplayMarkdownBlock = z.infer<typeof RoleplayMarkdownBlockSchema>;
export type RoleplaySceneViewBlock = z.infer<typeof RoleplaySceneViewBlockSchema>;
export type RoleplayDocumentBlock = z.infer<typeof RoleplayDocumentBlockSchema>;
export type RoleplayDocument = z.infer<typeof RoleplayDocumentSchema>;

export function roleplayDocumentFromMarkdown(content: string): RoleplayDocument {
  return RoleplayDocumentSchema.parse({
    version: 1,
    blocks: content === '' ? [] : [{ type: 'markdown', content }],
  });
}

export function roleplayDocumentPlainText(document: RoleplayDocument): string {
  return document.blocks.flatMap((block) => block.type === 'markdown' ? [block.content] : []).join('');
}

export function appendRoleplayMarkdown(document: RoleplayDocument, content: string): RoleplayDocument {
  if (content === '') return RoleplayDocumentSchema.parse(structuredClone(document));
  const blocks = structuredClone(document.blocks);
  const last = blocks.at(-1);
  if (last?.type === 'markdown') last.content += content;
  else blocks.push({ type: 'markdown', content });
  return RoleplayDocumentSchema.parse({ version: 1, blocks });
}

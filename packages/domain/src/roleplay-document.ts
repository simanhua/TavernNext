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

export const ActionOptionKindSchema = z.enum([
  'smooth', 'engage', 'advance', 'mainline', 'twist', 'dark',
]);

export const ActionOptionSchema = z.object({
  id: z.string().regex(/^option-[1-7]$/),
  kind: ActionOptionKindSchema,
  text: z.string().trim().min(1).max(300),
}).strict();

const orderedActionOption = (id: `option-${1 | 2 | 3 | 4 | 5 | 6 | 7}`, kind: z.infer<typeof ActionOptionKindSchema>) => (
  ActionOptionSchema.extend({ id: z.literal(id), kind: z.literal(kind) })
);

export const RoleplayActionOptionsBlockSchema = z.object({
  type: z.literal('action-options'),
  options: z.tuple([
    orderedActionOption('option-1', 'smooth'),
    orderedActionOption('option-2', 'smooth'),
    orderedActionOption('option-3', 'engage'),
    orderedActionOption('option-4', 'advance'),
    orderedActionOption('option-5', 'mainline'),
    orderedActionOption('option-6', 'twist'),
    orderedActionOption('option-7', 'dark'),
  ]),
}).strict();

export const RoleplayDocumentBlockSchema = z.discriminatedUnion('type', [
  RoleplayMarkdownBlockSchema,
  RoleplaySceneViewBlockSchema,
  RoleplayActionOptionsBlockSchema,
]);

export const RoleplayDocumentSchema = z.object({
  version: z.literal(1),
  blocks: z.array(RoleplayDocumentBlockSchema).max(4_096),
}).strict();

export type RoleplayMarkdownBlock = z.infer<typeof RoleplayMarkdownBlockSchema>;
export type RoleplaySceneViewBlock = z.infer<typeof RoleplaySceneViewBlockSchema>;
export type ActionOptionKind = z.infer<typeof ActionOptionKindSchema>;
export type ActionOption = z.infer<typeof ActionOptionSchema>;
export type RoleplayActionOptionsBlock = z.infer<typeof RoleplayActionOptionsBlockSchema>;
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

export function replaceRoleplayActionOptions(
  document: RoleplayDocument,
  options: ActionOption[],
): RoleplayDocument {
  const blocks: RoleplayDocumentBlock[] = structuredClone(document.blocks)
    .filter((block) => block.type !== 'action-options');
  if (options.length > 0) blocks.push(RoleplayActionOptionsBlockSchema.parse({ type: 'action-options', options }));
  return RoleplayDocumentSchema.parse({ version: 1, blocks });
}

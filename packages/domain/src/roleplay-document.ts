import { z } from 'zod';

export const RoleplayMarkdownBlockSchema = z.object({
  type: z.literal('markdown'),
  content: z.string(),
}).strict();

export const RoleplayDocumentSchema = z.object({
  version: z.literal(1),
  blocks: z.array(RoleplayMarkdownBlockSchema).max(4_096),
}).strict();

export type RoleplayMarkdownBlock = z.infer<typeof RoleplayMarkdownBlockSchema>;
export type RoleplayDocument = z.infer<typeof RoleplayDocumentSchema>;

export function roleplayDocumentFromMarkdown(content: string): RoleplayDocument {
  return RoleplayDocumentSchema.parse({
    version: 1,
    blocks: content === '' ? [] : [{ type: 'markdown', content }],
  });
}

export function roleplayDocumentPlainText(document: RoleplayDocument): string {
  return document.blocks.map((block) => block.content).join('');
}

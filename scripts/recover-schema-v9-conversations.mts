import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import initSqlJs from "sql.js/dist/sql-asm.js";
import { createDatabase } from "../apps/server/src/db/client.js";
import { createRepositories } from "../apps/server/src/db/repositories.js";

type LegacyRow = Record<string, number | string | Uint8Array | null>;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const positional = args.filter((value) => value !== "--apply");
  if (positional.length !== 2) {
    throw new Error(
      "Usage: recover-schema-v9-conversations.ts <schema-v9.sqlite> <current.sqlite> [--apply]",
    );
  }

  const [legacyPath, targetPath] = positional.map((value) => resolve(value));
  const SQL = await initSqlJs();
  const legacy = new SQL.Database(new Uint8Array(readFileSync(legacyPath)));
  const target = createDatabase(targetPath);
  const snapshotIntegrityKey = new Uint8Array(
    readFileSync(join(dirname(targetPath), "snapshot-integrity.key")),
  );
  const repositories = createRepositories(target, { snapshotIntegrityKey });

  function legacyRows(
    sql: string,
    parameters: Array<number | string> = [],
  ): LegacyRow[] {
    const statement = legacy.prepare(sql);
    try {
      statement.bind(parameters);
      const rows: LegacyRow[] = [];
      while (statement.step()) rows.push(statement.getAsObject() as LegacyRow);
      return rows;
    } finally {
      statement.free();
    }
  }

  function parsePayload(row: LegacyRow): Record<string, unknown> {
    if (typeof row.payload !== "string")
      throw new Error("legacy_payload_invalid");
    const value = JSON.parse(row.payload) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("legacy_payload_invalid");
    return value as Record<string, unknown>;
  }

  function text(value: unknown, field: string): string {
    if (typeof value !== "string" || value === "")
      throw new Error(`legacy_${field}_invalid`);
    return value;
  }

  function optionalNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;
  }

  const sourceVersion = legacyRows(
    "SELECT version FROM tavernnext_schema_version",
  )[0]?.version;
  if (sourceVersion !== 9)
    throw new Error(
      `legacy_schema_version_unsupported:${String(sourceVersion)}`,
    );
  const sourceConversations = legacyRows(
    "SELECT * FROM conversations ORDER BY created_at, id",
  );
  if (sourceConversations.length === 0)
    throw new Error("legacy_conversations_empty");

  const plans = sourceConversations.map((conversationRow) => {
    const conversation = parsePayload(conversationRow);
    const conversationId = text(conversation.id, "conversation_id");
    const characterId = text(conversation.characterId, "character_id");
    const personaId = text(conversation.personaId, "persona_id");
    const providerId = text(conversation.providerId, "provider_id");
    const presetId = text(conversation.presetId, "preset_id");
    const character = repositories.characters.get(characterId);
    const persona = repositories.personas.get(personaId);
    const provider = repositories.providerProfiles.get(providerId);
    const preset = repositories.presets.get(presetId);
    if (character === undefined)
      throw new Error(`character_missing:${characterId}`);
    if (persona === undefined) throw new Error(`persona_missing:${personaId}`);
    if (provider === undefined)
      throw new Error(`provider_missing:${providerId}`);
    if (preset === undefined) throw new Error(`preset_missing:${presetId}`);
    if (preset.kind !== "chat") throw new Error(`preset_not_chat:${presetId}`);

    const messages = legacyRows(
      "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, id",
      [conversationId],
    ).map((row) => ({ row, value: parsePayload(row) }));
    const messageIds = new Set(
      messages.map(({ value }) => text(value.id, "message_id")),
    );
    const variants = legacyRows(
      `
    SELECT v.* FROM message_variants v
    JOIN messages m ON m.id = v.message_id
    WHERE m.conversation_id = ?
    ORDER BY v.message_id, v.created_at, v.id
  `,
      [conversationId],
    ).map((row) => ({ row, value: parsePayload(row) }));
    for (const { value } of variants) {
      if (!messageIds.has(text(value.messageId, "variant_message_id")))
        throw new Error("variant_message_mismatch");
    }

    return {
      conversationId,
      characterId,
      personaId,
      providerId,
      preset,
      conversation,
      messages,
      variants,
    };
  });

  for (const plan of plans) {
    const existing = repositories.conversations.get(plan.conversationId);
    if (existing === undefined) continue;
    const messages = repositories.messages.listByConversationId(
      plan.conversationId,
    );
    const variants = repositories.messageVariants.listByConversationId(
      plan.conversationId,
    );
    if (
      messages.length !== plan.messages.length ||
      variants.length !== plan.variants.length
    ) {
      throw new Error(`target_conversation_conflict:${plan.conversationId}`);
    }
    console.log(
      JSON.stringify({
        mode: "already-recovered",
        conversationId: plan.conversationId,
        messages: messages.length,
        variants: variants.length,
      }),
    );
  }

  const pending = plans.filter(
    (plan) => repositories.conversations.get(plan.conversationId) === undefined,
  );
  console.log(
    JSON.stringify({
      mode: apply ? "apply" : "dry-run",
      conversations: pending.length,
      messages: pending.reduce((sum, plan) => sum + plan.messages.length, 0),
      variants: pending.reduce((sum, plan) => sum + plan.variants.length, 0),
    }),
  );

  if (apply && pending.length > 0) {
    target.transaction(() => {
      for (const plan of pending) {
        const value = plan.conversation;
        const worldbookIds = Array.isArray(value.worldbookIds)
          ? value.worldbookIds.map((id) => text(id, "worldbook_id"))
          : [];
        for (const worldbookId of worldbookIds) {
          if (repositories.worldbooks.get(worldbookId) === undefined)
            throw new Error(`worldbook_missing:${worldbookId}`);
        }
        repositories.conversations.create({
          id: plan.conversationId,
          characterId: plan.characterId,
          personaId: plan.personaId,
          title: text(value.title, "title"),
          worldbookIds,
          ...(optionalNumber(value.maxPromptTokens) === undefined
            ? {}
            : { maxPromptTokens: optionalNumber(value.maxPromptTokens) }),
          ...(optionalNumber(value.maxResponseTokens) === undefined
            ? {}
            : { maxResponseTokens: optionalNumber(value.maxResponseTokens) }),
          ...(typeof value.authorNote === "string"
            ? { authorNote: value.authorNote }
            : {}),
          ...(optionalNumber(value.authorNotePosition) === undefined
            ? {}
            : { authorNotePosition: optionalNumber(value.authorNotePosition) }),
          ...(optionalNumber(value.authorNoteDepth) === undefined
            ? {}
            : { authorNoteDepth: optionalNumber(value.authorNoteDepth) }),
          ...(optionalNumber(value.authorNoteRole) === undefined
            ? {}
            : { authorNoteRole: optionalNumber(value.authorNoteRole) }),
        });
        repositories.saveAgentConfigurations.create({
          id: randomUUID(),
          conversationId: plan.conversationId,
          sourcePresetId: plan.preset.id,
          sourcePresetRevision: plan.preset.revision,
          name: plan.preset.name,
          settings: plan.preset.settings,
        });

        for (const { value: message } of plan.messages) {
          repositories.messages.create({
            id: text(message.id, "message_id"),
            conversationId: plan.conversationId,
            role: text(message.role, "message_role") as
              "system" | "user" | "assistant",
            content: typeof message.content === "string" ? message.content : "",
            activeVariantId: null,
          });
        }
        for (const { value: variant } of plan.variants) {
          repositories.messageVariants.create({
            id: text(variant.id, "variant_id"),
            messageId: text(variant.messageId, "variant_message_id"),
            ordinal: optionalNumber(variant.ordinal) ?? 0,
            content: typeof variant.content === "string" ? variant.content : "",
            status: text(variant.status, "variant_status") as
              "streaming" | "completed" | "aborted" | "failed",
            ...(typeof variant.finishReason === "string"
              ? { finishReason: variant.finishReason }
              : {}),
            continuationBoundaries: Array.isArray(
              variant.continuationBoundaries,
            )
              ? variant.continuationBoundaries.filter(
                  (item): item is number => typeof item === "number",
                )
              : [],
          });
        }
        for (const { value: message } of plan.messages) {
          if (typeof message.activeVariantId !== "string") continue;
          const current = repositories.messages.get(
            text(message.id, "message_id"),
          );
          if (
            current === undefined ||
            repositories.messageVariants.get(message.activeVariantId) ===
              undefined
          ) {
            throw new Error("active_variant_missing");
          }
          const result = repositories.messages.update(
            current.id,
            current.revision,
            {
              activeVariantId: message.activeVariantId,
            },
          );
          if (!result.ok)
            throw new Error(`active_variant_update_${result.reason}`);
        }

        const global = repositories.globalGenerationConfig.get();
        const patch = {
          ...(global.providerId === null
            ? { providerId: plan.providerId }
            : {}),
          ...(global.chatPresetId === null
            ? { chatPresetId: plan.preset.id }
            : {}),
        };
        if (Object.keys(patch).length > 0) {
          const result = repositories.globalGenerationConfig.update(
            global.revision,
            patch,
          );
          if (!result.ok)
            throw new Error(`global_generation_config_${result.reason}`);
        }
      }
    });
  }

  for (const plan of plans) {
    const conversation = repositories.conversations.get(plan.conversationId);
    if (apply && conversation === undefined)
      throw new Error("recovered_conversation_missing");
    if (conversation === undefined) continue;
    const messages = repositories.messages.listByConversationId(
      plan.conversationId,
    );
    const variants = repositories.messageVariants.listByConversationId(
      plan.conversationId,
    );
    const configuration =
      repositories.saveAgentConfigurations.getByConversationId(
        plan.conversationId,
      );
    if (
      messages.length !== plan.messages.length ||
      variants.length !== plan.variants.length ||
      configuration === undefined
    ) {
      throw new Error("recovery_verification_failed");
    }
    console.log(
      JSON.stringify({
        mode: "verified",
        conversationId: plan.conversationId,
        messages: messages.length,
        variants: variants.length,
        activeVariants: messages.filter(
          (message) => message.activeVariantId !== null,
        ).length,
        saveAgentConfiguration: true,
      }),
    );
  }

  target.close();
  legacy.close();
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

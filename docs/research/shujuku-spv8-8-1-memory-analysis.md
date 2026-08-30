# `AlbusKen/shujuku` `spv8.8.1` 长期记忆机制分析

## 研究范围与结论

用户给出的脚本实际加载的是 `AlbusKen/shujuku` 的 `spv8.8.1` 构建产物。该 tag 对应提交 `f0d8c65`，发布页将其标为 `spv8.8.1`。本文只依据该 tag 的仓库源码、仓库内设计文档与发布信息，不依据第三方介绍。

结论先行：这套“数据库”最值得 TavernNext 借鉴的不是八张默认 RPG 表，也不是把世界书当数据库，而是以下设计组合：

1. 将“当前权威状态”和“历史纪要”分开；
2. 将纪要行视为权威源，向量、BM25 候选和世界书注入视为可重建派生物；
3. 用父纪要行、子 chunk、内容指纹和模型版本支持增量索引与失效；
4. 使用中文友好的 BM25 与向量检索并行召回，再用 RRF 融合，并允许外部 reranker 增强；
5. 在发送前对索引与实时纪要表做一致性检查，发现陈旧数据时拒绝继续使用旧索引；
6. 对外置索引采用不可变 revision、写后读校验、checksum、prepared/published 生命周期和可达性 GC。

不应直接移植的部分是：依赖 SillyTavern 消息自定义字段保存状态、用消息序号/聊天文本生成锚点、把召回结果覆盖进世界书常驻条目、让 LLM 维护权威表，以及缺少对 TavernNext `MessageVariant` / `SceneStateTransition` 分支身份的显式引用。

因此，TavernNext 应吸收它的“派生索引与混合检索”思想，但记忆的权威记录、分支一致性、原子提交和审计必须建立在 Save Agent、Scene State、Message Variant 与 Agent Run 之上。

## 1. 它实际上是什么

仓库默认模板包含全局状态、主角信息、重要角色、技能、背包、任务事件、纪要和选项八张表；这是一套由插件维护的结构化 RPG 状态，而不是单一长期记忆表。[默认表组装源码](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/shared/table-defaults/index.js#L1-L18)

其中存在两个不同语义层：

- “全局数据表”等表表达当前状态，例如当前位置、当前时间和上一场景时间。[全局状态表](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/shared/table-defaults/global-state.js#L3-L18)
- “纪要表”表达追加式事件历史，每轮插入一行，包含时间跨度、地点、较长纪要、短概要和稳定编码索引。[纪要表](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/shared/table-defaults/chronicle.js#L3-L29)

这种区分非常重要：当前状态回答“现在是什么”，纪要回答“过去发生过什么”。对 TavernNext 而言，前者已经由 Scene State 承担，后者才是长期记忆模块应补充的能力。

## 2. 数据模型

### 2.1 纪要行

默认纪要表的字段为：

| 字段 | 用途 |
| --- | --- |
| `row_id` | 行身份 |
| `time_span` | 事件发生时间 |
| `location` | 地点锚点 |
| `chronicle_text` | 详细事件纪要 |
| `summary` | 短概要 |
| `code_index` | `AMxxxx` 编码索引 |

默认指令要求每轮追加纪要，禁止更新和删除；详细纪要要求客观记录，概要限制为短句。[纪要表约束](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/shared/table-defaults/chronicle.js#L6-L19)

这值得借鉴的是“事件正文 + 短检索表示 + 时间/地点/稳定 ID”的分层，而不是其硬编码的列名或长度要求。

### 2.2 父行、子 chunk 与索引状态

`spv8.8.1` 的索引模型以纪要行为父对象，并为概要拆分子 chunk：

- chunk 保存 `chunkId`、`rowKey`、文本、向量、顺序、来源指纹和文本 hash；
- row 保存 `rowKey`、`rowId`、时间、地点、概要、编码索引、向量源文本和 `chunkIds`；
- row 状态支持 `active`、`removed`、`replaced`；
-索引状态保存快照消息 ID、来源表、行数、chunk 数、manifest 等。[索引类型](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/service/vector/summary-vector-index-types.ts#L25-L37) [行与状态类型](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/service/vector/summary-vector-index-types.ts#L93-L127)

`rowKey` 由来源表键、行 ID 和编码索引散列生成；来源指纹覆盖行 ID、时间、地点、概要、索引码和向量源文本，因此可以跳过未变化行，仅重建变更行。[归档行身份](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/service/vector/summary-vector-index-archive-service.ts#L270-L283)

### 2.3 消息级隔离与轻量 pointer

插件将表格、增量、向量索引轻量状态和 manifest 挂在 AI 消息的隔离标签槽中。新外置模式明确要求聊天消息不再保存完整 vector 数组，只保存定位和校验信息。[消息级模型](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/data/models/chat-message-data.ts#L14-L38)

这是一种适应 SillyTavern 宿主限制的方案。TavernNext 已有服务器 SQLite 和一等领域实体，不需要复制“自定义字段挂楼层”的存储方式。

## 3. 记忆写入、压缩和索引构建

### 3.1 写入源

默认模板要求每轮生成后追加纪要。纪要积累到阈值后，自动合并流程将普通纪要分批交给 LLM 压缩，保留一定数量近期行，并通过表格提交入口写回。[自动合并触发与批次](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/service/summary/merge-logic.ts#L27-L98) [合并写回](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/service/summary/merge-logic.ts#L245-L308)

优点是上下文体积受到控制；缺点是压缩结果本身由 LLM 产生，而且合并行没有保存完整的来源消息/来源纪要 ID 集合。它适合作为派生 consolidation，不适合作为唯一审计事实。

### 3.2 概要分块和 embedding

当前实现按标点切句，再按配置的句数合并为 chunk；embedding 输入取“概要”而不是整篇详细纪要。每个 chunk 反向关联父行，命中后可恢复父级字段。[分块函数](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/service/vector/summary-vector-index-archive-service.ts#L305-L320) [构建 embedding](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/service/vector/summary-vector-index-archive-service.ts#L531-L590)

仓库内重构计划给出的理由合理：短概要更适合检索，时间和地点可作为语义锚点，命中后再回卷父纪要可同时兼顾召回粒度与可读性。[重构计划](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/plans/vector_memory_worldbook_rearchitecture_plan.md#L101-L131)

### 3.3 增量同步与删除

归档支持 `append` 和 `sync`。`sync` 模式会移除当前权威纪要表中已不存在的父行及其 chunk，检测到指纹变化则标记替换；无新增、变更或删除时跳过重复 embedding 和快照上传。[同步合并](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/service/vector/summary-vector-index-archive-service.ts#L685-L727) [增量判定](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/service/vector/summary-vector-index-archive-service.ts#L1247-L1267)

这套“权威源 diff → 派生索引增量更新”的关系非常适合 TavernNext。

## 4. 持久化与恢复

### 4.1 不可变 V2 单文件快照

`spv8.8.1` 的当前安全路径会创建带随机 `writeGeneration` 和递增 revision 的不可变外置快照。manifest 记录 chat、isolation、source table、embedding 模型、维度、活动/删除/替换行以及父索引身份。[V2 identity 与 manifest](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/service/vector/summary-vector-index-storage-service.ts#L1501-L1566)

上传后立即读回，校验协议身份与 SHA-256 checksum；失败则回滚上传对象。成功对象先登记为 `prepared`，只有聊天 pointer 严格保存后才完成发布。[写后校验与 prepared](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/service/vector/summary-vector-index-storage-service.ts#L1586-L1659) [pointer 保存与发布](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/service/vector/summary-vector-index-archive-service.ts#L800-L839)

这是该项目最值得借鉴的工程部分：索引更新不是“先写一个 JSON 然后祈祷”，而是有 revision、不可变对象、读回校验、发布状态和失败补偿。

### 4.2 可达性 GC 与自愈

安全 GC 会从当前聊天 pointer 计算可达对象；对旧格式、身份不完整、仍处于发布中或无法验证 scope 的文件选择保留/隔离，而不是猜测删除。删除 V2 对象前还会验证物理路径、blob 内 scope、revision 和 write generation。[安全 GC](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/service/vector/summary-vector-index-storage-service.ts#L793-L896)

读取时如果 pointer 指向的文件缺失或身份不一致，运行时会尝试选择相同 canonical scope、revision 不回退且身份完整的磁盘快照；无法安全对齐则清除失效 pointer，要求 UI 重建，不盲目继续召回。[运行时对齐](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/service/vector/summary-vector-index-runtime.ts#L323-L393) [严格 scope 校验](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/service/vector/summary-vector-index-runtime.ts#L420-L483)

TavernNext 不需要照搬 ST 文件存储，但应保留同等级别的索引版本、模型版本、校验和、构建状态与可重建策略。

## 5. 召回、关键词、向量与排序

发送前流程如下：

1. 从最近若干对话与当前用户输入生成可选关键词；失败时允许返回空关键词；
2. 将用户输入和关键词拼成 query，生成 query embedding；
3. 最近 N 条纪要固定入选；较早纪要参与检索；
4. dense 通道计算 cosine similarity 并按阈值和候选上限截断；
5. sparse 通道执行 BM25；
6. 使用 RRF 合并 dense 与 sparse 排名；
7. 可选调用外部 reranker；失败则回退原排序；
8. 父行去重，取 TopK，与固定近期行合并，最后恢复原事件顺序。

关键词生成会读取最近对话，解析 `<keywords>` 或兼容的“关键词：”输出，最多保留 24 个词。[关键词生成](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/service/vector/summary-vector-index-runtime.ts#L81-L157)

BM25 对中文连续片段同时生成单字和二元组，对英文/数字使用普通 token；随后采用标准 BM25 参数 `k1=1.5`、`b=0.75`。[中文 BM25](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/service/vector/summary-vector-hybrid-retrieval.ts#L23-L46) [BM25 评分](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/service/vector/summary-vector-hybrid-retrieval.ts#L69-L95)

RRF 按各通道排名累加 `1 / (k + rank)`，避免直接比较不可同尺度的 cosine 与 BM25 原始分数。[RRF](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/service/vector/summary-vector-hybrid-retrieval.ts#L96-L121)

运行时实现明确组合 dense、BM25、RRF、可选 rerank、最近固定注入和父行去重。[发送前召回主链](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/service/vector/summary-vector-index-runtime.ts#L669-L753)

对 TavernNext 最有价值的是：

- 不只依赖 embedding；中文专名、地点和编码可由 sparse 通道保底；
- 不直接混加异构分数，而使用 RRF；
- 最近记忆与相关记忆分开分配名额；
- LLM 关键词改写和 reranker 都是增强项，失败不应阻断主生成。

## 6. 提示词注入

召回结果被格式化为包含时间、地点、概要和编码索引的 Markdown 表，然后覆盖一个固定的世界书 constant 条目。该条目设置高 order 与 `prevent_recursion`。[注入内容](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/service/vector/summary-vector-index-runtime.ts#L217-L237) [世界书 upsert](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/service/vector/summary-vector-index-runtime.ts#L239-L262)

这种做法适应 SillyTavern 的世界书提示词管线，但不应移植到 TavernNext：

- TavernNext 已有固定 prompt precedence；召回记忆应成为平台拥有的 `SAVE MEMORY` 层或可审计工具结果；
- 覆盖世界书条目会把“作者规则”和“派生历史证据”混在同一机制中；
- 世界书条目只保存最终文本，不能天然复现当时的 query、候选、分数、索引 revision 与模型版本；
- Agent Run 应记录实际注入的 memory ID/revision、检索算法版本、各通道排名与最终文本。

## 7. 分支、Swipe、消息编辑和删除一致性

该实现具备一定的宿主内防陈旧能力：

- 索引层从当前聊天数组中的现存 AI 消息枚举；删除/截断消息后，该消息携带的层自然不再可达；
- 当前 isolation key 单独聚合；
- 后续层可通过 `removed` 状态覆盖较早行；
- 发送前用当前纪要表重新构建行身份并比较来源指纹；行缺失或内容变化时停止使用旧快照，要求重建。[消息层聚合](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/service/vector/summary-vector-index-state-service.ts#L153-L206) [实时表对账](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/service/vector/summary-vector-index-runtime.ts#L265-L301) [陈旧索引拒绝](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/service/vector/summary-vector-index-runtime.ts#L655-L660)

但它不满足 TavernNext 的分支不变量：

- row/chunk 没有 `sourceVariantId`、`sourceTransitionId` 或分支父 ID；
- snapshot anchor 优先使用消息 ID/日期，否则退化为“消息序号 + 角色 + 前 2048 字文本”的 hash；这不是 Message Variant 身份。[消息锚点](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/service/vector/remote-memory-snapshot-anchor.ts#L20-L46)
- 用户 Swipe 到同一消息的另一个 variant 时，如果宿主仍保留相同自定义字段或纪要行未同步改变，旧记忆不一定能被精确识别为失效；
- 编辑正文与编辑纪要表之间没有强制原子关联；
- 聚合依赖线性聊天数组，没有 TavernNext 的 Scene State transition DAG。

TavernNext 必须让每条 episodic memory 显式引用产生它的 `MessageVariant`、`SceneStateTransition` 和 `AgentRun`。切换 variant、删除消息或回退分支时，记忆可见性应沿同一分支规则计算，不能靠文本 hash 猜测。

## 8. UI、配置、迁移和导入导出

Vector Index 页面提供：构建、非破坏迁移、清缓存、删除索引，以及关键词 API、最近上下文、embedding、rerank、TopK、最低分、候选上限、固定近期行、分块句数、V2 写入闸门和 scope allowlist。[索引维护 UI](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/presentation-v2/pages/VectorIndexPage.vue#L26-L105) [API 与 rerank UI](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/presentation-v2/pages/VectorIndexPage.vue#L109-L185) [高级召回配置](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/presentation-v2/pages/VectorIndexPage.vue#L213-L365)

表格 Checkpoint 可在聊天间迁移表格、模板快照和 Sheet Guide，但恢复后会清理向量 manifest，再由系统重新生成派生物；文档还区分核心数据保存成功与派生刷新警告。[Checkpoint 导入导出](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/docs/table-checkpoint-import-export.md#L1-L21)

这给 TavernNext 两个直接启示：

1. Save 导出应包含长期记忆的权威记录与来源关系；embedding/BM25 索引可以省略并在导入后重建；
2. UI 应把“记忆数据完整性”和“索引健康”分开显示，支持重建、迁移、删除派生索引和查看最后错误，而不是把索引失败显示成 Save 损坏。

## 9. 与 TavernNext 当前架构的映射

TavernNext 已将一个 Save 定义为独立 Conversation、消息、Variants 与 Scene State；Save Agent 的持久身份还包括 Agent Run 审计。成功 Agent Run 原子提交 Roleplay Document、Variant、Scene State transition、Worldbook timed state和审计，失败则保持原状态不变。[TavernNext 上下文](../../CONTEXT.md) [Agent Runtime ADR](../adr/0007-agent-first-save-runtime.md)

建议映射如下：

| `shujuku` 概念 | TavernNext 对应物 | 处理方式 |
| --- | --- | --- |
| 全局/人物/物品/任务当前表 | Scene State | 不复制；继续以 Scene State 为权威 |
| 纪要表父行 | Save Memory / episodic memory | 新增平台实体，按 Save 隔离 |
| 概要 chunk | Memory Chunk | 派生、可重建、记录 hash 与模型版本 |
| chat + isolation scope | `conversationId` + Scene/Save 身份 | 使用一等外键，不拼字符串命名空间 |
| 消息楼层 pointer | `sourceVariantId` / `sourceTransitionId` / `agentRunId` | 使用显式来源关系 |
| manifest revision | Memory Index Revision | 保留版本、构建状态和校验信息 |
| 世界书 constant 注入 | Save Agent memory 层 / `memory_query` | 由平台控制并写入 Agent Run 审计 |
| Checkpoint 导出 | Save recovery/export | 导出权威记忆，索引按版本选择重建 |

## 10. 推荐 TavernNext 采用的实现

### 10.1 权威记忆表

建议建立 `save_memories`，至少包含：

```ts
interface SaveMemory {
  id: string;
  conversationId: string;
  kind: 'episode' | 'fact' | 'relationship' | 'intention';
  detail: string;
  summary: string;
  entities: string[];
  occurredAtTurn: number;
  salience: number;
  sourceMessageId: string;
  sourceVariantId: string;
  sourceTransitionId: string | null;
  sourceAgentRunId: string;
  status: 'active' | 'superseded' | 'invalidated';
  supersedesId: string | null;
  contentHash: string;
  revision: number;
}
```

Scene State 始终高于记忆；记忆是历史证据，不能覆盖当前权威状态。

### 10.2 原子写入与异步索引

Agent Run 成功提交事务中同时创建 episodic memory 或至少创建可确定重放的 memory-source record。失败、取消、空正文和 revision conflict 不产生记忆。若使用额外 LLM 做摘要，可在提交后异步执行，但必须：

- 保留原始来源；
- 以 `sourceVariantId + sourceRevision` 做幂等键；
- 只更新派生摘要/索引状态；
- 分支失效后丢弃迟到结果。

### 10.3 检索

第一阶段建议直接采用 `shujuku` 已证明合理的形状，但落在服务器端：

1. SQLite FTS5/BM25 召回中文专名与精确短语；
2. 可选 embedding dense 召回；
3. 用 RRF 融合，不直接相加原始分数；
4. 预留 2–3 条最近记忆，其余从相关性 TopK 选择；
5. 父 memory 去重后按剧情时间恢复展示顺序；
6. 可选 reranker 失败时回退；
7. 后续再加实体重合、salience、时间衰减与 MMR 去重。

LLM 关键词改写应是可选增强，不能成为首轮召回的门槛。

### 10.4 注入与工具

同时提供：

- 自动注入：少量高置信、预算受控的 Save Memory；
- `memory_query`：Agent 可按 query、kind、实体和数量主动查询；
- Agent Run 审计：记录 query 摘要、memory ID/revision、dense/BM25/RRF/rerank 分数、索引 revision、embedding 模型和实际注入文本。

提示词应明确：召回记忆可能过时，不能覆盖 Scene State、World Rules 或更新的消息。

### 10.5 压缩与导入导出

consolidation 可以将多个 episode 合并为关系、事实和长期意图，但合并记忆必须保存 `sourceMemoryIds`；不得像单纯 LLM 合并表那样丢掉来源。导出 Save 时包含 memory 和来源图；embedding 可默认不导出，导入后按模型/算法版本重建。

## 11. 采用优先级

推荐顺序：

1. 先实现 `save_memories`、来源外键、分支可见性和 Agent Run 原子写入；
2. 实现 FTS5/BM25、固定近期记忆、预算和审计；
3. 增加 `memory_query` 与平台提示词层；
4. 再加 chunk/embedding/RRF 与索引 revision；
5. 最后增加 reranker、LLM consolidation、维护 UI 和导入导出优化。

不要先复制世界书注入或前端消息字段存储。`shujuku` 的真正经验恰恰是：索引必须是有身份、可校验、可失效、可重建的派生物；TavernNext 已具备更强的一等领域模型，应在此基础上实现，而不是退回宿主脚本式状态管理。

## 一手来源索引

- [`spv8.8.1` 发布页](https://github.com/AlbusKen/shujuku/releases/tag/spv8.8.1)
- [向量记忆重构计划](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/plans/vector_memory_worldbook_rearchitecture_plan.md)
- [远程记忆/向量再架构计划](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/plans/remote_memory_vector_rearchitecture_plan.md)
- [向量索引数据类型](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/service/vector/summary-vector-index-types.ts)
- [归档与 embedding 构建](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/service/vector/summary-vector-index-archive-service.ts)
- [发送前召回运行时](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/service/vector/summary-vector-index-runtime.ts)
- [BM25 与 RRF](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/service/vector/summary-vector-hybrid-retrieval.ts)
- [V2 外置快照持久化](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/service/vector/summary-vector-index-storage-service.ts)
- [消息级索引状态](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/data/models/chat-message-data.ts)
- [默认纪要表](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/shared/table-defaults/chronicle.js)
- [索引维护 UI](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/src/presentation-v2/pages/VectorIndexPage.vue)
- [表格 Checkpoint 导入导出](https://github.com/AlbusKen/shujuku/blob/spv8.8.1/docs/table-checkpoint-import-export.md)

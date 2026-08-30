# Pi Agent 框架调研

> 调研日期：2026-08-26。本文的“事实”仅取自 Pi 官方站点、官方仓库/API 与 npm registry；“判断”是面向 TavernNext 的工程分析。

## 结论摘要

**事实。**这里的 Pi 指 **Pi Coding Agent / Pi agent toolkit**，不是 Inflection 的 Pi 聊天产品。它目前由 Earendil Works 维护，官方仓库已从 `badlogic/pi-mono` 迁为 [`earendil-works/pi`](https://github.com/earendil-works/pi)，定位是“统一 LLM API、agent loop、TUI、coding-agent CLI”的 TypeScript 工具箱，而不只是一个终端应用。[官网](https://pi.dev/)与[仓库 API](https://api.github.com/repos/earendil-works/pi)相互指向；旧 `@mariozechner/*` 包已在 npm 标记弃用并要求迁往 `@earendil-works/*`（例：[旧 agent-core 元数据](https://registry.npmjs.org/@mariozechner%2Fpi-agent-core/latest)）。

**判断。**Pi 值得作为 TavernNext 的**可选 Agent Runtime**做 PoC，但不应替换现有 Provider/Prompt Engine。最有价值的是 agent loop、流式事件、tool 调用和可嵌入 SDK；最需防范的是默认文件/命令工具的高权限、0.x 快速演进，以及 Pi 的会话/压缩语义与 TavernNext Save/Message Variant 语义冲突。

## 产品范围与分层

**事实。**仓库是 monorepo，当前含 `ai`、`agent`、`coding-agent`、`tui`、`protocol`、`client`、`server`、`session-backends`、`telemetry`、`evals` 等包（[官方 packages 目录](https://github.com/earendil-works/pi/tree/main/packages)）：

- `@earendil-works/pi-ai`：统一模型 API、模型目录、provider/OAuth；npm 描述为 unified LLM API（[元数据](https://registry.npmjs.org/@earendil-works%2Fpi-ai/latest)）。
- `@earendil-works/pi-agent-core`：通用状态化 agent 与 transport 抽象，核心源码集中在 [`agent-loop.ts`](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts)、[`agent.ts`](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent.ts) 和 [`types.ts`](https://github.com/earendil-works/pi/blob/main/packages/agent/src/types.ts)。
- `@earendil-works/pi-coding-agent`：把核心组装成 `pi` CLI，提供 read/bash/edit/write、会话、扩展、skills 和 SDK；npm 暴露主模块、`./client`、`./rpc-entry`（[元数据](https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent/latest)）。

**事实。**agent loop 以“请求模型 → 流式产生 assistant message → 若有 tool call 则执行并追加 tool result → 再请求模型，直到无 tool call”为主循环；运行期间发出 agent、turn、message、tool execution 的 start/update/end 事件，宿主可订阅并投影 UI；消息进入模型前还有 context/message 转换边界（[核心源码](https://github.com/earendil-works/pi/tree/main/packages/agent/src)）。这比“只封装一次 completion”多了可观察的执行状态，但业务语义仍由宿主工具定义。

## 模型、上下文与扩展机制

**事实。**Pi AI 提供 Anthropic、OpenAI、Google、Bedrock 等 provider 适配及自定义模型/provider 接口，实际可用目录以[官方模型页](https://pi.dev/models)和[Provider 文档](https://pi.dev/docs/latest/providers)为准。模型可在会话中切换，但不同模型对消息、thinking、tool schema 的支持并不等价；自定义 OpenAI-compatible 端点见[自定义 Provider 文档](https://pi.dev/docs/latest/custom-provider)。

**事实。**coding-agent 会话以追加式记录保存，并可从树上分支、恢复路径；当前上下文由选中分支重建，格式见[Sessions](https://pi.dev/docs/latest/sessions)与[Session format](https://pi.dev/docs/latest/session-format)。接近上下文窗口时可自动或手动 compaction：总结较早历史、保留近期消息并继续，而原始记录仍在会话文件中（[Compaction](https://pi.dev/docs/latest/compaction)）。这是一种模型上下文策略，不是业务数据压缩或事务日志。

**事实。**扩展可注册工具、命令、快捷键、事件处理器、UI 与 provider；skills 是按约定发现的 `SKILL.md` 指令资源；Pi packages 可把 extensions、skills、prompt templates、themes 组合为 npm/Git/local 可安装单元（[Extensions](https://pi.dev/docs/latest/extensions)、[Skills](https://pi.dev/docs/latest/skills)、[Packages](https://pi.dev/docs/latest/packages)）。Pi 核心刻意不内置 MCP、sub-agent、plan mode、todo 或权限弹窗，官方建议用 CLI/README、tmux、扩展或容器按需搭建（[官网设计取舍](https://pi.dev/)）。这使它比约定了 durable graph/HITL 的 [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/overview) 或内置 handoff/guardrail/tracing 的 [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/) 更像可塑的 agent harness，而非完整工作流平台。

## 安装与接入

**事实。**当前 npm 最新版为 `0.84.3`，要求 Node `>=22.19.0`（[coding-agent 元数据](https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent/latest)）。最小交互使用：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi
# 首次进入后使用 /login，或预设对应 Provider API key
```

官方也提供 `curl -fsSL https://pi.dev/install.sh | sh`（[Quickstart](https://pi.dev/docs/latest/quickstart)）。程序化接入有三层：进程内 [`createAgentSession` SDK](https://pi.dev/docs/latest/sdk)；长期子进程的 [RPC mode](https://pi.dev/docs/latest/rpc)；适合管道/日志的 [JSON event stream](https://pi.dev/docs/latest/json)。前两者适合产品集成，CLI 文本输出不应成为稳定协议。

## 安全、成熟度与限制

**事实。**Pi 默认没有逐次权限确认；coding-agent 的 bash/read/write/edit 直接作用于宿主环境，扩展与第三方 package 也属于本地可执行代码。官方安全建议是可信项目运行、审查扩展并在需要时容器化（[Security](https://pi.dev/docs/latest/security)、[Containerization](https://pi.dev/docs/latest/containerization)）。因此“可拦截 tool 事件”不能替代 OS/进程隔离。

**事实。**截至调研日，GitHub API 显示仓库未归档、MIT、仍在当日推送（[实时元数据](https://api.github.com/repos/earendil-works/pi)）；npm 包有 provenance attestations，但版本仍为 0.x，且刚完成组织名/包名迁移。**判断。**项目活跃、源码和文档覆盖面好，适合试验与可控嵌入；但 API 稳定性、迁移成本、第三方 package 信任和跨 provider 行为差异仍应视为生产风险。Pi 不内置 durable workflow、业务状态一致性、多人审批或安全沙箱，这些需宿主承担。

## 对 TavernNext 的适配建议

**判断。**采用“现有生成链不动，新增窄腰 `AgentRuntime`”方案：

1. 首个版本只接 `@earendil-works/pi-agent-core`（必要时配 `pi-ai`），不要嵌入 coding-agent 默认文件/命令工具。只暴露 `read_scene_state`、`query_worldbook`、`propose_scene_patch`、`request_generation` 等白名单领域工具；写操作仍走 TavernNext 的校验、事务与 Trust Grant。
2. 保留当前 Chat Completion 与 Text Completion 双路径。Pi AI/agent loop 的主要价值依赖结构化 tool call，不能覆盖无 tool-call 的 Text Completion；因此它是可选 Agent Runtime，不是 `provider-openai-compatible` 或 `prompt-engine` 的替代品。
3. TavernNext 的 Save、Message、Variant、Scene State 继续是唯一事实源；Pi session ID/事件只作一次 agent run 的执行记录和 UI 投影，不能把 Pi JSONL 当数据库。模型调用仍固化 Global Generation Configuration 与 prompt snapshot。
4. 默认关闭 Pi 自动 compaction，先由 TavernNext 现有预算/提示词编译决定上下文；若以后启用，必须把 summary 作为有来源、可审计的派生消息，避免与 Worldbook、variant 回溯及 Scene State 快照“双重压缩”。
5. 生产形态优先独立 Worker/子进程 + RPC、超时/取消、输出大小限制和每工具 capability token；进程内 SDK 仅用于无副作用 PoC。现有 Scene server module 的 Worker 隔离也不是安全边界，因此不要复用“可信 Scene”来默认授权 agent 的 bash/文件系统。

## 建议验证型 PoC（1–2 天）

建立一个不落库的 server-only 实验入口：固定单一支持 tool call 的模型，向 Pi loop 注入两只只读工具和一只“返回 Patch 提案但不提交”的写工具；把 message/tool 事件转成 SSE 推给调试页。验收门槛：① 多轮 tool loop、取消和 provider 错误可复现；② prompt snapshot 与现有直连生成逐字段可比；③ agent 无法访问任意文件/命令/网络；④ 同一 run 可重放，token/费用可计量；⑤ Text Completion 仍走原链路。通过后再决定是否建立正式 `AgentRun`/`AgentEvent` 表和提交 Patch 的人工确认流；未通过则只吸收 Pi 的事件/工具接口思想，不引入依赖。

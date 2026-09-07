# Aelios 记忆网关（开发分支）

Aelios 负责身份、临时召回和自动记录，客户端 Harness 负责工具循环。
上游只有一个:Cloudflare AI Gateway(BYOK 走 gateway 面,REST 只花 Unified 额度),一把 CF token 管所有,无需 LiteLLM。

## 分工

| 组件 | 工作 |
| --- | --- |
| Worker | 原生协议入口、身份解析、主模型记忆追加、流式字节透传 |
| CF AI Gateway | Provider 识别(`author/model`)、BYOK 计费、限流、日志 |
| CF Dynamic Routes | 预算、路由与 fallback（在 CF 侧配置，本网关不实现） |
| Workers AI | embedding、reranker、默认 Dream 模型 |
| Vectorize | 按 namespace 检索长期记忆 |
| D1 | 配置、原始可见对话、记忆、去重记录 |
| Queue | 异步记录，失败重试，重复投递幂等 |
| Cron | 对各记录身份的 namespace 运行 Dream、日记与留存清理 |

本轮没有引入 Agents SDK / 自建 loop，也不做三协议之间的转换。
每个协议通过下文的 BYOK 路由访问 CF 对应端点；不再使用消耗 Unified 额度的 REST `/ai/v1` 地址转发聊天。
模型名原样透传，厂商识别交给 CF 的 `author/model` 命名；选错厂商由 CF 报错。

## 配置模型

配置只有三层，全部在 `/admin/gateway` 页面完成：

1. **连接**：CF 账号 ID（或完整地址）。token 不放面板，放 Worker Secret `CLOUDFLARE_API_TOKEN`。
2. **助手**：每位三格——名字（slug，即 URL 路径段）、主模型列表、可用钥匙。
   写入空间 `namespace` 默认同名；可另设 `readNamespaces` 召回空间列表。
3. **环境设置**：`settings` 白名单里的运行参数，面板直接改，覆盖部署默认值。

主模型白名单是唯一的记忆开关：**只有主模型的对话召回记忆、进入 Dream；其余模型安静透传**。
匹配容忍 `author/` 前缀，支持 `*` 通配（如 `*fable*` 同时认 `claude-fable-5-1` 和 `anthropic/claude-fable-5-1`）。
这样 Claude Code 的 haiku 小模型、Codex 的杂务模型天然不沾记忆，不需要维护黑名单。

配置优先级：D1 保存的配置 > Worker `GATEWAY_CONFIG` JSON 变量 > 空配置。
空配置的模型列表为空，聊天请求返回配置提示。
`GET /v1/models` 透传上游模型目录：CF 账号走 AI Gateway 的 compat 目录（`gateway.ai.cloudflare.com/v1/{账号}/{网关}/compat/models`，REST 无 GET /models），自定义地址走 `{base}/models`；上游答不上或无 CF token 时回落为主模型白名单提示。

聊天协议路由:chat 走 `…/{网关}/compat/chat/completions`(全 provider,BYOK);带 `provider/` 前缀的 messages / responses 走各 provider 原生端点。本 fork：`CLAUDE_OAUTH_TOKEN` 存在时，无前缀 `/v1/messages` 直打 `api.anthropic.com`；`CODEX_REFRESH_TOKEN` 存在时，无前缀 `/v1/responses` 直打 `chatgpt.com/backend-api/codex`。两路都不进 AI Gateway。无 token 的无前缀模型名仍 400。
管理配置允许 `CHATBOX_API_KEY` / `DEBUG_API_KEY`。旧 MCP 与记忆管理权限不变。

## 首次配置

1. 使用 `feat/memory-gateway` 分支，运行 `npm ci`。测试需要 Node.js 22+。
2. 按原部署流程创建 D1、Vectorize 和 Queue，应用全部 migrations，包含 `0012_memory_gateway.sql`。
3. Worker Secrets 只放两把钥匙：`CHATBOX_API_KEY`（自己编的，进面板用）和 `CLOUDFLARE_API_TOKEN`
   （使用现有 AI Gateway token 权限配置；第三方 Provider 密钥在 CF BYOK 面板管理）。
4. 打开 `/admin/gateway`，填 CF 账号 ID，添加助手（比如 `coder`），保存。
5. 客户端按助手接入：

| 客户端 | 配置 |
| --- | --- |
| Chatbox 等 OpenAI 兼容 | base URL `https://<host>/coder/v1`，填 `CHATBOX_API_KEY` |
| Claude Code | `ANTHROPIC_BASE_URL=https://<host>/coder`，token 同上 |
| Codex | `base_url = "https://<host>/coder/v1"`，`wire_api = "responses"` |

不带助手名的 `/v1/...` 走该钥匙的第一个助手，方便只配一个的时候用。
轮询和多 key 池需要时自行部署 new-api 之类的上游，把它的地址填进「连接」即可——配置模型不变。

## 临时记忆生命周期

| 入口 | 新输入 | 工具续轮 |
| --- | --- | --- |
| `/v1/chat/completions` | 最后一项 user | role=tool 不召回 |
| `/v1/messages` | 最后一项 user，非纯 tool_result | tool_result 内部文字不是用户原话 |
| `/v1/responses` | 字符串 input 或最后一项 user message | function_call_output 等输出不召回 |

纯图片仍原样转发，没有文本 query 时不召回。tool_result 旁有独立 text 块时，按新的用户指令处理。
相关珍贵原文和召回结果作为一段简短的 markdown 参考追加到当前消息末尾。默认最多 2 条、每条最多 240 字；提示词里只放正文，不放 memory id、消息 id、信封哈希或内部类型。显式 `memory_search` / `memory_recall` / REST 搜索返回完整记录和 ID，删除、修改、溯源走这条路，不套自动注入的条数预算。原有 system、工具、历史块和 cache_control 不变。
工具续轮不搜索、不恢复旧补丁；下一个人类输入重新召回。没有补丁缓存；请求重试可能再次搜索，但写入按指纹去重。

召回不再整包倾倒珍贵记忆，也不再用末轮短句单独打向量。短句（「那个呢」「继续」）会带上最近几轮用户原文再检索；向量和 D1 词面并行，RRF 合并（LMC-5 / Hindsight 的混合通道）。只有和当前问题词面重叠的珍贵才会进入补丁。
原话引用只在证据类问题（暗号、原话、说过、哪天）打开，作为精选记忆的补充引文；普通闲聊不扫 `messages`。记忆或珍贵原文已经覆盖同一句话时，丢掉原话、留下记录。仍出现在本次请求历史里的原话也不参与召回（双方都看得见，召回不增加信息）；上下文压缩把它丢掉后，它自动恢复可召回。规则按内容判，不用时间窗。
客户端消息若带 `<message from="…" msg_id="…">正文</message>` 或 `<wecom-message …>` 一类传输信封，只保存和检索正文；哈希、msg_id 不进召回词。客户端注入的 `<recap>`、`<system-reminder>` 以及「User stepped away; returning. Recap:」这类一看就不是用户发言的整段直接丢掉：不当成人类轮、不入库、不召回。普通散文里写 `<message>` 或「帮我写个 recap」不受影响。旧数据无需先迁移，召回和夜间整理读取时也会清洗。相同会话中，最高分命中只和它时间上直接相邻、且间隔不超过 90 秒的句子合成一个事件；不会顺着 90 秒窗口把整段连续对话收成一条。源消息 ID 仍保留在内部 trace。

如果第一响应只调用工具，后续最终回复可能不再看到记忆。“阅后即焚”不表示清除已经产生的模型影响、加密推理或上游日志。

### 共享和迁移空间

旧 v3 配置无需迁移数据库：`namespace` 继续表示唯一写入空间，省略时使用 slug。
`readNamespaces` 省略时只读写入空间；显式数组表示**完整召回名单**，不自动补上写入空间；`[]` 表示只记录、不召回。
最多 8 个唯一空间，只能在管理配置中设置，请求体、请求头都不能覆盖。

```json
{
  "slug": "coder",
  "keys": ["CHATBOX_API_KEY"],
  "models": ["*opus*", "*sonnet*"],
  "namespace": "coder",
  "readNamespaces": ["coder", "coder-old", "shared-docs"]
}
```

多个助手可以读同一空间，也可写同一空间。迁移时让新对话写新空间，召回保留旧空间；这里不搬移 D1 行或 Vectorize 索引。
每个空间独立检索，同类候选轮流合并、同类型同内容去重，最后统一执行一次条数/字数预算。
一个空间失败仍可用其他空间，全部失败报告召回不可用；trace 列出失败空间。
注入计数回写条目所属空间，`recall_explain` 存在写入空间，记录每条来源空间。
授权某助手读取共享空间，意味着该助手的所有可用钥匙都可召回其内容。
Cron 继续维护配置的写入空间，避免只读共享关系无意触发另一个空间的 Dream。

### Anthropic thinking

- `passthrough`（默认）：不修改 thinking，记忆照常注入。召回片段只追加在最后一轮 user 消息尾部，
  不改历史块。实测 Vertex 线路默认不校验 thinking 的前缀绑定(补丁下轮消失,旧签名块仍 200),
  只有客户端显式携带 `block_binding` 时前缀才进入签名范围。
- `drop_block`：在每次请求（含工具续轮）合并 `thinking.block_binding.prefix_mismatch_behavior: "drop_block"`，
  以及 `thinking-binding-controls-2026-08-01` beta header。仅适用于支持该 beta 的线路，会牺牲部分思考连续性。
- 显式 `thinking.type: "disabled"`：直接临时注入，不添加该 beta。
- 注意:`drop_block` 依赖上游认识 `block_binding` 字段;Vertex 线路会直接 400 `unrecognizedProperty`,勿用于 Vertex。
- 非主模型不自动启用 thinking，不自动添加 binding 设置。

本地只能验证结构，不能验证厂商的加密签名。历史签名块、空 thinking 文本、redacted data 原样保留。
切换到 disabled 不会修复之前已经失配的历史；更换线路、压缩、修改工具或 system 造成的失配也由上游判断。
完整审计矩阵、协议白名单范围见 [请求契约与 thinking 边界](request-contract.md)。

### Responses 状态

主模型请求强制 `store:false`，要求完整显式历史；含 `previous_response_id`、`conversation`、
`item_reference` 时返回 400，避免服务端隐藏历史继续携带补丁。
非主模型不做此检查：纯透传，服务端状态原样通过，不召回也不记录。
`reasoning.encrypted_content` 原样通过，不能承诺加密推理里不含记忆影响。

本版支持 HTTP POST + SSE，没有实现 WebSocket、Responses GET/DELETE、后台任务轮询、`/responses/compact`、
Anthropic token counting。使用这些额外端点的客户端需要后续适配；还不能声称 Claude Code / Codex 全功能兼容。

## 自动记录与辅助请求

主模型对话的原始新用户文本和完整可见助手回复进入 messages 表，供 Dream 使用，无需 Hook。
只观察可见文本；thinking、工具返回文本不作为人类对话入库。Chat Completions 记录第一个 choice。
`gateway_exchanges` 保存操作状态、实际模型/Provider 和可见文本，不保存注入补丁。

- 同一请求重试、Queue 重复投递：稳定指纹 + D1 主键去重。
- 更长历史中再次说相同文字：视为新消息。
- 每个输入/输出记录最多 8000 字符，超限为 truncated，不把截断对话当作完整 Dream 来源。
- 中断、取消、失败：不完整助手输出不进入 Dream。
- 无 Queue 或发送失败：直接写 D1，最终错误记录日志。
- exchanges 与 messages 共用 `MESSAGES_RETENTION_DAYS`。

| 可选请求头 | 用途 |
| --- | --- |
| `x-aelios-session-id` | 区分会话；也读取 session_id、x-session-id、metadata.session_id |
| `x-aelios-request-id` | 区分内容相同但有意重新生成的请求 |
| `x-aelios-purpose: auxiliary` | 标题、压缩、内部任务：不召回，不进入 Dream |

没有 session ID 时，在身份与来源下按完整输入去重；两个全新会话若历史完全相同，会合并为一次输入。
无法可靠识别未标记的机器内部任务；把杂务模型留在主模型白名单之外即可。

持久化在响应结束后调度，不是在返回客户端前确认写入；运行时强制终止仍可能丢失末尾记录。

## Fallback 与缓存

重试、跨厂商 fallback、预算与限流全部交给 CF AI Gateway（动态路由在 CF 仪表盘配置）。
本网关一次调用一个上游，本地不做主备。
旧 assembler、缓存断点/滚动缓存已退出对外入口。新网关不重排前缀，也不添加 prompt cache 断点：
召回内容追加在对话末尾，各家自己的 prompt 缓存照常命中。
顶层 `cache_control` 是 Anthropic 已支持的自动缓存字段，但部分 Vertex/代理线路仍会拒绝。
为兼容现有线路，网关把它转换成注入前最后一个可缓存块上的显式断点；已有断点保留，TTL 冲突或超过 4 个提前返回 400。
没有顶层缓存设置就不主动添加断点。这个转换不等于保证所有上游支持同一套特性。
工具定义上的断点同理:实测 Vertex 线路拒绝工具级 cache_control(400 unrecognizedProperty),system/user 位置正常。
网关按「学习」处理:某条线路 400 报这个签名,剥掉工具断点重试一次,并在本 isolate 记住,之后请求预先剥除;
支持工具断点的线路永远学不到这条,不受影响。
为兼容现有线路，网关把它转换成注入前最后一个可缓存块上的显式断点；已有断点保留，TTL 冲突或超过 4 个提前返回 400。
没有顶层缓存设置就不主动添加断点。这个转换不等于保证所有上游支持同一套特性。
响应头 `x-aelios-identity/memory/provider/model` 用于诊断；实际模型与 Provider 优先读取 `cf-aig-model/provider`。
`x-aelios-normalized` 表示删除的非规范字段数量，Worker 日志列出字段路径，不记录被删除的值。

## 验证与下一步

```bash
npm ci
npm run verify
npx wrangler deploy --dry-run
```

网关测试调用生产 TS 模块和实际 SQLite migrations/SQL，只替换外部 HTTP 调用。
覆盖三协议、主模型白名单、临时召回、去重、身份隔离、辅助请求、SSE Unicode 分块、中断与 Queue 回退。
这是本地验证，不等于已经在真实 CF、Claude Code 或 Codex 中跑过端到端会话。

后续联调优先级：真实三协议线路 → Claude thinking beta 透传 → 客户端工具续轮 → 辅助请求识别 → 更多协议端点。
每完成一个可验证阶段即提交开发分支，不等整轮联调完成。main 不合并、不部署。

## 官方依据（2026-09-06 核对）

- [CF REST 三协议](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)
- [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)
- [CF Dynamic Routes](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/usage/)
- [Anthropic preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)

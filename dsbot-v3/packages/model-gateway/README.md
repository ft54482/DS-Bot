# `@dsbot/model-gateway` — L45 统一模型网关

给真实模型调用提供一个统一入口 `complete()`，底层两条后端：

| backend | 走什么 | 凭据 | 是否需要 API key |
|---|---|---|---|
| `direct_http` | OpenAI 兼容的 `POST {base}/chat/completions` | 注入的 `env`（不落盘、不打印） | 是 |
| `dsh_bridge` | 本机 MCP 桥 `http://127.0.0.1:17300/mcp`（Streamable HTTP，仅 POST） | `bridge.secret`（Bearer） | **否** |

包本身**不读文件、不读 `process.env`、不打开 socket**：`transport`（网络）与
`clock`（时间）全部注入。测试只用 fake transport，不联网，也不会读真实的
`~/.dsh/bridge.secret`。

## 快速开始

```js
import { readFile } from 'node:fs/promises';
import { createGateway, fetchTransport } from '@dsbot/model-gateway';

// 推荐：DS Bot / DSH 内优先走本机桥，无需模型 API key。
const secret = (await readFile(`${process.env.USERPROFILE}/.dsh/bridge.secret`, 'utf8')).trim();

const gateway = createGateway({
  kind: 'dsh_bridge',
  transport: fetchTransport(fetch),
  env: { DSH_BRIDGE_SECRET: secret },
  cwd: 'D:/work/some-workspace',
  reuseSession: true, // 同一实例内的后续 complete() 复用这个 DSH 会话
});

const result = await gateway.complete({
  prompt: '用一句话解释什么是网关',
  system: '你是一个简洁的助手',
  maxTokens: 256,
  timeoutMs: 60_000,
});
// {
//   text: '……',
//   usage: {},                       // 桥不提供逐次 token 用量时为空对象
//   backend: 'dsh_bridge',
//   latencyMs: 1834
// }
```

直连（有 API key 时）：

```js
const direct = createGateway({
  kind: 'direct_http',
  transport: fetchTransport(fetch),
  env: {
    DSBOT_MODEL_BASE_URL: 'https://api.deepseek.com/v1',
    DSBOT_MODEL_API_KEY: process.env.DSBOT_MODEL_API_KEY, // 只放环境变量，不写盘
    DSBOT_MODEL_NAME: 'deepseek-chat',
  },
});

const out = await direct.complete({ prompt: 'ping' });
```

## 契约

```js
createGateway({ kind, transport, clock, env, ...options })
  .complete({ prompt, system?, maxTokens?, timeoutMs? })
    -> Promise<{ text, usage: { inputTokens?, outputTokens? }, backend, latencyMs }>
```

- `kind`：`'direct_http'` | `'dsh_bridge'`，其他值构造时抛 `invalid_kind`。
- `transport`：**必填**，`transport({ url, method, headers, body, timeoutMs })`，
  返回 `Response` 或 `{ status, headers, body }`；`fetchTransport(fetch)` 是现成的
  `fetch` 适配器。
- `clock`：可选，`now()`，或 `{ now, setTimeout, clearTimeout, sleep }`。缺省用真实
  时钟；`latencyMs` 与退避都由它计算，测试可完全确定化。
- `env`：可选对象，缺省 `{}`。网关只从这里读凭据，**不兜底读 `process.env`**，
  调用方显式传 `process.env` 才会生效。
- `maxTokens`：正整数；直连时映射为 `max_tokens`，桥后端不传（由桥侧会话模型决定上限）。
- `timeoutMs`：正整数，上限 300 000。`direct_http` 缺省 60 000；`dsh_bridge`
  缺省 180 000（长任务轮询预算），也可用网关级 `timeoutMs` 或环境变量
  `DSBOT_BRIDGE_TIMEOUT_MS` 改默认值，`request.timeoutMs` 优先级最高。
- `reuseSession`：可选布尔值（仅 `dsh_bridge`），缺省 `false`。为 `true` 时同一个
  gateway 实例内的多次 `complete()` 复用同一个 DSH 会话；会话复用不等于并发安全，
  调用方仍应串行使用。
- 返回形状固定为四个字段；错误一律抛 `GatewayError`（`code` / `message` /
  `retryable` / `status`），不会把 key 放进 `message`、`text`、`toJSON()`。

### `direct_http`

启用条件：`DSBOT_MODEL_BASE_URL`、`DSBOT_MODEL_API_KEY`、`DSBOT_MODEL_NAME`
三者齐全（或对应地传 `baseUrl`、`apiKey`、`model` 选项，选项优先）。缺任何
一个都在发请求前失败，`code = missing_credentials`，`error.missing` 列出缺失
的**变量名**（不含值）。

- URL：`{baseUrl}/chat/completions`；`baseUrl` 已以 `/chat/completions` 结尾时原样使用。
- 请求头：`Authorization: Bearer <key>`、`Content-Type: application/json`。
- 响应：`choices[0].message.content`（也兼容数组分段与 `choices[0].text`）；
  用量取 `usage.prompt_tokens` / `usage.completion_tokens`（或 `input_tokens` /
  `output_tokens`）。

### `dsh_bridge`

启用条件：`bridgeSecret` 选项或 `DSH_BRIDGE_SECRET`（兼容
`DSBOT_BRIDGE_SECRET`）。网关**不自己读** `bridge.secret` 文件；由调用方读出后
注入（文件默认在 `%USERPROFILE%\.dsh\bridge.secret`）。缺 secret 时在发请求前
失败，`code = missing_credentials`。

MCP 调用顺序（每个 `complete()` 一次）：

```text
initialize                         (JSON-RPC POST /mcp, Bearer <bridge.secret>)
notifications/initialized          (通知)
tools/call dsh_create_session      { cwd, source, title, model?, preset? }
tools/call dsh_prompt              { sessionId, text, delivery: "queue" }
tools/call dsh_follow              (分片轮询：服务端 ≤30 s，客户端 slice+5 s；直到文本或 turn/end)
```

- `cwd`：`cwd` 选项或 `DSBOT_BRIDGE_CWD`，缺省当前工作目录（桥要求必须落在白名单内）。
- `source`：缺省 `dsbot-model-gateway`（桥限制 ≤64 字符，自动截断）。
- `bridgeUrl` 选项或 `DSBOT_BRIDGE_URL`，缺省 `http://127.0.0.1:17300/mcp`。
- `reuseSession: true`：同一个 gateway 实例只建一次会话，后续 `complete()` 复用该
  `sessionId`；`dsh_follow` 的 `sinceSeq` 会从上一轮结束处继续，不会重放上一轮。
  缺省为 `false`（每次 `complete()` 新建会话），保持原有行为。
- 桥的 `dsh_prompt` 只返回 `accepted:true`（不代表完成），且一次 `dsh_follow`
  最多阻塞 30 s，真模型长任务必然超时。因此 prompt 被接受后网关按片轮询
  `dsh_follow`：
  1. 每片给服务端 `timeoutMs = slice`（≤30 s，且不超过剩余预算），客户端 rpc
     超时为 `slice + 5 s`——客户端必须比服务端晚到，否则会在桥返回
     `timedOut:true` 的同一刻先行 abort；
  2. 客户端超时（`AbortError`/`TimeoutError`）或桥返回 `timedOut:true` 且没有
     文本，都只表示“这一片还没结果”，不是致命错误；每片之间用注入的 `clock`
     睡 1 s，继续下一片，直到总预算 `timeoutMs`（缺省 180 s，
     `DSBOT_BRIDGE_TIMEOUT_MS` 可覆盖，封顶 300 s）用完才报 `timeout`；
  3. 只有拿到非空 assistant 文本或 `turn/end` 才结束；`records` 没有文本时用
     `projections.values.turnOutline` 的 `response`/`draft` 兜底（兼容
     `{turns, draft}` 包装），且只在 `turn/end` 后采信，避免返回半截草稿。
  若桥（或自建桥）在 `dsh_prompt` 的 `structuredContent.text` 里直接给出答案，
  则跳过轮询与 `follow`。
- prompt 被接受后**不再重试**，避免同一任务被执行两遍；只有握手/建会话/prompt
  被接受之前的可重试失败才重试一次。开启 `reuseSession` 后，prompt 被接受前失败
  的整次重试也会复用已建的会话，不会多建一个。

## 错误、超时与重试

| code | 含义 | 重试 |
|---|---|---|
| `missing_credentials` | 直连三变量缺失，或桥 secret 缺失 | 否（未发请求） |
| `auth_failed` | HTTP 401/403，或桥返回 FORBIDDEN/UNAUTHORIZED | 否 |
| `rate_limited` | HTTP 429（尊重 `Retry-After`，封顶 5 s） | 是，默认再试 1 次 |
| `upstream_error` | 5xx / 网络错误 / 桥 HOST_ERROR、TIMEOUT | 是，默认再试 1 次 |
| `timeout` | 总预算 `timeoutMs` 内没拿到非空 assistant 文本或 `turn/end` | 否 |
| `empty_completion` | 上游 2xx 但文本为空 | 否 |
| `bad_response` | 非 JSON、缺少 `sessionId` 等协议错误 | 视情况（协议 2xx 非 JSON 可重试） |
| `bridge_error` | JSON-RPC error、`dsh_prompt` 未被接受、未知工具错误 | 仅 `-32603` 可重试 |
| `invalid_request` / `invalid_kind` | 参数或 kind 不合法 | 否 |

退避：指数退避 `backoffMs * 2^attempt`（默认 250 ms，封顶 5 s），重试次数默认
`maxRetries: 1`。超时不重试，避免把总预算翻倍。

## 脱敏（sanitize）

- 网关不打印日志；`GatewayError.message` 中只包含上游响应的前 300 字符，并且
  先经过 `redact(text, [apiKey|bridgeSecret])`。
- 返回的 `text` 也会脱敏：即使模型回显 key，返回值里只会出现 `[redacted]`。
- 导出 `sanitize(value, secrets)`（深拷贝脱敏）与 `redact(text, secrets)`，调用方
  写日志时应先过一遍。
- 测试断言了 key/secret 不会出现在 `message`、`toJSON()` 和返回值里。

## DS Bot / DSH 内推荐用法

1. **优先 `dsh_bridge`**：不持有模型 API key，走本机已配置的 DSH 会话，审计面更小。
   任务服务/机器人只需读一次 `bridge.secret`，其余用 `DSH_BRIDGE_SECRET` 注入。
2. `direct_http` 只作为桥不可用时的降级：key 仅从环境变量读取，进程外不落盘；
   不要把 key 写进 `.env` 提交、日志或返回值。
3. 长任务用 `timeoutMs` 显式设预算；`429` 由网关退避一次，仍失败就交给上层调度器。
4. 该包不实现排队/限流（桥本身 30 次/分 prompt）；并发调用请由上层排队。

## 测试

```sh
node --test packages/model-gateway/test
```

50 个用例，覆盖：直连请求/响应映射、缺凭据、429 + `Retry-After`、5xx 指数
退避、401/403 不重试、超时（含 fetch abort）、空文本、key 脱敏；桥的握手、
Bearer、会话创建、accepted-only + 分片 follow 轮询、长任务连续 3 个 30 s slice
超时后成功且客户端不 abort（客户端超时 = slice + 5 s）、客户端 abort 后继续
下一片、总预算超时、`timedOut` 有游标进展仍继续、delta 事件、assistant 文本
过滤、`projections.values.turnOutline` 兜底、`reuseSession` 只建一次会话并推进
`sinceSeq`、默认仍每次新建会话、空文本、JSON-RPC / 工具错误映射、
prompt 被接受后不重试；以及参数校验、默认超时（桥 180 s / 环境变量覆盖）、
`fetch` 形态 transport、深拷贝脱敏与源码纯净性（无日志、无 IO/网络导入、
不读环境变量）。全部使用注入的 fake transport，不联网、不读真实 secret 文件。

## 边界

- 缺省每次 `complete()` 新建一个 DSH 会话；传 `reuseSession: true` 后同一 gateway
  实例复用同一个会话（适合一次 run 的 writer + reviewer）。复用会话会累积上下文，
  长任务应自行控制轮次。
- 桥的真实 token 用量可能拿不到，此时 `usage` 为 `{}`，不做估算。
- `direct_http` 只支持 OpenAI 兼容的 chat completions；其他厂商协议需另加适配。
- 本包不做重试幂等键：`dsh_prompt` 一旦被接受就不再重试；直连重试仅针对
  429/5xx/网络错误。

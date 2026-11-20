# selfmedia-run — M2 自媒体稿件 run harness

一条命令跑完 **取料 → 快照 → 事实核查 → 写稿 → 独立审校 → 排版 → 稿件包**，产出可审阅包、独立审校记录和运行报告。

- 默认 `--fake`：完全离线、确定性 fake 模型与 fake 取料，不联网。
- `--offline`：只读本地 source pack / snapshot；没有快照就明确 `blocked`，不编造来源。
- `--real`：OpenAI 兼容模型 + 真实取料（本地 source pack，或 `--search` 的元数据/摘要检索），配置全部走环境变量。

**不发布。** 稿件包始终是 `license_status: "unauthorized"`（未授权），`publish.executed: false`；发布需要单独的人工发布许可。

## 0. D-04：不抓原文正文

本工具遵守母项目产品决定 **D-04 的「不抓取原文正文」要求**：信息源只用元数据与摘要（excerpt/summary），**不抓取、不解析、不保存原文正文**。引用时说明来源 URL 与摘要即可；出处信息（`publisher` / `host` / `url`）随 `source_list` 保留。

- `createHttpRetrieval` 的 `fetchPages` 默认为 `false`；真实 HTTP 取料（`--real` 或 `--real --search`）只请求搜索/元数据端点，不请求任何文章正文 URL。
- 搜索结果只采用 `title` 与 `snippet`/`summary`/`description`，摘要最长 300 字符；`text`/`content`/`body` 这类正文字段在默认路径上被忽略。
- `article-pack.json` / `sources.json` 的 `source_list` 只有 URL、`fetched_at`、`sha256`、`excerpt`（≤300 字符），不含正文。
- `--allow-fulltext` 是**违反 D-04 的调试后门**，默认关闭，只能与 `--real --search` 一起使用；不要用于本项目任何正式运行。

## 1. 默认 fake 模式（验收命令）

```sh
node tools/selfmedia-run/run.mjs --topic "测试选题" --out .tmp/selfmedia-run
```

- 退出码 `0`，写出 `article-pack.json`、`review.json`、`report.json`（另有 `article.md`、`sources.json`）。
- 使用 `tools/selfmedia-run` 内置的三条 fixture 来源；fixture 只是 harness 演练材料，**不是真实世界证据**，`article-pack.json` 的 `warnings` 会明确标注。
- 标题候选 ≥3、标签 ≥3、正文 ≥200 字、来源清单带 URL / 抓取时间 / sha256 / 摘要，许可状态未授权。

## 2. 真实模式（环境变量）

真实模式有两种取模型的 gateway，用 `--gateway env|bridge` 选择（默认 `env`）：

| `--gateway` | 走什么 | 凭据 | 需要模型 API key |
|---|---|---|---|
| `env`（默认） | OpenAI 兼容的 `POST {base}/chat/completions` | `DSBOT_MODEL_*` | 是 |
| `bridge` | 本机 DSH MCP 桥（`packages/model-gateway` 的 `dsh_bridge`） | `~/.dsh/bridge.secret`（文件） | **否** |

```sh
export DSBOT_MODEL_BASE_URL="https://your-model-host/v1"
export DSBOT_MODEL_API_KEY="..."      # 不会打印、不会落盘
export DSBOT_MODEL_NAME="your-model"

# gateway env：取料方式一，本地 source pack（不联网）
export DSBOT_SOURCE_PACK_FILE="./sources.json"
node tools/selfmedia-run/run.mjs --topic "真实选题" --out .tmp/real --real

# gateway env：取料方式二，元数据搜索（只读 title/summary，不抓正文；D-04）
export DSBOT_SEARCH_BASE_URL="https://your-search-host/search"
# export DSBOT_SEARCH_API_KEY="..."   # 可选
node tools/selfmedia-run/run.mjs --topic "真实选题" --out .tmp/real --real --search
```

### 2.1 `--gateway bridge`：走桥拿真模型（无需 API key）

```sh
# 默认读 ~/.dsh/bridge.secret；也可以显式指定文件
export DSBOT_BRIDGE_SECRET_FILE="/path/to/bridge.secret"   # 可选
node tools/selfmedia-run/run.mjs --topic "真实选题" --out .tmp/bridge \
  --real --gateway bridge --sources ./sources.json

# 取料也可以走元数据搜索（同样遵守 D-04，不抓正文）
node tools/selfmedia-run/run.mjs --topic "真实选题" --out .tmp/bridge \
  --real --gateway bridge --search
```

- **一次 run 只建一个 DSH 会话**：`dsh_create_session` 只调用一次，写手和独立审校的两次 `dsh_prompt` 复用同一个 `sessionId`。
- **长任务分片 follow，不靠单次 follow**：`dsh_prompt` 被接受后，网关按片轮询 `dsh_follow`——每片服务端 `timeoutMs ≤ 30 s`，客户端 rpc 超时为 `slice + 5 s`；桥返回 `timedOut:true` 或客户端等待超时都只表示“这一片还没结果”，网关用注入的 `clock` 睡 1 s 后继续下一片。总预算 `DSBOT_BRIDGE_TIMEOUT_MS`（默认 180 s，封顶 300 s）用完才报 `timeout`，因此真模型长任务不会再被 30 s 的桥上限截断。
- **不重放上一轮**：每次 `dsh_follow` 从上一轮已读到的 seq 之后继续（`sinceSeq` 前进），不会把上一轮回复当成本轮答案。
- **文本提取**：先取 `dsh_follow` 的 `records` 里完整 assistant 文本；`records` 没有正文时，用 `projections.values.turnOutline` 的 `response`/`draft` 预览兜底（只在 `turn/end` 后采信）。
- **secret 只从文件读**：只出现在 `Authorization: Bearer` 头里，不打印、不写进任何工件，也不从环境变量兜底。缺 secret 文件时退出码 `2`，提示里不会出现文件内容。
- **失败不造假稿**：连接失败、超时、空回复都会给出明确错误并退出码 `1`，同时写出 `status: "failed"` 的失败工件（正文为「运行失败」），不会静默回落到 fake 写手。
- **成本提示**：桥本身不需要 API key，但一个 DSH 会话承载整次 run 的上下文；同一会话里后一次 prompt 会带上前面轮次的上下文，token 成本随轮次增长。run 内复用会话是为了不重复建会话/重复装载上下文，不代表长任务可以无限塞进同一会话。

### 2.2 真实模式环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `DSBOT_MODEL_BASE_URL` | `gateway env` 必填 | OpenAI 兼容 base URL；会自动拼 `/chat/completions`。 |
| `DSBOT_MODEL_API_KEY` | `gateway env` 必填 | 只作为 `Authorization: Bearer` 发送；**不打印、不写入任何工件**。 |
| `DSBOT_MODEL_NAME` | `gateway env` 必填 | 请求体里的 `model`。 |
| `DSBOT_BRIDGE_URL` | 否（bridge） | 本机 MCP 桥地址，默认 `http://127.0.0.1:17300/mcp`。 |
| `DSBOT_BRIDGE_SECRET_FILE` | 否（bridge） | bridge secret 文件路径，默认 `~/.dsh/bridge.secret`；只读文件，不读环境变量里的 secret。 |
| `DSBOT_BRIDGE_MODEL` / `DSBOT_BRIDGE_PRESET` | 否（bridge） | 建 DSH 会话时传给桥的模型 / preset。 |
| `DSBOT_BRIDGE_TIMEOUT_MS` | 否（bridge） | 单次 `complete()` 预算，默认 180000，封顶 300000。 |
| `DSBOT_SOURCE_PACK_FILE` | 取料二选一 | 本地 source pack；也可用 `--sources` / `--snapshots`。 |
| `DSBOT_SEARCH_BASE_URL` | 取料二选一 | `--real --search` 的元数据检索 endpoint：GET `?q=<topic>&limit=<n>`，返回数组或 `{results}` / `{items}` / `{data}`；每条含 `url` 和 `title`/`snippet`/`summary`。**只使用元数据与摘要，不抓取正文。** |
| `DSBOT_SEARCH_API_KEY` | 否 | search 请求的 Bearer token，同样不打印。 |
| `DSBOT_SEARCH_QUERY_PARAM` / `DSBOT_SEARCH_LIMIT_PARAM` | 否 | 默认 `q` / `limit`。 |
| `DSBOT_MODEL_TIMEOUT_MS` / `DSBOT_SEARCH_TIMEOUT_MS` | 否 | 默认 90000 / 15000 ms。 |
| `DSBOT_MODEL_MAX_TOKENS` | 否 | 默认 2000。 |
| `DSBOT_MODEL_PRICE_INPUT_CNY_PER_1K` / `DSBOT_MODEL_PRICE_OUTPUT_CNY_PER_1K` | 否 | 成本估算单价，见下文。 |

缺少任一 `DSBOT_MODEL_*` 时（`gateway env`）退出码 `2`，提示只列变量名，不打印值；`gateway bridge` 不要求这些变量，但缺 secret 文件时同样退出码 `2`。真实模式没有取料配置时同样退出码 `2`，并明确拒绝编造来源。

## 3. 离线 / 快照模式

```sh
node tools/selfmedia-run/run.mjs --topic "离线选题" --out .tmp/offline \
  --offline --snapshots ./snapshots
```

`--snapshots <dir>` 会依次查找 `sources.json`、`snapshots.json`、`source-pack.json`；也可 `--sources <file>` 直接指定。source pack / snapshot 是**操作者本地提供**的输入，不经过网络抓取；外部取料的 D-04 约束见第 0 节。

```json
{
  "topic": "离线选题",
  "sources": [
    {
      "url": "https://example.com/a",
      "title": "材料 A",
      "text": "材料正文……",
      "published_at": "2026-11-01T08:00:00.000Z",
      "claims": [{ "text": "可核查的句子。", "key": true }]
    }
  ],
  "facts": [
    {
      "claim": "可核查的句子。",
      "key": true,
      "source_refs": ["https://example.com/a", "https://example.com/b"]
    }
  ]
}
```

- `facts` 可省略：会从来源正文中带数字/归属词的句子里抽取，并把两个独立主机都出现的句子标为 `key`。
- 也接受 L43 topic-pack 字段：`sourceUrl`、`sourceName`、`summary`、`publishedAt`；`items`/`results` 包在 `{ items: [...] }` 里也可以。
- `--offline` 且没有任何 source pack / snapshot 时：退出码 `3`，`article-pack.json` / `review.json` 状态为 `blocked`，`source_list` 为空，**不会静默编造来源**。

## 4. 故意事实错误演练

```sh
node tools/selfmedia-run/run.mjs --topic "测试选题" --out .tmp/rework --inject-fact-error
```

- fake/offline 写手会追加一句来源无法支持的事实（含 `37.5`），独立审校返回 `rework`，`review.json` 的 `issues[]` 给出 `unsupported_claim` 和具体句子。
- `article-pack.json` 的 `injection` 字段记录 `{enabled, caught, claim, detected_claim}`。
- 退出码仍为 `0`：运行成功完成，结论是返修而非崩溃。

## 5. 产出工件

| 文件 | 内容 |
|---|---|
| `article-pack.json` | `title_candidates` / `chosen_title` / `body` / `tags` / `word_count` / `source_list` / `facts` / `review` / `layout` / `license_status`（`unauthorized`，附中文“未授权”）/ `publish.executed`（`false`）/ `warnings` / `blocks` / `injection`。 |
| `review.json` | `reviewer`（独立上下文 id）/ `verdict`（`passed` / `rework` / `blocked`）/ `score` / `rubric[]`（六项：事实与证据、来源与快照、结构、可读性、文风、合规，均带 `threshold`、`passed`、`evidence`）/ `issues[]` / `evidence`。 |
| `report.json` | `steps[]`（各步 `duration_ms` 与调用计数）/ `model_calls` / `fake_model_calls` / `calls` / `usage` / `cost` / `retrieval` / `env`（只记录 host 与 key 是否存在）/ `injection` / `artifacts`。 |
| `article.md` | 排版后的 Markdown 正文（可直接阅读/审阅）。 |
| `sources.json` | 来源清单副本（URL、标题、host、抓取时间、sha256、摘要）。 |

独立审校不是“模型说好就过”：fake 模式用本地确定性 rubric；real 模式另起一次模型调用（不同 system prompt/上下文），但本地事实数字/来源/许可检查仍会执行，模型只能降低、不能抬高本地评分。

真实模型的审校输出常带 ```json 围栏或解释文字，因此 `parseReview()` 依次尝试直接解析、解析代码块内容、截取第一个 `{` 到最后一个 `}` 后再解析；仍失败时自动重试 1 次并在提示词中强调“只输出 JSON，不要解释”。两次都无法解析才记 `review_invalid_json` 并按未通过处理，重试次数写入 `review.json` 的 `evidence.reviewer_retry_count`。解析成功但 rubric 缺项或评分证据缺失同样判 `rework`（`review_rubric_incomplete` / `review_evidence_missing`），不会因为“解析成功”放宽标准。

## 6. 成本估算口径

`report.json` 的 `cost` 字段：

- 口径：`(tokens_in / 1000) * DSBOT_MODEL_PRICE_INPUT_CNY_PER_1K + (tokens_out / 1000) * DSBOT_MODEL_PRICE_OUTPUT_CNY_PER_1K`，币种人民币。
- `usage` 来自模型响应的 `usage` 字段；没有返回时为 0，`usage.source` 标 `unavailable`。
- fake 模式：`estimated_cny: 0`，`pricing_source: "not_applicable_fake"`。
- real 模式未配置单价：`estimated_cny: 0`，`pricing_source: "unconfigured"`，并提示需要设置哪两个变量；**不会猜厂商价格**。
- 只估算模型 token 成本，不含搜索/抓取/代理等外部费用。

## 7. 退出码

| 码 | 含义 |
|---|---|
| `0` | 运行完成并写出工件；结论可能是 `ready_for_review` 或 `needs_rework`。 |
| `1` | 未预期的内部失败；已尽力写出失败工件，报告中 `error` 字段说明原因。 |
| `2` | 参数或环境配置错误；不写工件。 |
| `3` | 取料/核查 `blocked`；仍写工件，来源清单为空，不编造。 |

## 8. 测试

```sh
node --test tools/selfmedia-run/test
```

62 个用例，全部 fake 模型/fake 取料/fake MCP 桥，不联网：fake 全链路、工件形状、确定性、事实错误拦截、离线 blocked、离线快照、真实模式缺环境变量/不打印 key、真实模式 source pack + 注入模型响应、真实模式 `--search` 零正文抓取（注入 `fetchImpl` 记录全部请求 URL）、元数据摘要上限与正文字段忽略、`--allow-fulltext` 仅显式开启、source pack claims 派生事实、L43 topic-pack 字段兼容、成本公式、审校 rubric 合并、审校 JSON 三种解析路径与失败不抛异常、解析失败自动重试 1 次并记录 `retry_count`、两次失败判 `review_invalid_json`、rubric 缺项/证据缺失仍判 rework；以及 `--gateway bridge` 的会话只建一次、两次 prompt 复用同一 `sessionId`、prompt 顺序、分片 `dsh_follow`（服务端 ≤30 s、客户端 +5 s、`sinceSeq` 前进）、secret 只在 Bearer 头且不出现在工件/输出、空回复/超时/连接失败/审校阶段失败退出非 0 且不产出假稿、缺 secret 文件退出 2。`--real` / `--real --search` / `--gateway bridge` 的用例只使用注入的 fetch，不发起真实网络请求，也不读真实 secret 文件。

## 9. 安全与边界

- 不发布、不开启任何发布/授权流程；只产出待人工审阅的稿件包。
- 真实模型 key 只存在于进程内闭包；报告只写 `api_key_present` 和 `base_url_host`，错误信息会 redact 已知 key。
- `--gateway bridge` 的 secret 只从文件读取，只放在 `Authorization: Bearer` 头；报告只写 `bridge_secret_present` / `bridge_secret_logged`，工件、stdout/stderr 和错误信息都不含 secret。
- 真实 HTTP 取料默认只访问元数据/摘要端点：`--real` 与 `--real --search` 不请求文章正文 URL，`fetchPages` 默认为 `false`。
- `--allow-fulltext` 仅用于非本项目的调试，会恢复旧的正文抓取路径（≤20000 字符）；它违反 D-04，不应出现在任何正式运行或配置中。
- `--real` 的自动化只用注入 fetch 演练，不发起真实网络请求；本仓库测试不会访问外网。

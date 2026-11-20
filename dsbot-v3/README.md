# DS Bot V3 任务运行层（dsbot-v3）

本目录由试验仓 `tools/migrate/bundle.mjs` 打包生成：

- 源仓库：`ft54482/superagent-lab-smoke`
- 源 commit：`7887f886433061c9ca3e79d036d71376d8e33cc7`
- 目标：作为 DS Bot fork 的**新增顶层目录**整体落地；DS Bot 既有文件保持不变

## 目录

| 路径 | 内容 |
| --- | --- |
| `packages/` | 27 个任务运行层包（源码 + 各自 test） |
| `tests/` | 跨包验收测试：conformance / contract / e2e / dod / regression |
| `tools/` | 校验与运维脚本：verify / seed / perf / migrate |
| `MIGRATION.json` | 打包清单：源 commit、生成时间、文件数、逐包 sha256 |

## 结构约束

包之间用相对路径互相引用（例如 `packages/demo` → `../../runtime/src/index.js`），
因此 `packages/`、`tests/`、`tools/` 必须保持为同级目录整体搬运，不能只拷单个包。

## 包清单

- `packages/acceptance/` — `@dsbot/acceptance`
- `packages/adapters/` — `@ds-bot/adapters`
- `packages/agents/` — `@dsbot/agents`
- `packages/api/` — `@dsbot/api`
- `packages/authz/` — `@dsbot/authz`
- `packages/autoloop/` — `@dsbot/autoloop`
- `packages/bridge/` — `@ds-bot/bridge`
- `packages/cli/` — `@dsbot-v3/cli`
- `packages/context/` — `@dsbot/context`
- `packages/cost/` — `@dsbot/cost`
- `packages/demo/` — `@ds-bot/demo`
- `packages/events/` — `@dsbot/events`
- `packages/goal-engine/` — `@dsbot/goal-engine`
- `packages/loop/` — `@dsbot/loop`
- `packages/metrics/` — `@dsbot/metrics`
- `packages/monitor/` — `@dsbot/monitor`
- `packages/notify/` — `@dsbot/notify`
- `packages/pipelines/content/` — `@ds-bot/pipelines-content`
- `packages/pipelines/selfmedia/` — `@ds-bot/pipelines-selfmedia`
- `packages/profiles/` — `@dsbot/profiles`
- `packages/provisioner/` — `@dsbot/provisioner`
- `packages/recovery/` — `@dsbot/recovery`
- `packages/runtime/` — `@dsbot/runtime`
- `packages/scheduler/` — `@dsbot/scheduler`
- `packages/service/` — `@dsbot-v3/service`
- `packages/store/` — `@dsbot/store`
- `packages/verifier-agent/` — `@dsbot/verifier-agent`

## 校验

```
# 在本目录内（含 MIGRATION.json 时可直接指向自身）
node tools/migrate/bundle.mjs --verify .
# 或指向包含 dsbot-v3/ 的父目录
node tools/migrate/bundle.mjs --verify <父目录>
```

退出码 0 表示文件数与逐包/逐分区 sha256 全部匹配；非 0 时按输出逐条排查。

## 回滚

本目录是纯新增内容：删除 `dsbot-v3/` 或 revert 对应 PR 即可完全回滚，不涉及数据迁移。

# L18 演示库种子与校验器

为 e2e / 演示生成一个可丢弃、可复跑的 `control.sqlite`。数据库结构直接采用仓库里的 L1 迁移 `packages/store/migrations/001_init.sql`，数据是固定的三层任务样例，不连网络、不依赖 npm。

## 运行

```sh
# 生成或覆盖 <tmpdir>/control.sqlite
node tools/seed/seed.mjs --out <tmpdir>

# 只读复查
node tools/seed/seed.mjs --verify <tmpdir>
```

- `--out`：目标目录会被创建；目录里已有的 `control.sqlite`（连同 `-wal`/`-shm`/`-journal`）会被替换，其他文件不动。
- `--verify`：以只读方式打开 `<tmpdir>/control.sqlite`，全部检查通过退出码为 `0`，任一检查失败为 `1`。
- 演示库是单文件（rollback journal）；`--verify` 只读打开不会留下 `-wal`/`-shm` 旁路文件。
- 仅使用 Node 内置模块（`node:sqlite`、`node:fs`、`node:path`、`node:url`），无需 `npm install`。
- 每次生成都会自检一次；如果写入后的库不满足下面的数据契约，`--out` 也会以退出码 `1` 结束。

## 数据契约

| 数据 | 内容 |
|---|---|
| 任务 | 1 个 `goal`、2 个 `business`、3 个 `execution`；层级严格 `goal -> business -> execution` |
| 状态 | 1 个 `completed`（通过验收）、1 个 `reworking`、1 个 `blocked`；goal 与两个 business 保持 `running` |
| 验收 | 恰好 1 条 `acceptance.state='passed'`，`stage` 与目标任务层级一致，目标已 `completed` |
| 执行 | 3 条 `run`：`accepted` / `rejected` / `queued`，与三个执行任务一一对应 |
| 成本 | 恰好 3 条 `cost_ledger`，金额均为正，覆盖 `llm`、`tool`、`other` 三种来源 |
| 时间 | 固定时钟（`2026-11-20T08:00:00Z` 起），重复生成的业务数据一致 |

`schema_version` 记录为 `1`，与 `@dsbot/store` 的 `SCHEMA_VERSION` 对齐，因此 `openStore({ path })` 可以直接打开这个演示库，不会重放迁移或拒绝版本。完成任务是通过真实的 `UPDATE ... state='completed'` 写入的，会经过 `trg_completed_guard`，而不是直接插一条假完成记录。

## 校验项

1. `integrity_check` 为 `ok`，`foreign_key_check` 无违规。
2. L1 的 12 张表、`schema_version` 和 3 个守卫触发器都在，版本为 `1`。
3. 任务层级数量与父子关系正确。
4. `reworking`、`blocked` 各恰好 1 个。
5. 恰好 1 条 passed 验收，且验收层级、目标任务状态、完成时间戳、对应 run 状态自洽。
6. 没有“completed 但本级没有 passed 验收”的任务。
7. 恰好 3 条正数成本，且都指向真实的任务 / run。

## 示例

```sh
$ node tools/seed/seed.mjs --out .agent/tmp/l18-demo
Seed OK: .../.agent/tmp/l18-demo/control.sqlite
  schema v1 from packages/store/migrations/001_init.sql
  tasks: 1 goal / 2 business / 3 execution
  task states: completed 1, reworking 1, blocked 1
  acceptance: 1 row(s), 1 passed
  costs: 3 row(s), total CNY 0.61
  self-check: PASS

$ node tools/seed/seed.mjs --verify .agent/tmp/l18-demo
Demo control.sqlite verifier
Database: .../.agent/tmp/l18-demo/control.sqlite
...
Summary: 9 passed, 0 failed
Result: OK
```

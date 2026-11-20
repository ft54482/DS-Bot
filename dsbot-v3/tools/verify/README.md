# DDL 可复跑校验器

对只读的 `docs/prd/01-data-model.sql` 做一次端到端验证：在内存 SQLite 中建库，检查 schema 清单，并用真实写入触发两个结构性守卫。

## 运行

```sh
node tools/verify/verify.mjs
```

- 退出码 `0`：全部检查通过；`1`：至少一项失败，失败项会以 `[FAIL]` 打印。
- 仅使用 Node 内置模块（`node:sqlite`、`node:fs`、`node:crypto`、`node:path`、`node:url`），不需要 `npm install`。
- 每次运行都新建 `:memory:` 数据库，不写文件、不留状态，可重复执行。
- 需要带 `node:sqlite` 的 Node；本次验证使用 Node v25.2.0 / SQLite 3.50.4。

## 检查项

1. DDL 能在全新的内存库中完整执行。
2. 表数量 ≥ 30（当前 33）。
3. 视图数量 = 3。
4. 触发器数量 = 3，且包含 `trg_completed_guard`。
5. `schema_version` 至少有一条记录。
6. 守卫一：本级没有 `acceptance.state='passed'` 时，把 `task.state` 改为 `completed` 被拒绝；只有本级（`stage = task.level`）的通过结论才能放行。
7. 守卫二：`goal` 下直接插入 `execution` 子任务被拒绝；相邻的 `business` 子任务仍可插入。

脚本只读取 DDL，不修改 `docs/prd/**`。

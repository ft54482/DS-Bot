# @dsbot/store · L1 最小任务库

DS Bot V3 任务运行层的存储层：用 Node 内置 `node:sqlite` 建库、迁移，并提供任务 DAO 与两个不可绕过的守卫。

依据：`docs/prd/01-data-model.sql`（字段与约束沿用；只裁剪到 12 张 MVP 表）。
状态命名与 `docs/prd/03-acceptance-spec.md §10` 一致。

## 用法

```js
import { openStore } from '@dsbot/store';

const store = openStore({ path: 'control.sqlite' }); // 默认执行迁移
const task = store.createTask({
  level: 'goal',
  title: '把客服系统做成能体验的版本',
  goal: '端到端可体验',
  project: 'gd-customer-service',
  delegator_kind: 'human',
  delegator_ref: 'human:ft54482',
  owner_ref: 'bot:chief',
});
store.updateTaskState(task.id, 'queued', { actor: 'human:ft54482' });
store.close();
```

测试用 `openStore({ path: ':memory:' })`。

## 表（12 张 MVP）

`task`、`run`、`dispatch_outbox`、`event_inbox`、`event_watermark`、`claim`、
`acceptance`、`acceptance_item`、`evidence`、`cost_ledger`、`task_event`、
`publish_authorization`，另有 `schema_version` 记录迁移版本。

裁剪说明：`executor_instance`、`principal`、`delegation`、`report` 等不在 L1 范围，
因此 `task.executor_instance_id` 保留列但去掉外键；12 张表之间外键保持。

## 守卫（触发器，不在 DAO 中重复实现）

| 触发器 | 规则 | 错误码 |
|---|---|---|
| `trg_task_level_adjacent_insert` | 父任务必须是上一级（goal→business→execution） | `hierarchy_violation` |
| `trg_task_level_immutable` | `level` / `parent_task_id` 创建后不可改 | `hierarchy_immutable` |
| `trg_completed_guard` | 没有本级 `acceptance.state='passed'` 不得进入 `completed` | `missing_acceptance` |

`updateTaskState()` 与状态事件在同一个事务里写入：守卫拒绝时任务状态和 `task_event` 都不变。

## 迁移

`migrations/NNN_*.sql` 按版本号顺序执行，单文件单事务，成功后写 `schema_version`。
启动时校验：数据库版本高于本构建支持的 `SCHEMA_VERSION` 时拒绝使用。

## 测试

```sh
node --test packages/store/test
```

需要 `node:sqlite` 无需实验开关的 Node（22.13+/23.4+；本仓库实测 25.2.0）。
`node:sqlite` 目前仍会在 stderr 打一条 `ExperimentalWarning`，不影响退出码。

`test/index.js` 是该命令的入口（Node 25 把位置参数当文件解析，不展开目录），
内部 import 三个测试文件；也可单独运行某个文件：

```sh
node --test packages/store/test/guards.test.js
```

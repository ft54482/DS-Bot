# L28 存储层与状态机基准

`tools/perf/run.mjs` 用 Node 内置模块和仓库内包，对存储层与 L2 状态机跑一组可比较的耗时基线；不引入 npm 依赖。

## 运行

```sh
node tools/perf/run.mjs
```

- 退出码 `0`：三项指标的中位数都在阈值内；`1`：至少一项超阈值，并在 stderr 打印 `[FAIL] <指标>=<实测>ms > <阈值>ms`。
- stdout 只输出一个 JSON 对象（不带其他日志），固定三个键：

```json
{
  "store_insert_1k_ms": 169.9,
  "store_query_1k_ms": 56.8,
  "transition_1k_ms": 45.9
}
```

- 每次运行在系统临时目录新建 `dsbot-perf-*`，SQLite 文件只落在该目录；三个样本各用一个新库，结束后递归删除，不写仓库内文件。
- 样本数固定为 3，取中位数；单项内部正好 1000 次操作。

## 指标口径

| 指标 | 操作 | 1000 次含义 |
|---|---|---|
| `store_insert_1k_ms` | `Store#createTask` | 在**同一个事务**内批量插入 1000 个 `goal` 任务，直到事务提交 |
| `store_query_1k_ms` | `Store#getTask` | 1000 次主键点查，并校验每行都存在 |
| `transition_1k_ms` | `TaskService#queueTask` | 1000 个任务各走一次状态机迁移 `planned -> queued`（含守卫、迁移表、事件哈希与内存存储更新） |

存储指标使用临时文件 SQLite（WAL），不是 `:memory:`，因此包含真实落盘路径；插入用单事务批量写入，避免每行一次 fsync 带来的磁盘抖动，保证不同机器上的数字可比较。状态机指标使用 service 自带的 `createMemoryStore()`，只测状态机本身，不含 SQLite 提交开销。

## 阈值

| 指标 | 上限 |
|---|---|
| `store_insert_1k_ms` | 2000 ms |
| `store_query_1k_ms` | 1000 ms |
| `transition_1k_ms` | 500 ms |

## 基线环境

- base：开工时 `origin/main` = `0b415f30561accb2253fd398afd388bdbf05a422`
- 参考运行：Node v25.2.0 / 内置 SQLite 3.50.4（Windows）
- 上述 JSON 是一次参考输出；换机器后请以同机重复运行的中位数为准。

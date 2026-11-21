# `@dsbot/devloop-plugin` — L40 DSH bundle

把自动开发 loop 做成一个 DSH bundle。模型直接调用三个工具：

| 工具 | 作用 |
|---|---|
| `loop_start({ goal, lanes, budgetCny, maxWorkers })` | 用 goal-engine 拆任务书、用 autoloop 起循环，返回 `loopId` |
| `loop_status({ loopId? })` | 带 `loopId` 返回 `{ state, iteration, running, stoppedReason? }`；不带则返回 `{ loops, count }` |
| `loop_stop({ loopId?, reason })` | 停止并写入不可恢复的停止原因；不带 `loopId` 时只允许停唯一的在跑 loop |

插件内部组合 `goal-engine`、`autoloop`、`provisioner`、`verifier-agent`。
所有外部接缝（`sa` / `git` / `gh` / verifier `runner` / `fs`）都是注入的；
包本身不触网、不读写真实 `~/.dsh`。

## 在 DS Bot 内置 DSH 里安装

包已声明 cordis bundle 字段：

```json
"dsh": {
  "manifestVersion": 1,
  "bundle": { "patch": "./cordis.patch.yml" }
}
```

`cordis.patch.yml` 会插入 `devloop-plugin` 这一行。安装时用 `install_bundle`
指向本目录的 `file:` 路径（Windows 示例）：

```text
install_bundle {
  "spec": "file:C:\\path\\to\\superagent-lab-smoke\\packages\\devloop-plugin",
  "enabled": true
}
```

如果宿主暴露的是 DSH 的 `plugin_manager` 统一工具，等价调用是：

```text
plugin_manager {
  "action": "install_bundle",
  "target": "file:C:\\path\\to\\superagent-lab-smoke\\packages\\devloop-plugin"
}
```

安装后 bundle patch 自动生效；未开 HMR 的 profile 需要重启/重新加载。
可用 `list_bundles` 确认 `@dsbot/devloop-plugin` 已启用，随后模型侧应出现
`loop_start` / `loop_status` / `loop_stop`。

> 从仓库 checkout 直接 `install_bundle`（`file:` 指向 `packages/devloop-plugin`，
> 没有复制进 `node_modules`）时，插件回退到同级的 `packages/<name>/src`
> 加载四个兄弟包，因此请保留这五个兄弟目录。真正装进 `node_modules` 的
> profile 一律按下面的包名解析。

### 作为 npm 包安装（部署到任意 profile）

插件在 `src/manager.js` 里用包名加载四个兄弟包（`@dsbot/autoloop/src/index.js`
等），四个包通过 `package.json` 的 `./src/*` 子路径导出暴露源码。所以
**5 个包必须一起装进 profile**；只装 `@dsbot/devloop-plugin` 会在启动时报
`ERR_MODULE_NOT_FOUND: @dsbot/autoloop`。

先给 5 个包打 tgz：

```sh
cd packages
for p in autoloop goal-engine provisioner verifier-agent devloop-plugin; do
  (cd "$p" && npm pack)
done
```

再一次性装进目标 profile（`dsh plugin` 把参数转给 profile 目录的 pnpm）：

```sh
dsh plugin --profile ds-bot add \
  "file:./autoloop/dsbot-autoloop-0.1.0.tgz" \
  "file:./goal-engine/dsbot-goal-engine-0.1.0.tgz" \
  "file:./provisioner/dsbot-provisioner-0.1.0.tgz" \
  "file:./verifier-agent/dsbot-verifier-agent-0.1.0.tgz" \
  "file:./devloop-plugin/dsbot-devloop-plugin-0.1.0.tgz"
```

Windows 用绝对路径，例如：

```text
dsh plugin --profile ds-bot add "file:C:\path\to\dsbot-autoloop-0.1.0.tgz" "file:C:\path\to\dsbot-goal-engine-0.1.0.tgz" "file:C:\path\to\dsbot-provisioner-0.1.0.tgz" "file:C:\path\to\dsbot-verifier-agent-0.1.0.tgz" "file:C:\path\to\dsbot-devloop-plugin-0.1.0.tgz"
```

`@dsbot/devloop-plugin` 的 `dependencies` 与 `peerDependencies` 都把四个兄弟包
声明为 `0.1.0`：这四个包不发布到 npm registry，部署时由 profile 用
`file:` 包提供（一次装齐 5 个，pnpm 就不会去 registry 解析它们）。缺少某个
包时，插件 import 阶段会直接报出缺的包名和安装提示，而不是一个裸的
`ERR_MODULE_NOT_FOUND` 路径。安装完重启 profile，`list_bundles` 应能看到
`@dsbot/devloop-plugin`。

### 宿主注入真实接缝

`cordis.patch.yml` 只能传纯数据；`sa` / `git` / `gh` / verifier `runner` /
`fs` 是对象或函数，由宿主模块构造 manager 后交给 `apply`：

```js
import { apply, createDevloopManager } from '@dsbot/devloop-plugin';
import { createNodeFs } from '@dsbot/provisioner';

const manager = createDevloopManager({
  sa, git, gh, runner,
  fs: createNodeFs(),
  provision: { repo: 'ft54482/superagent-lab-smoke' },
});

export const name = 'devloop-plugin-host';
export const inject = ['tools'];
export const applyHost = (ctx) => apply(ctx, { manager });
```

宿主还可以用 `manager.advance(loopId)` 或 `manager.get(loopId)` 做外部驱动
和观测；三个模型工具本身不带后台定时器。

## 最小示例

```text
loop_start {
  "goal": {
    "title": "给设置页加导出按钮",
    "baseSha": "<开工时 origin/main 的 40 位 sha>"
  },
  "lanes": [
    {
      "lane": "settings-ui",
      "dir": "packages/settings",
      "cost": 3,
      "acceptanceCommands": ["node --test packages/settings/test"],
      "minCases": 4
    }
  ],
  "budgetCny": 20,
  "maxWorkers": 2
}
```

返回：

```json
{
  "loopId": "loop-mf3k2-1",
  "state": "collect",
  "iteration": 1,
  "running": true,
  "tasks": 1,
  "budgetCny": 20,
  "baseSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

`baseSha` 可省略；如果 goal 和所有 lane 都没给，则使用 `000…0`（40 个 0）
占位值让规划先跑起来（goal-engine 要求 40-hex）。生产调用应传开工时
`origin/main` 的完整 sha。

之后：

```text
loop_status {}
→ { "loops": [ { "loopId": "loop-mf3k2-1", "state": "collect",
    "goal": "给设置页加导出按钮", "startedAt": 1700000000000, ... } ],
    "count": 1 }

loop_status { "loopId": "loop-mf3k2-1" }
→ { "state": "collect", "iteration": 1, "running": true }

loop_stop { "loopId": "loop-mf3k2-1", "reason": "需求撤回" }
→ { "loopId": "loop-mf3k2-1", "state": "stopped", "iteration": 1,
    "running": false, "stoppedReason": "需求撤回", "irreversible": true }
```

`loop_status` 不传 `loopId` 时列出当前全部 loop；一个都没有时返回
`{ "loops": [], "count": 0 }`，不是错误。第一次调用的人可以先用它拿到 id。
`loop_stop` 也可以不传 `loopId`：只有一个在跑 loop 时停止它，多个在跑时抛
`ambiguous_loop` 并列出候选，避免误停。

## 行为与错误码

- 同一 goal（按标题归一化）只能起一个 loop；重复调用抛
  `loop_exists`。停止后也不可重新起同一 goal：停止标记不可恢复。
- lane 的 `cost` 合计超过 `budgetCny` 时抛 `budget_exceeded`，在起循环前
  拒绝，不产生派工。
- 不存在的 `loopId` 在 `loop_status` / `loop_stop` 中都抛 `loop_not_found`，
  消息和 `details.available` 里带当前最多 5 个可用 `loopId`；没有 loop 时
  提示先调用 `loop_start`。
- `loop_start` 会执行到第一次 `collect` 等待点后返回（plan → dispatch →
  collect），因此返回时已有任务书和派工；后续推进可由宿主用 manager 的
  `advance(loopId)` 驱动，三个工具本身不跑后台定时器。
- 没有注入 `sa`/`git`（或 `scheduler`/`merger`）时抛
  `missing_dependency`。没有注入 verifier `runner` 时 verifier fail-closed，
  不会误判 PASS。
- `provision` 默认关闭；传入 `provision: { repo, workRoot, ... }` 且注入
  `fs` 时，会为 loop 创建 SuperAgent 实例，实例信息随 `loop_start` 返回。

| code | 含义 |
|---|---|
| `invalid_input` | 参数结构、base sha、预算/worker 数值不合法 |
| `empty_goal` | goal 为空 |
| `loop_exists` | 同一 goal 已有 loop |
| `budget_exceeded` | lane cost 合计超预算 |
| `loop_not_found` | loopId 不存在，消息附最多 5 个候选 id |
| `ambiguous_loop` | `loop_stop` 不带 loopId 但有多个在跑 loop |
| `missing_dependency` | 缺少 sa/git/scheduler/merger/runner/fs 等注入 |
| `provision_failed` | provisioner 创建实例失败 |
| `loop_error` | 驱动 loop 时出现未分类错误 |

## 接缝与测试

`createDevloopManager(options)` 接受 `sa`、`git`、`gh`、`runner`、`fs`、
`probe`，以及 `scheduler` / `merger` / `verifier` / `goalEngine` /
`loopFactory` 覆盖。除安装布局用例外，测试全部用内存 fake：`sa`、`git`、
`gh`、runner、provisioner fs 均不触网、不写真实 `~/.dsh`。安装布局用例在系统
临时目录复制一份 `node_modules/@dsbot/*`（5 个包的 `package.json` 与 `src`），
用 `node` 子进程 `import('@dsbot/devloop-plugin')`，断言不再出现
`ERR_MODULE_NOT_FOUND`。

```sh
node --test packages/devloop-plugin/test
```

当前 54 条用例，覆盖：三个工具定义与 schema（`loopId` 可选）、DSH schema
子集校验、真实 goal-engine 拆任务、重复 goal、超预算、未知 loopId
（`loop_not_found` + 最多 5 个候选）、无 loopId 的列表与停止（空列表、单
loop、多 loop、`ambiguous_loop`）、停止与幂等、PASS 闭环完成、FAIL 触发
stop-loss、sa/git/gh 适配器、verifier-agent runner 注入、provisioner fake
fs、bundle 声明、四个兄弟包的 `./src/*` 子路径导出与 `files` 声明、纯度扫描，
以及安装布局（`node_modules/@dsbot`）下的 import。

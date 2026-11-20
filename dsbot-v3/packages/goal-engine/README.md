# @dsbot/goal-engine — L33 目标引擎

把「定目标 → 拆任务书」做成一个纯函数：

```js
import { decompose } from '@dsbot/goal-engine';

const { milestones } = decompose({
  goal: {
    id: 'goal-l33',
    title: '交付目标引擎',
    background: '把定目标到拆任务书自动化',
    baseSha: '7d576a98471bd39c90baed2d37a91980ff16cbe3',
    milestones: [{ id: 'm1', title: '核心引擎' }],
  },
  prdIndex: [
    { id: '03', title: '验收规范', path: 'docs/prd/03-acceptance-spec.md' },
  ],
  lanes: [{
    lane: 'engine',
    dir: 'packages/goal-engine',
    milestone: 'm1',
    prd: ['03'],
    acceptance: ['node --test packages/goal-engine/test'],
    minCases: 12,
    cost: 2,
  }],
  budget: { limit: 10, unit: 'points' },
});
```

返回：

```js
{
  milestones: [{
    id: 'm1',
    title: '核心引擎',
    lanes: [{
      lane: 'engine',
      dir: 'packages/goal-engine',
      taskBook: {
        background: '目标：交付目标引擎\n…',
        allowedPaths: ['packages/goal-engine/**'],
        workBase: { sha: '7d576a98471bd39c90baed2d37a91980ff16cbe3', ref: 'origin/main' },
        forbidden: ['白名单外写入或删除文件', …],
        acceptanceCommands: ['node --test packages/goal-engine/test'],
        minCases: 12,
        markdown: '## 背景\n…', // 六段渲染结果，可直接派发
      },
    }],
  }],
}
```

## 契约

### `decompose({goal, prdIndex, lanes, budget, template})`

| 参数 | 说明 |
|---|---|
| `goal` | 字符串（标题）或对象。对象字段：`title`（必填）、`background`、`acceptance`、`baseSha`、`milestones: [{id, title}]`。空目标（`''`、空白、无 `title`）抛 `empty_goal`。 |
| `prdIndex` | 只读 PRD 索引。数组 `[{id, title?, path}]` 或对象 `{id: path \| {title?, path}}`。lane 的 `prd` 只允许引用这里存在的 id。 |
| `lanes` | 非空数组。每条 lane 见下表。 |
| `budget` | 正数或 `{limit, unit?}`；所有 lane 的 `cost` 之和超过 `limit` 即整单拒绝。 |
| `template` | 可选注入模板：函数 `(context) => sixSections`，或 `{render(context)}`。返回值仍要过六段校验。 |

`context` 包含 `{goal, lane, milestone, prd, baseSha}`：`prd` 是已解析的索引条目，`lane` 是补全默认值后的 lane，`baseSha` 是 lane 覆盖或 goal 声明的完整 sha。

### lane 字段与默认值

| 字段 | 默认值 |
|---|---|
| `lane` / `name`（必填） | — |
| `dir` / `directory`（必填） | 必须是仓库相对路径；拒绝绝对路径、`..`、`.`，统一为正斜杠并去掉尾斜杠。 |
| `milestone` | 不声明时归入第一个里程碑；goal 没有声明里程碑时自动生成 `m1`（标题为 goal 标题）。 |
| `allowedPaths` | `[${dir}/**]` |
| `forbidden` | 通用禁止项（白名单外写入、reset --hard、force push、伪造证据、改 CI、加依赖等） |
| `acceptance` / `acceptanceCommands` | `[node --test ${dir}/test]`，可传字符串或数组 |
| `minCases` | `1`，必须是正整数 |
| `cost` | `1`，必须是 ≥0 的有限数 |
| `prd` | `[]`，元素为 `prdIndex` 的 id |
| `baseSha` | 继承 `goal.baseSha` |
| `baseRef` | `origin/main` |

### 任务书六段（缺段即 `invalid_task_book`）

| key | 渲染标题 | 校验规则 |
|---|---|---|
| `background` | 背景 | 非空字符串；默认包含目标、里程碑、lane 与 PRD 参考 |
| `allowedPaths` | 允许路径 | 非空字符串数组 |
| `workBase` | 工作位置（base sha） | `{sha}`，sha 必须是 40 位十六进制；`ref` 可选 |
| `forbidden` | 禁止 | 非空字符串数组 |
| `acceptanceCommands` | 验收命令 | 非空字符串数组 |
| `minCases` | 最少用例数 | 正整数 |

`validateTaskBook(book, {lane})` 可直接校验任意任务书；`renderTaskBook(book)` 输出六段 Markdown。

## 错误码

所有错误都是 `GoalEngineError`，调用方按 `error.code` 分支，`error.details` 附机器可读上下文。

| code | 触发条件 |
|---|---|
| `empty_goal` | 目标为空、空白或没有标题 |
| `invalid_input` | goal/prdIndex/lanes/budget/template 结构不合法，里程碑重复等 |
| `invalid_lane` | lane 缺名、目录非法、minCases/cost 非法等 |
| `duplicate_lane` | 两条 lane 重名 |
| `lane_dir_conflict` | 两条 lane 同目录或目录互相嵌套（`details.conflict` 为 `same`/`nested`） |
| `invalid_budget` | 预算缺失、非正数、非有限数或结构非法 |
| `budget_exceeded` | lane 成本合计超过预算（`details` 含 `total`/`limit`） |
| `unknown_prd` | lane 引用了 prdIndex 中不存在的 id |
| `unknown_milestone` | lane 引用了未声明的里程碑 id |
| `invalid_task_book` | 六段缺失或类型/取值不合法；`details` 含 `lane`、`section`、`reason` |

## 纯度与确定性

- 只用入参，无文件、网络、时钟、随机数、环境变量依赖；`test/purity.test.js` 会扫描 `src/**` 防回归。
- 同输入多次调用逐字段相等；输入不会被修改（测试用 `deepFreeze` 固定）。
- 不共享可变结果：每次调用返回新对象。
- 模板可注入；默认模板不写死的只有任务书内容，目录/预算/校验逻辑与模板无关。

## 测试

```powershell
node --test packages/goal-engine/test
```

当前 39 条用例，覆盖：返回结构、六段齐全、base sha、PRD 解析、里程碑分组、默认值、注入模板、缺段拒绝、幂等、目录互斥（同目录/嵌套）、预算超限与等额、空目标、非法输入、纯度扫描。

# tools/migrate — DS Bot V3 迁移打包器

把试验仓的 `packages/`、`tests/`、`tools/` 打成可整体落进 DS-Bot fork 的迁移包：

```
<out>/dsbot-v3/
  packages/  tests/  tools/  README.md  MIGRATION.json
```

## 用法

```powershell
# 生成（默认从本仓库根读取；--out 可指向任意目录）
node tools/migrate/bundle.mjs --out $env:TEMP\mig1

# 校验（可指向包含 dsbot-v3/ 的父目录，或 dsbot-v3 目录本身）
node tools/migrate/bundle.mjs --verify $env:TEMP\mig1
```

退出码：`0` 成功/校验通过，`1` 校验或操作失败，`2` 参数错误。

## 选项

| 选项 | 说明 |
| --- | --- |
| `--out <dir>` | 输出目录，迁移包写到 `<dir>/dsbot-v3`（已存在会先清空，保证重跑幂等） |
| `--verify <dir>` | 校验文件数、逐文件 sha256、逐包 sha256、分区 sha256、未登记/缺失文件 |
| `--root <dir>` | 源仓库根目录（默认：本脚本所在仓库；测试夹具用它指向临时源） |
| `--source-commit <sha>` | 覆盖清单记录的源 commit（默认用 `git rev-parse` 取源树所在仓库的 HEAD，含上层仓库；取不到时记录 `unknown`） |
| `--source-repo <owner/name>` | 覆盖清单记录的源仓库（默认 `ft54482/superagent-lab-smoke`） |
| `--generated-at <iso>` | 覆盖生成时间；也可设 `SOURCE_DATE_EPOCH` 做可复现打包 |
| `--help` | 打印用法 |

## sourceCommit 语义

`MIGRATION.json.sourceCommit` 记录的是**源树所在 git 仓库**的 HEAD，不是迁移树自己的提交：

- 打包时以 `--root`（默认本仓库根）为工作目录执行 `git rev-parse HEAD`。git 会自动向上发现仓库，
  所以源树位于某个仓库的子目录时（例如迁移树落在 DS-Bot fork 的 `dsbot-v3/`），记录的是**该上层仓库**
  的 40 位小写 sha；判断依据是 `git rev-parse` 能否解析，而不是源目录下有没有 `.git`。
- 源目录完全不在任何 git 仓库中（`git rev-parse` 失败，且源目录自身也没有可读的 `.git`）时，
  记录字面量 `unknown`；工具不会猜测 commit，也不会因此让打包失败。
- `--source-commit <sha>` 始终优先于自动探测。把迁移树放进 fork 后若要重新打包，自动探测到的是
  fork 的 HEAD；需要锁定实验仓来源时，应显式传入打包时的实验仓 commit。
- `--verify` 要求 `sourceCommit` 是非空字符串；值为 `unknown` 时给出警告，其余值（包括 40 位 sha）
  原样接受——迁移包可能被搬到别处，verify 不复核它是否仍是某个仓库的 HEAD。

## MIGRATION.json

包含：`schemaVersion`、`sourceRepo`/`sourceCommit`/`sourceBranch`、`generatedAt`、
`fileCount`、`totalBytes`、`sections`（packages/tests/tools 的文件数与聚合 sha256）、
`packages[]`（每个包的目录、npm 名、文件数、聚合 sha256）、`packageNames`（实际发现
的包名列表，`--verify` 会与树内 `package.json` 交叉校验）、`assets[]`（迁移树自包含
所需的只读文件，如 schema 副本）、`unpackagedFiles`、`files[]`（逐文件 sha256）、
`excludedDirNames`。完整字段说明见
[`docs/migration/fork-migration-plan.md`](../../docs/migration/fork-migration-plan.md)。

包数量不写死：打包时递归发现 `packages/` 下所有含 `package.json` 的目录，数量随仓库
演进而变化，清单里记录当次实际结果。

## 自包含与 cwd 无关

`tools/verify/verify.mjs` 需要 `docs/prd/01-data-model.sql`。打包时会把该文件作为
**只读副本**复制到 `<out>/dsbot-v3/docs/prd/01-data-model.sql` 并登记进 `assets[]`
（二选一方案中的“复制 schema”，另一个“只依赖 `packages/store` 内的精简 schema”
未采用，因为 verify 校验的是完整 PRD DDL）。只要源树包含 `tools/verify/`，缺少该
schema 会让打包直接失败，避免产出跑不起来的迁移包。

`tools/verify` 与 `tools/migrate` 都用 `import.meta.url` 解析路径，不读
`process.cwd()`，所以迁移树可以在任意工作目录下自检：

```powershell
node <迁移树>/tools/verify/verify.mjs
node --test <迁移树>/tools/migrate/test
node --test <迁移树>/tests/e2e
```

## 排除规则

任意深度下名为 `.agent`、`node_modules`、`tmp`、`.git` 的**目录**不复制（符号链接也会跳过并记录）。
输出目录若被放在源树内部，会自动从复制范围排除，避免自我复制。

## 测试

```powershell
node --test tools/migrate/test          # 22 个用例
```

覆盖：目标布局、排除规则、MIGRATION.json 字段与磁盘一致性、幂等重跑、`SOURCE_DATE_EPOCH`
可复现、`--out` 在源目录内不自复制、拒绝覆盖源目录、真实仓库冒烟（动态发现包并校验
schema 副本）、sourceCommit 两种布局（上层 git 仓库的子目录 → 40 位 sha；完全无 git 的临时目录
→ `unknown`）、校验通过、内容篡改/删除/多出文件/清单被改后失败、包名与清单不一致时
失败、schema 资产篡改后失败、迁移树在任意 cwd 下 verify 通过、schema 缺失时的明确报错、
CLI 退出码（0/1/2）。

> `tools/migrate/test/package.json` 的 `main` 让 `node --test tools/migrate/test` 在
> Node 25.2.0（实测该版本不展开目录参数）下也能解析到 `run-all.mjs` 聚合入口。

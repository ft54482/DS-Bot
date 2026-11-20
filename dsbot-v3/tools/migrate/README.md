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
| `--source-commit <sha>` | 覆盖清单记录的源 commit（默认取 git HEAD，取不到时回退读 `.git`） |
| `--source-repo <owner/name>` | 覆盖清单记录的源仓库（默认 `ft54482/superagent-lab-smoke`） |
| `--generated-at <iso>` | 覆盖生成时间；也可设 `SOURCE_DATE_EPOCH` 做可复现打包 |
| `--help` | 打印用法 |

## MIGRATION.json

包含：`schemaVersion`、`sourceRepo`/`sourceCommit`/`sourceBranch`、`generatedAt`、
`fileCount`、`totalBytes`、`sections`（packages/tests/tools 的文件数与聚合 sha256）、
`packages[]`（每个包的目录、npm 名、文件数、聚合 sha256）、`unpackagedFiles`、
`files[]`（逐文件 sha256）、`excludedDirNames`。完整字段说明见
[`docs/migration/fork-migration-plan.md`](../../docs/migration/fork-migration-plan.md)。

## 排除规则

任意深度下名为 `.agent`、`node_modules`、`tmp`、`.git` 的**目录**不复制（符号链接也会跳过并记录）。
输出目录若被放在源树内部，会自动从复制范围排除，避免自我复制。

## 测试

```powershell
node --test tools/migrate/test          # 17 个用例
```

覆盖：目标布局、排除规则、MIGRATION.json 字段与磁盘一致性、幂等重跑、`SOURCE_DATE_EPOCH`
可复现、`--out` 在源目录内不自复制、拒绝覆盖源目录、真实仓库冒烟（23 包）、校验通过、
内容篡改/删除/多出文件/清单被改后失败、CLI 退出码（0/1/2）。

> `tools/migrate/test/package.json` 的 `main` 让 `node --test tools/migrate/test` 在
> Node 25.2.0（实测该版本不展开目录参数）下也能解析到 `run-all.mjs` 聚合入口。

-- DS Bot V3 · 任务运行层数据模型（SQLite）· v2（两级管理、一级执行）
--
-- 架构：你 → Chief(goal) → 业务 BOT(business) → DSH/SuperAgent(execution)
--      一套基础设施，按层级与 BOT 范围隔离；子任务完成 ≠ 父任务完成。
--
-- 约定：
--   * 时间为 INTEGER 毫秒（UTC）；金额 CNY。
--   * 状态/层级/阶段用 TEXT + CHECK；结构性规则（层级相邻、授权不得扩大）用触发器 + 程序双保险。
--   * append-only：task_event / evidence / cost_ledger / report / auth_log。
--   * 所有外部副作用操作必须有 idempotency_key（唯一索引）。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER PRIMARY KEY,
  applied_at  INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- 1. 主体：人 / Chief / 业务 BOT（执行器不是主体，是 run 的属性）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS principal (
  id            TEXT PRIMARY KEY,          -- 'human:ft54482' | 'bot:chief' | 'bot:video'
  kind          TEXT NOT NULL CHECK (kind IN ('human','chief','bot')),
  display_name  TEXT NOT NULL,
  -- 该主体能向下委托到的层级：chief 可委托 business；business bot 可委托 execution
  max_delegate_level TEXT CHECK (max_delegate_level IN ('business','execution',NULL)),
  -- 该主体自身的执行边界（业务 BOT 的授权上限，越界直接拒绝）
  authorization_json TEXT NOT NULL DEFAULT '{}', -- {projects:[], paths:[], tools:[], spend_cny_cap:…}
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);

-- BOT 级范围：一个 BOT 能看到/调度哪些项目与任务；Chief 不在其中（它看委托）
CREATE TABLE IF NOT EXISTS bot_scope (
  bot_id        TEXT NOT NULL REFERENCES principal(id) ON DELETE CASCADE,
  project       TEXT NOT NULL,
  can_delegate  INTEGER NOT NULL DEFAULT 0,     -- 能否向下派 execution
  can_accept    INTEGER NOT NULL DEFAULT 1,     -- 能否做 business 验收
  spend_cny_cap REAL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (bot_id, project)
);

-- ---------------------------------------------------------------------------
-- 2. 任务：三层（goal / business / execution）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task (
  id                TEXT PRIMARY KEY,           -- 'task-<ulid>'
  level             TEXT NOT NULL CHECK (level IN ('goal','business','execution')),
  title             TEXT NOT NULL,
  goal              TEXT NOT NULL,
  project           TEXT NOT NULL,
  -- 业务域：自媒体是当前主业；不同域有不同验收模板与执行器
  domain            TEXT NOT NULL DEFAULT 'ops' CHECK (domain IN (
                      'self_media',   -- 自媒体（当前主业）
                      'video',        -- 短视频
                      'agent_dev',    -- Agent 开发
                      'dsbot_dev',    -- DS Bot 二次开发
                      'ops'           -- 其他运营/内部事务
                    )),
  deliverable_kind  TEXT,                        -- 'article_pack'|'film'|'commit_set'|'report'|…
  acceptance_profile TEXT,                       -- 每类业务的验收模板，如 'self_media_v1'
  -- 命名权威：03-acceptance-spec.md §10。此处与之逐字一致，不另设同义词。
  state             TEXT NOT NULL CHECK (state IN (
                      'planned',      -- 已建单，未排队
                      'queued',       -- 已排队
                      'running',      -- 执行中
                      'accepting',    -- 待验收（执行器已自报，等本级验收）
                      'reworking',    -- 返修（下级验收未通过，等新 run）
                      'stopping',     -- 停止中（验收停写核实，未核实不得 cancelled）
                      'completed',    -- 本级验收通过（唯一交付态）
                      'blocked',      -- 阻塞（等用户/外部）
                      'paused',       -- 暂停（超预算/停工）
                      'cancelled'     -- 取消（停写已核实）
                    )),
  priority          INTEGER NOT NULL DEFAULT 50,

  -- 委托关系：谁委托给谁；parent 必须是上一级
  parent_task_id    TEXT REFERENCES task(id),
  delegator_kind    TEXT NOT NULL CHECK (delegator_kind IN ('human','chief','bot')),
  delegator_ref     TEXT NOT NULL,              -- principal.id
  owner_ref         TEXT NOT NULL,              -- principal.id（唯一负责人；跨级接管后变更）

  -- 授权：本任务允许执行的范围（子任务不得扩大）
  authorization_json TEXT NOT NULL DEFAULT '{}',-- {projects:[],paths:[],tools:[],spend_cny_cap:…}
  -- 验收要求：本层通过的标准（JSON 数组，结构见 03-acceptance-spec）
  acceptance_criteria TEXT NOT NULL DEFAULT '[]',
  hard_rules_json   TEXT NOT NULL DEFAULT '[]',

  -- 预算：自身额度（NULL=继承父级剩余）；实际可用 = min(自身, 父级剩余, bot_scope.cap)
  budget_cny_cap    REAL,
  budget_tokens_cap INTEGER,

  -- 完成判定：三层各自独立
  execution_done_at INTEGER,                    -- 执行层通过（代码/产物）
  business_done_at  INTEGER,                    -- 业务层通过（业务可用）
  goal_met_at       INTEGER,                    -- 目标层通过（用户目标达成）

  -- 当前主会话（可空）；一个 BOT 可同时管理多个任务，各自独立会话
  active_session_id TEXT,
  -- 执行实例（SuperAgent 按项目一套；普通会话可为空）
  executor_instance_id TEXT REFERENCES executor_instance(id),
  idempotency_key   TEXT UNIQUE,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  closed_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_task_state  ON task(state, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_task_level  ON task(level, project, state);
CREATE INDEX IF NOT EXISTS idx_task_parent ON task(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_task_owner  ON task(owner_ref, state);

-- 结构规则：层级必须相邻（goal→business→execution），层级创建后不可改
CREATE TRIGGER IF NOT EXISTS trg_task_level_adjacent_insert
BEFORE INSERT ON task
WHEN NEW.parent_task_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM task p
      WHERE p.id = NEW.parent_task_id
        AND ((NEW.level = 'business' AND p.level = 'goal')
          OR (NEW.level = 'execution' AND p.level = 'business'))
    )
    THEN RAISE(ABORT, 'invalid task hierarchy: parent level must be exactly one above')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_task_level_immutable
BEFORE UPDATE OF level, parent_task_id ON task
WHEN NEW.level <> OLD.level OR (NEW.parent_task_id IS NOT OLD.parent_task_id)
BEGIN
  SELECT RAISE(ABORT, 'task level and parent are immutable');
END;

-- 依赖
CREATE TABLE IF NOT EXISTS task_dependency (
  task_id         TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  depends_on_id   TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL DEFAULT 'blocks' CHECK (kind IN ('blocks','soft')),
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (task_id, depends_on_id)
);

-- 任务 ↔ 会话绑定：一个任务多会话（初始/返修/研究），同一 BOT 多任务互不共享上下文
CREATE TABLE IF NOT EXISTS task_session (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  session_id    TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('primary','rework','research')),
  executor_kind TEXT NOT NULL CHECK (executor_kind IN ('tool_chain','dsh_session','superagent','manual')),
  state         TEXT NOT NULL CHECK (state IN ('active','idle','archived','lost')),
  created_at    INTEGER NOT NULL,
  archived_at   INTEGER,
  UNIQUE (task_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_task_session ON task_session(task_id, state);

-- 执行实例：一个项目一套 SuperAgent（或会话池），独立端口/库/账号
CREATE TABLE IF NOT EXISTS executor_instance (
  id            TEXT PRIMARY KEY,
  project       TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL CHECK (kind IN ('superagent','dsh_session_pool')),
  profile       TEXT NOT NULL,
  workdir       TEXT NOT NULL,
  port          INTEGER,
  repo          TEXT,
  account       TEXT,
  db_path       TEXT,
  version_json  TEXT NOT NULL DEFAULT '{}',
  state         TEXT NOT NULL CHECK (state IN (
                  'provisioning','starting','ready','busy','degraded','stopped','failed'
                )),
  health_json   TEXT NOT NULL DEFAULT '{}',
  last_seen_at  INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_instance_state ON executor_instance(state, last_seen_at);

-- ---------------------------------------------------------------------------
-- 3. 委托：一次委托的契约（目标、范围、预算、验收要求、期限）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS delegation (
  id              TEXT PRIMARY KEY,
  from_task_id    TEXT REFERENCES task(id),      -- Chief 的 goal 任务（可为空=人直接委托 BOT）
  from_principal  TEXT NOT NULL REFERENCES principal(id),
  to_principal    TEXT NOT NULL REFERENCES principal(id),
  to_task_id      TEXT REFERENCES task(id),      -- 业务任务
  scope_json      TEXT NOT NULL,                 -- 目标/范围/不可做事项
  acceptance_json TEXT NOT NULL,                 -- 上级要求的验收口径
  budget_cny      REAL,
  due_at          INTEGER,
  state           TEXT NOT NULL CHECK (state IN ('proposed','accepted','rejected','revoked','fulfilled')),
  idempotency_key TEXT UNIQUE,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deleg_from ON delegation(from_principal, created_at);
CREATE INDEX IF NOT EXISTS idx_deleg_to   ON delegation(to_principal, state);

-- ---------------------------------------------------------------------------
-- 4. 执行：一次具体派发（任务可多次 run：返修/重试/换会话）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS run (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  run_no            INTEGER NOT NULL,
  attempt           INTEGER NOT NULL DEFAULT 1,
  -- 命名权威：03-acceptance-spec.md §10.2
  state             TEXT NOT NULL CHECK (state IN (
                      'queued',           -- 已建记录，未派发
                      'dispatched',       -- 已调桥，等回执
                      'dispatch_unknown', -- 回执丢失，禁止盲目重发，先对账
                      'running',          -- 已确认执行中
                      'reported',         -- 执行器自报完成（≠ 验收通过）
                      'accepted',         -- 本级验收通过（唯一算交付的 run 终态）
                      'rejected',         -- 验收不通过
                      'invalidated',      -- 产物被改写/版本漂移，作废
                      'superseded',       -- 被新 run 取代
                      'failed',
                      'cancelled',
                      'lost',             -- 失联（状态未知）
                      'timed_out'         -- 已知超时
                    )),
  executor_kind     TEXT NOT NULL CHECK (executor_kind IN (
                      'tool_chain',   -- 内容/视频工具链（不经 DSH）
                      'dsh_session',  -- 普通 DSH 会话
                      'superagent',   -- SuperAgent 工单
                      'manual'        -- 人工执行（发布/付款/生产变更）
                    )),
  session_id        TEXT,
  workspace_path    TEXT,
  base_commit       TEXT,
  model             TEXT,
  -- 实际执行身份与授权来源（审计用；不要求机器人账号，也不为规则索取额外权限）
  executor_identity TEXT,                        -- 'dsh:session-…' | 'superagent:ticket-…' | 'bot:<id>' | 'human:<id>'
  authorization_ref TEXT,                        -- 授权记录引用（任务/委托/人工授权 id）
  authorization_json TEXT NOT NULL DEFAULT '{}', -- 派发时冻结的授权（不得越权）
  idempotency_key   TEXT NOT NULL UNIQUE,
  started_at        INTEGER,
  ended_at          INTEGER,
  exit_reason       TEXT,
  tokens_in         INTEGER NOT NULL DEFAULT 0,
  tokens_out        INTEGER NOT NULL DEFAULT 0,
  tokens_cached     INTEGER NOT NULL DEFAULT 0,
  cost_cny          REAL NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE (task_id, run_no, attempt)
);
CREATE INDEX IF NOT EXISTS idx_run_task ON run(task_id, run_no);
CREATE INDEX IF NOT EXISTS idx_run_state ON run(state, updated_at);
CREATE INDEX IF NOT EXISTS idx_run_session ON run(session_id);

-- ---------------------------------------------------------------------------
-- 5. 发件箱 / 收件箱（可靠性基础）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dispatch_outbox (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES task(id),
  run_id          TEXT REFERENCES run(id),
  principal_ref   TEXT NOT NULL,                 -- 由哪个 BOT 的适配器发出（审计）
  intent          TEXT NOT NULL CHECK (intent IN (
                    'delegate','dispatch_run','cancel_run','send_message','request_acceptance','stop_subtree'
                  )),
  payload_json    TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('pending','sending','sent','acked','failed','unknown')),
  idempotency_key TEXT NOT NULL UNIQUE,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_retry_at   INTEGER,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  sent_at         INTEGER,
  acked_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_outbox_state ON dispatch_outbox(state, next_retry_at);

CREATE TABLE IF NOT EXISTS event_inbox (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL,                   -- 'dsh'|'superagent'|'manual'|'reconcile'|'bot'
  source_seq    INTEGER,
  event_key     TEXT NOT NULL UNIQUE,
  task_id       TEXT REFERENCES task(id),
  run_id        TEXT REFERENCES run(id),
  principal_ref TEXT,                            -- 事件属于哪个 BOT 的范围
  type          TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  received_at   INTEGER NOT NULL,
  processed_at  INTEGER,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processed','ignored','failed'))
);
CREATE INDEX IF NOT EXISTS idx_inbox_status ON event_inbox(status, received_at);
CREATE INDEX IF NOT EXISTS idx_inbox_seq    ON event_inbox(source, source_seq);

CREATE TABLE IF NOT EXISTS event_watermark (
  source        TEXT PRIMARY KEY,
  last_seq      INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- 6. 验收：三级（execution / business / goal），结论绑定版本，不可互相冒充
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claim (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  run_id      TEXT REFERENCES run(id) ON DELETE CASCADE,
  stage       TEXT NOT NULL CHECK (stage IN ('execution','business','goal')),
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS acceptance (
  id              TEXT PRIMARY KEY,
  stage           TEXT NOT NULL CHECK (stage IN ('execution','business','goal')),
  target_task_id  TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  run_id          TEXT REFERENCES run(id) ON DELETE CASCADE,
  -- 验收主体：commit + 产物清单（决策时必须重算指纹，不信声明值）
  subject         TEXT,                          -- 'commit:<sha>' | 'artifacts:<n>'
  subject_fingerprint TEXT,                      -- 重算得到的内容指纹
  target_commit   TEXT,                          -- 冗余保留，便于查询
  artifact_hashes TEXT NOT NULL DEFAULT '[]',    -- [{path,sha256,bytes}]
  state           TEXT NOT NULL DEFAULT 'open' CHECK (state IN (
                    'open',        -- 进行中
                    'passed',      -- 本级通过（唯一能推进本级的结论）
                    'rejected',    -- 不通过（→ 返修或失败）
                    'invalidated', -- 产物在验收期间被改写/版本漂移
                    'superseded'   -- 被新一轮验收取代
                  )),
  mode            TEXT NOT NULL CHECK (mode IN ('auto','independent','human')),
  criteria_json   TEXT NOT NULL,
  reviewer        TEXT,
  notes           TEXT,
  created_at      INTEGER NOT NULL,
  decided_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_acc_task  ON acceptance(target_task_id, stage, created_at);
CREATE INDEX IF NOT EXISTS idx_acc_run   ON acceptance(run_id);

-- 一轮验收由多个 item 组成；每个 item 独立判定，汇总才得出 acceptance.state
CREATE TABLE IF NOT EXISTS acceptance_item (
  id            TEXT PRIMARY KEY,
  acceptance_id TEXT NOT NULL REFERENCES acceptance(id) ON DELETE CASCADE,
  class         TEXT NOT NULL CHECK (class IN ('auto','independent','human')),
  criterion     TEXT NOT NULL,                   -- 判定标准（可机器判定的写成断言）
  result        TEXT NOT NULL DEFAULT 'pending' CHECK (result IN ('pending','pass','fail','blocked')),
  detail        TEXT,
  decided_by    TEXT,                            -- 验收器主体（不得为代码作者本人）
  decided_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_item_acceptance ON acceptance_item(acceptance_id);

CREATE TABLE IF NOT EXISTS evidence (
  id            TEXT PRIMARY KEY,
  acceptance_id TEXT NOT NULL REFERENCES acceptance(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  ref           TEXT NOT NULL,
  sha256        TEXT,
  command       TEXT,
  output_excerpt TEXT,
  recorded_at   INTEGER NOT NULL,
  env_json      TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_ev_acceptance ON evidence(acceptance_id);

-- 逐级汇报：下级向上级交付的摘要（不含原始日志）
CREATE TABLE IF NOT EXISTS report (
  id            TEXT PRIMARY KEY,
  from_task_id  TEXT NOT NULL REFERENCES task(id),
  to_task_id    TEXT REFERENCES task(id),
  stage         TEXT NOT NULL CHECK (stage IN ('execution','business','goal')),
  summary_json  TEXT NOT NULL,                   -- {progress,risks,deliverables,needs_decision}
  evidence_ref  TEXT,                            -- 证据索引（可下钻）
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_report_to ON report(to_task_id, created_at);

-- 发布/上线/付款许可：与验收解耦（验收通过 ≠ 获得许可，D-V3-23）
CREATE TABLE IF NOT EXISTS publish_authorization (
  id                  TEXT PRIMARY KEY,
  task_id             TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  run_id              TEXT REFERENCES run(id) ON DELETE CASCADE,
  action              TEXT NOT NULL CHECK (action IN ('publish','deploy','pay','prod_change')),
  target              TEXT NOT NULL,              -- 平台/账号/环境，如 'wechat:公众号A' 'prod:main'
  content_fingerprint TEXT NOT NULL,              -- 许可绑定的内容/产物指纹；内容变更即失效
  state               TEXT NOT NULL DEFAULT 'granted' CHECK (state IN ('granted','used','revoked','expired')),
  granted_by          TEXT NOT NULL,              -- principal.id（通常 human）
  granted_at          INTEGER NOT NULL,
  expires_at          INTEGER,
  notes               TEXT
);
CREATE INDEX IF NOT EXISTS idx_pub_task ON publish_authorization(task_id, action, state);

-- ---------------------------------------------------------------------------
-- 7. 规则 / 决定 / 审计
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rule (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('hard','soft')),
  scope         TEXT NOT NULL CHECK (scope IN ('global','project','task')),
  project       TEXT,
  task_id       TEXT REFERENCES task(id),
  text          TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  source        TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  effective_from INTEGER NOT NULL,
  effective_to   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_rule_scope ON rule(scope, project, active);

CREATE TABLE IF NOT EXISTS rule_violation (
  id          TEXT PRIMARY KEY,
  rule_id     TEXT NOT NULL REFERENCES rule(id),
  run_id      TEXT REFERENCES run(id),
  task_id     TEXT REFERENCES task(id),
  detail      TEXT NOT NULL,
  detected_at INTEGER NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('blocked','warned'))
);

CREATE TABLE IF NOT EXISTS decision (
  id          TEXT PRIMARY KEY,
  project     TEXT,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'accepted' CHECK (status IN ('proposed','accepted','superseded','rejected')),
  supersedes  TEXT REFERENCES decision(id),
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_event (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  run_id      TEXT,
  type        TEXT NOT NULL,
  from_state  TEXT,
  to_state    TEXT,
  actor       TEXT NOT NULL,                     -- principal.id 或 'system:scheduler'
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_te_task ON task_event(task_id, created_at);

-- 授权检查日志：每次派发/工具调用检查是否越界，留痕
CREATE TABLE IF NOT EXISTS auth_log (
  id          TEXT PRIMARY KEY,
  principal_ref TEXT NOT NULL,
  task_id     TEXT,
  run_id      TEXT,
  check_kind  TEXT NOT NULL,                     -- 'dispatch'|'tool'|'path'|'spend'
  request_json TEXT NOT NULL,
  decision    TEXT NOT NULL CHECK (decision IN ('allow','deny')),
  reason      TEXT,
  at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_principal ON auth_log(principal_ref, at);

-- ---------------------------------------------------------------------------
-- 8. 会话谱系 / 工作区
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS session_lineage (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES task(id),
  run_id          TEXT REFERENCES run(id),
  from_session    TEXT,
  to_session      TEXT NOT NULL,
  reason          TEXT NOT NULL,                 -- new_task|context_budget|stale|parallel|takeover|user_request
  handoff_path    TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lineage_task ON session_lineage(task_id, created_at);

CREATE TABLE IF NOT EXISTS worktree (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES task(id),
  run_id        TEXT REFERENCES run(id),
  path          TEXT NOT NULL UNIQUE,
  base_commit   TEXT,
  state         TEXT NOT NULL CHECK (state IN ('leased','active','released','dirty')),
  leased_until  INTEGER,
  created_at    INTEGER NOT NULL,
  released_at   INTEGER
);

-- ---------------------------------------------------------------------------
-- 9. 成本 / 产物
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cost_ledger (
  id        TEXT PRIMARY KEY,
  task_id   TEXT NOT NULL REFERENCES task(id),
  run_id    TEXT REFERENCES run(id),
  kind      TEXT NOT NULL CHECK (kind IN ('llm','tool','acceptance','other')),
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  tokens_cached INTEGER NOT NULL DEFAULT 0,
  cost_cny  REAL NOT NULL DEFAULT 0,
  at        INTEGER NOT NULL,
  detail    TEXT
);
CREATE INDEX IF NOT EXISTS idx_cost_task ON cost_ledger(task_id, at);

CREATE TABLE IF NOT EXISTS artifact (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES task(id),
  run_id      TEXT REFERENCES run(id),
  path        TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifact_task ON artifact(task_id);

-- 预算台账：给某子树设定的额度（含 BOT 级）；实际可用取链路最小值
CREATE TABLE IF NOT EXISTS budget_grant (
  id            TEXT PRIMARY KEY,
  task_id       TEXT REFERENCES task(id),
  principal_ref TEXT,
  cap_cny       REAL NOT NULL,
  cap_tokens    INTEGER,
  period        TEXT NOT NULL DEFAULT 'task' CHECK (period IN ('task','day','month')),
  created_at    INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- 10. 停止 / 升级 / 跨级接管 / 人工介入 / 对账
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stop_request (
  id              TEXT PRIMARY KEY,
  root_task_id    TEXT NOT NULL REFERENCES task(id),
  requested_by    TEXT NOT NULL REFERENCES principal(id),
  scope           TEXT NOT NULL DEFAULT 'subtree' CHECK (scope IN ('subtree','task')),
  reason          TEXT,
  requested_at    INTEGER NOT NULL,
  verified_at     INTEGER,                       -- 停写核实时间（NULL=未核实）
  verify_detail   TEXT                           -- 进程树/文件稳定性/会话 idle 的核实结果
);

CREATE TABLE IF NOT EXISTS escalation (
  id              TEXT PRIMARY KEY,
  from_task_id    TEXT NOT NULL REFERENCES task(id),
  to_principal    TEXT NOT NULL REFERENCES principal(id),   -- 通常上级 BOT 或 Chief
  kind            TEXT NOT NULL CHECK (kind IN ('blocked','conflict','budget','direction','quality')),
  detail          TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','answered','closed')),
  created_at      INTEGER NOT NULL,
  answered_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_esc_open ON escalation(state, created_at);

CREATE TABLE IF NOT EXISTS takeover (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES task(id),
  from_principal TEXT NOT NULL REFERENCES principal(id),
  to_principal   TEXT NOT NULL REFERENCES principal(id),
  reason        TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('requested','active','released')),
  created_at    INTEGER NOT NULL,
  released_at   INTEGER
);

CREATE TABLE IF NOT EXISTS user_intervention (
  id          TEXT PRIMARY KEY,
  task_id     TEXT REFERENCES task(id),
  kind        TEXT NOT NULL,
  question    TEXT NOT NULL,
  answer      TEXT,
  asked_at    INTEGER NOT NULL,
  answered_at INTEGER
);

CREATE TABLE IF NOT EXISTS reconcile_log (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,
  at          INTEGER NOT NULL,
  checked     INTEGER NOT NULL,
  fixed       INTEGER NOT NULL,
  detail      TEXT
);

-- ---------------------------------------------------------------------------
-- 11. 视图：成本/预算沿层级汇总
-- ---------------------------------------------------------------------------
CREATE VIEW IF NOT EXISTS v_task_children AS
WITH RECURSIVE tree(root_id, id) AS (
  SELECT id, id FROM task
  UNION ALL
  SELECT t.root_id, c.id FROM tree t JOIN task c ON c.parent_task_id = t.id
)
SELECT root_id, id FROM tree;

-- 完成守卫：任务不能在没有"本级 acceptance passed"的情况下进入 completed
CREATE TRIGGER IF NOT EXISTS trg_completed_guard
BEFORE UPDATE OF state ON task
WHEN NEW.state = 'completed' AND OLD.state <> 'completed'
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM acceptance a
      WHERE a.target_task_id = NEW.id
        AND a.state = 'passed'
        AND a.stage = NEW.level
    )
    THEN RAISE(ABORT, 'cannot complete: no passed acceptance at this level')
  END;
END;

CREATE VIEW IF NOT EXISTS v_task_cost AS
SELECT ch.root_id AS task_id,
       COUNT(DISTINCT c.task_id) AS paid_tasks,
       SUM(c.cost_cny) AS cost_cny,
       SUM(c.tokens_in) AS tokens_in,
       SUM(c.tokens_out) AS tokens_out,
       SUM(c.tokens_cached) AS tokens_cached
FROM v_task_children ch
JOIN cost_ledger c ON c.task_id = ch.id
GROUP BY ch.root_id;

CREATE VIEW IF NOT EXISTS v_bot_workload AS
SELECT t.owner_ref AS principal_ref,
       COUNT(*) FILTER (WHERE t.state IN ('queued','running','awaiting_acceptance','rework')) AS open_tasks,
       COUNT(*) FILTER (WHERE t.state = 'blocked') AS blocked_tasks,
       MIN(t.created_at) AS oldest_open_at
FROM task t
GROUP BY t.owner_ref;

INSERT OR IGNORE INTO schema_version(version, applied_at) VALUES (7, CAST(strftime('%s','now') AS INTEGER) * 1000);

-- DS Bot V3 · L1 最小任务库 · 001_init
-- 依据：docs/prd/01-data-model.sql（字段与约束沿用；裁剪到 12 张 MVP 表）。
-- 裁剪说明：executor_instance / principal / delegation / report 等表不在 L1 范围，
-- 因此 task.executor_instance_id 保留列但去掉外键；12 张表之间的外键保持不变。
-- 守卫（触发器）不得删除：层级相邻、层级不可变、完成必须有本级 acceptance passed。

CREATE TABLE IF NOT EXISTS task (
  id                TEXT PRIMARY KEY,
  level             TEXT NOT NULL CHECK (level IN ('goal','business','execution')),
  title             TEXT NOT NULL,
  goal              TEXT NOT NULL,
  project           TEXT NOT NULL,
  domain            TEXT NOT NULL DEFAULT 'ops' CHECK (domain IN (
                      'self_media',
                      'video',
                      'agent_dev',
                      'dsbot_dev',
                      'ops'
                    )),
  deliverable_kind  TEXT,
  acceptance_profile TEXT,
  state             TEXT NOT NULL CHECK (state IN (
                      'planned',
                      'queued',
                      'running',
                      'accepting',
                      'reworking',
                      'stopping',
                      'completed',
                      'blocked',
                      'paused',
                      'cancelled'
                    )),
  priority          INTEGER NOT NULL DEFAULT 50,
  parent_task_id    TEXT REFERENCES task(id),
  delegator_kind    TEXT NOT NULL CHECK (delegator_kind IN ('human','chief','bot')),
  delegator_ref     TEXT NOT NULL,
  owner_ref         TEXT NOT NULL,
  authorization_json TEXT NOT NULL DEFAULT '{}',
  acceptance_criteria TEXT NOT NULL DEFAULT '[]',
  hard_rules_json   TEXT NOT NULL DEFAULT '[]',
  budget_cny_cap    REAL,
  budget_tokens_cap INTEGER,
  execution_done_at INTEGER,
  business_done_at  INTEGER,
  goal_met_at       INTEGER,
  active_session_id TEXT,
  executor_instance_id TEXT,
  idempotency_key   TEXT UNIQUE,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  closed_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_task_state  ON task(state, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_task_level  ON task(level, project, state);
CREATE INDEX IF NOT EXISTS idx_task_parent ON task(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_task_owner  ON task(owner_ref, state);

-- 结构规则：层级必须相邻（goal→business→execution）
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

-- 结构规则：层级与父子关系创建后不可改
CREATE TRIGGER IF NOT EXISTS trg_task_level_immutable
BEFORE UPDATE OF level, parent_task_id ON task
WHEN NEW.level <> OLD.level OR (NEW.parent_task_id IS NOT OLD.parent_task_id)
BEGIN
  SELECT RAISE(ABORT, 'task level and parent are immutable');
END;

CREATE TABLE IF NOT EXISTS run (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  run_no            INTEGER NOT NULL,
  attempt           INTEGER NOT NULL DEFAULT 1,
  state             TEXT NOT NULL CHECK (state IN (
                      'queued',
                      'dispatched',
                      'dispatch_unknown',
                      'running',
                      'reported',
                      'accepted',
                      'rejected',
                      'invalidated',
                      'superseded',
                      'failed',
                      'cancelled',
                      'lost',
                      'timed_out'
                    )),
  executor_kind     TEXT NOT NULL CHECK (executor_kind IN (
                      'tool_chain',
                      'dsh_session',
                      'superagent',
                      'manual'
                    )),
  session_id        TEXT,
  workspace_path    TEXT,
  base_commit       TEXT,
  model             TEXT,
  executor_identity TEXT,
  authorization_ref TEXT,
  authorization_json TEXT NOT NULL DEFAULT '{}',
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

CREATE TABLE IF NOT EXISTS dispatch_outbox (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES task(id),
  run_id          TEXT REFERENCES run(id),
  principal_ref   TEXT NOT NULL,
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
  source        TEXT NOT NULL,
  source_seq    INTEGER,
  event_key     TEXT NOT NULL UNIQUE,
  task_id       TEXT REFERENCES task(id),
  run_id        TEXT REFERENCES run(id),
  principal_ref TEXT,
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
  subject         TEXT,
  subject_fingerprint TEXT,
  target_commit   TEXT,
  artifact_hashes TEXT NOT NULL DEFAULT '[]',
  state           TEXT NOT NULL DEFAULT 'open' CHECK (state IN (
                    'open',
                    'passed',
                    'rejected',
                    'invalidated',
                    'superseded'
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

CREATE TABLE IF NOT EXISTS acceptance_item (
  id            TEXT PRIMARY KEY,
  acceptance_id TEXT NOT NULL REFERENCES acceptance(id) ON DELETE CASCADE,
  class         TEXT NOT NULL CHECK (class IN ('auto','independent','human')),
  criterion     TEXT NOT NULL,
  result        TEXT NOT NULL DEFAULT 'pending' CHECK (result IN ('pending','pass','fail','blocked')),
  detail        TEXT,
  decided_by    TEXT,
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

CREATE TABLE IF NOT EXISTS task_event (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  run_id      TEXT,
  type        TEXT NOT NULL,
  from_state  TEXT,
  to_state    TEXT,
  actor       TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_te_task ON task_event(task_id, created_at);

CREATE TABLE IF NOT EXISTS publish_authorization (
  id                  TEXT PRIMARY KEY,
  task_id             TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  run_id              TEXT REFERENCES run(id) ON DELETE CASCADE,
  action              TEXT NOT NULL CHECK (action IN ('publish','deploy','pay','prod_change')),
  target              TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL,
  state               TEXT NOT NULL DEFAULT 'granted' CHECK (state IN ('granted','used','revoked','expired')),
  granted_by          TEXT NOT NULL,
  granted_at          INTEGER NOT NULL,
  expires_at          INTEGER,
  notes               TEXT
);
CREATE INDEX IF NOT EXISTS idx_pub_task ON publish_authorization(task_id, action, state);

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

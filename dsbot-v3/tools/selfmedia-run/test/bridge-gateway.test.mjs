import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { readJson, runCli, tempDir, writeJson } from './support.mjs';

const SECRET = 'bridge-secret-for-tests-0123456789';
const CLAIM = '采用双人复核后，错误率从 18% 降到 7%。';

function sourcePack() {
  return {
    topic: '桥接选题',
    sources: [
      {
        url: 'https://one.bridge.invalid/a',
        title: '材料一',
        text: `材料一记录了一个编辑团队的流程变化。${CLAIM}团队在发布前由第二位编辑逐条核对来源。`,
        claims: [{ text: CLAIM, key: true }],
      },
      {
        url: 'https://two.bridge.invalid/b',
        title: '材料二',
        text: `材料二访谈了另一个团队，得到同样的结论。${CLAIM}受访者强调复核要留下记录。`,
        claims: [{ text: CLAIM, key: true }],
      },
    ],
    facts: [
      {
        claim: CLAIM,
        key: true,
        source_refs: ['https://one.bridge.invalid/a', 'https://two.bridge.invalid/b'],
      },
    ],
  };
}

function writerBody() {
  return [
    '# 桥接选题',
    '',
    '围绕这个选题，两组材料都记录了一次可复用的流程变化。',
    '',
    '## 事实与引用',
    '',
    `${CLAIM} [1][2]`,
    '',
    '## 可以怎么做',
    '',
    '- 把复核步骤固定下来，并留下可追溯的记录。',
    '- 发布前逐条核对来源。',
    '',
    '## 待确认',
    '',
    '- 来源样本是否覆盖不同规模的团队。',
    '',
    '## 来源',
    '',
    '[1] https://one.bridge.invalid/a',
    '[2] https://two.bridge.invalid/b',
    '',
  ].join('\n');
}

function reviewerPayload() {
  return {
    rubric: {
      factuality: { score: 95, evidence: ['numbers trace to the pack'] },
      sourcing: { score: 95, evidence: ['two hosts'] },
      structure: { score: 95, evidence: ['complete sections'] },
      readability: { score: 95, evidence: ['short paragraphs'] },
      style: { score: 95, evidence: ['plain language'] },
      compliance: { score: 95, evidence: ['license stays unauthorized'] },
    },
    issues: [],
    verdict: 'passed',
  };
}

function writerPayload() {
  return {
    title_candidates: ['桥接选题：一条可核查的流程变化', '把复核写进流程', '桥接选题的实践记录'],
    body: writerBody(),
  };
}

function mcpResult(id, value) {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    text: async () =>
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(value) }],
          isError: false,
          structuredContent: value,
        },
      }),
  };
}

function mcpResponse(id, result) {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    text: async () => JSON.stringify({ jsonrpc: '2.0', id, result }),
  };
}

function mcpToolError(id, code, message) {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    text: async () =>
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `ERROR ${code}: ${message}` }],
          isError: true,
        },
      }),
  };
}

/**
 * A fake MCP bridge. Every request must carry exactly `Authorization: Bearer
 * <SECRET>`; the secret never appears in the URL or body. No network is used.
 */
function fakeBridge({ failMode = null } = {}) {
  const state = {
    calls: 0,
    creates: 0,
    sessionIds: [],
    prompts: [],
    follows: [],
    auth: [],
    bodies: [],
  };

  const fetchImpl = async (url, init) => {
    state.calls += 1;
    state.auth.push(init?.headers?.authorization ?? null);
    state.bodies.push(String(init?.body ?? ''));
    assert.equal(state.auth.at(-1), `Bearer ${SECRET}`, 'every bridge request must use Bearer auth');
    assert.equal(String(url).includes(SECRET), false, 'the secret must not appear in the URL');

    if (failMode === 'connect') throw new Error(`connect ECONNREFUSED ${url}`);

    const envelope = JSON.parse(String(init.body));
    if (envelope.method === 'initialize') {
      return mcpResponse(envelope.id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'fake-bridge', version: 'test' },
      });
    }
    if (envelope.method === 'notifications/initialized') {
      return { status: 202, headers: {}, text: async () => '' };
    }
    if (envelope.method !== 'tools/call') {
      throw new Error(`unexpected MCP method: ${envelope.method}`);
    }

    const { name, arguments: args = {} } = envelope.params;
    if (name === 'dsh_create_session') {
      state.creates += 1;
      const sessionId = `ds-session-${state.creates}`;
      state.sessionIds.push(sessionId);
      return mcpResult(envelope.id, { sessionId, cwd: args.cwd });
    }
    if (name === 'dsh_prompt') {
      state.prompts.push({ sessionId: args.sessionId, text: args.text });
      return mcpResult(envelope.id, { accepted: true, sessionId: args.sessionId });
    }
    if (name === 'dsh_follow') {
      const index = state.follows.length;
      state.follows.push({ sessionId: args.sessionId, sinceSeq: args.sinceSeq, timeoutMs: args.timeoutMs });
      if (failMode === 'timeout') {
        return mcpResult(envelope.id, {
          sessionId: args.sessionId,
          records: [],
          projections: { values: { turnOutline: [] } },
          timedOut: true,
          hasMore: false,
        });
      }
      if (failMode === 'empty') {
        return mcpResult(envelope.id, {
          sessionId: args.sessionId,
          records: [{ seq: index * 2 + 1, type: 'turn/end', data: {} }],
          projections: { values: { turnOutline: [] } },
          timedOut: false,
          hasMore: false,
        });
      }
      if (failMode === 'reviewer-error' && index === 1) {
        return mcpToolError(envelope.id, 'HOST_ERROR', 'reviewer host went away');
      }
      const prompt = state.prompts[index];
      const isReviewer = String(prompt?.text ?? '').includes('独立审校');
      const answer = JSON.stringify(isReviewer ? reviewerPayload() : writerPayload());
      return mcpResult(envelope.id, {
        sessionId: args.sessionId,
        records: [
          {
            seq: index * 2 + 1,
            type: 'message',
            time: index * 2 + 1,
            data: { role: 'assistant', content: [{ type: 'text', text: answer }] },
          },
          { seq: index * 2 + 2, type: 'turn/end', time: index * 2 + 2, data: { reason: { kind: 'ok' } } },
        ],
        projections: { values: { turnOutline: [] } },
        cursor: { lastSeq: index * 2 + 2 },
        timedOut: false,
        hasMore: false,
      });
    }
    throw new Error(`unexpected bridge tool: ${name}`);
  };

  return { state, fetchImpl };
}

function bridgeEnv(secretFile) {
  return { DSBOT_BRIDGE_SECRET_FILE: secretFile };
}

function writeSecret(t) {
  const file = join(tempDir(t), 'bridge.secret');
  writeFileSync(file, `${SECRET}\n`, 'utf8');
  return file;
}

test('--gateway bridge creates one DSH session and reuses it for writer and reviewer', async (t) => {
  const out = tempDir(t);
  const packFile = join(tempDir(t), 'sources.json');
  writeJson(packFile, sourcePack());
  const secretFile = writeSecret(t);
  const bridge = fakeBridge();

  const result = await runCli(
    ['--topic', '桥接选题', '--out', out, '--real', '--gateway', 'bridge', '--sources', packFile],
    { env: bridgeEnv(secretFile), fetchImpl: bridge.fetchImpl },
  );

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /status: ready_for_review/);

  // One session, two prompts in writer -> reviewer order, same sessionId.
  assert.equal(bridge.state.creates, 1);
  assert.deepEqual(bridge.state.sessionIds, ['ds-session-1']);
  assert.equal(bridge.state.prompts.length, 2);
  assert.equal(bridge.state.prompts[0].sessionId, 'ds-session-1');
  assert.equal(bridge.state.prompts[1].sessionId, 'ds-session-1');
  assert.match(bridge.state.prompts[0].text, /已核查事实/);
  assert.match(bridge.state.prompts[1].text, /独立审校/);
  assert.match(bridge.state.prompts[1].text, /正文/);

  // Each finished turn was read with follow slices; the fake answers the first
  // slice with the text, and the cursor advances between turns.
  assert.deepEqual(
    bridge.state.follows.map((follow) => follow.sinceSeq),
    [0, 2],
  );
  assert.ok(bridge.state.follows.every((follow) => follow.sessionId === 'ds-session-1'));
  assert.ok(bridge.state.follows.every((follow) => follow.timeoutMs <= 30_000));
  for (const body of bridge.state.bodies) assert.equal(body.includes(SECRET), false);

  const pack = readJson(out, 'article-pack.json');
  const report = readJson(out, 'report.json');
  assert.equal(pack.status, 'ready_for_review');
  assert.equal(pack.review.verdict, 'passed');
  assert.equal(report.gateway, 'bridge');
  assert.equal(report.env.gateway, 'bridge');
  assert.equal(report.env.api_key_present, false);
  assert.equal(report.env.api_key_logged, false);
  assert.equal(report.env.bridge_secret_present, true);
  assert.equal(report.env.bridge_secret_logged, false);
  assert.equal(report.model_calls.total, 2);
  assert.equal(report.model_calls.writer, 1);
  assert.equal(report.model_calls.reviewer, 1);

  // The secret is only in the Authorization header: no artifact or output has it.
  assert.equal(result.stdout.includes(SECRET), false);
  assert.equal(result.stderr.includes(SECRET), false);
  for (const name of readdirSync(out)) {
    const text = readFileSync(join(out, name), 'utf8');
    assert.equal(text.includes(SECRET), false, `${name} leaked the bridge secret`);
  }
});

for (const [label, failMode, expectedCode] of [
  ['an empty reply', 'empty', 'empty_completion'],
  ['a follow timeout', 'timeout', 'timeout'],
  ['a connection failure', 'connect', 'upstream_error'],
  ['a reviewer failure after a successful draft', 'reviewer-error', 'upstream_error'],
]) {
  test(`--gateway bridge fails with a non-zero exit on ${label}`, async (t) => {
    const out = tempDir(t);
    const packFile = join(tempDir(t), 'sources.json');
    writeJson(packFile, sourcePack());
    const secretFile = writeSecret(t);
    const bridge = fakeBridge({ failMode });

    const result = await runCli(
      ['--topic', '桥接选题', '--out', out, '--real', '--gateway', 'bridge', '--sources', packFile],
      {
        // A bridge timeout is only reached after the budget is spent; keep the
        // fake-clock-free CLI test to a couple of real seconds.
        env: {
          ...bridgeEnv(secretFile),
          ...(failMode === 'timeout' ? { DSBOT_BRIDGE_TIMEOUT_MS: '1500' } : {}),
        },
        fetchImpl: bridge.fetchImpl,
      },
    );

    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.stdout.includes('ready_for_review'), false);
    const pack = readJson(out, 'article-pack.json');
    const report = readJson(out, 'report.json');
    assert.equal(pack.status, 'failed');
    assert.match(pack.body, /运行失败/);
    assert.equal(report.status, 'failed');
    assert.equal(report.error.code, expectedCode);
    // The failure path never fabricates a fake article.
    assert.equal(pack.source_list.length, 0);
    assert.equal(result.stdout.includes(SECRET), false);
    assert.equal(result.stderr.includes(SECRET), false);
  });
}

test('--real --gateway bridge without a bridge secret file exits 2 without an API key demand', async (t) => {
  const out = tempDir(t);
  let calls = 0;
  const result = await runCli(
    ['--topic', '桥接选题', '--out', out, '--real', '--gateway', 'bridge'],
    {
      env: { DSBOT_BRIDGE_SECRET_FILE: join(out, 'missing-bridge.secret') },
      fetchImpl: async () => {
        calls += 1;
        throw new Error('no request may be sent without a bridge secret');
      },
    },
  );

  assert.equal(result.code, 2);
  assert.equal(calls, 0);
  assert.match(result.stderr, /bridge secret file/);
  assert.match(result.stderr, /DSBOT_BRIDGE_SECRET_FILE/);
  assert.equal(result.stderr.includes('DSBOT_MODEL_API_KEY'), false);
  assert.equal(result.stderr.includes('DSBOT_MODEL_BASE_URL'), false);
});

test('--gateway bridge is rejected outside --real and the value is validated', async (t) => {
  const out = tempDir(t);
  const fake = await runCli(['--topic', '桥接选题', '--out', out, '--gateway', 'bridge']);
  assert.equal(fake.code, 2);
  assert.match(fake.stderr, /--gateway bridge is only valid with --real/);

  const invalid = await runCli(['--topic', '桥接选题', '--out', out, '--real', '--gateway', 'nope']);
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr, /--gateway must be env or bridge/);
});

test('--help documents the gateway switch and the bridge secret file', async () => {
  const result = await runCli(['--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /--gateway/);
  assert.match(result.stdout, /DSBOT_BRIDGE_SECRET_FILE/);
  assert.match(result.stdout, /one session|one DSH session/i);
});

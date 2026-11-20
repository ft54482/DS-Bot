import assert from 'node:assert/strict';
import test from 'node:test';

import { createFakeChief, createFakeRuntime } from './support/fakes.js';
import { send, setup } from './support/harness.js';

test('authorization: a user outside the allowlist is not_allowed before parsing', () => {
  const { adapter, chief, runtime } = setup({ allowlist: ['user-2'] });

  const result = send(adapter, '/goal new 不该执行');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'not_allowed');
  assert.match(result.reply, /allowlist/);
  assert.equal(result.action, undefined);
  assert.deepEqual(chief.calls.openGoal, []);
  assert.deepEqual(runtime.calls.stopRequest, []);
});

test('authorization: an allowlisted user can use the same command', () => {
  const { adapter, chief } = setup({ allowlist: ['user-1'] });

  const result = send(adapter, '/goal new 可以执行');

  assert.equal(result.ok, true);
  assert.deepEqual(chief.calls.openGoal, [{ title: '可以执行' }]);
});

test('authorization: accepts a Set and denies everyone when the list is empty', () => {
  const allowed = setup({ allowlist: new Set(['user-1']) });
  const empty = setup({ allowlist: [] });

  assert.equal(send(allowed.adapter, '/goal new 有权限').ok, true);
  assert.equal(send(empty.adapter, '/goal new 没权限').code, 'not_allowed');
});

test('authorization: a custom authorize predicate can deny access', () => {
  const chief = createFakeChief();
  const runtime = createFakeRuntime();
  const { adapter } = setup({
    chief,
    runtime,
    authorize: (userId) => userId === 'admin',
  });

  assert.equal(send(adapter, '/goal new 不通过').code, 'not_allowed');
  assert.deepEqual(chief.calls.openGoal, []);
  assert.equal(send(adapter, '/goal new 通过', { userId: 'admin' }).ok, true);
});

test('authorization: a missing userId is not_allowed and does not throw', () => {
  const { adapter, chief } = setup();

  const result = adapter.handle({ text: '/goal new 没有用户' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'not_allowed');
  assert.equal(result.data.reason, 'missing_user');
  assert.deepEqual(chief.calls.openGoal, []);
});

test('leapfrog: /exec and the other execution commands are not_allowed with a reason', () => {
  const { adapter, chief, runtime } = setup();
  const commands = ['/exec rm -rf /tmp/x', '/dispatch', '/run', '/shell', '/plan', '/rework'];

  for (const command of commands) {
    const result = send(adapter, command);
    assert.equal(result.ok, false, command);
    assert.equal(result.code, 'not_allowed', command);
    assert.match(result.reply, /业务 BOT/, command);
    assert.equal(result.action.denied, true, command);
    assert.equal(result.action.executed, false, command);
    assert.equal(result.action.reason, 'execution_dispatch_belongs_to_business_bot', command);
  }

  assert.deepEqual(chief.calls, { openGoal: [], status: [], delegate: [], deliver: [] });
  assert.deepEqual(runtime.calls.stopRequest, []);
});

test('audit: credential-shaped text is redacted in the reply and action summary', () => {
  const { adapter } = setup();
  const secret = 'sk-abcdef1234567890';

  const result = send(adapter, `/goal new 发布 token=${secret}`);

  assert.equal(result.ok, true);
  assert.equal(result.reply.includes(secret), false);
  assert.equal(JSON.stringify(result.action).includes(secret), false);
  assert.match(result.reply, /\[redacted\]/);
  assert.match(result.action.args.title, /\[redacted\]/);
});

test('audit: action arguments are bounded and never include undefined values', () => {
  const { adapter } = setup();
  const longBrief = 'x'.repeat(500);

  const result = send(adapter, `/delegate goal-1 content ${longBrief}`);

  assert.equal(result.action.args.brief.length, 200);
  assert.equal(Object.values(result.action.args).includes(undefined), false);
  assert.ok(result.reply.length > 0);
});

test('chief failure: a not_found result is passed through with its code and message', () => {
  const { adapter, chief } = setup();
  chief.setResult('status', {
    ok: false,
    code: 'not_found',
    message: 'task goal-missing does not exist',
    details: { taskId: 'goal-missing' },
  });

  const result = send(adapter, '/goal status goal-missing');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'not_found');
  assert.match(result.reply, /does not exist/);
  assert.match(result.reply, /代码：not_found/);
  assert.equal(result.action.executed, true);
  assert.equal(result.data.details.taskId, 'goal-missing');
});

test('chief failure: a thrown dependency error becomes a tool receipt, not an exception', () => {
  const { adapter, chief } = setup();
  const failure = new Error('budget service unavailable');
  failure.code = 'service_down';
  chief.setThrow('deliver', failure);

  const result = send(adapter, '/deliver goal-1');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'service_down');
  assert.match(result.reply, /service_down/);
  assert.match(result.reply, /budget service unavailable/);
  assert.equal(result.action.name, 'deliver');
});

test('runtime failure: a thrown stop error becomes a tool receipt, not an exception', () => {
  const runtime = createFakeRuntime({ error: new Error('stop store offline') });
  const { adapter } = setup({ runtime });

  const result = send(adapter, '/stop goal-1');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'tool_error');
  assert.match(result.reply, /stop store offline/);
  assert.match(result.reply, /动作|行动/);
});

test('empty input: missing text is missing_argument and does not throw', () => {
  const { adapter } = setup();

  const result = send(adapter, '');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'missing_argument');
  assert.equal(result.data.argument, 'text');
  assert.match(result.reply, /缺参数：text/);
});

test('malformed input: a non-object call is handled as an authorization failure', () => {
  const { adapter } = setup();

  const result = adapter.handle(null);

  assert.equal(result.ok, false);
  assert.equal(result.code, 'not_allowed');
  assert.equal(typeof result.reply, 'string');
});

test('clock: every audited action uses the injected clock', () => {
  let tick = 0;
  const { adapter } = setup({ clock: () => 1000 + ++tick });

  const first = send(adapter, '/goal new 第一');
  const second = send(adapter, '/goal new 第二');

  assert.equal(first.action.at, 1001);
  assert.equal(second.action.at, 1002);
});

test('channel: an absent channel is recorded as unknown in the audit', () => {
  const { adapter } = setup();

  const result = adapter.handle({ userId: 'user-1', text: '/goal new 无频道' });

  assert.equal(result.action.channel, 'unknown');
});

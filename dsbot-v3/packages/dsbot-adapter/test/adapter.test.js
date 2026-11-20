import assert from 'node:assert/strict';
import test from 'node:test';

import { COMMANDS, createDsBotAdapter } from '../src/index.js';
import { createFakeChief, createFakeRuntime } from './support/fakes.js';
import { AT, send, setup } from './support/harness.js';

test('surface: the adapter exposes handle, help and the command table', () => {
  const { adapter } = setup();

  assert.equal(typeof adapter.handle, 'function');
  assert.equal(typeof adapter.help, 'function');
  assert.match(adapter.help(), /\/goal new/);
  assert.deepEqual(
    adapter.commands.map((entry) => entry.command),
    ['/goal new', '/goal status', '/delegate', '/deliver', '/stop', '/help'],
  );
  assert.equal(COMMANDS.length, 6);
});

test('construction: missing chief, runtime or clock fails loudly', () => {
  const chief = createFakeChief();
  const runtime = createFakeRuntime();

  assert.throws(() => createDsBotAdapter({ runtime }), /chief/);
  assert.throws(() => createDsBotAdapter({ chief }), /runtime/);
  assert.throws(() => createDsBotAdapter({ chief, runtime, clock: 'later' }), /clock/);
  assert.throws(
    () => createDsBotAdapter({ chief: {}, runtime }),
    /chief\.openGoal/,
  );
});

test('help: returns the command list without an action', () => {
  const { adapter, chief, runtime } = setup();

  const result = send(adapter, '/help');

  assert.equal(result.ok, true);
  assert.match(result.reply, /\/delegate/);
  assert.match(result.reply, /\/deliver/);
  assert.equal(result.action, undefined);
  assert.equal(result.code, undefined);
  assert.deepEqual(chief.calls, { openGoal: [], status: [], delegate: [], deliver: [] });
  assert.deepEqual(runtime.calls.stopRequest, []);
});

test('unknown command: returns friendly help, not an exception, and calls nothing', () => {
  const { adapter, chief } = setup();

  const result = send(adapter, '/deploy now');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'unknown_command');
  assert.match(result.reply, /未识别命令/);
  assert.match(result.reply, /\/help/);
  assert.equal(result.action, undefined);
  assert.deepEqual(chief.calls.openGoal, []);
  assert.deepEqual(chief.calls.status, []);
});

test('plain text: is treated as an unknown command with help, not thrown', () => {
  const { adapter } = setup();

  const result = send(adapter, '帮我看一下目标');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'unknown_command');
  assert.match(result.reply, /\/help/);
});

test('goal new: maps title and --budget to chief.openGoal and audits the action', () => {
  const { adapter, chief } = setup();

  const result = send(adapter, '/goal new 写一篇文章 --budget 30');

  assert.equal(result.ok, true);
  assert.deepEqual(chief.calls.openGoal, [{ title: '写一篇文章', budgetCny: 30 }]);
  assert.equal(result.action.name, 'openGoal');
  assert.equal(result.action.command, 'goal.new');
  assert.equal(result.action.executed, true);
  assert.deepEqual(result.action.args, { budgetCny: 30, title: '写一篇文章' });
  assert.equal(result.action.userId, 'user-1');
  assert.equal(result.action.channel, 'dsbot:dm');
  assert.equal(result.action.at, AT);
  assert.match(result.reply, /已创建目标 goal-1/);
  assert.match(result.reply, /行动：openGoal/);
  assert.match(result.reply, /"budgetCny":30/);
  assert.equal(result.data.goalId, 'goal-1');
});

test('goal new: accepts --budget=<number> anywhere and keeps the remaining title', () => {
  const { adapter, chief } = setup();

  const result = send(adapter, '/goal new --budget=12.5 制作 视频');

  assert.equal(result.ok, true);
  assert.deepEqual(chief.calls.openGoal, [{ title: '制作 视频', budgetCny: 12.5 }]);
  assert.match(result.reply, /预算 12.5 CNY/);
});

test('goal new: budget is optional', () => {
  const { adapter, chief } = setup();

  const result = send(adapter, '/goal new 只做标题');

  assert.equal(result.ok, true);
  assert.deepEqual(chief.calls.openGoal, [{ title: '只做标题' }]);
  assert.deepEqual(result.action.args, { title: '只做标题' });
  assert.doesNotMatch(result.reply, /预算/);
});

test('goal new: a missing title is missing_argument and does not call the Chief', () => {
  const { adapter, chief } = setup();

  const result = send(adapter, '/goal new --budget 30');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'missing_argument');
  assert.equal(result.data.argument, 'title');
  assert.match(result.reply, /缺参数：title/);
  assert.deepEqual(chief.calls.openGoal, []);
});

test('goal new: --budget without a value is missing_argument for budget', () => {
  const { adapter, chief } = setup();

  const result = send(adapter, '/goal new 标题 --budget');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'missing_argument');
  assert.equal(result.data.argument, 'budget');
  assert.match(result.reply, /缺参数：budget/);
  assert.deepEqual(chief.calls.openGoal, []);
});

test('goal new: a non-numeric or negative budget is invalid_argument', () => {
  const { adapter, chief } = setup();

  const letters = send(adapter, '/goal new 标题 --budget lots');
  const negative = send(adapter, '/goal new 标题 --budget -5');

  assert.equal(letters.code, 'invalid_argument');
  assert.equal(letters.data.argument, 'budget');
  assert.match(letters.reply, /参数无效：budget/);
  assert.equal(negative.code, 'invalid_argument');
  assert.equal(negative.data.argument, 'budget');
  assert.deepEqual(chief.calls.openGoal, []);
});

test('goal new: passes the configured goal scope to the Chief', () => {
  const scope = { projects: ['self-media'], max_delegate_level: 'goal' };
  const { adapter, chief } = setup({ scope });

  const result = send(adapter, '/goal new 有项目范围 --budget 10');

  assert.equal(result.ok, true);
  assert.deepEqual(chief.calls.openGoal, [
    { title: '有项目范围', budgetCny: 10, scope },
  ]);
});

test('goal status: forwards the goal id and summarizes state, acceptance and cost', () => {
  const { adapter, chief } = setup();

  const result = send(adapter, '/goal status goal-9');

  assert.equal(result.ok, true);
  assert.deepEqual(chief.calls.status, [{ goalId: 'goal-9' }]);
  assert.equal(result.action.name, 'status');
  assert.deepEqual(result.action.args, { goalId: 'goal-9' });
  assert.match(result.reply, /目标 goal-9/);
  assert.match(result.reply, /running/);
  assert.match(result.reply, /验收：1\/1/);
  assert.match(result.reply, /成本：2.5\/100 CNY/);
  assert.equal(result.data.goalId, 'goal-9');
});

test('goal status: a missing id is missing_argument', () => {
  const { adapter, chief } = setup();

  const result = send(adapter, '/goal status');

  assert.equal(result.code, 'missing_argument');
  assert.equal(result.data.argument, 'id');
  assert.match(result.reply, /缺参数：id/);
  assert.deepEqual(chief.calls.status, []);
});

test('goal: an unknown subcommand gets friendly help and no tool call', () => {
  const { adapter, chief } = setup();

  const result = send(adapter, '/goal pause goal-1');

  assert.equal(result.code, 'unknown_command');
  assert.match(result.reply, /\/goal new/);
  assert.deepEqual(chief.calls.openGoal, []);
  assert.deepEqual(chief.calls.status, []);
});

test('delegate: forwards goalId, bot and brief verbatim', () => {
  const { adapter, chief } = setup();

  const result = send(adapter, '/delegate goal-1 content 写一篇初稿，含三个小标题');

  assert.equal(result.ok, true);
  assert.deepEqual(chief.calls.delegate, [
    { goalId: 'goal-1', bot: 'content', brief: '写一篇初稿，含三个小标题' },
  ]);
  assert.equal(result.action.name, 'delegate');
  assert.deepEqual(result.action.args, {
    bot: 'content',
    brief: '写一篇初稿，含三个小标题',
    goalId: 'goal-1',
  });
  assert.match(result.reply, /已派给 content/);
  assert.match(result.reply, /business-1/);
});

test('delegate: missing goalId, bot and brief name the exact argument', () => {
  const { adapter, chief } = setup();

  const noGoal = send(adapter, '/delegate');
  const noBot = send(adapter, '/delegate goal-1');
  const noBrief = send(adapter, '/delegate goal-1 content');

  assert.deepEqual(
    [noGoal.data.argument, noBot.data.argument, noBrief.data.argument],
    ['goalId', 'bot', 'brief'],
  );
  assert.equal(noGoal.code, 'missing_argument');
  assert.equal(noBot.code, 'missing_argument');
  assert.equal(noBrief.code, 'missing_argument');
  assert.match(noBrief.reply, /缺参数：brief/);
  assert.deepEqual(chief.calls.delegate, []);
});

test('deliver: returns the result package and its deliverable count', () => {
  const { adapter, chief } = setup();

  const result = send(adapter, '/deliver goal-1');

  assert.equal(result.ok, true);
  assert.deepEqual(chief.calls.deliver, [{ goalId: 'goal-1' }]);
  assert.equal(result.action.name, 'deliver');
  assert.match(result.reply, /交付包已生成/);
  assert.match(result.reply, /交付物：1 项/);
  assert.equal(result.data.outcome, 'done');
});

test('deliver: a missing goal id is missing_argument', () => {
  const { adapter, chief } = setup();

  const result = send(adapter, '/deliver');

  assert.equal(result.code, 'missing_argument');
  assert.equal(result.data.argument, 'goalId');
  assert.deepEqual(chief.calls.deliver, []);
});

test('deliver: a blocked Chief result keeps its code, blockers and pending count', () => {
  const { adapter, chief } = setup();
  chief.setResult('deliver', {
    ok: false,
    code: 'blocked',
    message: '1 of 2 business delegation(s) have not passed acceptance',
    blockers: [
      { code: 'acceptance_rework', message: 'business business-1 requires rework' },
    ],
    pending: [{ taskId: 'business-1', result: 'rework' }],
  });

  const result = send(adapter, '/deliver goal-1');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'blocked');
  assert.match(result.reply, /have not passed acceptance/);
  assert.match(result.reply, /acceptance_rework/);
  assert.match(result.reply, /待处理：1 项/);
  assert.equal(result.data.blockers.length, 1);
  assert.equal(result.action.executed, true);
});

test('stop: requests a runtime stop with the user as the requester', () => {
  const { adapter, runtime } = setup();

  const result = send(adapter, '/stop goal-1');

  assert.equal(result.ok, true);
  assert.deepEqual(runtime.calls.stopRequest, [
    { taskId: 'goal-1', requestedBy: 'user-1', reason: 'user_stop' },
  ]);
  assert.equal(result.action.name, 'stop.request');
  assert.deepEqual(result.action.args, { taskId: 'goal-1' });
  assert.match(result.reply, /已请求停止 goal-1/);
  assert.match(result.reply, /stopping/);
});

test('stop: a missing id is missing_argument and never touches the runtime', () => {
  const { adapter, runtime } = setup();

  const result = send(adapter, '/stop');

  assert.equal(result.code, 'missing_argument');
  assert.equal(result.data.argument, 'id');
  assert.deepEqual(runtime.calls.stopRequest, []);
});

test('stop: a runtime without stop.request reports runtime_unavailable, not a crash', () => {
  const { adapter } = setup({ runtime: createFakeRuntime({ withStop: false }) });

  const result = send(adapter, '/stop goal-1');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'runtime_unavailable');
  assert.match(result.reply, /stop\.request/);
  assert.equal(result.action.executed, false);
});

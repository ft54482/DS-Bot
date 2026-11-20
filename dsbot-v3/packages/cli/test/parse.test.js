import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArgv, usageText } from '../src/parse.js';

function throwsCli(argv, { code = 'validation_error', status = 422 } = {}) {
  assert.throws(
    () => parseArgv(argv),
    (error) => error.code === code && error.status === status,
    `expected ${code}/${status} for ${JSON.stringify(argv)}`,
  );
}

test('parses task create with required level and title', () => {
  const parsed = parseArgv(['task', 'create', '--level', 'goal', '--title', 'hello world']);
  assert.equal(parsed.command, 'task.create');
  assert.deepEqual(parsed.options, {
    level: 'goal',
    title: 'hello world',
    parent: null,
  });
  assert.equal(parsed.json, false);
  assert.equal(parsed.help, false);
});

test('accepts --flag=value, --json and --parent', () => {
  const parsed = parseArgv([
    'task',
    'create',
    '--level=business',
    '--title=delegate',
    '--parent=task-1',
    '--json',
  ]);
  assert.equal(parsed.json, true);
  assert.deepEqual(parsed.options, {
    level: 'business',
    title: 'delegate',
    parent: 'task-1',
  });
});

test('parses task list filters, get and cost', () => {
  assert.deepEqual(parseArgv(['task', 'list', '--level', 'execution', '--state', 'queued', '--limit', '5']).options, {
    level: 'execution',
    state: 'queued',
    limit: 5,
  });
  assert.deepEqual(parseArgv(['task', 'get', 'task-42']).positional, ['task-42']);
  assert.deepEqual(parseArgv(['cost', 'task-42']).positional, ['task-42']);
});

test('parses dispatch options', () => {
  const parsed = parseArgv([
    'dispatch',
    'task-1',
    '--executor-kind',
    'tool_chain',
    '--idempotency-key',
    'key-1',
  ]);
  assert.equal(parsed.command, 'dispatch');
  assert.deepEqual(parsed.positional, ['task-1']);
  assert.deepEqual(parsed.options, { executorKind: 'tool_chain', idempotencyKey: 'key-1' });
});

test('parses accept verdict, reason and item JSON', () => {
  const parsed = parseArgv([
    'accept',
    'run-1',
    '--verdict',
    'pass',
    '--reason',
    'looks good',
    '--items',
    '{"auto.checks":"pass"}',
  ]);
  assert.equal(parsed.command, 'accept');
  assert.deepEqual(parsed.positional, ['run-1']);
  assert.deepEqual(parsed.options, {
    verdict: 'pass',
    reason: 'looks good',
    itemStates: { 'auto.checks': 'pass' },
  });
});

test('parses stop options', () => {
  const parsed = parseArgv(['stop', 'task-1', '--reason', 'user_stop', '--requested-by', 'human']);
  assert.equal(parsed.command, 'stop');
  assert.deepEqual(parsed.options, { reason: 'user_stop', requestedBy: 'human' });
});

test('supports -- terminator for positional values that look like options', () => {
  const parsed = parseArgv(['task', 'get', '--', '--not-a-flag']);
  assert.deepEqual(parsed.positional, ['--not-a-flag']);
});

test('returns help for the global command and for a specific command', () => {
  assert.deepEqual(parseArgv(['--help']), {
    command: null,
    options: {},
    positional: [],
    json: false,
    help: true,
    version: false,
  });
  const commandHelp = parseArgv(['task', 'create', '--help']);
  assert.equal(commandHelp.command, 'task.create');
  assert.equal(commandHelp.help, true);
});

test('returns version without requiring a command', () => {
  const parsed = parseArgv(['--version']);
  assert.equal(parsed.version, true);
  assert.equal(parsed.help, false);
});

test('usage text names every required subcommand', () => {
  const usage = usageText();
  for (const fragment of [
    'task create',
    'task list',
    'task get',
    'dispatch',
    'accept',
    'stop',
    'cost',
    '--json',
  ]) {
    assert.ok(usage.includes(fragment), `usage should include ${fragment}`);
  }
});

test('rejects missing and unknown commands', () => {
  throwsCli([]);
  throwsCli(['unknown']);
  throwsCli(['task']);
  throwsCli(['task', 'delete']);
});

test('rejects missing, extra and unknown arguments', () => {
  throwsCli(['task', 'get']);
  throwsCli(['task', 'get', 'a', 'b']);
  throwsCli(['task', 'create', '--level', 'goal', '--title', 'x', 'extra']);
  throwsCli(['task', 'create', '--level', 'goal', '--title', 'x', '--nope', 'y']);
  throwsCli(['task', 'create', '--level', 'goal', '--title']);
  throwsCli(['task', 'create', '--level', 'goal', '--level', 'business', '--title', 'x']);
});

test('rejects invalid enum values and required options', () => {
  throwsCli(['task', 'create', '--level', 'nope', '--title', 'x']);
  throwsCli(['task', 'create', '--level', 'goal']);
  throwsCli(['task', 'create', '--level', 'goal', '--title', '   ']);
  throwsCli(['task', 'list', '--level', 'nope']);
  throwsCli(['task', 'list', '--limit', '0']);
  throwsCli(['task', 'list', '--limit', 'abc']);
  throwsCli(['dispatch', 'task-1', '--executor-kind', 'robot']);
  throwsCli(['accept', 'run-1']);
  throwsCli(['accept', 'run-1', '--verdict', 'maybe']);
  throwsCli(['accept', 'run-1', '--verdict', 'pass', '--items', 'not-json']);
  throwsCli(['accept', 'run-1', '--verdict', 'pass', '--items', '[]']);
});

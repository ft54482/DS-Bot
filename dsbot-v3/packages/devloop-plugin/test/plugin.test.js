import assert from 'node:assert/strict';
import test from 'node:test';
import {
  apply,
  createDevloopManager,
  toCordisTool,
} from '../src/index.js';
import {
  createClock,
  createMerger,
  createScriptedScheduler,
  createVerifier,
  startInput,
} from './support/harness.js';

function fakeManager() {
  const calls = [];
  return {
    calls,
    async start(input) {
      calls.push({ method: 'start', input });
      return { loopId: 'loop-1', state: 'collect', iteration: 1, running: true };
    },
    status(loopId) {
      calls.push({ method: 'status', loopId });
      return { state: 'collect', iteration: 1, running: true };
    },
    async stop(loopId, reason) {
      calls.push({ method: 'stop', loopId, reason });
      return { loopId, state: 'stopped', iteration: 1, running: false, stoppedReason: reason };
    },
  };
}

function fakeContext() {
  const registrations = [];
  return {
    registrations,
    tools: {
      register(tool) {
        registrations.push(tool);
        return tool;
      },
    },
  };
}

test('apply registers the three cordis tools with registry-ready schemas', () => {
  const ctx = fakeContext();
  const manager = fakeManager();

  const returned = apply(ctx, { manager });

  assert.equal(returned, manager);
  assert.deepEqual(
    ctx.registrations.map((tool) => tool.name),
    ['loop_start', 'loop_status', 'loop_stop'],
  );
  for (const tool of ctx.registrations) {
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.output.schema.type, 'object');
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof tool.presentCall, 'function');
  }
});

test('registered tools delegate to the manager', async () => {
  const ctx = fakeContext();
  const manager = fakeManager();
  apply(ctx, { manager });

  const [start, status, stop] = ctx.registrations;
  const started = await start.execute(
    {
      goal: { title: 'g', baseSha: 'a'.repeat(40) },
      lanes: [{ lane: 'ui', dir: 'packages/ui' }],
      budgetCny: 5,
    },
    {},
  );
  assert.equal(started.loopId, 'loop-1');

  const current = status.execute({ loopId: 'loop-1' }, {});
  assert.equal(current.running, true);

  const stopped = await stop.execute({ loopId: 'loop-1', reason: 'done' }, {});
  assert.equal(stopped.state, 'stopped');

  assert.deepEqual(
    manager.calls.map((call) => call.method),
    ['start', 'status', 'stop'],
  );
});

test('apply builds a manager from deps when none is supplied', async () => {
  const ctx = fakeContext();
  const manager = apply(ctx, {
    deps: {
      scheduler: createScriptedScheduler(),
      merger: createMerger(),
      verifier: createVerifier(),
      clock: createClock(),
      idFactory: () => 'loop-from-apply',
    },
  });

  assert.equal(typeof manager.start, 'function');
  const started = await manager.start(startInput());
  assert.equal(started.loopId, 'loop-from-apply');
  assert.equal(ctx.registrations.length, 3);
});

test('apply rejects a context without tools.register', () => {
  assert.throws(() => apply({}, { manager: fakeManager() }), /ctx\.tools\.register/);
  assert.throws(() => apply(undefined, { manager: fakeManager() }), /ctx\.tools\.register/);
});

test('toCordisTool renders a successful value as one JSON text block', async () => {
  const handler = async (args) => ({ echoed: args.value });
  const tool = toCordisTool({
    name: 'echo',
    description: 'Echo one value.',
    inputSchema: { type: 'object', required: ['value'] },
    handler,
  });

  const value = await tool.execute({ value: 'hello' }, { exec: true });
  assert.deepEqual(value, { echoed: 'hello' });
  assert.deepEqual(tool.output.render({}, value), [
    { type: 'text', text: '{"echoed":"hello"}' },
  ]);

  const presentation = tool.presentCall({ value: 'hello' });
  assert.equal(presentation.card, 'generic');
  assert.equal(presentation.rawInput.value, 'hello');
});

test('a manager created without seams is still a complete object', () => {
  const manager = createDevloopManager({ verifier: createVerifier() });
  assert.deepEqual(Object.keys(manager).sort(), [
    'advance',
    'get',
    'list',
    'start',
    'status',
    'stop',
  ]);
});

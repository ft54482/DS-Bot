import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDevloopTools,
  createLoopStartTool,
  createLoopStatusTool,
  createLoopStopTool,
  LOOP_START_INPUT_SCHEMA,
  LOOP_STATUS_INPUT_SCHEMA,
  LOOP_STOP_INPUT_SCHEMA,
  TOOL_FACTORIES,
} from '../src/index.js';

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
      return {
        loopId,
        state: 'stopped',
        iteration: 1,
        running: false,
        stoppedReason: reason,
        irreversible: true,
      };
    },
  };
}

test('the bundle exports exactly the three documented tool definitions', () => {
  const tools = createDevloopTools({ manager: fakeManager() });

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['loop_start', 'loop_status', 'loop_stop'],
  );
  for (const tool of tools) {
    assert.deepEqual(Object.keys(tool).sort(), [
      'description',
      'handler',
      'inputSchema',
      'name',
    ]);
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 0, `${tool.name} has a description`);
    assert.equal(typeof tool.handler, 'function');
    assert.equal(tool.inputSchema.type, 'object');
  }
});

test('loop_start schema requires goal, lanes and budgetCny', () => {
  assert.deepEqual(LOOP_START_INPUT_SCHEMA.required, ['goal', 'lanes', 'budgetCny']);
  assert.equal(LOOP_START_INPUT_SCHEMA.additionalProperties, false);
  assert.equal(LOOP_START_INPUT_SCHEMA.properties.lanes.type, 'array');
  assert.equal(LOOP_START_INPUT_SCHEMA.properties.budgetCny.type, 'number');
  assert.match(LOOP_START_INPUT_SCHEMA.properties.budgetCny.description, /positive/);
  assert.equal(LOOP_START_INPUT_SCHEMA.properties.maxWorkers.type, 'integer');
});

test('every input schema stays inside the DSH-supported keyword subset', () => {
  for (const [name, schema] of Object.entries({
    loop_start: LOOP_START_INPUT_SCHEMA,
    loop_status: LOOP_STATUS_INPUT_SCHEMA,
    loop_stop: LOOP_STOP_INPUT_SCHEMA,
  })) {
    assertSupportedSubset(schema, name);
  }
});

const DSH_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'default',
  'title',
]);

function assertSupportedSubset(schema, at) {
  assert.ok(schema !== null && typeof schema === 'object', `${at} must be a schema object`);
  for (const key of Object.keys(schema)) {
    assert.ok(DSH_KEYWORDS.has(key), `${at}.${key} is outside the DSH schema subset`);
  }
  if (schema.properties !== undefined) {
    for (const [property, child] of Object.entries(schema.properties)) {
      assertSupportedSubset(child, `${at}.properties.${property}`);
    }
  }
  if (schema.items !== undefined) assertSupportedSubset(schema.items, `${at}.items`);
  if (schema.oneOf !== undefined) {
    schema.oneOf.forEach((child, index) => assertSupportedSubset(child, `${at}.oneOf[${index}]`));
  }
  if ('additionalProperties' in schema) {
    assert.equal(typeof schema.additionalProperties, 'boolean', `${at}.additionalProperties`);
  }
  if ('required' in schema) assert.ok(Array.isArray(schema.required), `${at}.required`);
  if ('enum' in schema) assert.ok(Array.isArray(schema.enum), `${at}.enum`);
}

test('loop_status and loop_stop schemas require only loopId', () => {
  assert.deepEqual(LOOP_STATUS_INPUT_SCHEMA.required, ['loopId']);
  assert.deepEqual(LOOP_STOP_INPUT_SCHEMA.required, ['loopId']);
  assert.equal(LOOP_STATUS_INPUT_SCHEMA.additionalProperties, false);
  assert.equal(LOOP_STOP_INPUT_SCHEMA.additionalProperties, false);
  assert.equal(LOOP_STOP_INPUT_SCHEMA.properties.reason.default, 'manual');
});

test('tool factories are pure and return a fresh definition per call', () => {
  const manager = fakeManager();
  const first = createLoopStartTool({ manager });
  const second = createLoopStartTool({ manager });

  assert.notEqual(first, second);
  assert.equal(first.name, second.name);
  assert.equal(first.description, second.description);
  assert.equal(first.inputSchema, second.inputSchema);
  assert.equal(typeof first.handler, 'function');
  assert.equal(typeof second.handler, 'function');
});

test('each factory rejects a manager that cannot serve its method', () => {
  assert.throws(() => createLoopStartTool({}), { name: 'TypeError', message: /start/ });
  assert.throws(() => createLoopStatusTool({}), { name: 'TypeError', message: /status/ });
  assert.throws(() => createLoopStopTool({}), { name: 'TypeError', message: /stop/ });
});

test('TOOL_FACTORIES exposes one factory per tool name', () => {
  assert.deepEqual(Object.keys(TOOL_FACTORIES), [
    'loop_start',
    'loop_status',
    'loop_stop',
  ]);
  assert.equal(TOOL_FACTORIES.loop_start, createLoopStartTool);
  assert.equal(TOOL_FACTORIES.loop_status, createLoopStatusTool);
  assert.equal(TOOL_FACTORIES.loop_stop, createLoopStopTool);
});

test('loop_start handler delegates the exact input to manager.start', async () => {
  const manager = fakeManager();
  const tool = createLoopStartTool({ manager });
  const input = {
    goal: { title: 'g', baseSha: 'a'.repeat(40) },
    lanes: [{ lane: 'ui', dir: 'packages/ui' }],
    budgetCny: 5,
  };

  const result = await tool.handler(input);

  assert.equal(result.loopId, 'loop-1');
  assert.deepEqual(manager.calls, [{ method: 'start', input }]);
});

test('loop_status handler reads the requested loop', () => {
  const manager = fakeManager();
  const tool = createLoopStatusTool({ manager });

  const result = tool.handler({ loopId: 'loop-9' });

  assert.equal(result.state, 'collect');
  assert.deepEqual(manager.calls, [{ method: 'status', loopId: 'loop-9' }]);
});

test('loop_stop handler forwards the reason and defaults to manual', async () => {
  const manager = fakeManager();
  const tool = createLoopStopTool({ manager });

  await tool.handler({ loopId: 'loop-9', reason: 'budget froze' });
  await tool.handler({ loopId: 'loop-9' });

  assert.deepEqual(manager.calls, [
    { method: 'stop', loopId: 'loop-9', reason: 'budget froze' },
    { method: 'stop', loopId: 'loop-9', reason: 'manual' },
  ]);
});

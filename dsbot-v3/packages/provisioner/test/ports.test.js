import assert from 'node:assert/strict';
import test from 'node:test';
import { PORT_RANGE, provision } from '../src/provision.js';
import { baseOptions, createTestFs, dshHomeFor, seedRegistry } from './support/fixtures.js';

test('an explicit port already held by another profile is port_taken', async () => {
  const fs = createTestFs();
  seedRegistry(fs, dshHomeFor(fs), [{ name: 'other', port: 3091 }]);

  await assert.rejects(provision(baseOptions(fs, { port: 3091 })), (error) => {
    assert.equal(error.code, 'port_taken');
    assert.equal(error.details.port, 3091);
    assert.equal(error.details.holder, 'other');
    return true;
  });
});

test('an explicit port that the injected port check reports busy is port_taken', async () => {
  const fs = createTestFs();
  await assert.rejects(
    provision(baseOptions(fs, { port: 3092, isPortFree: async (port) => port !== 3092 })),
    (error) => {
      assert.equal(error.code, 'port_taken');
      assert.equal(error.details.reason, 'not_free');
      return true;
    },
  );
});

test('port auto picks the first free port when nothing is reserved', async () => {
  const fs = createTestFs();
  const result = await provision(baseOptions(fs, { port: 'auto' }));
  assert.equal(result.port, PORT_RANGE.min);
});

test('port auto skips ports reserved by other profiles in the registry', async () => {
  const fs = createTestFs();
  seedRegistry(fs, dshHomeFor(fs), [
    { name: 'one', port: 3080 },
    { name: 'two', port: 3081 },
  ]);

  const result = await provision(baseOptions(fs, { port: 'auto' }));
  assert.equal(result.port, 3082);
});

test('port auto also skips ports the injected port check reports busy', async () => {
  const fs = createTestFs();
  const busy = new Set([3080, 3081, 3082]);

  const result = await provision(
    baseOptions(fs, { port: 'auto', isPortFree: async (port) => !busy.has(port) }),
  );
  assert.equal(result.port, 3083);
});

test('port auto reports port_exhausted when the whole range is busy', async () => {
  const fs = createTestFs();
  await assert.rejects(
    provision(baseOptions(fs, { port: 'auto', isPortFree: () => false })),
    (error) => {
      assert.equal(error.code, 'port_exhausted');
      assert.deepEqual(error.details.range, { ...PORT_RANGE });
      return true;
    },
  );
});

test('a non-integer or out-of-range port is invalid input', async () => {
  const fs = createTestFs();
  for (const port of [3086.5, 0, 65536, 'nope']) {
    await assert.rejects(provision(baseOptions(fs, { port })), (error) => {
      assert.equal(error.code, 'invalid_input');
      assert.equal(error.details.field, 'port');
      return true;
    });
  }
});

test('the same profile may keep its own port without colliding with itself', async () => {
  const fs = createTestFs();
  const options = baseOptions(fs, { port: 3091 });
  const first = await provision(options);
  const second = await provision({ ...options, port: 3091 });

  assert.equal(second.created, false);
  assert.equal(second.port, first.port);
});

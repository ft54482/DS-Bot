import assert from 'node:assert/strict';
import test from 'node:test';

import { Watermark, WatermarkTable } from '../src/index.js';

test('watermark: advances one contiguous step and observes higher seq without jumping', () => {
  let now = 1_000;
  const watermark = new Watermark({ clock: () => now });

  assert.deepEqual(watermark.advance(1), {
    advanced: true,
    duplicate: false,
    value: 1,
    lastSeen: 1,
  });

  const gap = watermark.advance(4);
  assert.equal(gap.advanced, false);
  assert.equal(gap.gap, 2);
  assert.equal(watermark.value, 1);
  assert.equal(watermark.lastSeen, 4);

  const duplicate = watermark.advance(1);
  assert.equal(duplicate.advanced, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(watermark.value, 1);
  assert.equal(watermark.updatedAt, now);
});

test('watermark table: each source advances independently', () => {
  const table = new WatermarkTable({ clock: () => 1 });
  assert.equal(table.advance('dsh', 1).advanced, true);
  assert.equal(table.advance('dsh', 3).advanced, false);
  assert.equal(table.advance('superagent', 1).advanced, true);

  assert.equal(table.get('dsh').value, 1);
  assert.equal(table.get('dsh').lastSeen, 3);
  assert.equal(table.get('superagent').value, 1);
  assert.deepEqual(table.get('missing'), { value: 0, lastSeen: 0, updatedAt: null });
});

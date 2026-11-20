import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_MAX_REWORK_ROUNDS, DEFAULT_MAX_TASK_COST_CNY } from '../src/index.js';
import {
  DEFAULT_MAX_BUDGET,
  DEFAULT_MAX_ROUNDS,
} from '../../loop/src/constants.js';

test('rework and task-cost ceilings stay equal to the L25 loop defaults', () => {
  assert.equal(DEFAULT_MAX_REWORK_ROUNDS, DEFAULT_MAX_ROUNDS);
  assert.equal(DEFAULT_MAX_TASK_COST_CNY, DEFAULT_MAX_BUDGET);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContextPack,
  drilldownRef,
  measurePack,
  TASK_PACK_TRIM_ORDER,
} from '../src/index.js';
import {
  COUNT,
  makeQuestions,
  makeRecent,
  makeTask,
} from './helpers.js';

function packWith(task = makeTask(), budgets = {}) {
  return buildContextPack({
    level: 'business',
    task,
    recent: makeRecent(2),
    open_questions: makeQuestions(),
    budgets,
    countTokens: COUNT,
  });
}

test('pointers cover the task, evidence, run, acceptance and artifacts', () => {
  const pack = packWith();
  const byRef = new Map(pack.pointers.map((pointer) => [pointer.ref, pointer]));

  assert.ok(byRef.has('task:task-biz-1'));
  assert.ok(byRef.has('evidence:evidence-1'));
  assert.ok(byRef.has('run:run-1'));
  assert.ok(byRef.has('acceptance:acc-1'));
  assert.ok(byRef.has('report:report-1'));
  assert.ok(byRef.has('report:report-2'));
  assert.ok(byRef.has('artifact:packages/context/src/index.js'));
  assert.ok(byRef.has('escalation:esc-1'));

  assert.equal(byRef.get('task:task-biz-1').uri, '/v1/tasks/task-biz-1');
  assert.equal(byRef.get('evidence:evidence-1').uri, '/v1/evidence/evidence-1');
  assert.equal(byRef.get('run:run-1').uri, undefined);
  assert.equal(
    byRef.get('artifact:packages/context/src/index.js').sha256,
    'f'.repeat(64),
  );
  assert.equal(byRef.get('report:report-2').label, 'child report');
});

test('pointers are deduplicated by ref', () => {
  const pack = packWith(
    makeTask({
      pointers: [
        'evidence:evidence-1',
        'evidence:evidence-1',
        { ref: 'run:run-1', kind: 'run', id: 'run-1' },
      ],
    }),
  );
  const refs = pack.pointers.map((pointer) => pointer.ref);
  assert.equal(refs.filter((ref) => ref === 'evidence:evidence-1').length, 1);
  assert.equal(refs.filter((ref) => ref === 'run:run-1').length, 1);
});

test('pointers are not trimmed when the pack is tight', () => {
  const full = packWith();
  const minimal = structuredClone(full);
  minimal.recent = [];
  minimal.open_questions = [];
  for (const field of TASK_PACK_TRIM_ORDER) delete minimal.task_pack[field];
  const limit = measurePack(minimal, COUNT);

  const tight = packWith(makeTask(), { business: limit });
  assert.deepEqual(tight.pointers, full.pointers);
  assert.ok(measurePack(tight, COUNT) <= limit);
});

test('drilldownRef composes only documented read endpoints', () => {
  const pack = packWith();
  const taskPointer = pack.pointers.find((pointer) => pointer.kind === 'task');
  const evidencePointer = pack.pointers.find(
    (pointer) => pointer.kind === 'evidence',
  );
  const acceptancePointer = pack.pointers.find(
    (pointer) => pointer.kind === 'acceptance',
  );

  assert.equal(drilldownRef(taskPointer), '/v1/tasks/task-biz-1');
  assert.equal(
    drilldownRef(taskPointer, { fields: ['state', 'cost'] }),
    '/v1/tasks/task-biz-1?fields=state,cost',
  );
  assert.equal(drilldownRef(evidencePointer), '/v1/evidence/evidence-1');
  assert.equal(drilldownRef(acceptancePointer), 'acceptance:acc-1');
});

test('an unprefixed evidence_ref becomes an evidence pointer', () => {
  const pack = packWith(
    makeTask({
      pointers: [],
      latest_acceptance: {
        acceptance_id: 'acc-1',
        stage: 'business',
        result: 'passed',
        evidence_ref: 'evidence-set-1',
      },
    }),
  );
  const pointer = pack.pointers.find(
    (entry) => entry.ref === 'evidence:evidence-set-1',
  );
  assert.ok(pointer);
  assert.equal(pointer.uri, '/v1/evidence/evidence-set-1');
  assert.equal(drilldownRef(pointer), '/v1/evidence/evidence-set-1');
});

test('explicit pointer objects and refs are normalized', () => {
  const pack = packWith(
    makeTask({
      pointers: [
        { kind: 'session', id: 'sess-1', label: 'execution session' },
        { ref: 'evidence:custom-evidence' },
        { uri: '/v1/tasks/task-biz-1' },
      ],
    }),
  );
  const byRef = new Map(pack.pointers.map((pointer) => [pointer.ref, pointer]));

  assert.equal(byRef.get('session:sess-1').label, 'execution session');
  assert.equal(
    byRef.get('evidence:custom-evidence').uri,
    '/v1/evidence/custom-evidence',
  );
  assert.ok(byRef.has('/v1/tasks/task-biz-1'));

  const single = packWith(makeTask({ pointers: 'evidence:single-evidence' }));
  assert.ok(
    single.pointers.some(
      (pointer) => pointer.ref === 'evidence:single-evidence',
    ),
  );
});

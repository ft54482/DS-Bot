/** Shared fixtures for the context-pack tests. */

export const COUNT = (text) => Math.ceil(text.length / 4);

export function makeTask(overrides = {}) {
  return {
    task_id: 'task-biz-1',
    level: 'business',
    goal: 'Ship the level-aware context pack',
    title: 'L14 context',
    state: 'running',
    owner: 'bot:content',
    scope: {
      allowed_paths: ['packages/context/**'],
      forbidden_paths: ['docs/prd/**'],
      projects: ['superagent-lab'],
      bot_scope: 'bot:content',
    },
    base_sha: 'a'.repeat(40),
    acceptance: {
      stage: 'business',
      criteria: [
        'node --test packages/context/test exits 0',
        'every level stays within its token budget',
      ],
    },
    delivery: { format: 'commit + PR + raw test output' },
    budget: { cny: 20 },
    due_at: '2026-11-21T00:00:00.000Z',
    stop_conditions: ['budget exceeded', 'hard rule violation'],
    idempotency_key: 'idem-1',
    outcome: 'done',
    conclusions: ['Level-aware assembly implemented.'],
    risks: ['execution budget depends on deployment configuration'],
    latest_run: {
      run_id: 'run-1',
      run_no: 1,
      attempt: 1,
      state: 'accepted',
      summary: 'tests pass',
      commit: 'b'.repeat(40),
      evidence_ref: 'evidence-1',
      logs: ['RAW RUN LOG'],
      tool_calls: [{ name: 'secret-tool' }],
    },
    latest_acceptance: {
      acceptance_id: 'acc-1',
      stage: 'business',
      result: 'passed',
      evidence_ref: 'evidence-1',
    },
    latest_report: {
      report_id: 'report-1',
      stage: 'business',
      summary: 'business summary',
    },
    pointers: [
      'evidence:evidence-1',
      { kind: 'report', id: 'report-2', label: 'child report' },
    ],
    artifacts: [
      {
        path: 'packages/context/src/index.js',
        sha256: 'f'.repeat(64),
      },
    ],
    ...overrides,
  };
}

export function makeRecent(count = 3) {
  return Array.from({ length: count }, (_, index) => ({
    id: `msg-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `turn ${index} ` + 'x'.repeat(40),
    at: `2026-11-20T15:5${index}:00.000Z`,
    raw_log: 'RAW RECENT LOG',
    tool_calls: [{ name: 'secret-tool' }],
    stdout: 'RAW STDOUT',
  }));
}

export function makeQuestions() {
  return [
    {
      id: 'esc-1',
      kind: 'budget',
      question: 'Which budget should execution use?',
      options: ['100k', '120k'],
      state: 'open',
    },
    {
      id: 'esc-2',
      kind: 'direction',
      question: 'This one is already answered.',
      state: 'answered',
    },
    {
      id: 'esc-3',
      kind: 'quality',
      question: 'Is the acceptance evidence sufficient?',
      state: 'pending',
    },
  ];
}

export function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

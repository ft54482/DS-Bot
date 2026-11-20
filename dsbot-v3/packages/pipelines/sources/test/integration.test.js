import assert from 'node:assert/strict';
import test from 'node:test';

import { createSourceClient, crossCheck } from '../src/index.js';
import { createClock, createHttp } from './helpers.js';

const ALPHA_ITEM = {
  id: 'alpha-1',
  title: 'The same headline',
  summary: 'The same summary text.',
  source_name: 'Alpha',
  source_url: 'https://alpha.example/story/1',
  published_at: '2026-11-20T10:00:00.000Z',
};

const BETA_ITEM = {
  id: 'beta-7',
  title: 'The same headline',
  summary: 'The same summary text.',
  source_name: 'Beta',
  source_url: 'https://beta.example/story/7',
  published_at: '2026-11-20T18:00:00+08:00',
};

function twoSourceHttp(betaOverrides = {}) {
  return createHttp(({ url }) => {
    if (url.startsWith('https://alpha.example/')) {
      return { status: 200, body: { item: ALPHA_ITEM } };
    }
    if (url.startsWith('https://beta.example/')) {
      return { status: 200, body: { item: { ...BETA_ITEM, ...betaOverrides } } };
    }
    return { status: 404, body: {} };
  });
}

function clientFor(http, name) {
  return createSourceClient({
    http,
    clock: createClock(),
    retries: 0,
    endpoints: { item: `https://${name}.example/story/{id}` },
  });
}

test('integration: two sources of the same story agree after normalization', async () => {
  const { http } = twoSourceHttp();
  const alpha = clientFor(http, 'alpha');
  const beta = clientFor(http, 'beta');

  const first = await alpha.fetchItem({ id: 'alpha-1' });
  const second = await beta.fetchItem({ id: 'beta-7' });

  assert.deepEqual(crossCheck({ item: first, second }), { agree: true, conflicts: [] });
});

test('integration: a second source with a different headline blocks agreement', async () => {
  const { http } = twoSourceHttp({ title: 'A different headline' });
  const alpha = clientFor(http, 'alpha');
  const beta = clientFor(http, 'beta');

  const first = await alpha.fetchItem({ id: 'alpha-1' });
  const second = await beta.fetchItem({ id: 'beta-7' });

  const result = crossCheck({ item: first, second });
  assert.equal(result.agree, false);
  assert.deepEqual(result.conflicts.map((conflict) => conflict.field), ['title']);
});

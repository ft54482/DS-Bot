import assert from 'node:assert/strict';
import test from 'node:test';

import { envDigest, normalizeAllowlist, pickAllowedEnv } from '../src/env.js';

test('env: only allowlisted keys are forwarded', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/home/me',
    TZ: 'UTC',
    SECRET_TOKEN: 'ghp_not_forwarded',
    AWS_SECRET_ACCESS_KEY: 'not_forwarded',
    DS_BOT_TOKEN: 'not_forwarded',
  };
  const picked = pickAllowedEnv(source, ['PATH', 'HOME', 'TZ']);
  assert.deepEqual(picked, { PATH: '/usr/bin', HOME: '/home/me', TZ: 'UTC' });
  assert.equal('SECRET_TOKEN' in picked, false);
  assert.equal('AWS_SECRET_ACCESS_KEY' in picked, false);
  assert.equal('DS_BOT_TOKEN' in picked, false);
});

test('env: Windows-style keys map to the canonical allowlist spelling', () => {
  const picked = pickAllowedEnv(
    { Path: 'C:\\Windows\\System32', TEMP: 'C:\\Temp', NotAllowed: 'x' },
    ['PATH', 'TEMP'],
  );
  assert.deepEqual(picked, { PATH: 'C:\\Windows\\System32', TEMP: 'C:\\Temp' });
  assert.equal('NotAllowed' in picked, false);
});

test('env: duplicate allowlist entries differing only by case are normalized once', () => {
  assert.deepEqual(normalizeAllowlist(['PATH', 'Path', ' path ', 'TZ']), ['PATH', 'TZ']);
});

test('env: digest is stable across key order and changes with values', () => {
  const first = envDigest({ PATH: '/bin', TZ: 'UTC' });
  const second = envDigest({ TZ: 'UTC', PATH: '/bin' });
  assert.equal(first, second);
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(first, envDigest({ PATH: '/bin', TZ: 'CST' }));
});

test('env: the default allowlist never forwards secrets or code-injection keys', () => {
  const picked = pickAllowedEnv({
    PATH: '/bin',
    SECRET_TOKEN: 'x',
    NODE_OPTIONS: '--require .\\evil.js',
    PYTHONSTARTUP: '.\\evil.py',
  });
  assert.deepEqual(picked, { PATH: '/bin' });
});

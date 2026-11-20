import path from 'node:path';
import { resolvePaths } from '../../src/paths.js';
import { createFakeFs } from './fake-fs.js';

export const FIXED_NOW = '2026-11-21T00:00:00.000Z';

export function createTestFs() {
  const root = path.parse(process.cwd()).root;
  return createFakeFs({ home: path.resolve(root, 'provisioner-test-home') });
}

export function dshHomeFor(fs) {
  return path.join(fs.homedir(), '.dsh');
}

export function pathsFor(fs, name) {
  return resolvePaths({ name, fs });
}

/** A probe double that records every call and returns a configurable result. */
export function createProbe({ ok = true, reason = 'overview unavailable', health = {} } = {}) {
  const calls = [];
  const probe = async (context) => {
    calls.push(context);
    return ok ? { ok: true, ...health } : { ok: false, reason };
  };
  probe.calls = calls;
  return probe;
}

export function baseOptions(fs, overrides = {}) {
  return {
    name: 'lab-one',
    repo: 'ft54482/superagent-lab-smoke',
    account: 'yuxianghan-droid',
    port: 3091,
    model: 'orange-pro/DeepSeek-V4.1-flash-2.5',
    fs,
    probe: createProbe(),
    now: FIXED_NOW,
    ...overrides,
  };
}

/** Seed the central registry without going through provision. */
export function seedRegistry(fs, dshHome, instances) {
  const registryPath = path.join(dshHome, 'state', 'provisioner', 'registry.json');
  fs.mkdir(path.dirname(registryPath));
  fs.writeFile(registryPath, `${JSON.stringify({ version: 1, instances }, null, 2)}\n`);
  return registryPath;
}

export function readRegistryFile(fs, dshHome) {
  const registryPath = path.join(dshHome, 'state', 'provisioner', 'registry.json');
  return JSON.parse(fs.readFile(registryPath));
}

/** Capture CLI streams without touching process.stdout/stderr. */
export function captureStreams() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    stdout: { write: (chunk) => (out.push(String(chunk)), true) },
    stderr: { write: (chunk) => (err.push(String(chunk)), true) },
    outText: () => out.join(''),
    errText: () => err.join(''),
  };
}

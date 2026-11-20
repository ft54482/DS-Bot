import { createDsBotAdapter } from '../../src/index.js';
import { createFakeChief, createFakeRuntime } from './fakes.js';

export const AT = 1_700_000_000_000;

export function setup({ chief = createFakeChief(), runtime = createFakeRuntime(), ...options } = {}) {
  const adapter = createDsBotAdapter({
    chief,
    runtime,
    clock: () => AT,
    ...options,
  });
  return { chief, runtime, adapter };
}

export function send(adapter, text, overrides = {}) {
  return adapter.handle({
    userId: 'user-1',
    channel: 'dsbot:dm',
    text,
    ...overrides,
  });
}

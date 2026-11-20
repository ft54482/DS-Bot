/**
 * Load the L9 runtime package lazily.
 *
 * A static import would make every CLI command (including `--help`) fail when
 * the runtime package is not checked out. The dynamic import keeps the CLI
 * testable on its own and reports a clear operator-facing error instead.
 */
import { cliError } from './errors.js';

export async function loadRuntime(options = {}) {
  let module;
  try {
    module = await import('../../runtime/src/index.js');
  } catch (error) {
    throw cliError(
      'runtime_unavailable',
      'packages/runtime is not available; the operator CLI needs the L9 runtime package',
      { cause: error?.code ?? 'import_failed' },
      503,
    );
  }
  if (typeof module.createRuntime !== 'function') {
    throw cliError(
      'runtime_unavailable',
      'packages/runtime does not export createRuntime()',
      { exports: Object.keys(module) },
      503,
    );
  }
  return module.createRuntime(options);
}

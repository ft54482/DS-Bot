/**
 * Thin process shell around `runCli`.
 *
 * Everything here is I/O: load the runtime facade, build deps, write the
 * returned buffers and report the exit code. Keeping it separate means the CLI
 * behaviour itself stays a pure, testable function.
 */
import { createDepsFromRuntime } from './from-runtime.js';
import { loadRuntime as defaultLoadRuntime } from './load-runtime.js';
import { wantsHelp } from './parse.js';
import { runCli } from './run-cli.js';

function throwingDeps(error) {
  const fail = async () => {
    throw error;
  };
  return {
    createTask: fail,
    listTasks: fail,
    getTask: fail,
    dispatchTask: fail,
    acceptRun: fail,
    stopTask: fail,
    getCost: fail,
  };
}

/**
 * @param {string[]} argv arguments excluding the node/script prefix
 * @param {object} [options]
 * @param {Function} [options.loadRuntime] injectable for tests
 * @param {object} [options.runtimeOptions] forwarded to `createRuntime`
 * @param {{write: Function}} [options.stdout]
 * @param {{write: Function}} [options.stderr]
 * @returns {Promise<number>} process exit code
 */
export async function main(
  argv,
  {
    loadRuntime = defaultLoadRuntime,
    runtimeOptions = {
      dbPath: process.env.SUPERAGENT_DB_PATH ?? 'control.sqlite',
      workspacePath: process.env.SUPERAGENT_WORKSPACE ?? null,
    },
    stdout = process.stdout,
    stderr = process.stderr,
  } = {},
) {
  let deps = {};
  if (!wantsHelp(argv)) {
    try {
      deps = createDepsFromRuntime(await loadRuntime(runtimeOptions));
    } catch (error) {
      deps = throwingDeps(error);
    }
  }

  const result = await runCli(argv, deps);
  if (result.stdout) stdout.write(result.stdout);
  if (result.stderr) stderr.write(result.stderr);
  return result.exitCode;
}

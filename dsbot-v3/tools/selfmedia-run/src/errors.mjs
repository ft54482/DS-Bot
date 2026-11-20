/**
 * Stable error classes for the selfmedia-run harness.
 *
 * Exit-code contract (see run.mjs and README.md):
 *   0  run finished and artifacts were written (passed or rework)
 *   1  unexpected internal failure
 *   2  configuration / usage error; no artifacts are written
 *   3  the run blocked because retrieval had no usable sources (artifacts
 *      are still written and say "blocked"; nothing is fabricated)
 */

export const EXIT_OK = 0;
export const EXIT_INTERNAL = 1;
export const EXIT_CONFIG = 2;
export const EXIT_BLOCKED = 3;

export class ConfigError extends Error {
  constructor(message, { hint = null } = {}) {
    super(message);
    this.name = 'ConfigError';
    this.code = 'config_error';
    this.exitCode = EXIT_CONFIG;
    this.hint = hint;
  }
}

export class RetrievalError extends Error {
  constructor(message, { code = 'retrieval_error', cause = null } = {}) {
    super(message);
    this.name = 'RetrievalError';
    this.code = code;
    this.cause = cause;
  }
}

export class ModelError extends Error {
  constructor(message, { code = 'model_error', status = null, cause = null } = {}) {
    super(message);
    this.name = 'ModelError';
    this.code = code;
    this.status = status;
    this.cause = cause;
  }
}

export function errorMessage(error) {
  if (!error) return 'unknown error';
  return error instanceof Error ? error.message : String(error);
}

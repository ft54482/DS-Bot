/**
 * `loadLoop(yamlText)` turns the loop.yaml text into a validated, normalized
 * config. It never throws on bad input: every failure is reported as
 *
 *     { ok: false, code: 'invalid_config', path, message }
 *
 * where `path` is the field path (`verifier`, `verifier.command`, `base`,
 * `maxWorkers`, `lane`, `stopLoss.maxRounds`, ...) and `$` means the whole
 * document (bad YAML or a non-mapping root).
 *
 * Required fields are `verifier`, `base` and `maxWorkers`. `lane` and
 * `stopLoss` are optional and default to the PRD values. Unknown keys are
 * ignored so a later loop revision can add fields without breaking older
 * loaders.
 */

import {
  BASE_REF,
  DEFAULT_LANE,
  DEFAULT_STOP_LOSS,
  MAX_WORKERS,
  MIN_WORKERS,
} from './constants.js';
import { parseYaml, YamlError } from './yaml.js';

/**
 * @param {string} yamlText
 * @returns {{ok: true, config: object} | {ok: false, code: 'invalid_config', path: string, message: string}}
 */
export function loadLoop(yamlText) {
  if (typeof yamlText !== 'string') {
    return invalid('$', 'loop config must be a YAML string');
  }

  let document;
  try {
    document = parseYaml(yamlText);
  } catch (error) {
    if (error instanceof YamlError) return invalid('$', error.message);
    return invalid('$', error instanceof Error ? error.message : String(error));
  }

  return validateLoopDocument(document);
}

/**
 * Validate an already parsed document. Exported for callers that hold a
 * parsed YAML/JSON document (tests, future file loaders).
 */
export function validateLoopDocument(document) {
  if (!isPlainObject(document)) {
    return invalid('$', 'loop config must be a YAML mapping');
  }

  const verifier = normalizeVerifier(document.verifier);
  if (!verifier.ok) return verifier;

  if (document.base !== BASE_REF) {
    return invalid('base', `base must be "${BASE_REF}"`);
  }

  if (
    !Number.isInteger(document.maxWorkers)
    || document.maxWorkers < MIN_WORKERS
    || document.maxWorkers > MAX_WORKERS
  ) {
    return invalid(
      'maxWorkers',
      `maxWorkers must be an integer between ${MIN_WORKERS} and ${MAX_WORKERS}`,
    );
  }

  let lane = DEFAULT_LANE;
  if (document.lane !== undefined) {
    if (typeof document.lane !== 'string' || document.lane.trim() === '') {
      return invalid('lane', 'lane must be a non-empty string');
    }
    lane = document.lane.trim();
  }

  const stopLossConfig = normalizeStopLossConfig(document.stopLoss);
  if (!stopLossConfig.ok) return stopLossConfig;

  return {
    ok: true,
    config: {
      lane,
      base: BASE_REF,
      maxWorkers: document.maxWorkers,
      verifier: verifier.value,
      stopLoss: stopLossConfig.value,
    },
  };
}

function normalizeVerifier(value) {
  if (value === undefined || value === null) {
    return invalid('verifier', 'verifier is required');
  }

  if (typeof value === 'string') {
    const command = value.trim();
    if (command === '') return invalid('verifier', 'verifier command must not be empty');
    return { ok: true, value: { command, independent: true } };
  }

  if (!isPlainObject(value)) {
    return invalid('verifier', 'verifier must be a command string or a mapping');
  }

  if (typeof value.command !== 'string' || value.command.trim() === '') {
    return invalid('verifier.command', 'verifier.command must be a non-empty string');
  }

  let independent = true;
  if (value.independent !== undefined) {
    if (typeof value.independent !== 'boolean') {
      return invalid('verifier.independent', 'verifier.independent must be a boolean');
    }
    independent = value.independent;
  }

  return { ok: true, value: { command: value.command.trim(), independent } };
}

function normalizeStopLossConfig(value) {
  if (value === undefined) return { ok: true, value: { ...DEFAULT_STOP_LOSS } };
  if (!isPlainObject(value)) return invalid('stopLoss', 'stopLoss must be a mapping');

  const result = { ...DEFAULT_STOP_LOSS };

  if (value.maxRounds !== undefined) {
    if (!Number.isInteger(value.maxRounds) || value.maxRounds < 1) {
      return invalid('stopLoss.maxRounds', 'stopLoss.maxRounds must be an integer >= 1');
    }
    result.maxRounds = value.maxRounds;
  }

  if (value.maxBudget !== undefined) {
    if (!Number.isFinite(value.maxBudget) || value.maxBudget <= 0) {
      return invalid('stopLoss.maxBudget', 'stopLoss.maxBudget must be a number > 0');
    }
    result.maxBudget = value.maxBudget;
  }

  if (value.noProgressMinutes !== undefined) {
    if (!Number.isFinite(value.noProgressMinutes) || value.noProgressMinutes <= 0) {
      return invalid(
        'stopLoss.noProgressMinutes',
        'stopLoss.noProgressMinutes must be a number > 0',
      );
    }
    result.noProgressMinutes = value.noProgressMinutes;
  }

  return { ok: true, value: result };
}

function invalid(path, message) {
  return { ok: false, code: 'invalid_config', path, message };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

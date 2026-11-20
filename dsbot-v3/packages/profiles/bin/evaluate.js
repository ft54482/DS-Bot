#!/usr/bin/env node
/**
 * Evaluate one article-pack JSON file and print the full acceptance evidence.
 *
 *   node packages/profiles/bin/evaluate.js <pack.json> [profile.json]
 *
 * Exit codes: 0 pass, 2 needs_rework, 3 blocked, 64 usage/IO/profile error.
 * This CLI is acceptance-only; it never publishes and never grants a license.
 */
import { readFileSync } from 'node:fs';
import { evaluateArticlePack, selfMediaProfileV1 } from '../src/index.js';

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const wrapped = new Error(`cannot read ${label} ${path}: ${error.message}`);
    wrapped.code = 'input_error';
    throw wrapped;
  }
}

function main() {
  const [, , packPath, profilePath] = process.argv;
  if (!packPath) {
    console.error('usage: node packages/profiles/bin/evaluate.js <pack.json> [profile.json]');
    process.exitCode = 64;
    return;
  }

  let pack;
  let profile;
  try {
    pack = readJson(packPath, 'article pack');
    profile = profilePath ? readJson(profilePath, 'profile') : selfMediaProfileV1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 64;
    return;
  }

  let result;
  try {
    result = evaluateArticlePack(pack, profile);
  } catch (error) {
    console.error(`${error.name}: ${error.message}`);
    process.exitCode = 64;
    return;
  }

  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.result === 'pass' ? 0 : result.result === 'needs_rework' ? 2 : 3;
}

main();

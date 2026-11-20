/**
 * Resolve the four sibling packages the manager composes.
 *
 * A DSH profile installs `@dsbot/devloop-plugin` under `node_modules/@dsbot/`,
 * next to the four packages it depends on. There the bare specifiers below
 * resolve through each package's `./src/*` subpath export, so the plugin binds
 * to whatever version the profile installed instead of to a relative path that
 * happens to exist next to the checkout.
 *
 * A plain git checkout has no `node_modules`; the same modules then live under
 * the sibling `packages/<name>/src` directories. That fallback only serves the
 * checkout: once the plugin is loaded from an installed tree a missing
 * dependency fails here with the package name and the install hint, instead of
 * surfacing a bare ERR_MODULE_NOT_FOUND for a path the user never wrote.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

/** Logical name -> [installed specifier, source-checkout relative path]. */
const DEPENDENCIES = Object.freeze({
  autoloop: ['@dsbot/autoloop/src/index.js', '../../autoloop/src/index.js'],
  goalEngine: ['@dsbot/goal-engine/src/index.js', '../../goal-engine/src/index.js'],
  provisioner: ['@dsbot/provisioner/src/index.js', '../../provisioner/src/index.js'],
  verifierAgent: ['@dsbot/verifier-agent/src/index.js', '../../verifier-agent/src/index.js'],
});

/** The four packages a profile must install alongside the plugin. */
const SIBLINGS = Object.values(DEPENDENCIES)
  .map(([specifier]) => specifier.slice(0, specifier.indexOf('/src/')))
  .join(', ');

/** True when this module was loaded from an installed `node_modules` tree. */
const INSTALLED = /\/node_modules\//.test(decodeURIComponent(new URL(import.meta.url).pathname));

/**
 * Import one sibling package.
 *
 * @param {'autoloop'|'goalEngine'|'provisioner'|'verifierAgent'} name
 * @returns {Promise<object>} the package module namespace
 */
export async function loadDependency(name) {
  const entry = DEPENDENCIES[name];
  if (entry === undefined) {
    throw new Error(`devloop-plugin: unknown dependency "${name}"`);
  }
  const [specifier, relative] = entry;
  if (!INSTALLED) return import(new URL(relative, import.meta.url).href);

  try {
    return await import(pathToFileURL(require.resolve(specifier)).href);
  } catch (error) {
    if (isMissingModule(error)) {
      throw new Error(
        `devloop-plugin: cannot load ${specifier}. Install ${SIBLINGS} 0.1.0 ` +
          'into the profile before starting (see README: 作为 npm 包安装).',
        { cause: error },
      );
    }
    throw error;
  }
}

function isMissingModule(error) {
  return (
    error?.code === 'MODULE_NOT_FOUND' ||
    error?.code === 'ERR_MODULE_NOT_FOUND' ||
    error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
  );
}

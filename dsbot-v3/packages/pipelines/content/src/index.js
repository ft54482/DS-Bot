/**
 * Public surface of `@ds-bot/pipelines-content`.
 */

export {
  PACK_REQUIRED_KEYS,
  PACK_VERSION,
  excerptOf,
  sha256Hex,
  validateArticlePack,
} from './article-pack.js';

export {
  CANCELLED_CODE,
  DEFAULT_EXCERPT_CHARS,
  DEFAULT_MIN_INDEPENDENT_SOURCES_FOR_KEY_FACT,
  DEFAULT_MIN_TITLE_CANDIDATES,
  STAGES,
  createContentPipeline,
  defaultFetch,
  defaultModel,
  defaultReview,
  defaultSearch,
  defaultWrite,
  runContentPipeline,
  scoreFromIssues,
} from './pipeline.js';

export {
  createContentToolChainAdapter,
  createContentToolChainAdapter as createContentAdapter,
  createContentToolChainAdapter as createToolChainAdapter,
} from './tool-chain.js';

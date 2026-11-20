/**
 * Report helpers: timestamps, cost estimation and environment summaries.
 *
 * The report is an audit artifact. It records how many calls happened and what
 * they cost, but never the model API key or the search key.
 */

export function isoOf(ms) {
  const value = Number(ms);
  return new Date(Number.isFinite(value) ? value : Date.now()).toISOString();
}

function priceOf(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/**
 * Cost estimate basis: CNY per 1,000 input/output tokens, read from
 * DSBOT_MODEL_PRICE_INPUT_CNY_PER_1K and DSBOT_MODEL_PRICE_OUTPUT_CNY_PER_1K.
 * When prices are not configured the estimate is 0 and says so; it is never a
 * guessed vendor price.
 */
export function buildCost({ usage, mode, env = {} }) {
  const inputPrice = priceOf(env.DSBOT_MODEL_PRICE_INPUT_CNY_PER_1K);
  const outputPrice = priceOf(env.DSBOT_MODEL_PRICE_OUTPUT_CNY_PER_1K);
  const tokensIn = Number(usage?.tokens_in ?? 0);
  const tokensOut = Number(usage?.tokens_out ?? 0);
  const base = {
    currency: 'CNY',
    unit: 'per_1k_tokens',
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    input_cny_per_1k: inputPrice,
    output_cny_per_1k: outputPrice,
  };

  if (mode !== 'real') {
    return {
      ...base,
      estimated_cny: 0,
      pricing_source: 'not_applicable_fake',
      formula: 'fake mode performs no paid model calls',
    };
  }
  if (inputPrice === null || outputPrice === null) {
    return {
      ...base,
      estimated_cny: 0,
      pricing_source: 'unconfigured',
      formula:
        'set DSBOT_MODEL_PRICE_INPUT_CNY_PER_1K and DSBOT_MODEL_PRICE_OUTPUT_CNY_PER_1K to estimate cost',
    };
  }
  const estimate = (tokensIn / 1000) * inputPrice + (tokensOut / 1000) * outputPrice;
  return {
    ...base,
    estimated_cny: Math.round(estimate * 1e6) / 1e6,
    pricing_source: 'env',
    formula: '(tokens_in / 1000) * input_cny_per_1k + (tokens_out / 1000) * output_cny_per_1k',
  };
}

export function buildUsage({ mode, client }) {
  const usage = client?.getUsage?.() ?? { tokens_in: 0, tokens_out: 0, tokens_cached: 0 };
  const total = Number(usage.tokens_in ?? 0) + Number(usage.tokens_out ?? 0);
  return {
    tokens_in: Number(usage.tokens_in ?? 0),
    tokens_out: Number(usage.tokens_out ?? 0),
    tokens_cached: Number(usage.tokens_cached ?? 0),
    total_tokens: total,
    source: mode === 'real' ? (total > 0 ? 'api_usage' : 'unavailable') : 'fake_no_usage',
  };
}

export function buildModelEnvSummary({ mode, env = {}, client, gateway = 'env' }) {
  if (mode !== 'real') {
    return {
      mode,
      gateway,
      model: 'deterministic-fake',
      api_key_present: false,
      api_key_logged: false,
    };
  }
  if (gateway === 'bridge') {
    return {
      mode,
      gateway,
      model: String(env.DSBOT_BRIDGE_MODEL ?? env.DSBOT_MODEL_NAME ?? 'dsh-bridge'),
      base_url_host: client?.endpointHost ?? null,
      api_key_present: false,
      api_key_logged: false,
      bridge_secret_present: true,
      bridge_secret_logged: false,
    };
  }
  return {
    mode,
    gateway,
    model: String(env.DSBOT_MODEL_NAME ?? ''),
    base_url_host: client?.endpointHost ?? null,
    api_key_present: Boolean(String(env.DSBOT_MODEL_API_KEY ?? '').trim()),
    api_key_logged: false,
  };
}

/** Remove configured secret values from any message before it is recorded. */
export function redactSecrets(text, env = {}, extraSecrets = []) {
  let value = String(text ?? '');
  for (const name of ['DSBOT_MODEL_API_KEY', 'DSBOT_SEARCH_API_KEY']) {
    const secret = String(env[name] ?? '').trim();
    if (secret.length >= 4) value = value.split(secret).join('[redacted]');
  }
  for (const secret of Array.isArray(extraSecrets) ? extraSecrets : [extraSecrets]) {
    const textSecret = typeof secret === 'string' ? secret.trim() : '';
    if (textSecret.length >= 4) value = value.split(textSecret).join('[redacted]');
  }
  return value;
}

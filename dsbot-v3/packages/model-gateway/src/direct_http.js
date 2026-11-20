import { ERROR_CODES, ENV_NAMES } from './constants.js';
import { errorFromStatus, gatewayError, asGatewayError } from './errors.js';
import { withTimeout } from './clock.js';
import { chatCompletionsUrl, firstNumber, firstString, parseJson, parseRetryAfterMs, readTransportResponse } from './transport.js';
import { redact } from './sanitize.js';
import { retryOperation } from './retry.js';

function missingCredentials(names) {
  const error = gatewayError(
    ERROR_CODES.missing_credentials,
    `direct_http is missing credentials: ${names.join(', ')} (set them in the injected env; nothing is read from disk)`,
    { retryable: false },
  );
  error.missing = names;
  return error;
}

function extractText(payload) {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  let text = choice?.message?.content ?? choice?.text ?? null;
  if (Array.isArray(text)) {
    text = text
      .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
      .join('');
  }
  return typeof text === 'string' ? text : null;
}

function extractUsage(payload) {
  const usage = payload?.usage ?? {};
  const input = firstNumber(usage.prompt_tokens, usage.input_tokens);
  const output = firstNumber(usage.completion_tokens, usage.output_tokens);
  const result = {};
  if (input !== null) result.inputTokens = input;
  if (output !== null) result.outputTokens = output;
  return result;
}

function bodyExcerpt(body, secrets) {
  if (typeof body !== 'string' || body.length === 0) return null;
  return redact(body.slice(0, 300), secrets);
}

export function createDirectHttpBackend({ transport, clock, env, options }) {
  function resolveCredentials() {
    const baseUrl = firstString(options.baseUrl, env[ENV_NAMES.baseUrl]);
    const apiKey = firstString(options.apiKey, env[ENV_NAMES.apiKey]);
    const model = firstString(options.model, env[ENV_NAMES.model]);
    const missing = [];
    if (baseUrl === null) missing.push(ENV_NAMES.baseUrl);
    if (apiKey === null) missing.push(ENV_NAMES.apiKey);
    if (model === null) missing.push(ENV_NAMES.model);
    if (missing.length > 0) throw missingCredentials(missing);
    return { baseUrl, apiKey, model, url: chatCompletionsUrl(baseUrl) };
  }

  async function attempt(credentials, request, timeoutMs) {
    const secrets = [credentials.apiKey];
    const messages = [];
    if (typeof request.system === 'string' && request.system.length > 0) {
      messages.push({ role: 'system', content: request.system });
    }
    messages.push({ role: 'user', content: request.prompt });
    const payload = { model: credentials.model, messages };
    if (request.maxTokens !== null) payload.max_tokens = request.maxTokens;

    let response;
    try {
      response = await withTimeout(
        Promise.resolve(
          transport({
            url: credentials.url,
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${credentials.apiKey}`,
              accept: 'application/json',
            },
            body: JSON.stringify(payload),
            timeoutMs,
          }),
        ),
        timeoutMs,
        clock,
        () => gatewayError(ERROR_CODES.timeout, `direct_http timed out after ${timeoutMs} ms`, { retryable: false }),
      );
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw gatewayError(ERROR_CODES.timeout, `direct_http timed out after ${timeoutMs} ms`, { retryable: false });
      }
      const normalized = asGatewayError(error, ERROR_CODES.upstream_error);
      if (normalized.code === ERROR_CODES.timeout) throw normalized;
      throw gatewayError(
        ERROR_CODES.upstream_error,
        `direct_http transport failed: ${redact(normalized.message, secrets)}`,
        { retryable: true },
      );
    }

    let parsedResponse;
    try {
      parsedResponse = await readTransportResponse(response);
    } catch (error) {
      throw gatewayError(
        ERROR_CODES.bad_response,
        `direct_http transport returned an unusable response: ${redact(asGatewayError(error).message, secrets)}`,
        { retryable: true },
      );
    }

    const { status, headers, body } = parsedResponse;
    if (status < 200 || status >= 300) {
      const error = errorFromStatus(status, 'direct_http', bodyExcerpt(body, secrets));
      const retryAfterMs = status === 429 ? parseRetryAfterMs(headers) : null;
      if (retryAfterMs !== null) error.retryAfterMs = retryAfterMs;
      throw error;
    }

    const json = parseJson(body);
    if (json === null) {
      throw gatewayError(ERROR_CODES.bad_response, 'direct_http returned a non-JSON body', {
        status,
        retryable: true,
      });
    }

    const text = extractText(json);
    if (text === null || text.trim().length === 0) {
      throw gatewayError(ERROR_CODES.empty_completion, 'direct_http returned an empty completion', {
        status,
        retryable: false,
      });
    }

    return {
      text: redact(text, secrets),
      usage: extractUsage(json),
    };
  }

  return {
    async complete(request) {
      const startedAt = clock.now();
      const credentials = resolveCredentials();
      const timeoutMs = request.timeoutMs;
      const result = await retryOperation(
        () => attempt(credentials, request, timeoutMs),
        {
          clock,
          maxRetries: options.maxRetries,
          backoffMs: options.backoffMs,
        },
      );
      return {
        text: result.text,
        usage: result.usage,
        backend: 'direct_http',
        latencyMs: Math.max(0, clock.now() - startedAt),
      };
    },
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';

import { createGateway, ERROR_CODES } from '../src/index.js';
import {
  advancingClock,
  jsonResponse,
  mcpBridge,
  mcpError,
  mcpToolError,
  mcpToolValue,
  sequenceClock,
  toolCalls,
} from './helpers/fake_transport.js';

const SECRET = 'bridge-secret-0123456789abcdef';

function makeGateway(transport, extra = {}) {
  return createGateway({
    kind: 'dsh_bridge',
    transport,
    env: { DSH_BRIDGE_SECRET: SECRET },
    cwd: 'D:/work/model-gateway',
    clock: sequenceClock([10, 25]),
    ...extra,
  });
}

function acceptedPrompt(text, { structured = true, usage } = {}) {
  const value = { accepted: true, requestId: 'req-1', sessionId: 's-1' };
  if (text !== undefined) value.text = text;
  if (usage !== undefined) value.usage = usage;
  return mcpToolValue(1, value, { structured });
}

test('dsh_bridge: complete() runs initialize -> dsh_create_session -> dsh_prompt over MCP JSON-RPC', async () => {
  const transport = mcpBridge({
    tools: {
      dsh_create_session: ({ args, id }) => mcpToolValue(id, { sessionId: 's-1', cwd: args.cwd }),
      dsh_prompt: ({ id }) => acceptedPrompt('bridge says hi', { usage: { inputTokens: 3, outputTokens: 4 } }),
    },
  });
  const gateway = makeGateway(transport);

  const result = await gateway.complete({ prompt: 'user', system: 'sys' });

  assert.deepEqual(result, {
    text: 'bridge says hi',
    usage: { inputTokens: 3, outputTokens: 4 },
    backend: 'dsh_bridge',
    latencyMs: 15,
  });
  assert.deepEqual(transport.state.methods, ['initialize', 'notifications/initialized', 'tools/call', 'tools/call']);
  assert.deepEqual(transport.state.tools.map((tool) => tool.name), ['dsh_create_session', 'dsh_prompt']);
  const firstCall = transport.calls[0];
  assert.equal(firstCall.url, 'http://127.0.0.1:17300/mcp');
  assert.equal(firstCall.headers.authorization, `Bearer ${SECRET}`);
  assert.equal(firstCall.body.method, 'initialize');
  assert.equal(firstCall.body.jsonrpc, '2.0');

  const create = transport.state.tools[0];
  assert.equal(create.args.cwd, 'D:/work/model-gateway');
  assert.equal(create.args.source, 'dsbot-model-gateway');
  const prompt = transport.state.tools[1].args;
  assert.deepEqual(prompt, { sessionId: 's-1', text: 'sys\n\nuser', delivery: 'queue' });
});

test('dsh_bridge: a missing bridge secret fails before any request', async () => {
  const transport = mcpBridge({});
  const gateway = createGateway({ kind: 'dsh_bridge', transport, env: {}, clock: sequenceClock([0, 1]) });

  await assert.rejects(gateway.complete({ prompt: 'x' }), (error) => {
    assert.equal(error.code, ERROR_CODES.missing_credentials);
    assert.match(error.message, /DSH_BRIDGE_SECRET/);
    assert.deepEqual(error.missing, ['DSH_BRIDGE_SECRET']);
    return true;
  });
  assert.equal(transport.calls.length, 0);
});

test('dsh_bridge: a 401 on initialize is auth_failed and is not retried', async () => {
  const clock = sequenceClock([0, 1]);
  const transport = mcpBridge({
    initialize: () => jsonResponse(401, { error: 'unauthorized' }),
  });
  const gateway = createGateway({
    kind: 'dsh_bridge',
    transport,
    env: { DSH_BRIDGE_SECRET: SECRET },
    clock,
    backoffMs: 5,
  });

  await assert.rejects(gateway.complete({ prompt: 'x' }), (error) => {
    assert.equal(error.code, ERROR_CODES.auth_failed);
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(transport.calls.length, 1);
  assert.deepEqual(clock.sleeps, []);
});

test('dsh_bridge: a retryable initialize failure retries the whole handshake once', async () => {
  const clock = sequenceClock([0, 1]);
  let first = true;
  const transport = mcpBridge({
    initialize: ({ envelope }) => {
      if (first) {
        first = false;
        return jsonResponse(503, { error: 'starting' });
      }
      return mcpError(envelope.id, -32000, 'late');
    },
  });
  // The handler above returns a JSON-RPC error on the retry, which is not retryable.
  // Prove the first 503 was retried by counting initialize calls.
  const gateway = createGateway({
    kind: 'dsh_bridge',
    transport,
    env: { DSH_BRIDGE_SECRET: SECRET },
    clock,
    backoffMs: 5,
  });

  await assert.rejects(gateway.complete({ prompt: 'x' }), (error) => {
    assert.equal(error.code, ERROR_CODES.bridge_error);
    return true;
  });
  assert.equal(transport.state.initialized, 2);
  assert.deepEqual(clock.sleeps, [5]);
});

test('dsh_bridge: a JSON-RPC internal error is retryable and retried once', async () => {
  const clock = sequenceClock([0, 1]);
  let first = true;
  const transport = mcpBridge({
    initialize: ({ envelope }) => {
      if (first) {
        first = false;
        return mcpError(envelope.id, -32603, 'internal error');
      }
      return mcpRpcSuccess(envelope);
    },
    tools: {
      dsh_create_session: ({ id }) => mcpToolValue(id, { sessionId: 's-retry' }),
      dsh_prompt: ({ id }) => acceptedPrompt('retried'),
    },
  });
  const gateway = makeGateway(transport, { clock, backoffMs: 5 });

  const result = await gateway.complete({ prompt: 'x' });

  assert.equal(result.text, 'retried');
  assert.equal(transport.state.initialized, 2);
  assert.deepEqual(clock.sleeps, [5]);
});

function mcpRpcSuccess(envelope) {
  return jsonResponse(200, {
    jsonrpc: '2.0',
    id: envelope.id,
    result: {
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'fake', version: 'test' },
    },
  });
}

test('dsh_bridge: a rate-limited prompt is retried once and then succeeds', async () => {
  const clock = sequenceClock([0, 1]);
  let attempts = 0;
  const transport = mcpBridge({
    tools: {
      dsh_create_session: ({ id }) => mcpToolValue(id, { sessionId: 's-1' }),
      dsh_prompt: ({ id }) => {
        attempts += 1;
        if (attempts === 1) return mcpToolError(id, 'RATE_LIMITED', 'slow down');
        return acceptedPrompt('after retry');
      },
    },
  });
  const gateway = makeGateway(transport, { clock, backoffMs: 5 });

  const result = await gateway.complete({ prompt: 'x' });

  assert.equal(result.text, 'after retry');
  assert.equal(toolCalls(transport, 'dsh_prompt').length, 2);
  assert.equal(transport.state.initialized, 2);
  assert.deepEqual(clock.sleeps, [5]);
});

test('dsh_bridge: when dsh_prompt is accepted-only, dsh_follow collects the turn text', async () => {
  const transport = mcpBridge({
    tools: {
      dsh_create_session: ({ id }) => mcpToolValue(id, { sessionId: 's-2' }, { structured: false }),
      dsh_prompt: ({ id }) => acceptedPrompt(undefined, { structured: false }),
      dsh_follow: ({ id, args }) =>
        mcpToolValue(
          id,
          {
            sessionId: 's-2',
            sinceSeq: args.sinceSeq,
            records: [
              { seq: 1, type: 'message', time: 1, data: { role: 'assistant', text: 'the answer' } },
              { seq: 2, type: 'turn/end', time: 2, data: { reason: { kind: 'ok' } } },
            ],
            timedOut: false,
            hasMore: false,
          },
          { structured: false },
        ),
    },
  });
  const gateway = makeGateway(transport, { clock: sequenceClock([0, 1000]) });

  const result = await gateway.complete({ prompt: 'x', timeoutMs: 5000 });

  assert.equal(result.text, 'the answer');
  assert.deepEqual(result.usage, {});
  const follow = toolCalls(transport, 'dsh_follow')[0];
  assert.equal(follow.args.sessionId, 's-2');
  assert.equal(follow.args.sinceSeq, 0);
  assert.equal(follow.args.maxEvents, 200);
});

test('dsh_bridge: follow delta events are concatenated', async () => {
  const transport = mcpBridge({
    tools: {
      dsh_create_session: ({ id }) => mcpToolValue(id, { sessionId: 's-3' }),
      dsh_prompt: ({ id }) => acceptedPrompt(undefined),
      dsh_follow: ({ id }) =>
        mcpToolValue(id, {
          records: [
            { seq: 1, type: 'message/delta', data: { text: '你' } },
            { seq: 2, type: 'message/delta', data: { text: '好' } },
            { seq: 3, type: 'turn/end', data: {} },
          ],
          timedOut: false,
          hasMore: false,
        }),
    },
  });
  const gateway = makeGateway(transport);

  const result = await gateway.complete({ prompt: 'x', timeoutMs: 5000 });

  assert.equal(result.text, '你好');
});

test('dsh_bridge: follow ignores user/tool text and reads assistant content parts', async () => {
  const transport = mcpBridge({
    tools: {
      dsh_create_session: ({ id }) => mcpToolValue(id, { sessionId: 's-9' }),
      dsh_prompt: ({ id }) => acceptedPrompt(undefined),
      dsh_follow: ({ id }) =>
        mcpToolValue(id, {
          records: [
            { seq: 1, type: 'message', data: { role: 'user', text: 'the user prompt' } },
            { seq: 2, type: 'tool/result', data: { text: 'raw tool output' } },
            { seq: 3, type: 'message', data: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] } },
            { seq: 4, type: 'turn/end', data: { reason: { kind: 'ok' } } },
          ],
          timedOut: false,
          hasMore: false,
        }),
    },
  });
  const gateway = makeGateway(transport);

  const result = await gateway.complete({ prompt: 'x', timeoutMs: 5000 });

  assert.equal(result.text, 'final answer');
});

test('dsh_bridge: following past the total timeout is timeout and does not re-prompt', async () => {
  const clock = advancingClock(0);
  const transport = mcpBridge({
    tools: {
      dsh_create_session: ({ id }) => mcpToolValue(id, { sessionId: 's-4' }),
      dsh_prompt: ({ id }) => acceptedPrompt(undefined),
      dsh_follow: ({ id, args }) => {
        clock.advance(args.timeoutMs);
        return mcpToolValue(id, { records: [], timedOut: true, hasMore: false });
      },
    },
  });
  const gateway = makeGateway(transport, { clock });

  await assert.rejects(gateway.complete({ prompt: 'x', timeoutMs: 1000 }), (error) => {
    assert.equal(error.code, ERROR_CODES.timeout);
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(toolCalls(transport, 'dsh_prompt').length, 1);
  // The single slice used the whole budget; no extra follow or sleep follows.
  assert.equal(toolCalls(transport, 'dsh_follow').length, 1);
  assert.deepEqual(clock.sleeps, []);
});

test('dsh_bridge: a finished turn without assistant text is empty_completion', async () => {
  const transport = mcpBridge({
    tools: {
      dsh_create_session: ({ id }) => mcpToolValue(id, { sessionId: 's-5' }),
      dsh_prompt: ({ id }) => acceptedPrompt(undefined),
      dsh_follow: ({ id }) => mcpToolValue(id, { records: [{ seq: 1, type: 'turn/end', data: {} }] }),
    },
  });
  const gateway = makeGateway(transport);

  await assert.rejects(gateway.complete({ prompt: 'x' }), (error) => {
    assert.equal(error.code, ERROR_CODES.empty_completion);
    return true;
  });
});

test('dsh_bridge: follow can be disabled, leaving accepted-only prompts as empty_completion', async () => {
  const transport = mcpBridge({
    tools: {
      dsh_create_session: ({ id }) => mcpToolValue(id, { sessionId: 's-6' }),
      dsh_prompt: ({ id }) => acceptedPrompt(undefined),
      dsh_follow: () => {
        throw new Error('follow must not be called');
      },
    },
  });
  const gateway = makeGateway(transport, { follow: false });

  await assert.rejects(gateway.complete({ prompt: 'x' }), (error) => {
    assert.equal(error.code, ERROR_CODES.empty_completion);
    return true;
  });
  assert.equal(toolCalls(transport, 'dsh_follow').length, 0);
});

test('dsh_bridge: an unknown tool is a non-retryable bridge_error', async () => {
  const clock = sequenceClock([0, 1]);
  const transport = mcpBridge({
    tools: {
      dsh_create_session: ({ envelope }) => mcpError(envelope.id, -32601, 'method not found'),
    },
  });
  const gateway = makeGateway(transport, { clock, backoffMs: 5 });

  await assert.rejects(gateway.complete({ prompt: 'x' }), (error) => {
    assert.equal(error.code, ERROR_CODES.bridge_error);
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(transport.state.methods.length, 3);
  assert.deepEqual(clock.sleeps, []);
});

test('dsh_bridge: a session without sessionId is bad_response', async () => {
  const transport = mcpBridge({
    tools: {
      dsh_create_session: ({ id }) => mcpToolValue(id, { cwd: 'D:/work' }),
    },
  });
  const gateway = makeGateway(transport);

  await assert.rejects(gateway.complete({ prompt: 'x' }), (error) => {
    assert.equal(error.code, ERROR_CODES.bad_response);
    assert.equal(error.retryable, false);
    return true;
  });
});

test('dsh_bridge: tool errors are mapped and the bridge secret is redacted', async () => {
  const transport = mcpBridge({
    tools: {
      dsh_create_session: ({ id }) => mcpToolValue(id, { sessionId: 's-7' }),
      dsh_prompt: ({ id }) => mcpToolError(id, 'BAD_REQUEST', `bad secret ${SECRET}`),
    },
  });
  const gateway = makeGateway(transport, { maxRetries: 0 });

  await assert.rejects(gateway.complete({ prompt: 'x' }), (error) => {
    assert.equal(error.code, ERROR_CODES.invalid_request);
    assert.equal(error.retryable, false);
    assert.ok(!error.message.includes(SECRET));
    assert.match(error.message, /\[redacted\]/);
    return true;
  });
});

test('dsh_bridge: a retryable follow failure after the prompt is accepted is not retried', async () => {
  const transport = mcpBridge({
    tools: {
      dsh_create_session: ({ id }) => mcpToolValue(id, { sessionId: 's-8' }),
      dsh_prompt: ({ id }) => acceptedPrompt(undefined),
      dsh_follow: ({ id }) => mcpToolError(id, 'HOST_ERROR', 'host went away'),
    },
  });
  const gateway = makeGateway(transport, { clock: sequenceClock([0, 1]), backoffMs: 5 });

  await assert.rejects(gateway.complete({ prompt: 'x', timeoutMs: 5000 }), (error) => {
    assert.equal(error.code, ERROR_CODES.upstream_error);
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(toolCalls(transport, 'dsh_prompt').length, 1);
});

test('dsh_bridge: reuseSession creates one session and advances the follow cursor per turn', async () => {
  let created = 0;
  const prompts = [];
  const follows = [];
  const transport = mcpBridge({
    tools: {
      dsh_create_session: ({ id }) => {
        created += 1;
        return mcpToolValue(id, { sessionId: `s-reuse-${created}` });
      },
      dsh_prompt: ({ id, args }) => {
        prompts.push(args);
        return acceptedPrompt(undefined);
      },
      dsh_follow: ({ id, args }) => {
        follows.push(args);
        const turn = follows.length;
        return mcpToolValue(id, {
          records: [
            { seq: turn * 2 - 1, type: 'message', data: { role: 'assistant', text: `answer ${turn}` } },
            { seq: turn * 2, type: 'turn/end', data: {} },
          ],
          timedOut: false,
          hasMore: false,
        });
      },
    },
  });
  const gateway = makeGateway(transport, { reuseSession: true, clock: sequenceClock([0, 1, 2, 3]) });

  const first = await gateway.complete({ prompt: 'first', timeoutMs: 5000 });
  const second = await gateway.complete({ prompt: 'second', timeoutMs: 5000 });

  assert.equal(first.text, 'answer 1');
  assert.equal(second.text, 'answer 2');
  assert.equal(created, 1);
  assert.equal(toolCalls(transport, 'dsh_create_session').length, 1);
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].sessionId, 's-reuse-1');
  assert.equal(prompts[1].sessionId, 's-reuse-1');
  assert.deepEqual(prompts.map((prompt) => prompt.text), ['first', 'second']);
  assert.deepEqual(
    follows.map((follow) => follow.sinceSeq),
    [0, 2],
  );
  assert.ifError(follows.find((follow) => follow.sessionId !== 's-reuse-1'));
});

test('dsh_bridge: without reuseSession each complete() creates a fresh session', async () => {
  let created = 0;
  const transport = mcpBridge({
    tools: {
      dsh_create_session: ({ id }) => {
        created += 1;
        return mcpToolValue(id, { sessionId: `s-${created}` });
      },
      dsh_prompt: ({ id }) => acceptedPrompt('direct text'),
    },
  });
  const gateway = makeGateway(transport);

  await gateway.complete({ prompt: 'one' });
  await gateway.complete({ prompt: 'two' });

  assert.equal(created, 2);
  assert.equal(toolCalls(transport, 'dsh_create_session').length, 2);
});

test('dsh_bridge: the final assistant text can come from projections.values.turnOutline', async () => {
  const transport = mcpBridge({
    tools: {
      dsh_create_session: ({ id }) => mcpToolValue(id, { sessionId: 's-outline' }),
      dsh_prompt: ({ id }) => acceptedPrompt(undefined),
      dsh_follow: ({ id }) =>
        mcpToolValue(id, {
          records: [{ seq: 1, type: 'turn/end', data: {} }],
          projections: {
            values: {
              turnOutline: [
                { turn: 1, seq: 1, prompt: 'prompt', response: '' },
                { turn: 2, seq: 4, prompt: 'next', response: 'outline answer' },
              ],
            },
          },
          timedOut: false,
          hasMore: false,
        }),
    },
  });
  const gateway = makeGateway(transport);

  const result = await gateway.complete({ prompt: 'x', timeoutMs: 5000 });

  assert.equal(result.text, 'outline answer');
});

test('dsh_bridge: turnOutline wrapped in { turns } is also accepted', async () => {
  const transport = mcpBridge({
    tools: {
      dsh_create_session: ({ id }) => mcpToolValue(id, { sessionId: 's-outline-2' }),
      dsh_prompt: ({ id }) => acceptedPrompt(undefined),
      dsh_follow: ({ id }) =>
        mcpToolValue(id, {
          records: [{ seq: 1, type: 'turn/end', data: {} }],
          projections: {
            values: {
              turnOutline: { turns: [{ turn: 1, seq: 1, prompt: 'p', response: 'wrapped answer' }], draft: '' },
            },
          },
          timedOut: false,
          hasMore: false,
        }),
    },
  });
  const gateway = makeGateway(transport);

  const result = await gateway.complete({ prompt: 'x', timeoutMs: 5000 });

  assert.equal(result.text, 'wrapped answer');
});

test('dsh_bridge: turnOutline never falls back to a previous turn on a reused session', async () => {
  const transport = mcpBridge({
    tools: {
      dsh_create_session: ({ id }) => mcpToolValue(id, { sessionId: 's-outline-3' }),
      dsh_prompt: ({ id }) => acceptedPrompt(undefined),
      dsh_follow: ({ id }) =>
        mcpToolValue(id, {
          records: [{ seq: 2, type: 'turn/end', data: {} }],
          projections: {
            values: {
              turnOutline: [
                { turn: 1, seq: 1, prompt: 'first', response: 'previous answer' },
                { turn: 2, seq: 2, prompt: 'second', response: '' },
              ],
            },
          },
          timedOut: false,
          hasMore: false,
        }),
    },
  });
  const gateway = makeGateway(transport);

  await assert.rejects(gateway.complete({ prompt: 'x', timeoutMs: 5000 }), (error) => {
    assert.equal(error.code, ERROR_CODES.empty_completion);
    return true;
  });
});

/** Transport requests for `dsh_follow`, with both the server and client timeouts. */
function followRequests(transport) {
  return transport.calls
    .filter((call) => call.body?.method === 'tools/call' && call.body?.params?.name === 'dsh_follow')
    .map((call) => ({ args: call.body.params.arguments, timeoutMs: call.timeoutMs }));
}

test('dsh_bridge: a long generation is read in follow slices and the client never aborts', async () => {
  const clock = advancingClock(0);
  let follows = 0;
  const transport = mcpBridge({
    tools: {
      dsh_create_session: ({ id }) => mcpToolValue(id, { sessionId: 's-long' }),
      dsh_prompt: ({ id }) => acceptedPrompt(undefined),
      dsh_follow: ({ id, args }) => {
        follows += 1;
        // The bridge blocks for its whole slice and answers timedOut until the
        // turn completes at t = 120 s (three 30 s timeouts, then the text).
        clock.advance(args.timeoutMs);
        if (clock.time < 120_000) {
          return mcpToolValue(id, {
            sessionId: args.sessionId,
            records: [],
            cursor: { lastSeq: args.sinceSeq },
            timedOut: true,
            hasMore: false,
          });
        }
        return mcpToolValue(id, {
          sessionId: args.sessionId,
          records: [
            { seq: args.sinceSeq + 1, type: 'message', data: { role: 'assistant', text: 'long answer' } },
            { seq: args.sinceSeq + 2, type: 'turn/end', data: {} },
          ],
          cursor: { lastSeq: args.sinceSeq + 2 },
          timedOut: false,
          hasMore: false,
        });
      },
    },
  });
  const gateway = makeGateway(transport, { clock });

  const result = await gateway.complete({ prompt: 'x', timeoutMs: 180_000 });

  assert.equal(result.text, 'long answer');
  assert.equal(toolCalls(transport, 'dsh_create_session').length, 1);
  assert.equal(toolCalls(transport, 'dsh_prompt').length, 1);
  assert.equal(follows, 4);
  const calls = followRequests(transport);
  assert.equal(calls.length, 4);
  for (const call of calls) {
    // Server slices stay under the bridge's 30 s cap...
    assert.ok(call.args.timeoutMs <= 30_000);
    // ...and the client deadline is strictly later, so it never aborts first.
    assert.equal(call.timeoutMs, call.args.timeoutMs + 5_000);
  }
  assert.deepEqual(clock.sleeps, [1000, 1000, 1000]);
});

test('dsh_bridge: a client-side abort while waiting continues with the next follow slice', async () => {
  const clock = advancingClock(0);
  let follows = 0;
  const transport = mcpBridge({
    tools: {
      dsh_create_session: ({ id }) => mcpToolValue(id, { sessionId: 's-abort' }),
      dsh_prompt: ({ id }) => acceptedPrompt(undefined),
      dsh_follow: ({ id, args }) => {
        follows += 1;
        if (follows === 1) {
          // Aborted at 30.5 s: after the server slice, before the client
          // deadline. That must mean "wait again", not a fatal run failure.
          clock.advance(30_500);
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          throw error;
        }
        clock.advance(args.timeoutMs);
        return mcpToolValue(id, {
          sessionId: args.sessionId,
          records: [
            { seq: args.sinceSeq + 1, type: 'message', data: { role: 'assistant', text: 'after abort' } },
            { seq: args.sinceSeq + 2, type: 'turn/end', data: {} },
          ],
          cursor: { lastSeq: args.sinceSeq + 2 },
          timedOut: false,
        });
      },
    },
  });
  const gateway = makeGateway(transport, { clock });

  const result = await gateway.complete({ prompt: 'x', timeoutMs: 180_000 });

  assert.equal(result.text, 'after abort');
  assert.equal(follows, 2);
  assert.deepEqual(clock.sleeps, [1000]);
  assert.equal(toolCalls(transport, 'dsh_prompt').length, 1);
  assert.equal(toolCalls(transport, 'dsh_create_session').length, 1);
});

test('dsh_bridge: the bridge default budget is 180 s when the request omits timeoutMs', async () => {
  const clock = advancingClock(0);
  const transport = mcpBridge({
    tools: {
      dsh_create_session: ({ id }) => mcpToolValue(id, { sessionId: 's-default-budget' }),
      dsh_prompt: ({ id }) => acceptedPrompt(undefined),
      dsh_follow: ({ id, args }) => {
        clock.advance(args.timeoutMs);
        if (clock.time < 179_000) {
          return mcpToolValue(id, { sessionId: args.sessionId, records: [], timedOut: true, hasMore: false });
        }
        return mcpToolValue(id, {
          sessionId: args.sessionId,
          records: [
            { seq: args.sinceSeq + 1, type: 'message', data: { role: 'assistant', text: 'default budget answer' } },
            { seq: args.sinceSeq + 2, type: 'turn/end', data: {} },
          ],
          cursor: { lastSeq: args.sinceSeq + 2 },
          timedOut: false,
        });
      },
    },
  });
  const gateway = makeGateway(transport, { clock });

  // Completing at 179 s only fits the 180 s bridge default (not direct_http's 60 s).
  const result = await gateway.complete({ prompt: 'x' });

  assert.equal(result.text, 'default budget answer');
  const calls = followRequests(transport);
  assert.equal(calls.length, 6);
  assert.deepEqual(clock.sleeps, Array(5).fill(1000));
  // The last slice is clipped to the remaining budget, never above 30 s.
  assert.equal(calls.at(-1).args.timeoutMs, 25_000);
  assert.equal(calls.at(-1).timeoutMs, 30_000);
});

test('dsh_bridge: DSBOT_BRIDGE_TIMEOUT_MS overrides the bridge default budget', async () => {
  const clock = advancingClock(0);
  const transport = mcpBridge({
    tools: {
      dsh_create_session: ({ id }) => mcpToolValue(id, { sessionId: 's-env-budget' }),
      dsh_prompt: ({ id }) => acceptedPrompt(undefined),
      dsh_follow: ({ id, args }) => {
        clock.advance(args.timeoutMs);
        return mcpToolValue(id, { sessionId: args.sessionId, records: [], timedOut: true, hasMore: false });
      },
    },
  });
  const gateway = makeGateway(transport, {
    clock,
    env: { DSH_BRIDGE_SECRET: SECRET, DSBOT_BRIDGE_TIMEOUT_MS: '3000' },
  });

  await assert.rejects(gateway.complete({ prompt: 'x' }), (error) => {
    assert.equal(error.code, ERROR_CODES.timeout);
    assert.equal(error.retryable, false);
    return true;
  });
  const calls = followRequests(transport);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.timeoutMs, 3000);
  assert.equal(calls[0].timeoutMs, 8000);
  assert.equal(toolCalls(transport, 'dsh_prompt').length, 1);
  assert.deepEqual(clock.sleeps, []);
});

test('dsh_bridge: a timedOut slice that advanced the cursor still keeps following', async () => {
  const clock = advancingClock(0);
  let follows = 0;
  const transport = mcpBridge({
    tools: {
      dsh_create_session: ({ id }) => mcpToolValue(id, { sessionId: 's-progress' }),
      dsh_prompt: ({ id }) => acceptedPrompt(undefined),
      dsh_follow: ({ id, args }) => {
        follows += 1;
        clock.advance(args.timeoutMs);
        if (follows === 1) {
          // Records arrived but no assistant text yet; the cursor must advance
          // so the next follow starts after them.
          return mcpToolValue(id, {
            sessionId: args.sessionId,
            records: [{ seq: 5, type: 'tool/result', data: { role: 'tool', text: 'working' } }],
            cursor: { lastSeq: 5 },
            timedOut: true,
            hasMore: true,
          });
        }
        return mcpToolValue(id, {
          sessionId: args.sessionId,
          records: [
            { seq: 6, type: 'message', data: { role: 'assistant', text: 'progress answer' } },
            { seq: 7, type: 'turn/end', data: {} },
          ],
          cursor: { lastSeq: 7 },
          timedOut: false,
        });
      },
    },
  });
  const gateway = makeGateway(transport, { clock });

  const result = await gateway.complete({ prompt: 'x', timeoutMs: 60_000 });

  assert.equal(result.text, 'progress answer');
  const calls = toolCalls(transport, 'dsh_follow');
  assert.deepEqual(
    calls.map((call) => call.args.sinceSeq),
    [0, 5],
  );
  assert.deepEqual(clock.sleeps, [1000]);
});

test('dsh_bridge: a follow timeout after a finished turn is retried once and then succeeds', async () => {
  let follows = 0;
  const transport = mcpBridge({
    tools: {
      dsh_create_session: ({ id }) => mcpToolValue(id, { sessionId: 's-follow-retry' }),
      dsh_prompt: ({ id }) => acceptedPrompt(undefined),
      dsh_follow: ({ id, args }) => {
        follows += 1;
        if (follows === 1) return mcpToolValue(id, { records: [], timedOut: true, hasMore: false });
        return mcpToolValue(id, {
          records: [
            { seq: args.sinceSeq + 1, type: 'message', data: { role: 'assistant', text: 'after retry' } },
            { seq: args.sinceSeq + 2, type: 'turn/end', data: {} },
          ],
          cursor: { lastSeq: args.sinceSeq + 2 },
          timedOut: false,
        });
      },
    },
  });
  const gateway = makeGateway(transport, { clock: advancingClock(0) });

  const result = await gateway.complete({ prompt: 'x', timeoutMs: 5000 });

  assert.equal(result.text, 'after retry');
  assert.equal(toolCalls(transport, 'dsh_follow').length, 2);
  assert.equal(toolCalls(transport, 'dsh_create_session').length, 1);
});

test('dsh_bridge: a queued prompt keeps following until the turn text arrives', async () => {
  const clock = advancingClock(0);
  let follows = 0;
  const transport = mcpBridge({
    tools: {
      dsh_create_session: ({ id }) => mcpToolValue(id, { sessionId: 's-queued' }),
      dsh_prompt: ({ id }) => acceptedPrompt(undefined),
      dsh_follow: ({ id, args }) => {
        follows += 1;
        // The prompt is still queued: no records and no text yet.
        if (follows === 1) {
          return mcpToolValue(id, { sessionId: args.sessionId, records: [], timedOut: true, hasMore: false });
        }
        return mcpToolValue(id, {
          sessionId: args.sessionId,
          records: [
            { seq: 1, type: 'message', data: { role: 'assistant', text: 'queued answer' } },
            { seq: 2, type: 'turn/end', data: {} },
          ],
          cursor: { lastSeq: 2 },
          timedOut: false,
        });
      },
    },
  });
  const gateway = makeGateway(transport, { clock });

  const result = await gateway.complete({ prompt: 'x', timeoutMs: 5000 });

  assert.equal(result.text, 'queued answer');
  assert.equal(toolCalls(transport, 'dsh_follow').length, 2);
  assert.deepEqual(clock.sleeps, [1000]);
});

test('dsh_bridge: long slice polling creates one session and redacts the secret', async () => {
  const clock = advancingClock(0);
  let follows = 0;
  const transport = mcpBridge({
    tools: {
      dsh_create_session: ({ id }) => mcpToolValue(id, { sessionId: 's-secret' }),
      dsh_prompt: ({ id }) => acceptedPrompt(undefined),
      dsh_follow: ({ id, args }) => {
        follows += 1;
        clock.advance(args.timeoutMs);
        if (follows < 3) {
          return mcpToolValue(id, { sessionId: args.sessionId, records: [], timedOut: true, hasMore: false });
        }
        return mcpToolValue(id, {
          sessionId: args.sessionId,
          records: [
            { seq: args.sinceSeq + 1, type: 'message', data: { role: 'assistant', text: `answer ${SECRET}` } },
            { seq: args.sinceSeq + 2, type: 'turn/end', data: {} },
          ],
          cursor: { lastSeq: args.sinceSeq + 2 },
          timedOut: false,
        });
      },
    },
  });
  const gateway = makeGateway(transport, { clock });

  const result = await gateway.complete({ prompt: 'x', timeoutMs: 180_000 });

  assert.match(result.text, /answer \[redacted\]/);
  assert.equal(result.text.includes(SECRET), false);
  assert.equal(toolCalls(transport, 'dsh_create_session').length, 1);
  assert.equal(follows, 3);
});


/**
 * Test doubles for the injected transport. Nothing here opens a socket, reads a
 * secret file or touches the network.
 */

export function fakeTransport(handler) {
  const calls = [];
  const transport = async (request) => {
    let body = request.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        body = request.body;
      }
    }
    const call = { ...request, body };
    calls.push(call);
    return handler(call, calls.length - 1, calls);
  };
  transport.calls = calls;
  return transport;
}

export function jsonResponse(status, payload, headers = {}) {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  };
}

export function emptyResponse(status = 202) {
  return { status, headers: {}, body: '' };
}

export function chatResponse({ text, usage } = {}) {
  return jsonResponse(200, {
    id: 'chatcmpl-test',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    ...(usage === undefined ? {} : { usage }),
  });
}

export function mcpRpc(id, result) {
  return jsonResponse(200, { jsonrpc: '2.0', id, result });
}

export function mcpError(id, code, message) {
  return jsonResponse(200, { jsonrpc: '2.0', id, error: { code, message } });
}

export function mcpToolValue(id, value, { structured = true } = {}) {
  return jsonResponse(200, {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: JSON.stringify(value) }],
      isError: false,
      ...(structured ? { structuredContent: value } : {}),
    },
  });
}

export function mcpToolError(id, code, message) {
  return jsonResponse(200, {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: `ERROR ${code}: ${message}` }],
      isError: true,
    },
  });
}

/**
 * A fake MCP bridge: initialize / notifications/initialized / tools/call.
 * `tools[name]({ args, id, state })` returns an HTTP response; when it returns
 * undefined the default success value is used.
 */
export function mcpBridge({ initialize, tools = {} } = {}) {
  const state = { methods: [], tools: [], initialized: 0, errors: [] };
  const transport = fakeTransport(async (call) => {
    const envelope = call.body;
    state.methods.push(envelope.method);
    if (envelope.method === 'initialize') {
      state.initialized += 1;
      if (typeof initialize === 'function') {
        const response = initialize({ envelope, state });
        if (response !== undefined && response !== null) return response;
      }
      return mcpRpc(envelope.id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'dsh-agent-bridge', version: 'test' },
      });
    }
    if (envelope.method === 'notifications/initialized') return emptyResponse(202);
    if (envelope.method === 'tools/call') {
      const { name, arguments: args = {} } = envelope.params;
      state.tools.push({ name, args });
      const handler = tools[name];
      if (typeof handler === 'function') {
        const response = handler({ args, id: envelope.id, state, envelope });
        if (response !== undefined && response !== null) return response;
      }
      throw new Error(`fake bridge received an unexpected tool: ${name}`);
    }
    throw new Error(`fake bridge received an unexpected method: ${envelope.method}`);
  });
  transport.state = state;
  return transport;
}

export function toolCalls(transport, name) {
  return transport.state.tools.filter((tool) => tool.name === name);
}

/** A clock whose `now` returns the given timestamps in order (last repeats). */
export function sequenceClock(values, { sleeps = [] } = {}) {
  const queue = [...values];
  let last = queue.length > 0 ? queue[queue.length - 1] : 0;
  return {
    now() {
      if (queue.length > 0) last = queue.shift();
      return last;
    },
    async sleep(ms) {
      sleeps.push(ms);
    },
    setTimeout(fn, ms) {
      return setTimeout(fn, ms);
    },
    clearTimeout(handle) {
      clearTimeout(handle);
    },
    sleeps,
  };
}

/**
 * A clock that really advances on sleep, so a fake generation can take 45 s of
 * virtual time without the test waiting. `now` never jumps on its own.
 */
export function advancingClock(start = 0) {
  let current = start;
  const sleeps = [];
  return {
    now: () => current,
    async sleep(ms) {
      sleeps.push(ms);
      current += ms;
    },
    /** Move virtual time without a sleep, e.g. to model a blocking bridge call. */
    advance(ms) {
      current += ms;
    },
    setTimeout(fn, ms) {
      return setTimeout(fn, ms);
    },
    clearTimeout(handle) {
      clearTimeout(handle);
    },
    get time() {
      return current;
    },
    sleeps,
  };
}

export function hangingClock() {
  return {
    now: () => 0,
    sleep: async () => {},
    setTimeout(fn) {
      return setTimeout(fn, 0);
    },
    clearTimeout(handle) {
      clearTimeout(handle);
    },
  };
}

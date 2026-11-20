/**
 * Fakes for the three external systems the dev loop must not really call:
 * GitHub, the SuperAgent queue and the independent verifier.
 *
 * - `createFakeGitHub()` owns pull requests and merge commits. It refuses to
 *   merge the same pull request twice, so a duplicate merge is visible as a
 *   failed action instead of silently succeeding.
 * - `createFakeSuperAgent()` is the `sa` port consumed by the shipped
 *   `createSaScheduler` adapter: dispatch opens a PR, rework updates the same
 *   PR with a new commit, and every work order reports cost.
 * - `createFakeGit()` is the `git` port consumed by `createGitGhMerger`; it
 *   resolves the submission commit to its pull request and records the merge.
 * - `createFakeVerifier()` returns JSON exactly like an independent verifier
 *   process and keeps every context it was given.
 */

function clone(value) {
  return structuredClone(value);
}

export function createFakeGitHub() {
  let nextPull = 0;
  const pulls = new Map();
  const pullByCommit = new Map();
  const mergeEvents = [];
  const openPrCalls = [];

  function recordCommit(pull, commit) {
    pull.commits.push(commit);
    pullByCommit.set(commit, pull.number);
  }

  function publicPull(pull) {
    return {
      number: pull.number,
      url: pull.url,
      taskId: pull.taskId,
      lane: pull.lane,
      state: pull.state,
      head: pull.head,
      attempt: pull.attempt,
      commits: [...pull.commits],
      mergeCommit: pull.mergeCommit,
    };
  }

  function pullForCommit(commit) {
    const number = pullByCommit.get(commit);
    return number === undefined ? null : publicPull(pulls.get(number));
  }

  function openPullRequest({ task, attempt, commit }) {
    nextPull += 1;
    const pull = {
      number: nextPull,
      url: `https://github.example/ft54482/superagent-lab-smoke/pull/${nextPull}`,
      taskId: task.id,
      lane: task.lane,
      state: 'open',
      head: `agent/${task.id}-a${attempt}`,
      attempt,
      commits: [],
      mergeCommit: null,
    };
    pulls.set(pull.number, pull);
    recordCommit(pull, commit);
    return publicPull(pull);
  }

  function revisePullRequest({ prNumber, task, attempt, commit }) {
    const pull = pulls.get(prNumber);
    if (!pull) throw new Error(`fake GitHub: unknown pull request #${prNumber}`);
    if (pull.state === 'merged') {
      throw new Error(`fake GitHub: pull request #${prNumber} is already merged`);
    }
    pull.state = 'open';
    pull.head = `agent/${task.id}-a${attempt}`;
    pull.attempt = attempt;
    recordCommit(pull, commit);
    return publicPull(pull);
  }

  function mergePullRequest({ prNumber, commit, taskId, lane, round }) {
    const pull = pulls.get(prNumber);
    if (!pull) throw new Error(`fake GitHub: unknown pull request #${prNumber}`);
    if (pull.state === 'merged') {
      throw new Error(`fake GitHub: pull request #${prNumber} is already merged`);
    }
    if (pull.state !== 'open') {
      throw new Error(`fake GitHub: pull request #${prNumber} is ${pull.state}`);
    }

    pull.state = 'merged';
    pull.mergeCommit = `merge-${pull.number}-${mergeEvents.length + 1}`;
    // The merge commit is a base-branch commit, not another source commit in
    // the pull request; map it so the optional gh.openPr call can still resolve
    // the PR after createGitGhMerger passes the merge commit along.
    pullByCommit.set(pull.mergeCommit, pull.number);
    mergeEvents.push({
      pr: pull.number,
      url: pull.url,
      commit: pull.mergeCommit,
      sourceCommit: commit,
      taskId,
      lane,
      round,
    });
    return {
      merged: true,
      commit: pull.mergeCommit,
      pr: pull.number,
      url: pull.url,
    };
  }

  function openPr(request) {
    openPrCalls.push(clone(request));
    const pull = pullForCommit(request.commit);
    if (!pull) {
      throw new Error(
        `fake GitHub: no pull request for commit ${request.commit}`,
      );
    }
    return { number: pull.number, url: pull.url };
  }

  return {
    openPullRequest,
    revisePullRequest,
    pullForCommit,
    mergePullRequest,
    openPr,
    pulls() {
      return [...pulls.values()].map(publicPull);
    },
    mergedPulls() {
      return [...pulls.values()]
        .filter((pull) => pull.state === 'merged')
        .map(publicPull);
    },
    mergeEvents() {
      return clone(mergeEvents);
    },
    openPrCalls() {
      return clone(openPrCalls);
    },
  };
}

export function createFakeSuperAgent({ github, costOf }) {
  let nextWorkOrder = 0;
  const orders = new Map();
  const dispatchCalls = [];
  const reworkCalls = [];

  function commitFor(taskId, attempt) {
    return `commit-${taskId}-a${attempt}`;
  }

  function orderOf(id) {
    const order = orders.get(id);
    if (!order) throw new Error(`fake SuperAgent: unknown work order ${id}`);
    return order;
  }

  function dispatch({ ticket, idempotencyKey, meta }) {
    nextWorkOrder += 1;
    const id = `sa-${nextWorkOrder}`;
    const attempt = meta?.attempt ?? ticket.attempt ?? 1;
    const commit = commitFor(ticket.id, attempt);
    const pull = github.openPullRequest({ task: ticket, attempt, commit });
    const order = {
      id,
      taskId: ticket.id,
      lane: ticket.lane,
      state: 'review',
      attempt,
      idempotencyKey,
      pr: pull.number,
      ticket: clone(ticket),
      result: {
        commit,
        costCny: costOf(ticket, { phase: 'dispatch', attempt }),
        output: `fake agent opened ${pull.url}`,
        tests: { unit: 'pass', lint: 'pass' },
        pr: pull.number,
      },
    };
    orders.set(id, order);
    dispatchCalls.push({
      id,
      taskId: ticket.id,
      lane: ticket.lane,
      attempt,
      idempotencyKey,
      pr: pull.number,
      commit,
    });
    return { id };
  }

  function list() {
    return [...orders.values()].map(clone);
  }

  function rework({ id, feedback, ticket }) {
    const order = orderOf(id);
    const attempt = order.attempt + 1;
    const commit = commitFor(ticket.id, attempt);
    const pull = github.revisePullRequest({
      prNumber: order.pr,
      task: ticket,
      attempt,
      commit,
    });

    order.state = 'review';
    order.attempt = attempt;
    order.feedback = feedback;
    order.reworkRound = ticket.reworkRound;
    order.result = {
      commit,
      costCny: costOf(ticket, {
        phase: 'rework',
        attempt,
        reworkRound: ticket.reworkRound,
      }),
      output: `fake agent revised ${pull.url}`,
      tests: { unit: 'pass', lint: 'pass' },
      pr: pull.number,
    };
    reworkCalls.push({
      id,
      taskId: ticket.id,
      lane: ticket.lane,
      attempt,
      reworkRound: ticket.reworkRound,
      feedback,
      pr: pull.number,
      commit,
    });
    return { id };
  }

  function markMerged(commit) {
    for (const order of orders.values()) {
      if (order.result.commit === commit) order.state = 'merged';
    }
  }

  return {
    dispatch,
    list,
    rework,
    markMerged,
    orders() {
      return [...orders.values()].map(clone);
    },
    dispatchCalls() {
      return clone(dispatchCalls);
    },
    reworkCalls() {
      return clone(reworkCalls);
    },
  };
}

export function createFakeGit({ github, sa }) {
  const mergeCalls = [];

  async function merge(request) {
    mergeCalls.push(clone(request));
    const pull = github.pullForCommit(request.commit);
    if (pull === null) {
      return {
        merged: false,
        error: `fake git: no pull request for commit ${request.commit}`,
      };
    }
    const result = github.mergePullRequest({
      prNumber: pull.number,
      commit: request.commit,
      taskId: request.taskId,
      lane: request.lane,
      round: request.round,
    });
    sa.markMerged(request.commit);
    return result;
  }

  return {
    merge,
    mergeCalls() {
      return clone(mergeCalls);
    },
  };
}

export function createFakeVerifier(script) {
  const verifyCalls = [];

  async function verify(context) {
    const index = verifyCalls.length + 1;
    verifyCalls.push({ index, ...clone(context) });
    const result = await script(context, index);
    return typeof result === 'string' ? result : JSON.stringify(result);
  }

  return { verify, verifyCalls };
}

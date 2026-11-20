import assert from 'node:assert/strict';
import test from 'node:test';

import { Inbox } from '../src/index.js';

function makeInbox(options = {}) {
  const seen = [];
  const inbox = new Inbox({
    clock: () => 1_000,
    handler: (event) => {
      seen.push(event.seq);
      return true;
    },
    ...options,
  });
  return { inbox, seen };
}

function event(seq, overrides = {}) {
  return {
    source: 'dsh',
    session: 'session-1',
    seq,
    type: 'turn.end',
    payload: { seq },
    ...overrides,
  };
}

test('inbox: event_key is source|session|seq|type and duplicates are deduped', () => {
  const { inbox, seen } = makeInbox();
  const first = inbox.receive(event(1));
  const second = inbox.receive(event(1));

  assert.equal(first.inserted, true);
  assert.equal(first.processed, true);
  assert.equal(second.inserted, false);
  assert.equal(second.duplicate, true);
  assert.deepEqual(seen, [1]);
  assert.equal(inbox.stats().total, 1);
  assert.equal(inbox.get('dsh|session-1|1|turn.end').status, 'processed');
});

test('inbox: out-of-order records are buffered by seq and drained in order', () => {
  const { inbox, seen } = makeInbox();

  const second = inbox.receive(event(2));
  assert.equal(second.buffered, true);
  assert.equal(inbox.watermark('dsh', 'session-1').lastSeqConsumed, 0);
  assert.equal(inbox.watermark('dsh', 'session-1').buffered, 1);

  inbox.receive(event(3));
  assert.equal(inbox.watermark('dsh', 'session-1').buffered, 2);

  const first = inbox.receive(event(1));
  assert.equal(first.processed, true);
  assert.deepEqual(seen, [1, 2, 3]);

  const watermark = inbox.watermark('dsh', 'session-1');
  assert.equal(watermark.lastSeqConsumed, 3);
  assert.equal(watermark.lastSeqSeen, 3);
  assert.equal(watermark.buffered, 0);
  assert.equal(watermark.gapDetectedAt, null);
});

test('inbox: the watermark stops at a gap until the missing seq arrives', () => {
  const { inbox, seen } = makeInbox();
  inbox.receive(event(1));
  const ahead = inbox.receive(event(3));

  assert.equal(ahead.buffered, true);
  assert.equal(inbox.watermark('dsh', 'session-1').lastSeqConsumed, 1);
  assert.notEqual(inbox.watermark('dsh', 'session-1').gapDetectedAt, null);
  assert.deepEqual(seen, [1]);

  inbox.receive(event(4));
  assert.equal(inbox.watermark('dsh', 'session-1').lastSeqConsumed, 1);

  inbox.receive(event(2));
  assert.deepEqual(seen, [1, 2, 3, 4]);
  assert.equal(inbox.watermark('dsh', 'session-1').lastSeqConsumed, 4);
  assert.equal(inbox.watermark('dsh', 'session-1').gapDetectedAt, null);
});

test('inbox: a failing handler blocks the watermark and retry resumes the stream', () => {
  let failSeq2 = true;
  const seen = [];
  const inbox = new Inbox({
    clock: () => 1_000,
    handler: (entry) => {
      if (entry.seq === 2 && failSeq2) throw new Error('handler exploded');
      seen.push(entry.seq);
      return true;
    },
  });

  inbox.receive(event(1));
  const failed = inbox.receive(event(2));
  inbox.receive(event(3));

  assert.equal(failed.event.status, 'failed');
  assert.match(failed.event.lastError, /handler exploded/);
  assert.equal(inbox.watermark('dsh', 'session-1').lastSeqConsumed, 1);
  assert.equal(inbox.get('dsh|session-1|3|turn.end').status, 'buffered');

  failSeq2 = false;
  const retried = inbox.retry('dsh|session-1|2|turn.end');
  assert.equal(retried.consumed, true);
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(inbox.watermark('dsh', 'session-1').lastSeqConsumed, 3);
  assert.equal(inbox.get('dsh|session-1|2|turn.end').status, 'processed');
});

test('inbox: the same seq with a different type is a conflict, not a second event', () => {
  const { inbox, seen } = makeInbox();
  inbox.receive(event(1, { type: 'turn.end' }));

  const conflict = inbox.receive(event(1, { type: 'turn.start' }));
  assert.equal(conflict.inserted, true);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.event.status, 'conflict');
  assert.deepEqual(seen, [1]);
  assert.equal(inbox.watermark('dsh', 'session-1').lastSeqConsumed, 1);
  assert.equal(inbox.conflicts().length, 1);
  assert.equal(inbox.stats().byStatus.conflict, 1);
});

test('inbox: unknown types are stored ignored and do not block the watermark', () => {
  const { inbox, seen } = makeInbox({ knownTypes: ['turn.end'] });

  const unknown = inbox.receive(event(1, { type: 'mystery.event' }));
  assert.equal(unknown.event.status, 'ignored');
  assert.equal(unknown.event.reason, 'unknown_type');
  assert.equal(inbox.watermark('dsh', 'session-1').lastSeqConsumed, 1);

  inbox.receive(event(2));
  assert.deepEqual(seen, [2]);
  assert.equal(inbox.watermark('dsh', 'session-1').lastSeqConsumed, 2);
});

test('inbox: sessions are independent streams', () => {
  const { inbox } = makeInbox();
  inbox.receive(event(1, { session: 'a' }));
  inbox.receive(event(2, { session: 'a' }));
  inbox.receive(event(1, { session: 'b' }));

  assert.equal(inbox.watermark('dsh', 'a').lastSeqConsumed, 2);
  assert.equal(inbox.watermark('dsh', 'b').lastSeqConsumed, 1);
  assert.equal(inbox.stats().sessions, 2);
});

test('inbox: receive with process=false leaves contiguous records for a later drain', () => {
  const { inbox, seen } = makeInbox();
  inbox.receive(event(1), { process: false });
  assert.equal(inbox.watermark('dsh', 'session-1').lastSeqConsumed, 0);
  assert.equal(inbox.stats().buffered, 1);
  assert.deepEqual(seen, []);

  const drained = inbox.drain('dsh', 'session-1');
  assert.equal(drained.processed.length, 1);
  assert.deepEqual(seen, [1]);
  assert.equal(inbox.watermark('dsh', 'session-1').lastSeqConsumed, 1);
});

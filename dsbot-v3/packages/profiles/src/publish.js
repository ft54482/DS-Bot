import { PUBLISH_DENIALS } from './constants.js';
import { contentFingerprint } from './canonical.js';
import { PublishNotAuthorizedError } from './errors.js';
import { evaluateArticlePack } from './evaluate.js';
import { selfMediaProfileV1 } from './profile.js';

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseTime(value) {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const time = Date.parse(value);
    return Number.isNaN(time) ? null : time;
  }
  return null;
}

function resolveNow(value) {
  const time = value === undefined ? Date.now() : parseTime(value);
  if (time === null) throw new TypeError('options.now must be a Date, epoch milliseconds or a parsable timestamp');
  return time;
}

function reason(code, detail) {
  return { code, detail };
}

/**
 * `platform:account` that a publish authorization must cover when the pack
 * declares its target (docs/prd/01-data-model.sql `publish_authorization.target`,
 * e.g. `wechat:公众号A`). `options.target` overrides it for callers that hold the
 * target outside the pack.
 */
export function expectedPublishTarget(pack, options = {}) {
  const explicit = normalizeText(options?.target);
  if (explicit !== '') return explicit;
  const platform = normalizeText(pack?.layout?.platform);
  const account = normalizeText(pack?.layout?.account);
  return platform !== '' && account !== '' ? `${platform}:${account}` : null;
}

/**
 * The publish gate. Publishing is a separate authorization
 * (docs/prd/14-business-model.md §3.2, D-V3-23): an acceptance `pass` does not
 * authorize publishing, and no authorization record means rejection.
 *
 * The authorization follows `publish_authorization` in
 * docs/prd/01-data-model.sql:
 *   { id, action: 'publish', target, content_fingerprint, state: 'granted',
 *     granted_by, granted_at, expires_at }
 *
 * It must be granted by a human/authorized principal, still `granted`, not
 * expired, cover the pack's target, and bind to the current content
 * fingerprint (T-07: any content change invalidates it).
 *
 * @returns {{allowed: boolean, result: 'authorized'|'rejected',
 *   content_fingerprint: string, acceptance: string,
 *   reasons: Array<{code: string, detail: string}>}}
 */
export function evaluatePublish(pack, authorization = null, options = {}) {
  const profile = options?.profile ?? selfMediaProfileV1;
  const now = resolveNow(options?.now);
  const acceptance = evaluateArticlePack(pack, profile, { now });
  const fingerprint = contentFingerprint(pack);
  const reasons = [];

  if (acceptance.result !== 'pass') {
    reasons.push(
      reason(
        PUBLISH_DENIALS.acceptanceNotPassed,
        `acceptance result is ${acceptance.result}; only an accepted article pack may request publishing`,
      ),
    );
  }

  if (!authorization || typeof authorization !== 'object' || Array.isArray(authorization)) {
    reasons.push(
      reason(
        PUBLISH_DENIALS.authorizationRequired,
        'no publish authorization record; acceptance never authorizes publishing',
      ),
    );
  } else {
    const id = normalizeText(authorization.id ?? authorization.authorization_id);
    if (id === '') reasons.push(reason(PUBLISH_DENIALS.invalid, 'authorization id is required'));

    if (authorization.action !== 'publish') {
      reasons.push(
        reason(PUBLISH_DENIALS.invalid, `authorization action must be "publish", got "${String(authorization.action)}"`),
      );
    }

    const grantedBy = normalizeText(authorization.granted_by);
    if (grantedBy === '') reasons.push(reason(PUBLISH_DENIALS.invalid, 'granted_by is required (authorized principal)'));

    const target = normalizeText(authorization.target);
    if (target === '') {
      reasons.push(reason(PUBLISH_DENIALS.invalid, 'authorization target is required (platform:account)'));
    } else {
      const expected = expectedPublishTarget(pack, options);
      if (expected === null) {
        reasons.push(
          reason(
            PUBLISH_DENIALS.targetMismatch,
            'no publish target is available; declare layout.platform/layout.account or pass options.target',
          ),
        );
      } else if (target !== expected) {
        reasons.push(
          reason(
            PUBLISH_DENIALS.targetMismatch,
            `authorization target "${target}" does not cover "${expected}"`,
          ),
        );
      }
    }

    if (authorization.content_fingerprint !== fingerprint) {
      reasons.push(
        reason(
          PUBLISH_DENIALS.fingerprintMismatch,
          'authorization is bound to a different content fingerprint; the content changed after it was granted',
        ),
      );
    }

    if (authorization.state === 'expired') {
      reasons.push(reason(PUBLISH_DENIALS.expired, 'authorization state is expired'));
    } else if (authorization.state !== 'granted') {
      reasons.push(
        reason(
          PUBLISH_DENIALS.notGranted,
          `authorization state is "${String(authorization.state)}" (only "granted" allows publishing)`,
        ),
      );
    } else {
      const expiresAt = parseTime(authorization.expires_at);
      if (expiresAt === null) {
        reasons.push(reason(PUBLISH_DENIALS.invalid, 'expires_at is required for a publish authorization'));
      } else if (expiresAt <= now) {
        reasons.push(reason(PUBLISH_DENIALS.expired, `authorization expired at ${new Date(expiresAt).toISOString()}`));
      }
    }
  }

  return {
    allowed: reasons.length === 0,
    result: reasons.length === 0 ? 'authorized' : 'rejected',
    content_fingerprint: fingerprint,
    acceptance: acceptance.result,
    reasons,
  };
}

/**
 * Throw unless the independent publish authorization allows publishing.
 * Use this at the publish boundary; `evaluateArticlePack` must never be used as
 * a publish gate.
 */
export function assertPublishAllowed(pack, authorization = null, options = {}) {
  const decision = evaluatePublish(pack, authorization, options);
  if (!decision.allowed) throw new PublishNotAuthorizedError(decision);
  return decision;
}

/**
 * Two-source consistency check (L43).
 *
 * `crossCheck({ item, second })` compares the three things a topic pack must
 * agree on before a story can be written: title, publication instant and the
 * subject (the summary text; the content hash is used as a fallback when a
 * source only supplied a hash).
 *
 * The comparison is intentionally strict: text is compared case-sensitively
 * after collapsing whitespace, and times are compared as instants, so the same
 * moment written in two time zones is not a conflict while two different
 * moments are. Callers that want fuzzy title matching must normalize before
 * calling; this primitive never hides a difference behind a similarity score.
 */

export const CROSS_CHECK_FIELDS = Object.freeze(['title', 'publishedAt', 'subject']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function collapseWhitespace(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function textField(item, field) {
  const value = item[field];
  if (value === undefined || value === null) return { present: false, raw: value, normalized: '' };
  return { present: true, raw: value, normalized: collapseWhitespace(value) };
}

function subjectField(item) {
  const hash = typeof item.contentHash === 'string' ? item.contentHash : null;
  if (typeof item.summary === 'string') {
    return {
      present: true,
      raw: item.summary,
      normalized: collapseWhitespace(item.summary),
      hash,
    };
  }
  if (hash !== null) return { present: true, raw: hash, normalized: hash, hash };
  if (item.summary !== undefined && item.summary !== null) {
    return {
      present: true,
      raw: item.summary,
      normalized: collapseWhitespace(item.summary),
      hash: null,
    };
  }
  return { present: false, raw: undefined, normalized: '', hash: null };
}

function subjectConflict(a, b) {
  if (a.present !== b.present) return true;
  if (!a.present) return false;
  if (a.normalized === b.normalized) return false;
  // A source may return only the summary hash; equal hashes still prove that
  // the two sources describe the same subject.
  return !(a.hash !== null && b.hash !== null && a.hash === b.hash);
}

function instantOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return ms;
  }
  return null;
}

function timeField(item) {
  const value = item.publishedAt;
  if (value === undefined || value === null) {
    return { present: false, raw: value, instant: null, normalized: '' };
  }
  return {
    present: true,
    raw: value,
    instant: instantOf(value),
    normalized: collapseWhitespace(value),
  };
}

function textConflict(a, b) {
  if (a.present !== b.present) return true;
  if (!a.present) return false;
  return a.normalized !== b.normalized;
}

function timeConflict(a, b) {
  if (a.present !== b.present) return true;
  if (!a.present) return false;
  if (a.instant !== null && b.instant !== null) return a.instant !== b.instant;
  return a.normalized !== b.normalized;
}

/**
 * Compare a primary item with the same story fetched from a second source.
 *
 * @param {{item: object, second: object}} input
 * @returns {{agree: boolean, conflicts: Array<{field: string, a: unknown, b: unknown}>}}
 */
export function crossCheck(input) {
  if (!isPlainObject(input)) {
    throw new TypeError('crossCheck input must be an object: { item, second }');
  }
  const { item, second } = input;
  if (!isPlainObject(item) || !isPlainObject(second)) {
    throw new TypeError('crossCheck requires two item objects: { item, second }');
  }

  const conflicts = [];

  const titleA = textField(item, 'title');
  const titleB = textField(second, 'title');
  if (textConflict(titleA, titleB)) {
    conflicts.push({ field: 'title', a: titleA.raw, b: titleB.raw });
  }

  const timeA = timeField(item);
  const timeB = timeField(second);
  if (timeConflict(timeA, timeB)) {
    conflicts.push({ field: 'publishedAt', a: timeA.raw, b: timeB.raw });
  }

  const subjectA = subjectField(item);
  const subjectB = subjectField(second);
  if (subjectConflict(subjectA, subjectB)) {
    conflicts.push({ field: 'subject', a: subjectA.raw, b: subjectB.raw });
  }

  return { agree: conflicts.length === 0, conflicts };
}

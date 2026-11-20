/** A profile object is structurally invalid and cannot be used for acceptance. */
export class ProfileError extends TypeError {
  constructor(message, issues = []) {
    super(issues.length > 0 ? `${message}: ${issues.join(', ')}` : message);
    this.name = 'ProfileError';
    this.code = 'invalid_profile';
    this.issues = issues;
  }
}

/**
 * Publishing was requested but the independent publish authorization did not
 * allow it. The full decision (codes + details) is kept for audit; acceptance
 * itself can never raise this error because it does not authorize publishing.
 */
export class PublishNotAuthorizedError extends Error {
  constructor(decision) {
    const codes = (decision?.reasons ?? []).map((reason) => reason.code);
    super(`publish rejected: ${codes.length > 0 ? codes.join(', ') : 'not authorized'}`);
    this.name = 'PublishNotAuthorizedError';
    this.code = 'publish_not_authorized';
    this.decision = decision;
  }
}

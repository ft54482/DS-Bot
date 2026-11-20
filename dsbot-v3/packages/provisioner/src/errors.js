/**
 * A provisioning failure with a stable machine-readable `code`.
 *
 * Codes used by this package:
 *  - `invalid_input`     a caller-supplied option is missing or malformed;
 *  - `port_taken`        the requested port is already assigned or not free;
 *  - `port_exhausted`    `--port auto` found no free port in the range;
 *  - `profile_exists`    the profile directory exists but is not provisioner-managed;
 *  - `profile_corrupt`   a provisioner manifest exists but cannot be trusted;
 *  - `registry_corrupt`  the provisioner registry cannot be trusted;
 *  - `not_ready`         the injected health probe reported the instance is not ready.
 *
 * `not_ready` also exposes `reason` so callers can display the probe's own
 * explanation without parsing the message.
 */
export class ProvisionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProvisionError';
    this.code = code;
    this.details = details;
    if (code === 'not_ready') {
      this.reason = details.reason ?? message;
    }
  }
}

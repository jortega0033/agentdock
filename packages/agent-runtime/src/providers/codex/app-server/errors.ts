export class CodexAppServerProtocolError extends Error {
  constructor(
    readonly code:
      | 'closed'
      | 'forbidden_method'
      | 'frame_invalid'
      | 'frame_too_large'
      | 'interaction_invalid'
      | 'process_failed'
      | 'response_invalid'
      | 'state_invalid',
    message: string,
  ) {
    super(message);
    this.name = 'CodexAppServerProtocolError';
  }
}

// Relocated to providers/common/safe-display.ts (issue #67) so other provider adapters' own
// diagnostics can reuse the same bounding/sanitizing logic instead of logging an untrusted
// provider-controlled string verbatim; re-exported here so every existing call site in this
// directory keeps working unchanged.
export { boundedUtf8, safeDisplay } from '../../common/safe-display.js';

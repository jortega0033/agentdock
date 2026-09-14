// Relocated to providers/common/channel.ts (issue #132) so other provider adapters' own raw-output
// side channels can reuse the same backpressure logic; re-exported here so every existing call
// site in this directory keeps working unchanged.
export { FailableChannel } from '../../common/channel.js';

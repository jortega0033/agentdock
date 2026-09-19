/**
 * Single source of truth for the outbound-attachment byte bound (issue #152), shared by every
 * layer that enforces it: the daemon route (`apps/daemon/src/routes/sessions.ts`, before a
 * provider process ever spawns) and Claude's own stdin-payload builder (which reads and
 * base64-encodes the file). Both enforce it independently -- belt and suspenders, not one
 * substituting for the other -- but importing the same constant means they can never silently
 * drift apart the way two hand-copied literals could. A CV or similar document is a handful of
 * pages; this is generous for any real one.
 */
export const MAX_SESSION_ATTACHMENT_BYTES = 10 * 1024 * 1024;

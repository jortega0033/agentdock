import { resolveWorkspaceIdentity, revalidateWorkspaceIdentity } from './workspace-identity.js';
import type { WorkspaceIdentity } from './workspace-identity.js';
import type { WorkspaceTrustStore } from './workspace-trust-store.js';

/**
 * The one reusable exact-trust guard every worktree-mutating entry point gates through: a
 * workspace is trusted only when its *current* on-disk identity (device/inode/birthtime, not
 * merely its path) still matches the incarnation the trust record was issued for. Callers that
 * already hold a resolved `WorkspaceIdentity` should prefer `revalidateWorkspaceTrusted`, which
 * additionally re-derives that identity from disk to close the TOCTOU gap between an earlier
 * resolution and the mutation about to run.
 */
export async function isWorkspaceTrusted(
  trustStore: WorkspaceTrustStore,
  identity: WorkspaceIdentity,
): Promise<boolean> {
  return (await trustStore.inspect(identity)).state === 'trusted';
}

/** Re-resolves `identity.canonicalPath` from disk and confirms both the filesystem object and the
 * trust record still match — fails closed on replacement, revocation, or I/O failure. */
export async function revalidateWorkspaceTrusted(
  trustStore: WorkspaceTrustStore,
  identity: WorkspaceIdentity,
): Promise<boolean> {
  return (
    (await revalidateWorkspaceIdentity(identity)) &&
    (await isWorkspaceTrusted(trustStore, identity))
  );
}

/** First admission check on a raw path: resolves identity and confirms it is trusted right now. */
export async function resolveTrustedWorkspace(
  trustStore: WorkspaceTrustStore,
  cwd: string,
): Promise<{ identity: WorkspaceIdentity; trusted: boolean }> {
  const identity = await resolveWorkspaceIdentity(cwd);
  return { identity, trusted: await isWorkspaceTrusted(trustStore, identity) };
}

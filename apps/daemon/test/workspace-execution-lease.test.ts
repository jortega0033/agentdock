import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CapabilitySelection } from '@agent-dock/shared';
import {
  isWorkspaceDirty,
  WorkspaceExecutionLeaseError,
  WorkspaceExecutionLeaseManager,
  workspaceLeaseMode,
} from '../src/workspace-execution-lease.js';
import { resolveWorkspaceIdentity } from '../src/workspace-identity.js';

describe('WorkspaceExecutionLeaseManager', () => {
  it('allows clean read-only sharing and releases leases idempotently', () => {
    const manager = new WorkspaceExecutionLeaseManager();
    const first = manager.acquire({
      workspaceId: 'canonical-worktree',
      mode: 'read',
      dirty: false,
      allowDirtyShare: false,
    });
    const second = manager.acquire({
      workspaceId: 'canonical-worktree',
      mode: 'read',
      dirty: false,
      allowDirtyShare: false,
    });

    first.release();
    first.release();
    second.release();
    expect(() =>
      manager.acquire({
        workspaceId: 'canonical-worktree',
        mode: 'write',
        dirty: false,
        allowDirtyShare: false,
      }),
    ).not.toThrow();
  });

  it('blocks mutation conflicts for the same canonical identity before dispatch', () => {
    const manager = new WorkspaceExecutionLeaseManager();
    manager.acquire({
      workspaceId: 'canonical-worktree',
      mode: 'read',
      dirty: false,
      allowDirtyShare: false,
    });

    expect(() =>
      manager.acquire({
        workspaceId: 'canonical-worktree',
        mode: 'write',
        dirty: false,
        allowDirtyShare: false,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<WorkspaceExecutionLeaseError>>({
        code: 'workspace_execution_conflict',
      }),
    );
  });

  it('requires explicit opt-in before a second reader shares a dirty worktree', () => {
    const manager = new WorkspaceExecutionLeaseManager();
    manager.acquire({
      workspaceId: 'canonical-worktree',
      mode: 'read',
      dirty: false,
      allowDirtyShare: false,
    });

    expect(() =>
      manager.acquire({
        workspaceId: 'canonical-worktree',
        mode: 'read',
        dirty: true,
        allowDirtyShare: false,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<WorkspaceExecutionLeaseError>>({
        code: 'dirty_workspace_share_requires_opt_in',
      }),
    );
    expect(() =>
      manager.acquire({
        workspaceId: 'canonical-worktree',
        mode: 'read',
        dirty: true,
        allowDirtyShare: true,
      }),
    ).not.toThrow();
  });

  it('fails closed when negotiated effects are incomplete or mutation-capable', () => {
    expect(workspaceLeaseMode(selection([], true))).toBe('read');
    expect(workspaceLeaseMode(selection(['read'], true))).toBe('read');
    expect(workspaceLeaseMode(selection(['command'], true))).toBe('write');
    expect(workspaceLeaseMode(selection([], false))).toBe('write');
  });

  it('detects untracked work in the canonical Git worktree', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-dock-dirty-workspace-'));
    try {
      execFileSync('git', ['init', '-b', 'dirty-test', cwd], { windowsHide: true });
      const workspace = await resolveWorkspaceIdentity(cwd);
      expect(await isWorkspaceDirty(workspace)).toBe(false);

      writeFileSync(join(cwd, 'uncommitted.txt'), 'preserve me', 'utf8');
      expect(await isWorkspaceDirty(workspace)).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 10_000);
});

function selection(
  possibleEffects: CapabilitySelection['possibleEffects'],
  effectsComplete: boolean,
): CapabilitySelection {
  return {
    transport: 'test',
    enabled: [],
    unavailableOptional: [],
    possibleEffects,
    effectsComplete,
  };
}

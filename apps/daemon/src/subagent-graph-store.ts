import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { subagentNodeV2Schema, type SubagentControlRequestV2, type SubagentGraphV2, type SubagentNodeV2 } from '@agent-dock/shared';

export type SubagentControlHandler = (request: SubagentControlRequestV2, node: SubagentNodeV2) => Promise<void>;

/** Durable normalized child-agent graph. Native payloads and secrets never enter this store. */
export class SubagentGraphStore {
  readonly #nodes = new Map<string, SubagentNodeV2>();

  constructor(private readonly filePath: string, private readonly controlHandler?: SubagentControlHandler) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as { version?: unknown; nodes?: unknown };
      if (parsed.version !== 1 || !Array.isArray(parsed.nodes)) return;
      for (const raw of parsed.nodes.slice(0, 10_000)) {
        const node = subagentNodeV2Schema.safeParse(raw);
        if (node.success) this.#nodes.set(node.data.id, node.data);
      }
    } catch { /* missing or corrupt state stays fail-closed and empty */ }
  }

  upsert(input: SubagentNodeV2): void {
    const node = subagentNodeV2Schema.parse(input);
    if (node.parentId) {
      const parent = this.#nodes.get(node.parentId);
      if (!parent || parent.sessionId !== node.sessionId) throw new Error('subagent parent does not belong to this session');
    }
    const existing = this.#nodes.get(node.id);
    if (existing && existing.sessionId !== node.sessionId) throw new Error('subagent cannot move between sessions');
    this.#nodes.set(node.id, structuredClone(node));
    this.persist();
  }

  graph(sessionId: string): SubagentGraphV2 {
    return { sessionId, nodes: [...this.#nodes.values()].filter((node) => node.sessionId === sessionId).map((node) => structuredClone(node)) };
  }

  async control(request: SubagentControlRequestV2): Promise<'accepted' | 'unsupported' | 'not_found'> {
    const node = this.#nodes.get(request.agentId);
    if (!node || node.sessionId !== request.sessionId) return 'not_found';
    if (!node.controls[request.action]) return 'unsupported';
    if (!this.controlHandler) return 'unsupported';
    await this.controlHandler(request, structuredClone(node));
    return 'accepted';
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ version: 1, nodes: [...this.#nodes.values()] })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, this.filePath);
  }
}

/** Adapter registry — add new agents here without touching core. */
import type { AgentAdapter } from "./adapter.js";
import { opencodeAdapter } from "./opencode.js";
import { codexAdapter } from "./codex.js";
import { claudeAdapter } from "./claude.js";

const registry = new Map<string, AgentAdapter>([
  [opencodeAdapter.id, opencodeAdapter],
  [codexAdapter.id, codexAdapter],
  [claudeAdapter.id, claudeAdapter],
]);

export function registerAdapter(adapter: AgentAdapter): void {
  registry.set(adapter.id, adapter);
}

export function getAdapter(id: string): AgentAdapter | undefined {
  return registry.get(id.toLowerCase());
}

export function listAdapters(): AgentAdapter[] {
  return [...registry.values()];
}

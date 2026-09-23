/**
 * Which hook events ask for an ambient-recall reindex, and the request format
 * bin/recall-reindex-hook.ts writes into the mailbox as `reindex-<tag>.json`.
 *
 * Kept free of vectra and the indexer: the hook runs after every Write and
 * Edit in every project, and importing either costs it ~130ms per fire.
 */

import { realpathSync } from "fs";
import { isAbsolute, join, relative, resolve, sep } from "path";
import { getEntitiesDir, getJournalDir } from "./config.ts";

/** A whole-corpus reconcile, or reconcileSource over each absolute path. */
export type ReindexRequest = { corpus: true } | { paths: string[] };

export interface HookEnvelope {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

// MCP tools that append to the journal. Their envelope names no file, and a
// no-op corpus reconcile costs well under a second of worker time, so they ask
// for the whole corpus rather than duplicating the journal's file naming here.
const MEMORY_WRITE_TOOL = /^mcp__.*macrodata.*__(?:log_journal|save_conversation_summary)$/;

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * The path as the indexer spells it (under the configured root), or null when
 * it is outside both corpus roots or not a file the indexer indexes. Compared through realpath so an edit made
 * through a symlinked alias of the store still counts.
 */
function corpusPath(filePath: string): string | null {
  const real = realOrSelf(resolve(filePath));
  for (const [root, ext] of [
    [getJournalDir(), ".jsonl"],
    [getEntitiesDir(), ".md"],
  ] as const) {
    const rel = relative(realOrSelf(root), real);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
      // Files the indexer never indexes would only buy a corpus fallback.
      if (!rel.endsWith(ext) || rel.split(sep).some((s) => s.startsWith("."))) return null;
      return join(root, rel);
    }
  }
  return null;
}

/** What reindex, if any, a hook event calls for. */
export function reindexRequestFor(env: HookEnvelope): ReindexRequest | null {
  if (env.hook_event_name === "SessionStart") return { corpus: true };
  if (MEMORY_WRITE_TOOL.test(env.tool_name ?? "")) return { corpus: true };
  const filePath = env.tool_input?.file_path;
  if (typeof filePath !== "string" || !isAbsolute(filePath)) return null;
  const p = corpusPath(filePath);
  return p ? { paths: [p] } : null;
}

export function parseReindexRequest(raw: unknown): ReindexRequest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.corpus === true) return { corpus: true };
  if (
    Array.isArray(r.paths) &&
    r.paths.length > 0 &&
    r.paths.every((p) => typeof p === "string" && isAbsolute(p))
  ) {
    return { paths: r.paths as string[] };
  }
  return null;
}

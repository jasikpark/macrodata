/**
 * CLI: converge the ambient-recall Qwen3/1024 index on macrodata markdown.
 *   bun run bin/recall-reindex.ts               reconcile: embed new/changed items, prune deleted
 *   bun run bin/recall-reindex.ts --full        re-embed everything (after an embedding-model change)
 *   bun run bin/recall-reindex.ts --prune-only  drop orphaned vectors, no embedding
 *
 * Safe to run repeatedly — writes only to the recall index dir, printed on
 * startup. An interrupted run resumes: the next reconcile skips every item
 * already committed.
 */

import { reconcileCorpus, pruneOrphans } from "../src/recall/indexer.ts";
import { getMacrodataRoot, getIndexDir } from "../src/recall/config.ts";

const USAGE = "usage: bun run bin/recall-reindex.ts [--full | --prune-only]";
const args = process.argv.slice(2);
if (args.length > 1 || args.some((a) => a !== "--full" && a !== "--prune-only")) {
  console.error(USAGE);
  process.exit(2);
}
const mode = args[0];

const say = (msg: string) => console.log(`[macrodata-recall]${msg}`);
say(`data root: ${getMacrodataRoot()}`);
say(`index dir: ${getIndexDir()}`);

let failures: string[];
if (mode === "--prune-only") {
  const r = await pruneOrphans();
  failures = r.failures;
  say(`✓ pruned ${r.pruned} orphaned vectors, ${r.kept} live items remain`);
} else {
  const start = Date.now();
  const r = await reconcileCorpus({ force: mode === "--full", onProgress: say });
  failures = r.failures;
  if (r.setAside) say(`unusable index moved to ${r.setAside}`);
  say(
    `✓ ${r.itemCount} items: ${r.embedded} embedded, ${r.relabeled} relabeled, ${r.unchanged} unchanged, ${r.pruned} pruned in ${((Date.now() - start) / 1000).toFixed(1)}s${r.complete ? "" : " (projection incomplete: nothing under a failed source was pruned)"}`,
  );
}
for (const f of failures) say(`incomplete: ${f}`);

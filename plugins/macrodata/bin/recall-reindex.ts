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

import { reconcileCorpus, rebuildIndex, pruneOrphans } from "../src/recall/indexer.ts";
import { getMacrodataRoot, getIndexDir } from "../src/recall/config.ts";

const USAGE = "usage: bun run bin/recall-reindex.ts [--full | --prune-only]";
const args = process.argv.slice(2);
if (args.length > 1 || args.some((a) => a !== "--full" && a !== "--prune-only")) {
  console.error(USAGE);
  process.exit(2);
}
const mode = args[0];

console.log(`[macrodata-recall]data root: ${getMacrodataRoot()}`);
console.log(`[macrodata-recall]index dir: ${getIndexDir()}`);

if (mode === "--prune-only") {
  const { pruned, kept } = await pruneOrphans();
  console.log(`[macrodata-recall]✓ pruned ${pruned} orphaned vectors, ${kept} live items remain`);
} else if (mode === "--full") {
  const { itemCount, pruned } = await rebuildIndex();
  console.log(`[macrodata-recall]✓ indexed ${itemCount} items, pruned ${pruned} orphaned vectors`);
} else {
  const start = Date.now();
  const r = await reconcileCorpus();
  console.log(
    `[macrodata-recall]✓ ${r.itemCount} items: ${r.embedded} embedded, ${r.relabeled} relabeled, ${r.unchanged} unchanged, ${r.pruned} pruned in ${((Date.now() - start) / 1000).toFixed(1)}s${r.complete ? "" : " (projection incomplete: nothing under a failed source was pruned)"}`,
  );
}

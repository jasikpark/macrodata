/**
 * Preload for a recall-hook.ts run that must not load the pipeline: resolving
 * recall-hook-main.ts exits 3, before any of its imports run.
 */
import { plugin } from "bun";

plugin({
  name: "trap-recall-pipeline",
  setup(build) {
    build.onLoad({ filter: /recall-hook-main\.ts$/ }, () => {
      process.stderr.write("recall pipeline loaded\n");
      process.exit(3);
    });
  },
});

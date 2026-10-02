#!/usr/bin/env bun
/**
 * Ambient-recall hook entry. The pipeline in recall-hook-main.ts imports vectra
 * and the indexer, about 120 MB per fire, so a disabled hook exits before
 * loading it. A manual --query is an explicit ask and runs regardless.
 */

import { recallDisabled } from "../src/recall/config.ts";

if (!process.argv.includes("--query") && recallDisabled()) process.exit(0);
await import("./recall-hook-main.ts");

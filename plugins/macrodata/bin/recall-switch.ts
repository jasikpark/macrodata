#!/usr/bin/env bun
/**
 * Prints "disabled" or "enabled" for ambient recall, and nothing else, for
 * macrodata-hook.sh.
 *
 * The supervisor asks this rather than parsing the settings file itself: jq and
 * JSON.parse accept different files (a BOM, NaN, a second document, a lone
 * surrogate), and a split leaves the supervisor reaping while hooks queue into a
 * mailbox no worker drains, or a worker running that no hook uses. One start
 * costs ~10 ms and ~16 MB.
 */

import { recallDisabled } from "../src/recall/config.ts";

console.log(recallDisabled() ? "disabled" : "enabled");

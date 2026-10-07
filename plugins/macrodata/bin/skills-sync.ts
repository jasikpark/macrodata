#!/usr/bin/env bun
/**
 * Links the memory store's skills into Claude Code (src/skills.ts).
 *
 *   skills-sync.ts          reconcile; the SessionStart hook. Silent unless
 *                           something changed or needs attention.
 *   skills-sync.ts adopt N  move ~/.claude/skills/N into the store, link it back.
 */

import { adoptSkill, getClaudeSkillsDir, reconcileSkills } from "../src/skills.ts";

/** Hook stdout lands in model context; an error message may carry store-supplied text. */
// eslint-disable-next-line no-control-regex -- stripping them is the point
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 300);

const [cmd, arg] = process.argv.slice(2);

if (cmd === "adopt") {
  if (!arg) {
    console.error("usage: skills-sync.ts adopt <name>");
    process.exit(2);
  }
  try {
    console.log(`adopted ${arg} → ${adoptSkill(arg)}`);
  } catch (e) {
    console.error(`adopt failed: ${(e as Error).message}`);
    process.exit(1);
  }
} else {
  // A SessionStart hook's stdout lands in context and a nonzero exit shows as a
  // hook error, so a failed sync reports one line and still exits 0.
  try {
    const r = reconcileSkills();
    const lines: string[] = [];
    if (r.linked.length) lines.push(`linked: ${r.linked.join(", ")}`);
    if (r.relinked.length) lines.push(`relinked: ${r.relinked.join(", ")}`);
    if (r.pruned.length) lines.push(`unlinked: ${r.pruned.join(", ")}`);
    lines.push(...r.warnings);
    if (r.createdDir)
      lines.push(`created ${getClaudeSkillsDir()}; run /reload-skills to load these this session`);
    if (lines.length) console.log(`<macrodata-skills>\n${lines.join("\n")}\n</macrodata-skills>`);
  } catch (e) {
    console.log(
      `<macrodata-skills>sync failed: ${oneLine(String((e as Error).message))}</macrodata-skills>`,
    );
  }
}

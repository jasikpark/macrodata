/**
 * Pure helpers for the scheduled-reminder pipeline (daemon side).
 *
 * Extracted from the daemon so the sanitization is unit- and property-testable
 * without booting the process. Everything here treats a schedule's
 * id/description/payload/model as UNTRUSTED: a schedule can be planted by any
 * `schedule` MCP-tool call (which model-driven prompt injection can induce),
 * and its fields are later injected verbatim into a live session's context and
 * used to build a filesystem path. So we sanitize at this boundary even though
 * the MCP tool also validates — schedule JSON on disk can predate the tool's
 * validation or be hand-edited.
 */

export const DEFAULT_MODEL = "haiku";

// Aliases the Agent tool accepts. An unknown/garbage model can't be pinned —
// it falls back to the cheap default, so an injected schedule can't re-arm an
// expensive model (the cost regression this whole change exists to prevent).
const MODEL_ALIASES: readonly string[] = ["opus", "sonnet", "haiku", "fable"];

/** Map a stored model string to a safe Agent-tool alias, or the cheap default. */
export function resolveModel(model?: string): string {
  if (!model) return DEFAULT_MODEL;
  const bare = model.replace(/^anthropic\//, "").trim();
  if (MODEL_ALIASES.includes(bare)) return bare;
  // Full ids like "claude-opus-4-7" → their alias.
  const m = bare.match(/\b(opus|sonnet|haiku|fable)\b/);
  return m ? m[1] : DEFAULT_MODEL;
}

/**
 * Reduce a schedule id to a safe filename + XML-attribute token. Drops any
 * path component, keeps only [A-Za-z0-9_-], strips leading separators, caps
 * length. Guarantees: no "/" or ".." (no traversal), no leading "." (the drain
 * skips dotfiles forever), no quote/glob/newline.
 */
export function safeId(id: string): string {
  const base = id.replace(/^.*[\\/]/, "");
  const cleaned = base.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return cleaned.replace(/^[-_]+/, "") || "reminder";
}

/**
 * Filename for a schedule's single pending reminder. Keyed by id alone —
 * queue length of one per schedule: a new firing overwrites the prior
 * unclaimed reminder (last-fire-wins), so the dir never grows past the number
 * of distinct schedules.
 */
export function reminderFileName(id: string): string {
  return safeId(id);
}

/**
 * Escape a value for safe interpolation inside an XML attribute. Collapses
 * control chars FIRST: the consumer is an LLM, not an XML parser, so a newline
 * in the description would render as a free-standing line in the block header
 * (above "give it the prompt below verbatim") and read as an injected
 * instruction. Attribute values are single-line, so flattening is correct.
 */
function attrEscape(s: string): string {
  return s
    .replace(/[\r\n\t]+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Neutralize macrodata block openers/closers in free text so an untrusted
 * payload can't close the <macrodata-scheduled-task> frame or forge a sibling
 * block. Mirrors the USER_INFO neutralization in macrodata-hook.sh; leaves
 * other markup intact so legitimate payload text (code, etc.) survives.
 */
export function neutralizeTags(s: string): string {
  return s
    .replace(/<\/macrodata/g, "&lt;/macrodata")
    .replace(/<macrodata/g, "&lt;macrodata");
}

export interface ReminderInput {
  id: string;
  description: string;
  payload: string;
  model?: string;
}

/** Build the reminder block injected into the active session. */
export function formatReminder(s: ReminderInput, when: string): string {
  const id = safeId(s.id);
  const model = resolveModel(s.model);
  const description = attrEscape(s.description);
  const payload = neutralizeTags(s.payload);
  return `<macrodata-scheduled-task id="${id}" description="${description}" model="${model}">
[Scheduled task due — ${when}]
Start a background subagent (Agent tool, run_in_background, model pinned to "${model}") and give it the prompt below verbatim. It uses the macrodata_* tools for memory operations. Don't block on it.

Subagent prompt:
${payload}
</macrodata-scheduled-task>`;
}

/**
 * Argv for the "headless" delivery path:
 *   claude --print --model <alias> -- <payload>
 * Flags go first and the payload is the final positional behind a `--`
 * end-of-options sentinel, so a payload that happens to start with "-" is still
 * the prompt, never parsed as a claude flag. (claude is Commander-based and the
 * prompt is positional — `Usage: claude [options] [command] [prompt]`, verified
 * against CLI 2.1.x, which honors `--`.) The model is clamped to a safe alias by
 * resolveModel. spawn uses an arg array (never a shell), so no shell-escaping is
 * needed.
 */
export function buildHeadlessArgs(s: ReminderInput): string[] {
  return ["--print", "--model", resolveModel(s.model), "--", s.payload];
}

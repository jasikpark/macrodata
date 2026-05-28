#!/usr/bin/env bun
// Composer for the macrodata files-manifest SessionStart hook.
//
// Renders a "filetree-as-index" manifest (Letta MemFS style): one line per
// state/entity file. A file with an authored frontmatter `description:` renders
// as `- <path> — <description>`; a file without one renders as a bare
// `- <path>`. A single aggregate footer counts the files still lacking a
// description — a nudge to add one — so the manifest advertises WHAT memory
// exists (and when to go read it) cheaply, instead of dumping content.
//
// Why a dedicated hook (not a section in the state composer): the manifest is
// an always-available navigational index, not mutable state, and it grows as
// files gain descriptions. Running it as its own SessionStart hook gives it its
// own ~10K hook-output envelope (anthropics/claude-code#44086 caps each hook
// output string independently) rather than competing for the composer's budget.
//
// Why authored frontmatter, NOT a scraped body/heading: scraping the first
// heading just echoes the filename (`billing-api.md — Billing Api`), which is
// dead weight. The description is a curated field; its absence → the footer.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const MAX_BUDGET = 9_500;
const DESC_CAP = 100;

const stateRoot =
  process.argv[2] ||
  process.env.MACRODATA_ROOT ||
  join(process.env.HOME ?? "", ".config/macrodata");

// Neutralize literal macrodata tag-openers so an authored description can't
// close the wrapper early or forge a sibling block. Entity-escaping the "<"
// keeps it readable and unmistakably meta. Mirrors the state composer.
function neutralizeTags(s: string): string {
  return s.replaceAll("</macrodata", "&lt;/macrodata").replaceAll("<macrodata", "&lt;macrodata");
}

// Authored `description:` from a file's YAML frontmatter, or null. One-liner,
// capped; quotes stripped; empty treated as absent.
function frontmatterDescription(absPath: string): string | null {
  let text: string;
  try {
    text = readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end < 0) return null;
  for (const line of lines.slice(1, end)) {
    const m = /^description:\s*(.*)$/i.exec(line);
    if (!m) continue;
    let v = m[1].trim().replace(/^["']|["']$/g, "").trim();
    if (!v) return null;
    if (v.length > DESC_CAP) v = v.slice(0, DESC_CAP - 1) + "…";
    return neutralizeTags(v);
  }
  return null;
}

// state/*.md (one level) + entities/**/*.md (recursive), as paths relative to
// the state root, in a stable sorted order.
function collectFiles(): string[] {
  const out: string[] = [];
  const statePath = join(stateRoot, "state");
  if (existsSync(statePath)) {
    let names: string[] = [];
    try {
      names = readdirSync(statePath).sort();
    } catch {
      // skip unreadable state dir
    }
    for (const f of names) if (f.endsWith(".md")) out.push(`state/${f}`);
  }
  const entitiesPath = join(stateRoot, "entities");
  if (existsSync(entitiesPath)) walk(entitiesPath, out);
  return out;
}

function walk(dir: string, out: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of names) {
    const abs = join(dir, name);
    let isDir = false;
    try {
      // statSync follows symlinks and throws on a broken one — skip it rather
      // than crash the whole manifest.
      isDir = statSync(abs).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walk(abs, out);
    else if (name.endsWith(".md")) out.push(relative(stateRoot, abs));
  }
}

function renderBody(): string {
  const files = collectFiles();
  if (!files.length) return "_No files yet_";
  let undescribed = 0;
  const lines = files.map((rel) => {
    // State files are exempt from the description convention: they are always
    // injected in full by the dynamic-state composer, so a manifest description
    // would be decorative. List them as plain pointers and never nudge for them.
    // Descriptions earn their keep only on entities, whose bodies are NOT
    // injected — the manifest line is the sole signpost to them.
    if (rel.startsWith("state/")) return `- ${rel}`;
    const desc = frontmatterDescription(join(stateRoot, rel));
    if (desc) return `- ${rel} — ${desc}`;
    undescribed++;
    return `- ${rel}`;
  });
  let body = lines.join("\n");
  if (undescribed > 0) {
    body += `\n\n_${undescribed} entit${undescribed === 1 ? "y has" : "ies have"} no \`description:\` frontmatter — add one for better recall._`;
  }
  return body;
}

let body = renderBody();

// Defensive head-keep: a pathological store (hundreds of files) could push the
// manifest past the hook-output cap. Keep the head + a visible marker so it is
// never silently truncated to a 2K preview.
const framing = `<macrodata-files root="${stateRoot}">\n\n</macrodata-files>`.length;
const room = Math.max(0, MAX_BUDGET - framing);
if (body.length > room) {
  const marker = "\n…\n[manifest truncated to fit; full list via `ls` under root]";
  body = body.slice(0, Math.max(0, room - marker.length)) + marker;
}

process.stdout.write(`<macrodata-files root="${stateRoot}">\n${body}\n</macrodata-files>`);

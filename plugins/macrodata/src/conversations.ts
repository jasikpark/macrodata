/**
 * Claude Conversation Log Parser and Indexer
 * 
 * Indexes conversation "exchanges" from Claude Code's log files for semantic search.
 * Each exchange = user prompt + assistant's first text response.
 * 
 * Features:
 * - Project-biased search (current project first, then global)
 * - Time-weighted scoring (recent > old)
 * - Metadata: project, branch, timestamp, session
 */

import {
  readdirSync,
  readFileSync,
  existsSync,
  statSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  openSync,
  readSync,
  closeSync,
} from "fs";
import { createHash } from "crypto";
import { join, basename } from "path";
import { homedir } from "os";
import { getLogger } from "@logtape/logtape";
import { embed, embedBatch } from "./embeddings.js";
import { AtomicLocalIndex } from "./recall/atomic-index.js";
import { getIndexDir } from "./config.js";

// Library-side logging: sink comes from the entrypoint's configure() (MCP
// server -> stderr, daemon -> .daemon.log); unconfigured processes drop the
// records. Never writes to stdout, so MCP stdio callers are safe.
const logger = getLogger(["macrodata", "conversations"]);

// Index state tracking for incremental updates
interface IndexState {
  files: Record<string, FileState>;
  lastUpdate: string;
}

interface FileState {
  mtime: number;
  /** File size when last read; absent in state written before offsets existed. */
  size?: number;
  /** Byte offset the next read resumes from; absent means read from the start. */
  offset?: number;
  /** anchorAt(offset) when it was recorded; a read resumes only while it still matches. */
  anchor?: string;
  exchangeIds: string[];
}

const ANCHOR_BYTES = 4096;

/**
 * A hash of the first and last ANCHOR_BYTES before `offset`. The head holds the
 * session's first line and the tail its latest, so a rewritten file differs in
 * one or the other; line tails alone repeat across sessions.
 */
function anchorAt(filePath: string, offset: number): string {
  const head = readRange(filePath, 0, Math.min(offset, ANCHOR_BYTES));
  const tail = readRange(filePath, Math.max(0, offset - ANCHOR_BYTES), offset);
  return createHash("sha256").update(head).update(tail).digest("base64");
}

function getIndexStatePath(): string {
  return join(getIndexDir(), "conversations-state.json");
}

function loadIndexState(): IndexState {
  const statePath = getIndexStatePath();
  if (existsSync(statePath)) {
    try {
      return JSON.parse(readFileSync(statePath, "utf-8"));
    } catch {
      logger.warn("index state corrupted, starting fresh");
    }
  }
  return { files: {}, lastUpdate: "" };
}

function saveIndexState(state: IndexState): void {
  const statePath = getIndexStatePath();
  const dir = getIndexDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // A torn write would parse as corrupt, and a fresh state re-embeds every transcript.
  const tmp = `${statePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, statePath);
}

// Claude Code keeps transcripts under CLAUDE_CONFIG_DIR when it is set. Read per
// scan, not at import, so a long-lived process follows the environment it runs in.
function projectsDir(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
}

// Types
interface ConversationMessage {
  type: "user" | "assistant" | "file-history-snapshot";
  message?: {
    role: string;
    content: string | Array<{ type: string; text?: string; thinking?: string }>;
  };
  uuid?: string;
  parentUuid?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
}

export interface ConversationExchange {
  id: string;
  userPrompt: string;
  assistantSummary: string;
  project: string;
  projectPath: string;
  branch?: string;
  timestamp: string;
  sessionId: string;
  sessionPath: string;
  messageUuid: string;
}

export interface ConversationSearchResult {
  exchange: ConversationExchange;
  score: number;
  adjustedScore: number; // After time weighting and project boost
}

// Cached index with path tracking
let convIndex: AtomicLocalIndex | null = null;
let convIndexPath: string | null = null;

// Vectra rewrites the whole index.json on every endUpdate (and on every bare
// upsertItem, which wraps its own update), so a write per exchange makes an
// update quadratic in index size. Commit every COMMIT_ITEMS exchanges instead,
// mirroring src/recall/indexer.ts.
const COMMIT_ITEMS = 128;

async function getConversationIndex(): Promise<AtomicLocalIndex> {
  const currentIndexDir = getIndexDir();
  const currentIndexPath = join(currentIndexDir, "conversations");

  // The daemon's checkpoint pass and other sessions' MCP servers rewrite
  // index.json; a long-lived server that kept its first load would never see
  // their exchanges.
  if (convIndex && (convIndexPath !== currentIndexPath || !convIndex.isCurrent())) {
    convIndex = null;
    convIndexPath = null;
  }

  if (convIndex) return convIndex;

  if (!existsSync(currentIndexDir)) {
    const { mkdirSync } = await import("fs");
    mkdirSync(currentIndexDir, { recursive: true });
  }

  convIndex = new AtomicLocalIndex(currentIndexPath);
  convIndexPath = currentIndexPath;

  if (!(await convIndex.isIndexCreated())) {
    logger.info("creating new conversation index");
    await convIndex.createIndex();
  }

  return convIndex;
}

function indexItemOf(exchange: ConversationExchange, vector: number[]) {
  return {
    id: exchange.id,
    vector,
    metadata: {
      userPrompt: exchange.userPrompt,
      assistantSummary: exchange.assistantSummary,
      project: exchange.project,
      projectPath: exchange.projectPath,
      branch: exchange.branch || "",
      timestamp: exchange.timestamp,
      sessionId: exchange.sessionId,
      sessionPath: exchange.sessionPath,
      messageUuid: exchange.messageUuid,
    },
  };
}

// A failed commit may have left the on-disk index ahead of or behind this copy
// (ConcurrentWriteError); drop the cache so the next call reloads it.
function abandonUpdate(idx: AtomicLocalIndex, open: boolean): void {
  if (open) idx.cancelUpdate();
  convIndex = null;
  convIndexPath = null;
}

/**
 * Decode project directory name back to path
 * e.g., "-Users-mkane-Repos-workers-sdk" -> "/Users/mkane/Repos/workers-sdk"
 */
function decodeProjectPath(encoded: string): string {
  return encoded.replace(/^-/, "/").replace(/-/g, "/");
}

/**
 * Extract project name from path
 */
function getProjectName(projectPath: string): string {
  return basename(projectPath);
}

/**
 * Extract first text content from assistant message
 */
function extractAssistantText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") {
    return content.slice(0, 500);
  }

  for (const block of content) {
    if (block.type === "text" && block.text) {
      return block.text.slice(0, 500);
    }
  }

  return "";
}

/**
 * Check if user message content is a tool result (not an actual user prompt)
 */
function isToolResult(content: unknown): boolean {
  if (Array.isArray(content)) {
    // Array content with tool_result or tool_use_id = tool result, not user prompt
    return content.some(item =>
      item.type === "tool_result" ||
      item.tool_use_id !== undefined
    );
  }
  return false;
}

/**
 * Check if content is noise we should skip indexing
 */
function isNoiseContent(content: string): boolean {
  // Skip compacted session summaries
  if (content.startsWith("This session is being continued from a previous conversation")) {
    return true;
  }

  // Skip local command outputs
  if (content.includes("<local-command-stdout>") ||
      content.includes("<local-command-caveat>") ||
      content.includes("<command-name>")) {
    return true;
  }

  // Skip hook-injected context (standalone, not part of agent context)
  if (content.startsWith("<current_time>") ||
      content.startsWith("<context_status>") ||
      content.startsWith("<state_files>") ||
      content.startsWith("<system-reminder>") ||
      content.startsWith("## Current State Files") ||
      content.startsWith("Base directory for this skill:")) {
    return true;
  }

  // Skip empty messages
  if (content.trim().length < 1) {
    return true;
  }

  return false;
}

/**
 * Extract actual user text from message content, filtering out tool results
 */
function extractUserText(content: string | unknown[]): string {
  let text = "";

  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    // Array content - try to find actual text blocks
    for (const block of content) {
      const b = block as Record<string, unknown>;
      // Skip tool results
      if (b.type === "tool_result" || b.tool_use_id !== undefined) {
        continue;
      }
      // Look for text content
      if (b.type === "text" && typeof b.text === "string") {
        text = b.text;
        break;
      }
    }
  }

  if (!text) return "";

  // Extract actual user message from agent context blocks
  // These have format: "# Agent Context\n...\nUser message: <actual message>"
  if (text.startsWith("# Agent Context") || text.includes("\nUser message: ")) {
    const userMsgMatch = text.match(/\nUser message: (.+)$/s);
    if (userMsgMatch) {
      return userMsgMatch[1].trim();
    }
    // No user message found in context block - skip it
    return "";
  }

  return text;
}

/** Bytes [from, to) of a file. */
function readRange(filePath: string, from: number, to: number): Buffer {
  const buf = Buffer.alloc(Math.max(0, to - from));
  const fd = openSync(filePath, "r");
  try {
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, from + read);
      if (n === 0) break;
      read += n;
    }
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/**
 * Parse a conversation file from byte `from` up to `size` and extract exchanges.
 *
 * Returns the offset a later call resumes from: the start of a user prompt
 * still waiting for its reply, or else the end of the last complete line. A
 * trailing line without its newline is still being written and is left for the
 * next read. Transcripts are append-only, so resuming there sees every
 * exchange exactly once.
 */
function parseConversationFile(
  filePath: string,
  projectPath: string,
  from = 0,
  size = Infinity,
): { exchanges: ConversationExchange[]; offset: number } {
  const exchanges: ConversationExchange[] = [];
  const projectName = getProjectName(projectPath);
  let offset = from;

  try {
    const end = Number.isFinite(size) ? size : statSync(filePath).size;
    const buf = readRange(filePath, from, end);

    let currentUser: { msg: ConversationMessage; text: string; start: number } | null = null;
    let malformedLines = 0;

    // Split on the newline byte: it never occurs inside a multi-byte UTF-8
    // sequence, so line boundaries are exact byte offsets.
    let lineStart = 0;
    for (let nl = buf.indexOf(0x0a); nl !== -1; lineStart = nl + 1, nl = buf.indexOf(0x0a, lineStart)) {
      offset = from + nl + 1;
      const line = buf.toString("utf-8", lineStart, nl).trim();
      if (!line) continue;
      try {
        const msg: ConversationMessage = JSON.parse(line);

        if (msg.type === "user" && msg.message?.content) {
          // Skip tool results - these aren't actual user prompts
          if (isToolResult(msg.message.content)) {
            continue;
          }

          // Extract the actual text
          const userText = extractUserText(msg.message.content);

          // Skip noise (command outputs, compacted summaries, very short messages)
          if (!userText || isNoiseContent(userText)) {
            continue;
          }

          currentUser = { msg, text: userText, start: from + lineStart };
        } else if (msg.type === "assistant" && currentUser && msg.message?.content) {
          // Found a user-assistant pair
          const assistantText = extractAssistantText(msg.message.content);

          if (currentUser.text) {
            exchanges.push({
              id: `conv-${currentUser.msg.sessionId}-${currentUser.msg.uuid}`,
              userPrompt: currentUser.text.slice(0, 1000),
              assistantSummary: assistantText,
              project: projectName,
              projectPath: projectPath,
              branch: currentUser.msg.gitBranch,
              timestamp: currentUser.msg.timestamp || new Date().toISOString(),
              sessionId: currentUser.msg.sessionId || basename(filePath, ".jsonl"),
              sessionPath: filePath,
              messageUuid: currentUser.msg.uuid || "",
            });
          }

          currentUser = null; // Reset for next exchange
        }
      } catch {
        malformedLines++;
      }
    }
    if (currentUser) offset = currentUser.start;
    if (malformedLines > 0) {
      logger.warn("skipped malformed lines", { filePath, malformedLines });
    }
  } catch (err) {
    logger.error("failed to parse session file", { filePath, error: String(err) });
  }

  return { exchanges, offset };
}

/**
 * Scan all Claude project directories for conversation files
 */
function* scanConversationFiles(): Generator<{
  filePath: string;
  projectPath: string;
  mtime: number;
  size: number;
}> {
  const root = projectsDir();
  if (!existsSync(root)) {
    return;
  }

  const projectDirs = readdirSync(root);

  for (const projectDir of projectDirs) {
    if (projectDir.startsWith(".")) continue;

    const projectPath = decodeProjectPath(projectDir);
    const projectFullPath = join(root, projectDir);

    if (!statSync(projectFullPath).isDirectory()) continue;

    const files = readdirSync(projectFullPath);

    for (const file of files) {
      // Skip agent files, only process main conversation files
      if (!file.endsWith(".jsonl") || file.startsWith("agent-")) continue;

      const filePath = join(projectFullPath, file);
      const { mtimeMs: mtime, size } = statSync(filePath);

      yield { filePath, projectPath, mtime, size };
    }
  }
}

// Every writer below runs through this chain. manage_index starts updates and
// rebuilds without awaiting them, and two passes on the shared cached index
// would interleave inside one Vectra update: the second beginUpdate throws, and
// its cleanup cancels the first pass's update.
let writeChain: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => {});
  return run;
}

/**
 * Rebuild the conversation index from scratch
 */
export function rebuildConversationIndex(): Promise<{ exchangeCount: number }> {
  return serialized(rebuildUnserialized);
}

async function rebuildUnserialized(): Promise<{ exchangeCount: number }> {
  logger.info("starting full index rebuild");
  const startTime = Date.now();

  const allExchanges: ConversationExchange[] = [];
  const newState: IndexState = { files: {}, lastUpdate: new Date().toISOString() };

  for (const { filePath, projectPath, mtime, size } of scanConversationFiles()) {
    const { exchanges, offset } = parseConversationFile(filePath, projectPath, 0, size);
    allExchanges.push(...exchanges);
    newState.files[filePath] = {
      mtime,
      size,
      offset,
      anchor: anchorAt(filePath, offset),
      exchangeIds: exchanges.map(e => e.id),
    };
  }

  logger.info("found exchanges", { exchanges: allExchanges.length });

  if (allExchanges.length === 0) {
    saveIndexState(newState);
    return { exchangeCount: 0 };
  }

  // Create embeddings for all exchanges
  const texts = allExchanges.map(e =>
    `${e.project}${e.branch ? ` (${e.branch})` : ""}: ${e.userPrompt}`
  );

  logger.info("generating embeddings");
  const vectors = await embedBatch(texts);

  const idx = await getConversationIndex();

  // State is saved only after this commit, so an interrupted rebuild starts over
  // whatever the commit size.
  await idx.beginUpdate();
  let open = true;
  try {
    for (let i = 0; i < allExchanges.length; i++) {
      await idx.upsertItem(indexItemOf(allExchanges[i], vectors[i]));
    }
    open = false;
    await idx.endUpdate();
  } catch (err) {
    abandonUpdate(idx, open);
    throw err;
  }

  saveIndexState(newState);

  const duration = Date.now() - startTime;
  logger.info("full rebuild complete", { ms: duration });

  return { exchangeCount: allExchanges.length };
}

/**
 * Incrementally update the conversation index (only changed files)
 */
export function updateConversationIndex(): Promise<{ exchangeCount: number; filesUpdated: number; skipped: number }> {
  return serialized(updateUnserialized);
}

async function updateUnserialized(): Promise<{ exchangeCount: number; filesUpdated: number; skipped: number }> {
  logger.info("starting incremental update");
  const startTime = Date.now();

  const state = loadIndexState();
  const idx = await getConversationIndex();

  // Check if index exists - if not, do full rebuild
  if (!(await idx.isIndexCreated())) {
    logger.info("no existing index, doing full rebuild");
    const result = await rebuildUnserialized();
    return { exchangeCount: result.exchangeCount, filesUpdated: 0, skipped: 0 };
  }

  let filesUpdated = 0;
  let skipped = 0;
  let totalExchanges = 0;
  const currentFiles = new Set<string>();

  // A file's state entry is recorded only once its exchanges are committed, so
  // an interrupted pass re-indexes at most the uncommitted batch.
  let pending: [string, IndexState["files"][string]][] = [];
  let sinceCommit = 0;
  let open = false;
  const commit = async () => {
    if (open) {
      open = false;
      await idx.endUpdate();
    }
    for (const [filePath, entry] of pending) state.files[filePath] = entry;
    saveIndexState(state);
    pending = [];
    sinceCommit = 0;
  };

  try {
    for (const { filePath, projectPath, mtime, size } of scanConversationFiles()) {
      currentFiles.add(filePath);
      const cached = state.files[filePath];

      if (cached && cached.mtime === mtime && (cached.size === undefined || cached.size === size)) {
        skipped++;
        totalExchanges += cached.exchangeIds.length;
        continue;
      }

      // Read only what was appended since the last pass. A file now shorter
      // than its offset, or whose bytes before it changed, was rewritten rather
      // than appended to, so read it whole.
      const resume =
        cached?.offset !== undefined &&
        cached.offset <= size &&
        cached.anchor === anchorAt(filePath, cached.offset);
      const { exchanges, offset } = parseConversationFile(
        filePath,
        projectPath,
        resume ? cached.offset : 0,
        size,
      );

      if (exchanges.length > 0) {
        const texts = exchanges.map(e =>
          `${e.project}${e.branch ? ` (${e.branch})` : ""}: ${e.userPrompt}`
        );
        const vectors = await embedBatch(texts);

        if (!open) {
          await idx.beginUpdate();
          open = true;
        }
        for (let i = 0; i < exchanges.length; i++) {
          await idx.upsertItem(indexItemOf(exchanges[i], vectors[i]));
        }
      }

      const ids = exchanges.map((e) => e.id);
      const exchangeIds = resume ? [...new Set([...cached.exchangeIds, ...ids])] : ids;
      pending.push([filePath, { mtime, size, offset, anchor: anchorAt(filePath, offset), exchangeIds }]);
      filesUpdated++;
      totalExchanges += exchangeIds.length;
      sinceCommit += exchanges.length;
      if (sinceCommit >= COMMIT_ITEMS) await commit();
    }
    await commit();
  } catch (err) {
    abandonUpdate(idx, open);
    throw err;
  }

  // Clean up deleted files from state (but don't remove from index - they may still be useful)
  for (const filePath of Object.keys(state.files)) {
    if (!currentFiles.has(filePath)) {
      delete state.files[filePath];
    }
  }

  state.lastUpdate = new Date().toISOString();
  saveIndexState(state);

  const duration = Date.now() - startTime;
  logger.info("incremental update complete", { ms: duration, filesUpdated, skipped });

  return { exchangeCount: totalExchanges, filesUpdated, skipped };
}

/**
 * Calculate time-based weight for scoring
 * Recent = higher weight
 */
function getTimeWeight(timestamp: string): number {
  const age = Date.now() - new Date(timestamp).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  
  if (age < 7 * dayMs) return 1.0;      // Last week: full weight
  if (age < 30 * dayMs) return 0.9;     // Last month: 90%
  if (age < 90 * dayMs) return 0.7;     // Last 3 months: 70%
  if (age < 365 * dayMs) return 0.5;    // Last year: 50%
  return 0.3;                            // Older: 30%
}

/**
 * Search conversations with project bias and time weighting
 */
export async function searchConversations(
  query: string,
  options: {
    currentProject?: string;  // Path to current project for boosting
    limit?: number;
    projectOnly?: boolean;    // Only search current project
  } = {}
): Promise<ConversationSearchResult[]> {
  const { currentProject, limit = 5, projectOnly = false } = options;
  
  const idx = await getConversationIndex();
  const stats = await idx.listItems();
  
  if (stats.length === 0) {
    logger.info("index is empty");
    return [];
  }
  
  const queryVector = await embed(query);
  
  // Get more results than needed for filtering/reranking
  const results = await idx.queryItems(queryVector, limit * 3);
  
  // Convert to search results with adjusted scoring
  const searchResults: ConversationSearchResult[] = results.map(r => {
    const meta = r.item.metadata as Record<string, string>;
    
    const exchange: ConversationExchange = {
      id: r.item.id,
      userPrompt: meta.userPrompt,
      assistantSummary: meta.assistantSummary,
      project: meta.project,
      projectPath: meta.projectPath,
      branch: meta.branch || undefined,
      timestamp: meta.timestamp,
      sessionId: meta.sessionId,
      sessionPath: meta.sessionPath,
      messageUuid: meta.messageUuid,
    };
    
    // Calculate adjusted score
    let adjustedScore = r.score;
    
    // Time weighting
    adjustedScore *= getTimeWeight(exchange.timestamp);
    
    // Project boost (1.5x for current project)
    if (currentProject && exchange.projectPath === currentProject) {
      adjustedScore *= 1.5;
    }
    
    return {
      exchange,
      score: r.score,
      adjustedScore,
    };
  });
  
  // Filter to current project if requested
  let filtered = searchResults;
  if (projectOnly && currentProject) {
    filtered = searchResults.filter(r => r.exchange.projectPath === currentProject);
  }
  
  // Sort by adjusted score and limit
  return filtered
    .sort((a, b) => b.adjustedScore - a.adjustedScore)
    .slice(0, limit);
}

/**
 * Load full conversation context around a specific message
 */
export async function expandConversation(
  sessionPath: string,
  messageUuid: string,
  contextMessages: number = 10
): Promise<{
  messages: Array<{ role: string; content: string; timestamp?: string }>;
  project: string;
  branch?: string;
}> {
  if (!existsSync(sessionPath)) {
    throw new Error(`Session file not found: ${sessionPath}`);
  }

  const content = readFileSync(sessionPath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);

  const messages: Array<{ role: string; content: string; timestamp?: string; uuid?: string }> = [];
  let project = "";
  let branch: string | undefined;
  let malformedLines = 0;

  // Parse all messages
  for (const line of lines) {
    try {
      const msg: ConversationMessage = JSON.parse(line);

      if (msg.type === "user" && msg.message?.content) {
        // Skip tool results
        if (isToolResult(msg.message.content)) {
          continue;
        }

        const text = extractUserText(msg.message.content);

        // Skip empty or noise content
        if (!text || isNoiseContent(text)) {
          continue;
        }

        messages.push({
          role: "user",
          content: text,
          timestamp: msg.timestamp,
          uuid: msg.uuid,
        });

        if (!project && msg.cwd) {
          project = getProjectName(msg.cwd);
        }
        if (!branch && msg.gitBranch) {
          branch = msg.gitBranch;
        }
      } else if (msg.type === "assistant" && msg.message?.content) {
        const text = extractAssistantText(msg.message.content);
        if (text) {
          messages.push({
            role: "assistant",
            content: text,
            timestamp: msg.timestamp,
            uuid: msg.uuid,
          });
        }
      }
    } catch {
      malformedLines++;
    }
  }
  if (malformedLines > 0) {
    logger.warn("skipped malformed lines", { sessionPath, malformedLines });
  }

  // Find the target message index
  const targetIdx = messages.findIndex(m => m.uuid === messageUuid);

  if (targetIdx === -1) {
    // Return last N messages if target not found
    return {
      messages: messages.slice(-contextMessages).map(({ uuid: _uuid, ...rest }) => rest),
      project,
      branch,
    };
  }

  // Return context around target
  const start = Math.max(0, targetIdx - Math.floor(contextMessages / 2));
  const end = Math.min(messages.length, start + contextMessages);

  return {
    messages: messages.slice(start, end).map(({ uuid: _uuid, ...rest }) => rest),
    project,
    branch,
  };
}

/**
 * Get conversation index stats
 */
export async function getConversationIndexStats(): Promise<{ exchangeCount: number }> {
  const idx = await getConversationIndex();
  const items = await idx.listItems();
  return { exchangeCount: items.length };
}

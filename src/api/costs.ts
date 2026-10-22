import { Elysia} from "elysia";
import { closeSync, openSync, readSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// Cost per million tokens (USD)
const COST_PER_MTOK: Record<string, { input: number; output: number }> = {
  opus: { input: 15, output: 75 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 0.25, output: 1.25 },
};

function modelTier(model: string): string {
  if (model.includes("opus")) return "opus";
  if (model.includes("sonnet")) return "sonnet";
  if (model.includes("haiku")) return "haiku";
  return "sonnet"; // default
}

function agentNameFromDir(dir: string): string {
  // Dir like "-home-nat-Code-github-com-laris-co-neo-oracle"
  // Extract the last meaningful segment(s)
  const parts = dir.replace(/^-/, "").split("-");
  // Find github-com pattern and take org/repo after it
  const ghIdx = parts.indexOf("github");
  if (ghIdx >= 0 && parts[ghIdx + 1] === "com" && parts.length > ghIdx + 3) {
    return parts.slice(ghIdx + 2).join("-");
  }
  // Fallback: last 2 segments
  return parts.slice(-2).join("-");
}

interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  turns: number;
  model: string;
  lastTimestamp: string;
}

function estimateCost(usage: SessionUsage): number {
  const tier = modelTier(usage.model);
  const rates = COST_PER_MTOK[tier] || COST_PER_MTOK.sonnet;
  const totalInput = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreateTokens;
  return (totalInput / 1_000_000) * rates.input + (usage.outputTokens / 1_000_000) * rates.output;
}

// ---------------------------------------------------------------------------
// Helpers for /costs/daily
// ---------------------------------------------------------------------------

/** Convert an ISO timestamp string to a local-TZ "YYYY-MM-DD" string. */
function localDateStr(isoTs: string): string {
  const d = new Date(isoTs);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

/**
 * Generate N date strings (local TZ) ending today (inclusive), oldest first.
 * Uses UTC arithmetic then converts to local date — DST-safe for display.
 */
function makeBuckets(n: number): string[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(today.getTime() - (n - 1 - i) * 86_400_000);
    return localDateStr(d.toISOString());
  });
}

export interface CostsApiDeps {
  projectsDir: string;
  readdirSync: typeof readdirSync;
  readFileSync: typeof readFileSync;
  statSync: typeof statSync;
  join: typeof join;
  /** Read bytes [start, end) of a file. Defaults to a real fs range read. */
  readRange?: (filePath: string, start: number, end: number) => Buffer;
}

/** One parsed session file, kept warm across polls. */
interface FileCacheEntry {
  mtimeMs: number;
  size: number;
  /** Bytes already folded into `acc`; always ends on a line boundary. */
  offset: number;
  acc: SessionUsage;
  usage: SessionUsage | null;
}

/** Session JSONL files must stay under this many warm entries. */
const FILE_CACHE_LIMIT = 4096;

function emptyUsage(): SessionUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    turns: 0,
    model: "",
    lastTimestamp: "",
  };
}

/** Aggregate an already-parsed file. `null` when the file holds no assistant turns. */
function toUsage(acc: SessionUsage): SessionUsage | null {
  return acc.turns > 0 ? { ...acc } : null;
}

function defaultReadRange(filePath: string, start: number, end: number): Buffer {
  const length = end - start;
  if (length <= 0) return Buffer.alloc(0);
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      const read = readSync(fd, buffer, filled, length - filled, start + filled);
      if (read <= 0) break;
      filled += read;
    }
    return filled === length ? buffer : buffer.subarray(0, filled);
  } finally {
    closeSync(fd);
  }
}

/** Split a chunk into the complete trailing lines plus the bytes they occupy. */
function completeLines(chunk: Buffer): { text: string; consumed: number } {
  const lastNewline = chunk.lastIndexOf(0x0a);
  if (lastNewline < 0) return { text: "", consumed: 0 };
  return { text: chunk.subarray(0, lastNewline + 1).toString("utf-8"), consumed: lastNewline + 1 };
}

function accumulateUsage(content: string, acc: SessionUsage): void {
  for (const line of content.split("\n")) {
    if (!line) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type !== "assistant" || !obj.message?.usage) continue;

    const u = obj.message.usage;
    acc.inputTokens += u.input_tokens || 0;
    acc.outputTokens += u.output_tokens || 0;
    acc.cacheReadTokens += u.cache_read_input_tokens || 0;
    acc.cacheCreateTokens += u.cache_creation_input_tokens || 0;
    acc.turns++;

    if (obj.message.model && !acc.model) acc.model = obj.message.model;
    if (obj.timestamp) acc.lastTimestamp = obj.timestamp;
  }
}

export function createCostsApi(deps: CostsApiDeps = {
  projectsDir: join(homedir(), ".claude", "projects"),
  readdirSync,
  readFileSync,
  statSync,
  join,
}) {
  const readRange = deps.readRange ?? defaultReadRange;
  // Warm-scan cache. Session JSONL files are append-only and can pass 250 MB,
  // so re-reading all of them on every /costs poll blocked the serve event loop
  // for seconds. Each entry stores the parsed totals plus the byte offset
  // already consumed; a poll then only parses newly appended lines.
  const fileCache = new Map<string, FileCacheEntry>();

  function storeEntry(
    filePath: string,
    mtimeMs: number,
    size: number,
    offset: number,
    acc: SessionUsage,
  ): SessionUsage | null {
    const usage = toUsage(acc);
    if (fileCache.size >= FILE_CACHE_LIMIT) fileCache.clear();
    fileCache.set(filePath, { mtimeMs, size, offset, acc, usage });
    return usage;
  }

  function scanSessionFresh(filePath: string, mtimeMs?: number, size?: number): SessionUsage | null {
    let content: string;
    try {
      content = String(deps.readFileSync(filePath, "utf-8"));
    } catch {
      return null;
    }
    const acc = emptyUsage();
    accumulateUsage(content, acc);
    // No usable stat identity (test doubles) — parse fresh, never cache.
    if (mtimeMs === undefined || size === undefined) return toUsage(acc);

    const tail = content.slice(content.lastIndexOf("\n") + 1);
    const offset = size - Buffer.byteLength(tail, "utf-8");
    return storeEntry(filePath, mtimeMs, size, offset, acc);
  }

  function scanSessionWithDeps(filePath: string): SessionUsage | null {
    let stat: { size?: number; mtimeMs?: number };
    try {
      stat = deps.statSync(filePath) as unknown as { size?: number; mtimeMs?: number };
    } catch {
      return null;
    }
    const size = Number(stat?.size);
    const mtimeMs = Number(stat?.mtimeMs);
    if (!Number.isFinite(size) || !Number.isFinite(mtimeMs)) return scanSessionFresh(filePath);

    const cached = fileCache.get(filePath);
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached.usage;

    // Append-only fast path: parse just the new tail of a file we already read.
    if (cached && size > cached.offset) {
      try {
        const { text, consumed } = completeLines(readRange(filePath, cached.offset, size));
        const acc = { ...cached.acc };
        accumulateUsage(text, acc);
        return storeEntry(filePath, mtimeMs, size, cached.offset + consumed, acc);
      } catch { /* fall back to a full read below */ }
    }
    return scanSessionFresh(filePath, mtimeMs, size);
  }

  function projectDirs(set: { status?: number }) {
    try {
      return deps.readdirSync(deps.projectsDir).filter((d) => {
        try { return deps.statSync(deps.join(deps.projectsDir, d)).isDirectory(); } catch { return false; }
      });
    } catch {
      set.status = 500;
      return null;
    }
  }

  const api = new Elysia();

  api.get("/costs/daily", ({ query, set }) => {
    const days = Number(query.days ?? 7);
    if (isNaN(days) || days < 1 || days > 365) {
      set.status = 400;
      return { error: "days must be 1–365" };
    }

    const buckets = makeBuckets(days);
    const bucketIndex = new Map(buckets.map((b, i) => [b, i]));

    const dirs = projectDirs(set);
    if (!dirs) return { error: "Cannot read ~/.claude/projects/" };

    // agentName → { costs: number[], hadActivity: boolean[] }
    const agentDailyMap = new Map<string, { costs: number[]; hadActivity: boolean[] }>();

    for (const dir of dirs) {
      const dirPath = deps.join(deps.projectsDir, dir);
      let files: string[];
      try {
        files = deps.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
      } catch { continue; }

      if (files.length === 0) continue;
      const agentName = agentNameFromDir(dir);

      if (!agentDailyMap.has(agentName)) {
        agentDailyMap.set(agentName, {
          costs: Array(days).fill(0),
          hadActivity: Array(days).fill(false),
        });
      }

      const entry = agentDailyMap.get(agentName)!;

      for (const file of files) {
        const usage = scanSessionWithDeps(deps.join(dirPath, file));
        if (!usage || !usage.lastTimestamp) continue;

        const dateStr = localDateStr(usage.lastTimestamp);
        const idx = bucketIndex.get(dateStr);
        if (idx === undefined) continue; // outside the window

        entry.costs[idx] += estimateCost(usage);
        entry.hadActivity[idx] = true;
      }
    }

    const agents = [...agentDailyMap.entries()]
      .filter(([, d]) => d.costs.reduce((s, v) => s + v, 0) > 0)
      .map(([name, d]) => ({
        name,
        dailyCosts: d.costs,
        totalCost: d.costs.reduce((s, v) => s + v, 0),
        hadActivity: d.hadActivity,
      }))
      .sort((a, b) => b.totalCost - a.totalCost);

    const totalCost = agents.reduce((s, a) => s + a.totalCost, 0);
    return { window: days, buckets, agents, total: { cost: totalCost, agents: agents.length } };
  });

  api.get("/costs", ({ set }) => {
    const dirs = projectDirs(set);
    if (!dirs) return { error: "Cannot read ~/.claude/projects/" };

    const agents: Record<string, {
      name: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreateTokens: number;
      totalTokens: number;
      estimatedCost: number;
      sessions: number;
      turns: number;
      models: Record<string, number>;
      lastActive: string;
    }> = {};

    for (const dir of dirs) {
      const dirPath = deps.join(deps.projectsDir, dir);
      let files: string[];
      try {
        files = deps.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
      } catch { continue; }

      if (files.length === 0) continue;
      const agentName = agentNameFromDir(dir);

      if (!agents[agentName]) {
        agents[agentName] = {
          name: agentName,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          totalTokens: 0,
          estimatedCost: 0,
          sessions: 0,
          turns: 0,
          models: {},
          lastActive: "",
        };
      }

      for (const file of files) {
        const usage = scanSessionWithDeps(deps.join(dirPath, file));
        if (!usage) continue;

        const a = agents[agentName];
        a.inputTokens += usage.inputTokens;
        a.outputTokens += usage.outputTokens;
        a.cacheReadTokens += usage.cacheReadTokens;
        a.cacheCreateTokens += usage.cacheCreateTokens;
        a.totalTokens += usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreateTokens;
        a.estimatedCost += estimateCost(usage);
        a.sessions++;
        a.turns += usage.turns;

        const tier = modelTier(usage.model);
        a.models[tier] = (a.models[tier] || 0) + usage.turns;

        if (usage.lastTimestamp > a.lastActive) a.lastActive = usage.lastTimestamp;
      }
    }

    const agentList = Object.values(agents)
      .filter((a) => a.sessions > 0)
      .sort((a, b) => b.estimatedCost - a.estimatedCost);

    const total = {
      tokens: agentList.reduce((s, a) => s + a.totalTokens, 0),
      cost: agentList.reduce((s, a) => s + a.estimatedCost, 0),
      sessions: agentList.reduce((s, a) => s + a.sessions, 0),
      agents: agentList.length,
    };

    return { agents: agentList, total };
  });

  return api;
}

export const costsApi = createCostsApi();

import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createCostsApi, type CostsApiDeps } from "../src/api/costs";

const PROJECTS = "/projects";
const DIR = "-home-x-github-com-org-agent-oracle";
const FILE = `${PROJECTS}/${DIR}/session.jsonl`;

function assistant(model: string, timestamp: string, usage: Record<string, number>): string {
  return JSON.stringify({ type: "assistant", timestamp, message: { model, usage } }) + "\n";
}

/**
 * Fake projects dir whose files can grow between requests. Counts how often the
 * route reads a whole file versus a byte range, so the warm-cache fast path is
 * observable.
 */
function makeApp(content: { text: string }) {
  const reads = { full: 0, range: 0 };
  let mtimeMs = 1_000;

  const deps: CostsApiDeps = {
    projectsDir: PROJECTS,
    join: (...parts) => parts.join("/"),
    readdirSync: ((path: string) => {
      if (path === PROJECTS) return [DIR];
      return [FILE.slice(path.length + 1)];
    }) as CostsApiDeps["readdirSync"],
    readFileSync: ((_path: string) => {
      reads.full++;
      return content.text;
    }) as CostsApiDeps["readFileSync"],
    statSync: ((path: string) => {
      const isFile = path.endsWith(".jsonl");
      return {
        isDirectory: () => !isFile,
        size: Buffer.byteLength(content.text, "utf-8"),
        mtimeMs: isFile ? mtimeMs : 1,
      };
    }) as unknown as CostsApiDeps["statSync"],
    readRange: (path: string, start: number, end: number) => {
      reads.range++;
      expect(path).toBe(FILE);
      return Buffer.from(content.text, "utf-8").subarray(start, end);
    },
  };

  return { app: new Elysia().use(createCostsApi(deps)), reads, append: (line: string) => {
    content.text += line;
    mtimeMs += 1_000;
  } };
}

async function get(app: Elysia, path: string): Promise<any> {
  const res = await app.handle(new Request(`http://local${path}`));
  return res.json();
}

describe("costs warm cache", () => {
  test("unchanged files are not re-read between polls", async () => {
    const { app, reads } = makeApp({
      text: assistant("claude-sonnet-4", "2026-10-22T10:00:00.000Z", { input_tokens: 1_000_000, output_tokens: 1_000_000 }),
    });

    const first = await get(app, "/costs");
    expect(first.total.tokens).toBe(2_000_000);
    expect(reads).toEqual({ full: 1, range: 0 });

    const second = await get(app, "/costs");
    expect(second).toEqual(first);
    expect(reads).toEqual({ full: 1, range: 0 });
  });

  test("appended lines are parsed from a byte range, not a full re-read", async () => {
    const { app, reads, append } = makeApp({
      text: assistant("claude-sonnet-4", "2026-10-22T10:00:00.000Z", { input_tokens: 1_000_000, output_tokens: 1_000_000 }),
    });

    await get(app, "/costs");
    append(assistant("claude-sonnet-4", "2026-10-22T10:05:00.000Z", { input_tokens: 500_000, output_tokens: 500_000 }));

    const grown = await get(app, "/costs");
    expect(grown.total.tokens).toBe(3_000_000);
    expect(grown.total.sessions).toBe(1);
    expect(reads).toEqual({ full: 1, range: 1 });
  });

  test("a partially written trailing line is re-read instead of dropped", async () => {
    const { app, reads, append } = makeApp({
      text: assistant("claude-sonnet-4", "2026-10-22T10:00:00.000Z", { input_tokens: 1_000_000, output_tokens: 0 }),
    });

    await get(app, "/costs");

    const full = assistant("claude-sonnet-4", "2026-10-22T10:05:00.000Z", { input_tokens: 1_000_000, output_tokens: 0 });
    append(full.slice(0, 20));
    expect((await get(app, "/costs")).total.tokens).toBe(1_000_000);

    append(full.slice(20));
    expect((await get(app, "/costs")).total.tokens).toBe(2_000_000);
    expect(reads.full).toBe(1);
  });

  test("rewritten (shrunk) files fall back to a full re-read", async () => {
    const content = {
      text:
        assistant("claude-sonnet-4", "2026-10-22T10:00:00.000Z", { input_tokens: 1_000_000, output_tokens: 0 }) +
        assistant("claude-sonnet-4", "2026-10-22T10:01:00.000Z", { input_tokens: 1_000_000, output_tokens: 0 }),
    };
    const { app, reads } = makeApp(content);

    await get(app, "/costs");
    content.text = assistant("claude-sonnet-4", "2026-10-22T10:02:00.000Z", { input_tokens: 7, output_tokens: 0 });

    expect((await get(app, "/costs")).total.tokens).toBe(7);
    expect(reads.full).toBe(2);
  });

  test("/costs/daily shares the warm cache", async () => {
    const { app, reads } = makeApp({
      text: assistant("claude-sonnet-4", new Date().toISOString(), { input_tokens: 1_000_000, output_tokens: 0 }),
    });

    await get(app, "/costs");
    const daily = await get(app, "/costs/daily?days=7");
    expect(daily.total.cost).toBeCloseTo(3, 5);
    expect(reads.full).toBe(1);
  });
});

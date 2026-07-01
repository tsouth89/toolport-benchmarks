// Conduit standing-context token-savings benchmark.
//
// Measures the INPUT-token cost a model pays just to have tools AVAILABLE on
// every request, two ways:
//
//   Full mode  (baseline): the client injects the entire MCP `tools/list`
//                          (every tool's name + description + inputSchema)
//                          into context on every turn.
//   Lazy mode  (Conduit):  the client injects ONLY Conduit's lazy meta-tools.
//
// Headline metric: standing-context reduction = (full - lazy) / full, per set.
//
// Honesty caveat (see README): lazy mode adds per-search RESULT tokens when the
// model calls conduit_search_tools (the search returns a handful of tools'
// schemas as a tool RESULT). The standing reduction is the headline; the
// amortized cost depends on how many DISTINCT tools a session actually uses.
//
// Everything runs from the committed fixtures with a local, deterministic
// tokenizer (tiktoken o200k_base) - no API keys, no network.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getEncoding } from "js-tiktoken";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const FIXTURES = join(ROOT, "fixtures");
const RESULTS = join(ROOT, "results");

type Tool = { name: string; description?: string; inputSchema?: unknown };

// The catalogs to benchmark. Each is a real MCP `tools/list` captured from a
// real OpenAPI spec via conduit-openapi-mcp (see README for provenance).
const CATALOGS: { label: string; file: string; source: string }[] = [
  { label: "Stripe", file: "stripe.tools.json", source: "stripe/openapi spec3.json" },
  { label: "GitHub", file: "github.tools.json", source: "github/rest-api-description" },
  { label: "OpenAI", file: "openai.tools.json", source: "openai/openai-openapi" },
];

const LAZY_FILE = "conduit-lazy-tools.json";

const enc = getEncoding("o200k_base");

/**
 * Token cost of a tool set as a model actually pays it: the serialized JSON of
 * the tool array injected into context. We serialize the whole array once
 * (compact JSON, the wire form) so array framing is counted the same for both
 * the full catalog and the lazy meta-tools - an apples-to-apples comparison.
 */
function countTools(tools: Tool[]): number {
  // Encode with NO special-token handling: any `<|...|>` sequence that happens
  // to appear in a tool description is ordinary text here (a model tokenizing
  // tool JSON as input never interprets it as a control token). Without this,
  // js-tiktoken throws on catalogs whose text contains `<|endoftext|>`.
  // allowedSpecial=[] , disallowedSpecial=[]: no sequence is treated as a
  // special/control token, so `<|endoftext|>` is tokenized as plain text.
  return enc.encode(JSON.stringify(tools), [], []).length;
}

function loadJson<T>(file: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as T;
}

function pct(full: number, lazy: number): number {
  return ((full - lazy) / full) * 100;
}

/**
 * OPTIONAL cross-check: exact Claude token count for one tool set via the
 * Anthropic `/v1/messages/count_tokens` endpoint. Only runs if ANTHROPIC_API_KEY
 * is set; returns null (silent skip) on any missing key / network / API error so
 * the deterministic o200k_base run is never blocked. We count the serialized
 * tool JSON as a user message (same payload we tokenize locally) so the two
 * numbers are directly comparable, and the point is to show the % reduction is
 * near-invariant across tokenizers.
 */
async function claudeCount(tools: Tool[]): Promise<number | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: JSON.stringify(tools) }],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { input_tokens?: number };
    return typeof data.input_tokens === "number" ? data.input_tokens : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const lazyTools = loadJson<Tool[]>(LAZY_FILE);
  const lazyTokens = countTools(lazyTools);
  const lazyNames = lazyTools.map((t) => t.name);

  const rows = CATALOGS.filter((c) => existsSync(join(FIXTURES, c.file))).map((c) => {
    const tools = loadJson<Tool[]>(c.file);
    const fullTokens = countTools(tools);
    return {
      catalog: c.label,
      source: c.source,
      tools: tools.length,
      fullTokens,
      lazyTokens,
      reductionPct: pct(fullTokens, lazyTokens),
    };
  });

  // --- Markdown table ---
  const header =
    "| Catalog | Tools | Full tokens | Lazy tokens | Standing reduction |\n" +
    "|---|--:|--:|--:|--:|";
  const body = rows
    .map(
      (r) =>
        `| ${r.catalog} | ${r.tools} | ${r.fullTokens.toLocaleString("en-US")} | ` +
        `${r.lazyTokens.toLocaleString("en-US")} | ${r.reductionPct.toFixed(1)}% |`,
    )
    .join("\n");
  const table = `${header}\n${body}`;

  const meta = [
    `Tokenizer: tiktoken \`o200k_base\` (GPT-4o/5 family).`,
    `Lazy meta-tool set (${lazyNames.length}, the default lazy \`tools/list\`): ${lazyNames.join(", ")}.`,
    `Lazy standing cost is constant across catalogs: **${lazyTokens.toLocaleString("en-US")} tokens**.`,
  ].join("\n\n");

  const caveat =
    "> **Honesty caveat.** This is the *standing* context cost (tools always in " +
    "context). Lazy mode adds per-search result tokens when the model calls " +
    "`conduit_search_tools`, and those results return a handful of tools' schemas. " +
    "The standing reduction above is the headline; the amortized savings for a " +
    "given session depends on how many DISTINCT tools it actually uses. We report " +
    "the standing reduction and state this plainly - we do not claim the full % as " +
    "an end-to-end session saving.";

  const md =
    `# Conduit lazy-discovery: standing-context token savings\n\n` +
    `${meta}\n\n${table}\n\n${caveat}\n`;

  const out = {
    generatedBy: "conduit-benchmarks",
    tokenizer: "o200k_base",
    lazy: { names: lazyNames, tokens: lazyTokens },
    rows,
  };

  // Optional Claude cross-check on the hero (first) catalog. Silent if no key.
  let claudeNote = "";
  if (rows.length > 0) {
    const hero = CATALOGS.find((c) => c.label === rows[0].catalog)!;
    const heroFull = await claudeCount(loadJson<Tool[]>(hero.file));
    const heroLazy = await claudeCount(lazyTools);
    if (heroFull !== null && heroLazy !== null) {
      const cp = pct(heroFull, heroLazy);
      (out as Record<string, unknown>).claudeCrossCheck = {
        catalog: rows[0].catalog,
        model: "claude-sonnet-4-5",
        fullTokens: heroFull,
        lazyTokens: heroLazy,
        reductionPct: cp,
      };
      claudeNote =
        `\n**Claude cross-check (${rows[0].catalog}, count_tokens):** ` +
        `full ${heroFull.toLocaleString("en-US")} / lazy ${heroLazy.toLocaleString("en-US")} tokens ` +
        `= ${cp.toFixed(1)}% reduction - the % holds even though absolute counts differ.\n`;
    }
  }

  const finalMd = md + claudeNote;

  if (!existsSync(RESULTS)) mkdirSync(RESULTS, { recursive: true });
  writeFileSync(join(RESULTS, "benchmark.json"), JSON.stringify(out, null, 2) + "\n");
  writeFileSync(join(RESULTS, "benchmark.md"), finalMd);

  // --- console ---
  console.log("\n" + finalMd);
  console.log(`Wrote results/benchmark.json and results/benchmark.md\n`);
}

main();

#!/usr/bin/env node
/**
 * ShipScore — action skeleton (v0)
 * ---------------------------------
 * Hackathon-stage stub for the real scanner. It walks the repository,
 * detects "AI touchpoints" by filename/content heuristics, computes a
 * deterministic placeholder score across five categories, writes a job
 * summary, and posts the breakdown as a PR comment when applicable.
 *
 * The full agent (AST-based touchpoint map, 40+ heuristics, LLM review,
 * fix-PR authoring) lands during the online build phase, Sept 18-24 2026.
 * The report JSON contract below stays stable so the dashboard can
 * consume skeleton runs and real runs identically.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CATEGORIES = ['design', 'ship', 'run', 'secure', 'test'];

const SCAN_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.yaml', '.yml', '.json',
]);

const IGNORED_DIRS = new Set([
  '.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.venv', 'vendor',
]);

/** Filename signals for AI touchpoints. */
const FILE_SIGNALS = [
  /prompt/i, /llm/i, /agent/i, /openai/i, /anthropic/i, /gemini/i,
  /completion/i, /embedding/i, /tool_call/i, /mcp/i, /eval/i, /model/i,
];

/** Content signals for AI touchpoints (counted per file, capped). */
const CONTENT_SIGNALS = [
  'system prompt', 'systemPrompt', 'messages:', 'chat.completions', 'generateText',
  'tool_choice', 'function_call', 'temperature', 'max_tokens', 'api_key',
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'tools:', 'mcp',
];

/** Placeholder weights — the real engine replaces these with 40+ heuristics. */
const PLACEHOLDER_WEIGHTS = { design: 72, ship: 64, run: 58, secure: 47, test: 41 };

// ---------------------------------------------------------------------------
// Scanner (skeleton heuristics)
// ---------------------------------------------------------------------------

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return; // unreadable directory — skip
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue; // broken symlink or raced file — skip
    }
    if (st.isDirectory()) yield* walk(full);
    else yield full;
  }
}

function baseName(p) {
  return p.split(/[\\/]/).pop() ?? p;
}

function scanRepository(root) {
  const touchpoints = [];
  for (const file of walk(root)) {
    const rel = relative(root, file);
    const ext = extname(file);
    const nameHit = FILE_SIGNALS.some((re) => re.test(baseName(rel)));
    if (!nameHit && !SCAN_EXTENSIONS.has(ext)) continue;
    let contentHit = 0;
    if (SCAN_EXTENSIONS.has(ext) && statSync(file).size < 512 * 1024) {
      try {
        const text = readFileSync(file, 'utf8');
        contentHit = CONTENT_SIGNALS.reduce((n, sig) => n + (text.includes(sig) ? 1 : 0), 0);
      } catch {
        /* unreadable — skip */
      }
    }
    if (nameHit || contentHit > 0) {
      touchpoints.push({ file: rel, nameHit, contentHit });
    }
  }
  return touchpoints;
}

/** Deterministic placeholder score in [0,100] per category. */
function scoreCategories(touchpointCount, enabled) {
  return Object.fromEntries(
    CATEGORIES.filter((c) => enabled.has(c)).map((c) => {
      const raw = PLACEHOLDER_WEIGHTS[c] - Math.min(touchpointCount, 24) * 0.5;
      return [c, Math.max(0, Math.min(100, Math.round(raw)))];
    })
  );
}

function overall(scores) {
  const vals = Object.values(scores);
  return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function renderSummary(scores, total, touchpoints, threshold) {
  const rows = Object.entries(scores)
    .map(([c, s]) => {
      const filled = Math.round(s / 10);
      const tone = s >= 70 ? '\u{1F7E9}' : s >= 50 ? '\u{1F7E8}' : '\u{1F534}';
      return `| ${tone} ${cap(c)} | ${'\u2593'.repeat(filled)}${'\u2591'.repeat(10 - filled)} | ${s}/100 |`;
    })
    .join('\n');
  const verdict =
    total >= 70 ? '\u2705 **Shipping AI responsibly.**' :
    total >= 50 ? '\u26A0\uFE0F **Fixable gaps found.** Fix PRs are coming in v0.1.' :
    '\u{1F534} **High AI-era risk.** Guardrails and evals before the next merge.';

  return `## \u{1F6A8} ShipScore: **${total}/100** ${verdict}

> _Lighthouse for the AI era — how safely does this repo ship AI?_

| Category | Score | |
|---|---|---|
${rows}

<details>
<summary><strong>AI touchpoints detected (skeleton heuristic): ${touchpoints.length}</strong></summary>

${touchpoints.slice(0, 25).map((t) => `- \`${t.file}\`${t.contentHit ? ` — ${t.contentHit} signal(s)` : ''}`).join('\n') || '- none'}

</details>

${total < threshold ? `\u274C Score **${total}** is below the required threshold **${threshold}** — merge blocked.` : `Threshold: ${threshold} — passed.`}

---

<sub>ShipScore v0 skeleton · Team Dash · WeAreDevelopers Hackathon 2026 · the real AST-based engine ships Sept 18-24.</sub>
`;
}

async function postPrComment(summary) {
  const token = process.env.INPUT_GITHUB_TOKEN;
  const { GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GITHUB_EVENT_NAME } = process.env;
  if (!token || !GITHUB_EVENT_PATH || GITHUB_EVENT_NAME !== 'pull_request') return;

  try {
    const event = JSON.parse(readFileSync(GITHUB_EVENT_PATH, 'utf8'));
    const pr = event.pull_request?.number;
    if (!pr) return;
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/issues/${pr}/comments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'shipscore-action',
      },
      body: JSON.stringify({ body: summary }),
    });
    if (!res.ok) console.error(`ShipScore: PR comment failed (${res.status})`);
    else console.log(`ShipScore: posted score comment on PR #${pr}`);
  } catch (err) {
    console.error('ShipScore: PR comment skipped —', err.message);
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const enabled = new Set(
  (process.env.INPUT_CATEGORIES ?? CATEGORIES.join(','))
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((c) => CATEGORIES.includes(c))
);

const root = process.env.GITHUB_WORKSPACE ?? process.cwd();
const touchpoints = scanRepository(root);
const scores = scoreCategories(touchpoints.length, enabled);
const total = overall(scores);
const threshold = Number(process.env.INPUT_THRESHOLD ?? 0);

if (process.env.INPUT_FIX_PRS === 'true') {
  console.log('ShipScore: fix-prs requested — PR authoring ships in v0.1 (accepted, not yet active).');
}

const summary = renderSummary(scores, total, touchpoints, threshold);

// GitHub Step Summary (visible on every run, no token needed)
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) writeFileSync(summaryPath, summary, { flag: 'a' });

// JSON report artifact — stable contract for the dashboard
const report = { version: 0, overall: total, threshold, categories: scores, touchpoints: touchpoints.length };
writeFileSync(join(root, 'shipscore-report.json'), JSON.stringify(report, null, 2));

await postPrComment(summary);

// Outputs for downstream steps
console.log(`ShipScore: overall ${total}/100 across ${enabled.size} categories.`);
const ghOutput = process.env.GITHUB_OUTPUT;
if (ghOutput) {
  writeFileSync(ghOutput, `score=${total}\nreport=shipscore-report.json\n`, { flag: 'a' });
}

if (total < threshold) {
  console.error(`ShipScore: ${total} < threshold ${threshold} — failing the job.`);
  process.exit(1);
}

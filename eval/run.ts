/**
 * Offline eval/replay harness for the AI reply pipeline.
 *
 * Runs curated fixtures through the REAL triage → (generator) → (validator)
 * stages against the configured OpenRouter models, scores each with
 * deterministic assertions, prints a report, and diffs against a saved baseline
 * so prompt/code changes can be checked for regressions.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... pnpm eval                 # run all fixtures, diff vs baseline
 *   pnpm eval -- --filter price                      # only fixtures whose name includes "price"
 *   pnpm eval -- --update-baseline                   # save current results as the new baseline
 *   pnpm eval -- --json out.json                     # also write full results JSON
 *
 * Costs real tokens (it calls the live models). Keep the fixture set small.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Minimal .env loader (no dotenv dependency): populate process.env from the
// project .env for any key not already set, so `pnpm eval` works standalone.
function loadDotEnv(): void {
  const path = join(__dirname, '..', '.env');
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf-8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

import { buildStages } from './factory';
import { sampleSkincareProfile, deepMerge } from './sample-profile';
import { checkTriage, checkReply, checkValidator, extractReply, ruleIdsOf } from './assertions';
import type { Fixture, FixtureResult, Baseline, BaselineEntry } from './types';
import type { ContextPacket } from '../src/common/types/pipeline.types';

const FIXTURES_DIR = join(__dirname, 'fixtures');
const BASELINE_PATH = join(__dirname, 'baseline.json');

/**
 * Mirror the orchestrator's post-stream candidate cleanup (orchestrator.service.ts):
 * strip markdown code fences some models wrap around the output and collapse a
 * duplicated <reply> prefix, so the harness validates what would actually ship.
 */
function cleanupCandidate(candidate: string): string {
  let c = candidate.replace(/^```[^\n]*\n?/, '').replace(/\n?```\s*$/, '').trim();
  c = c.replace(/^<reply>\s*<reply>/i, '<reply>');
  if (c && !/^<reply>/i.test(c)) c = '<reply>' + c;
  // Match the orchestrator: normalize em/en dashes → hyphen before validation.
  c = c.replace(/[—–]/g, '-');
  return c;
}

function parseArgs(argv: string[]) {
  const args = { filter: '', updateBaseline: false, json: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--filter') args.filter = argv[++i] ?? '';
    else if (argv[i] === '--update-baseline') args.updateBaseline = true;
    else if (argv[i] === '--json') args.json = argv[++i] ?? '';
  }
  return args;
}

function loadFixtures(filter: string): Fixture[] {
  if (!existsSync(FIXTURES_DIR)) return [];
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(FIXTURES_DIR, f), 'utf-8')) as Fixture)
    .filter((fx) => !filter || fx.name.includes(filter));
}

function loadBaseline(): Baseline {
  return existsSync(BASELINE_PATH) ? (JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) as Baseline) : {};
}

async function runFixture(stages: ReturnType<typeof buildStages>, fx: Fixture): Promise<FixtureResult> {
  const wanted = fx.stages ?? ['triage'];
  const profile = deepMerge(sampleSkincareProfile(), fx.input.profilePatch);
  const systemPrompt = stages.compiler.compile(profile);
  const ctx: ContextPacket = {
    business_id: 'eval',
    profile,
    history: fx.input.history ?? [],
    contact_id: 'eval',
    channel: 'eval',
    systemPrompt,
  };
  const customerContext = fx.input.customerContext ?? {};
  const result: FixtureResult = { name: fx.name, ok: true, checks: [], observed: {} };

  try {
    const { triage } = await stages.triage.callTriage({
      ctx,
      message: fx.input.message,
      customerContext,
      priorAssistantLang: (fx.input.priorAssistantLang ?? null) as any,
      priorAgentQuestion: fx.input.priorAgentQuestion ?? null,
      stalledCountIncoming: fx.input.stalledCountIncoming ?? 0,
    });
    result.observed.intent_path = triage?.intent_path;
    result.observed.language = (triage as any)?.language?.detected;
    result.checks.push(...checkTriage(fx.expect.triage, triage));

    let candidate = '';
    const fixedCandidate = fx.input.candidate;
    if (fixedCandidate && !wanted.includes('generator')) {
      // Deterministic path: validate an exact candidate, skip generation.
      // Apply the same pre-validation cleanup the orchestrator does.
      candidate = cleanupCandidate(fixedCandidate);
      result.observed.reply = extractReply(candidate);
      result.checks.push(...checkReply(fx.expect.reply, result.observed.reply));
    } else if (wanted.includes('generator') || wanted.includes('validator')) {
      for await (const chunk of stages.generator.streamGenerator({
        ctx,
        message: fx.input.message,
        customerContext,
        triage,
        feedback: null,
      })) {
        if (chunk.type === 'content') candidate += chunk.text;
        else if (chunk.type === 'usage') {
          result.observed.tokensIn = (result.observed.tokensIn ?? 0) + (chunk.promptTokens ?? 0);
          result.observed.tokensOut = (result.observed.tokensOut ?? 0) + (chunk.completionTokens ?? 0);
        }
      }
      candidate = cleanupCandidate(candidate);
      const reply = extractReply(candidate);
      result.observed.reply = reply;
      result.checks.push(...checkReply(fx.expect.reply, reply));
    }

    if (wanted.includes('validator')) {
      const { verdict } = await stages.validator.callValidator({
        ctx,
        message: fx.input.message,
        customerContext,
        triage,
        candidate: candidate || `<reply>${result.observed.reply ?? ''}</reply><metadata>{}</metadata>`,
      });
      result.observed.validatorPass = verdict?.pass;
      result.observed.violationRuleIds = ruleIdsOf(verdict);
      result.checks.push(...checkValidator(fx.expect.validator, verdict));
    }
  } catch (e) {
    result.error = (e as Error).message;
  }

  result.ok = !result.error && result.checks.every((c) => c.ok);
  return result;
}

function toBaselineEntry(r: FixtureResult): BaselineEntry {
  return {
    ok: r.ok,
    intent_path: r.observed.intent_path,
    validatorPass: r.observed.validatorPass,
    violationRuleIds: r.observed.violationRuleIds,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stages = buildStages();
  if (!stages.hasKey) {
    console.error('✖ OPENROUTER_API_KEY is not set. The harness calls live models — set it and retry.');
    process.exit(2);
  }

  const fixtures = loadFixtures(args.filter);
  if (fixtures.length === 0) {
    console.error(`No fixtures found in ${FIXTURES_DIR}${args.filter ? ` matching "${args.filter}"` : ''}.`);
    process.exit(1);
  }

  console.log(`Running ${fixtures.length} fixture(s)…\n`);
  const results: FixtureResult[] = [];
  for (const fx of fixtures) {
    const r = await runFixture(stages, fx);
    results.push(r);
    const icon = r.ok ? '✓' : '✗';
    console.log(`${icon} ${r.name}${r.error ? `  [ERROR: ${r.error}]` : ''}`);
    for (const c of r.checks.filter((c) => !c.ok)) {
      console.log(`    ✗ ${c.label}  (${c.detail ?? ''})`);
    }
  }

  // Baseline diff
  const baseline = loadBaseline();
  const regressions = results.filter((r) => baseline[r.name]?.ok === true && !r.ok);
  const newlyPassing = results.filter((r) => baseline[r.name]?.ok === false && r.ok);

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} fixtures passed.`);
  if (regressions.length) console.log(`⚠ ${regressions.length} REGRESSION(S): ${regressions.map((r) => r.name).join(', ')}`);
  if (newlyPassing.length) console.log(`✓ ${newlyPassing.length} newly passing: ${newlyPassing.map((r) => r.name).join(', ')}`);

  if (args.json) {
    writeFileSync(args.json, JSON.stringify(results, null, 2));
    console.log(`Wrote full results to ${args.json}`);
  }
  if (args.updateBaseline) {
    const next: Baseline = {};
    for (const r of results) next[r.name] = toBaselineEntry(r);
    writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + '\n');
    console.log(`Updated baseline at ${BASELINE_PATH}`);
  }

  // Non-zero exit on regression so CI/pre-merge can gate on it.
  process.exit(regressions.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

import type { CheckResult, Fixture } from './types';

function get(obj: any, path: string): unknown {
  return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/** Score a fixture's triage expectations against the triage JSON. */
export function checkTriage(expect: Fixture['expect']['triage'], triage: any): CheckResult[] {
  const out: CheckResult[] = [];
  if (!expect?.fields) return out;
  for (const [path, want] of Object.entries(expect.fields)) {
    const got = get(triage, path);
    out.push({
      label: `triage.${path} === ${JSON.stringify(want)}`,
      ok: JSON.stringify(got) === JSON.stringify(want),
      detail: `got ${JSON.stringify(got)}`,
    });
  }
  return out;
}

/** Score a fixture's reply expectations against the extracted reply text. */
export function checkReply(expect: Fixture['expect']['reply'], reply: string): CheckResult[] {
  const out: CheckResult[] = [];
  if (!expect) return out;
  for (const pat of expect.matches ?? []) {
    out.push({
      label: `reply matches /${pat}/i`,
      ok: new RegExp(pat, 'i').test(reply),
      detail: `reply="${reply.slice(0, 120)}"`,
    });
  }
  for (const pat of expect.notMatches ?? []) {
    out.push({
      label: `reply does NOT match /${pat}/i`,
      ok: !new RegExp(pat, 'i').test(reply),
      detail: `reply="${reply.slice(0, 120)}"`,
    });
  }
  if (expect.maxWords != null) {
    const wc = wordCount(reply);
    out.push({ label: `reply ≤ ${expect.maxWords} words`, ok: wc <= expect.maxWords, detail: `got ${wc}` });
  }
  if (expect.minWords != null) {
    const wc = wordCount(reply);
    out.push({ label: `reply ≥ ${expect.minWords} words`, ok: wc >= expect.minWords, detail: `got ${wc}` });
  }
  return out;
}

/** Score a fixture's validator expectations against the verdict. */
export function checkValidator(expect: Fixture['expect']['validator'], verdict: any): CheckResult[] {
  const out: CheckResult[] = [];
  if (!expect) return out;
  const ruleIds: number[] = Array.isArray(verdict?.violations)
    ? verdict.violations.map((v: any) => Number(v.rule_id))
    : [];
  if (expect.pass != null) {
    out.push({ label: `validator pass === ${expect.pass}`, ok: verdict?.pass === expect.pass, detail: `got ${verdict?.pass}` });
  }
  for (const id of expect.failsRules ?? []) {
    out.push({ label: `violations include rule ${id}`, ok: ruleIds.includes(id), detail: `got [${ruleIds.join(',')}]` });
  }
  for (const id of expect.passesRules ?? []) {
    out.push({ label: `violations exclude rule ${id}`, ok: !ruleIds.includes(id), detail: `got [${ruleIds.join(',')}]` });
  }
  return out;
}

export function ruleIdsOf(verdict: any): number[] {
  return Array.isArray(verdict?.violations) ? verdict.violations.map((v: any) => Number(v.rule_id)) : [];
}

export function extractReply(candidate: string): string {
  const m = /<reply>([\s\S]*?)<\/reply>/i.exec(candidate);
  return (m ? m[1] : candidate).trim();
}

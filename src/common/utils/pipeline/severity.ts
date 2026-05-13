import type { Verdict, Violation } from '../../types/pipeline.types';

const SEVERITY_RANK: Record<string, number> = { high: 100, medium: 10, low: 1 };

export function severityScore(violations: Violation[] | undefined | null): number {
  if (!Array.isArray(violations)) return 0;
  return violations.reduce((sum, v) => sum + (SEVERITY_RANK[v?.severity] || 0), 0);
}

export function highCount(violations: Violation[] | undefined | null): number {
  if (!Array.isArray(violations)) return 0;
  return violations.filter((v) => v?.severity === 'high').length;
}

export function mediumCount(violations: Violation[] | undefined | null): number {
  if (!Array.isArray(violations)) return 0;
  return violations.filter((v) => v?.severity === 'medium').length;
}

export function verdictPasses(verdict: Verdict | null | undefined): boolean {
  if (!verdict) return false;
  if (verdict.pass === true) return true;
  if (verdict.pass === false) return false;
  return (
    highCount(verdict.violations) === 0 &&
    mediumCount(verdict.violations) < 2 &&
    verdict.metadata_valid !== false &&
    verdict.language_match !== false
  );
}

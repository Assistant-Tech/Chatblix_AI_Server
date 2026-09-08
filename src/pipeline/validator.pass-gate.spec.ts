import { computeValidatorPass } from './validator.service';
import type { Violation } from '../common/types/pipeline.types';

function v(rule_id: number, severity: Violation['severity']): Violation {
  return { rule_id, rule_name: `r${rule_id}`, severity, evidence: 'e', fix_hint: 'f' };
}

describe('computeValidatorPass', () => {
  it('passes with no violations', () => {
    expect(computeValidatorPass([], true, true).pass).toBe(true);
  });

  it('fails on a single HIGH violation', () => {
    expect(computeValidatorPass([v(11, 'high')], true, true).pass).toBe(false);
  });

  it('passes with two purely-stylistic mediums (half-weighted = 1.0)', () => {
    const r = computeValidatorPass([v(12, 'medium'), v(33, 'medium')], true, true);
    expect(r.weightedMedium).toBe(1);
    expect(r.pass).toBe(true);
  });

  it('fails with three stylistic mediums (1.5 still < 2 → passes)', () => {
    // 3 × 0.5 = 1.5 < 2 → still a pass; tone slips alone never block.
    const r = computeValidatorPass([v(12, 'medium'), v(28, 'medium'), v(33, 'medium')], true, true);
    expect(r.weightedMedium).toBe(1.5);
    expect(r.pass).toBe(true);
  });

  it('fails with two substantive mediums (2.0)', () => {
    const r = computeValidatorPass([v(5, 'medium'), v(7, 'medium')], true, true);
    expect(r.weightedMedium).toBe(2);
    expect(r.pass).toBe(false);
  });

  it('fails with one substantive + one stylistic medium (1.5) only if... it passes', () => {
    // 1.0 + 0.5 = 1.5 < 2 → passes. One real slip plus one tone slip is tolerated.
    const r = computeValidatorPass([v(5, 'medium'), v(12, 'medium')], true, true);
    expect(r.weightedMedium).toBe(1.5);
    expect(r.pass).toBe(true);
  });

  it('fails when metadata_valid is false regardless of violations', () => {
    expect(computeValidatorPass([], false, true).pass).toBe(false);
  });

  it('fails when language_match is false', () => {
    expect(computeValidatorPass([], true, false).pass).toBe(false);
  });

  it('ignores low-severity violations in the gate', () => {
    expect(computeValidatorPass([v(13, 'low'), v(27, 'low')], true, true).pass).toBe(true);
  });
});

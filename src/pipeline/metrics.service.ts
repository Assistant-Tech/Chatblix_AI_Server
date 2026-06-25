import { Injectable } from '@nestjs/common';

interface Counters {
  turn_pass_first_try: number;
  turn_pass_after_retry: number;
  turn_ship_with_violations: number;
  triage_json_parse_error: number;
  triage_self_correction_used: number;
  triage_synthesized_fallback: number;
  generator_api_error: number;
  generator_timeout: number;
  validator_api_error: number;
  validator_timeout: number;
  validator_soft_pass_on_error: number;
  tool_iteration_cap_hit: number;
  reply_tool_salvaged: number;
  violations_by_rule: Record<string, number>;
  total_turns: number;
  [key: string]: number | Record<string, number>;
}

@Injectable()
export class MetricsService {
  private readonly counters: Counters = {
    turn_pass_first_try: 0,
    turn_pass_after_retry: 0,
    turn_ship_with_violations: 0,
    triage_json_parse_error: 0,
    triage_self_correction_used: 0,
    triage_synthesized_fallback: 0,
    generator_api_error: 0,
    generator_timeout: 0,
    validator_api_error: 0,
    validator_timeout: 0,
    validator_soft_pass_on_error: 0,
    tool_iteration_cap_hit: 0,
    reply_tool_salvaged: 0,
    violations_by_rule: {},
    total_turns: 0,
  };

  bump(key: string, by = 1): void {
    if (typeof this.counters[key] === 'number') {
      (this.counters[key] as number) += by;
    }
  }

  bumpViolation(ruleId: number | string): void {
    const k = String(ruleId);
    this.counters.violations_by_rule[k] = (this.counters.violations_by_rule[k] || 0) + 1;
  }

  snapshot(): Counters {
    return JSON.parse(JSON.stringify(this.counters)) as Counters;
  }
}

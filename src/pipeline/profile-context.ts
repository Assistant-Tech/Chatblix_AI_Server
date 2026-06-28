import type { BusinessProfileDto } from '../common/types/business-profile.dto';

/**
 * Fields stripped from the BUSINESS_CONTEXT JSON that triage & validator receive
 * in their *user* payload (the uncacheable part of the request).
 *
 * Rationale: the full profile is already rendered into the per-tenant compiled
 * system prompt (see SystemPromptCompilerService), so shipping the whole JSON in
 * the user message duplicates it. These specific fields are additionally not
 * referenced by any `BUSINESS_CONTEXT.<path>` in 01_triage.md / 03_validator.md
 * and are only consumed elsewhere:
 *   - corrections    → teaching corrections, generator voice only
 *   - enabled_tools  → tool gating, resolved in tools.registry / generator only
 *   - escalation     → keyword/threshold config applied in EscalationRulesService
 *
 * Dropping them is behavior-neutral for triage/validation while removing what can
 * be the heaviest part of a profile (corrections: up to 50 × 2000 chars).
 *
 * NOTE: the larger dedup (catalog/faqs are still duplicated between the compiled
 * prompt and this JSON) is intentionally deferred to Phase 2, where it is
 * coordinated with the prompt wording and rule-18 fact-checking. See
 * docs/AI_PIPELINE_OPTIMIZATION_WORKLOG.md.
 */
const OMITTED_FIELDS = ['corrections', 'enabled_tools', 'escalation'] as const;

/**
 * Return a shallow copy of the profile with generation-only / internal fields
 * removed, for embedding as BUSINESS_CONTEXT in triage/validator user payloads.
 */
export function slimProfileForContext(
  profile: BusinessProfileDto,
): Partial<BusinessProfileDto> {
  if (!profile || typeof profile !== 'object') return profile;
  const slim: Record<string, unknown> = { ...profile };
  for (const field of OMITTED_FIELDS) {
    delete slim[field];
  }
  return slim as Partial<BusinessProfileDto>;
}

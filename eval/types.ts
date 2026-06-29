import type { BusinessProfileDto } from '../src/common/types/business-profile.dto';
import type { IncomingHistoryMessage } from '../src/common/types/pipeline.types';

/**
 * One eval case. Lives as a JSON file under eval/fixtures/. Inputs feed the real
 * pipeline stages; `expect` is scored deterministically against the outputs.
 */
export interface Fixture {
  name: string;
  description?: string;
  /** Which stages to run. Default ['triage']. Add 'generator'/'validator' for fuller (and costlier) checks. */
  stages?: Array<'triage' | 'generator' | 'validator'>;

  input: {
    message: string;
    history?: IncomingHistoryMessage[];
    customerContext?: Record<string, unknown>;
    priorAssistantLang?: string | null;
    priorAgentQuestion?: string | null;
    stalledCountIncoming?: number;
    /** Deep-merged onto the default sample profile (see sample-profile.ts). */
    profilePatch?: Record<string, unknown>;
    /**
     * A fixed `<reply>…</reply><metadata>{…}</metadata>` candidate to validate
     * directly. When set (and 'generator' is not requested), the generator is
     * skipped and the validator scores this exact candidate — deterministic and
     * cheap, ideal for pinning validator rule behavior.
     */
    candidate?: string;
  };

  expect: {
    triage?: {
      /** Exact-equality checks on top-level triage fields (dot paths allowed, e.g. "language.detected"). */
      fields?: Record<string, unknown>;
    };
    reply?: {
      /** Each regex (case-insensitive) MUST match the reply text. */
      matches?: string[];
      /** Each regex (case-insensitive) must NOT match the reply text. */
      notMatches?: string[];
      maxWords?: number;
      minWords?: number;
    };
    validator?: {
      pass?: boolean;
      /** These rule_ids MUST appear in the verdict's violations. */
      failsRules?: number[];
      /** These rule_ids must NOT appear. */
      passesRules?: number[];
    };
  };
}

export interface CheckResult {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface FixtureResult {
  name: string;
  ok: boolean;
  checks: CheckResult[];
  /** Compact snapshot of what the stages produced, for the report + baseline. */
  observed: {
    intent_path?: string;
    language?: string;
    reply?: string;
    validatorPass?: boolean;
    violationRuleIds?: number[];
    tokensIn?: number;
    tokensOut?: number;
  };
  error?: string;
}

export interface BaselineEntry {
  ok: boolean;
  intent_path?: string;
  validatorPass?: boolean;
  violationRuleIds?: number[];
}

export type Baseline = Record<string, BaselineEntry>;

export type { BusinessProfileDto };

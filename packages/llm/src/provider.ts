import type {
  ActionProposalV2,
  PlayerContextV2,
  PlayerViewV1,
  ProviderUsageV1,
  UsageV2,
} from "@werewolf/contracts";
import type { z } from "zod";

export type DecisionKind =
  | "initiative"
  | "speech"
  | "team_point"
  | "night_action"
  | "vote"
  | "narration"
  | "decision_v2"
  | "decision_v3"
  | "decision_v3_1";

export interface PreparedPrompt {
  instructions: string;
  /** Cross-player public state. When present, it follows instructions and precedes all private data. */
  publicInput?: string;
  /** Player-authorized state. This must never be shared across seats. */
  privateInput?: string;
  /** Player/turn context that is unchanged across repair and reconsideration calls. */
  sharedInput?: string;
  /** The changing episode suffix. */
  input: string;
  cache?: {mode:"explicit";ttl:"30m";stablePrefix:string;boundary?:"instructions"|"public"};
  /** Moderator-only construction diagnostics persisted with the attempt. */
  layerHashes?: {l0:string;l1:string|null;l2:string|null;l3:string;schema?:string};
}

export interface DecisionRequest<T> {
  kind: DecisionKind;
  playerId?: string;
  model: string;
  personality?: string;
  view?: PlayerViewV1;
  disclosurePacket?: Record<string, unknown>;
  schemaName: string;
  schema: z.ZodType<T>;
  maxOutputTokens: number;
  repairFeedback?: string;
  preparedPrompt?: PreparedPrompt;
  contextV2?: PlayerContextV2;
  proposalKind?: ActionProposalV2["kind"];
  commitOnly?: boolean;
  /** Isolated provider conversation used only for calls within one decision episode. */
  sessionKey?: string;
  reasoningEffort?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onUsage?: (usage: UsageV2, metadata: { provider: string; model: string; outputLimitEnforced: boolean }) => void;
  /** Persist the explicit final response before parsing so malformed output remains auditable. */
  onRawResponse?: (response: string) => void;
}

export interface DecisionResult<T> {
  data: T;
  provider: string;
  model: string;
  usage: ProviderUsageV1;
}

export interface DecisionProvider {
  decide<T>(request: DecisionRequest<T>): Promise<DecisionResult<T>>;
  releaseSession?(sessionKey: string): Promise<void> | void;
}

export interface DecisionAttempt<T> {
  result?: DecisionResult<T>;
  errors: string[];
  attempts: number;
  providerFailure: boolean;
}

export async function decideWithRepair<T>(
  provider: DecisionProvider,
  request: DecisionRequest<T>,
  validate?: (data: T) => string[],
): Promise<DecisionAttempt<T>> {
  const errors: string[] = [];
  let providerFailure = false;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await provider.decide({
        ...request,
        ...(errors.length > 0 ? { repairFeedback: errors.join("; ") } : {}),
      });
      const parsed = request.schema.safeParse(result.data);
      if (!parsed.success) {
        errors.push(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(", "));
        continue;
      }
      const domainErrors = validate?.(parsed.data) ?? [];
      if (domainErrors.length > 0) {
        errors.push(...domainErrors);
        continue;
      }
      return { result: { ...result, data: parsed.data }, errors, attempts: attempt, providerFailure: false };
    } catch (error) {
      providerFailure = true;
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { errors, attempts: 2, providerFailure };
}

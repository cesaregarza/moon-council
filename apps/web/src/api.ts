import type {
  CreateGameRequestV1,
  CreateGameV2Request,
  ExperimentSpecV1,
  ExperimentSummaryV1,
  GameEventV1,
  PrivateJournalV1,
  RoleDefinitionV1,
  StoredGameConfig,
} from "@werewolf/contracts";

export interface GameListItem {
  game: { id: string; name: string; status: string; createdAt: string; updatedAt: string };
  state: {
    phase: string;
    day: number;
    players: Array<{ id: string; name: string; alive: boolean; revealedRole?: string }>;
    winnerAlignments: string[];
  };
}

export interface ModeratorGamePayload {
  game: { id: string; name: string; status: string; config: StoredGameConfig; speedMs: number };
  state: {
    gameId: string;
    phase: string;
    day: number;
    status: string;
    players: Array<{
      id: string;
      name: string;
      alive: boolean;
      role: RoleDefinitionV1;
      revealedRole?: string;
      model?: string;
    }>;
    events: GameEventV1[];
    journals: Record<string, PrivateJournalV1>;
    winnerAlignments: string[];
    outcomeReason?: string;
    modelCalls: number;
  };
  usage: Array<{ inputTokens: number; outputTokens: number; totalTokens: number; cachedInputTokens?: number | null; cacheWriteInputTokens?: number | null; model: string; estimatedCost: number }>;
}

export type GameView = "public" | "moderator" | "player" | "team";
export interface ObserverGamePayload {
  game: { id: string; name: string; status: string; config?: StoredGameConfig; legacyReplayOnly?: boolean; createdAt?: string; updatedAt?: string; speedMs?: number };
  state: {
    gameId: string;
    phase: string;
    day: number;
    status: string;
    players: Array<{ id: string; name: string; alive: boolean; role?: RoleDefinitionV1; revealedRole?: string; model?: string }>;
    events?: GameEventV1[];
    journals?: Record<string, PrivateJournalV1 | Record<string, unknown>>;
    winnerAlignments: string[];
    outcomeReason?: string;
    modelCalls?: number;
  };
  events?: GameEventV1[];
  usage?: Array<{ inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; cachedInputTokens?: number | null; cacheWriteInputTokens?: number | null; model?: string; estimatedCost?: number }>;
  at?: number | null;
  view?: GameView;
}

export interface DecisionOpportunity {
  id: string; gameId: string; playerId: string; kind: string; phase: string; day: number; epoch: string; viewId: string;
  baseJournalVersion: number; packet?: Record<string, unknown>; status: "open" | "pending" | "committed" | "paused" | string;
  best?: Record<string, unknown> | null; recovery: number; createdAt: string;
  taskType?: string; bestSubmission?: Record<string,unknown> | null;
}
export interface DecisionAttempt {
  id: string; status: string; provider?: string; model?: string; reasoningEffort?: string; latencyMs?: number | null;
  error?: string | null; usage?: Record<string, unknown>; startedAt?: string; endedAt?: string | null;
  response?: string | null; promptVersion?: string; schemaVersion?: string;
}
export interface DecisionTurn { decisionId: string; playerId: string; turnIndex: number; recovery: number; report: Record<string, unknown>; viewId: string; }
export interface DecisionDetail { opportunity: DecisionOpportunity; attempts: DecisionAttempt[]; turns: DecisionTurn[]; events: GameEventV1[]; }

export interface ExperimentRecord {
  id: string;
  name: string;
  status: string;
  spec: ExperimentSpecV1 | { schemaVersion: "experiment_v2"; baseConfig: StoredGameConfig; runs: number; concurrency: number; name: string; baseSeed: string; pricingPerMillionTokens: Record<string, number> };
  summary?: ExperimentSummaryV1 & { completed?: number; interrupted?: number; failed?: number; budgetTruncated?: number; validOutcomeDenominator?: number };
  error?: string;
}

export interface ProviderHealth {
  ok: boolean;
  provider: "fake" | "openai" | "codex";
  providerReady: boolean;
  liveModelConfigured: boolean;
  authentication: "none" | "api_key" | "codex_login";
  statusDetail: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message ?? body.error ?? `Request failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  health: () => request<ProviderHealth>("/api/v1/health"),
  roles: () => request<RoleDefinitionV1[]>("/api/v1/roles"),
  createRole: (role: unknown) =>
    request<RoleDefinitionV1>("/api/v1/roles", { method: "POST", body: JSON.stringify(role) }),
  games: () => request<GameListItem[]>("/api/v1/games"),
  game: (id: string, options: { view?: GameView; playerId?: string; teamId?: string; at?: number | null } = {}) => {
    const query = new URLSearchParams({ view: options.view ?? "public" });
    if (options.playerId) query.set("playerId", options.playerId);
    if (options.teamId) query.set("teamId", options.teamId);
    if (options.at !== undefined && options.at !== null) query.set("at", String(options.at));
    return request<ObserverGamePayload>(`/api/v1/games/${id}?${query.toString()}`);
  },
  createGame: (input: CreateGameRequestV1 | CreateGameV2Request) =>
    request<ModeratorGamePayload>("/api/v1/games", { method: "POST", body: JSON.stringify(input) }),
  control: (id: string, body: Record<string, unknown>) =>
    request<{ ok: boolean; status: string }>(`/api/v1/games/${id}/control`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  experiments: () => request<ExperimentRecord[]>("/api/v1/experiments"),
  controlExperiment:(id:string,action:"pause"|"resume")=>request<{ok:boolean;status:string}>(`/api/v1/experiments/${id}/control`,{method:"POST",body:JSON.stringify({action})}),
  createExperiment: (spec: ExperimentSpecV1 | Record<string, unknown>) =>
    request<ExperimentRecord>("/api/v1/experiments", { method: "POST", body: JSON.stringify(spec) }),
  decisions: (id: string, options: { view: "moderator" | "player"; playerId?: string; at?: number | null }) => {
    const query = new URLSearchParams({ view: options.view });
    if (options.playerId) query.set("playerId", options.playerId);
    if (options.at !== undefined && options.at !== null) query.set("at", String(options.at));
    return request<DecisionOpportunity[]>(`/api/v1/games/${id}/decisions?${query.toString()}`);
  },
  decision: (id: string, decisionId: string, options: { view: "moderator" | "player"; playerId?: string; at?: number | null }) => {
    const query = new URLSearchParams({ view: options.view });
    if (options.playerId) query.set("playerId", options.playerId);
    if (options.at !== undefined && options.at !== null) query.set("at", String(options.at));
    return request<DecisionDetail>(`/api/v1/games/${id}/decisions/${decisionId}?${query.toString()}`);
  },
};

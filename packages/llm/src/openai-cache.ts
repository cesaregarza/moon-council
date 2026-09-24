import { createHash } from "node:crypto";
import type { ResponseCreateParamsNonStreaming, ResponseInput } from "openai/resources/responses/responses";
import { providerJsonSchema } from "@werewolf/contracts";
import { promptFor } from "./prompt";
import type { DecisionRequest, PreparedPrompt } from "./provider";

export function supportsExplicitPromptCaching(model: string): boolean {
  const match = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/.exec(model);
  return Boolean(match && (Number(match[1]) > 5 || Number(match[1]) === 5 && Number(match[2] ?? 0) >= 6));
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const message = (role: "developer" | "user", text: string, cache = false) => ({
  role,
  content: [{ type: "input_text" as const, text, ...(cache ? { prompt_cache_breakpoint: { mode: "explicit" as const } } : {}) }],
});

const REFERENCE_MARKER = "\n\nFROZEN PUBLIC GAME REFERENCE (data):\n";
const DURABLE_EVENTS = new Set(["vote.resolved", "player.eliminated", "role.revealed", "moderator.announcement", "game.ended"]);

/** Four write slots: behavior/schema, frozen rules, durable public outcomes, current public view. */
function cachedInput(prompt: PreparedPrompt, formatInstructions = ""): ResponseInput {
  const split=prompt.instructions.indexOf(REFERENCE_MARKER);
  const behavior=split<0?prompt.instructions:prompt.instructions.slice(0,split);
  const rules=split<0?null:prompt.instructions.slice(split);
  const input:ResponseInput=[message("developer",behavior+(formatInstructions?`\n\n${formatInstructions}`:""),true)];
  if(rules)input.push(message("developer",rules,true));
  if(prompt.publicInput) {
    let state:Record<string,unknown>|undefined;
    try {
      const parsed=JSON.parse(prompt.publicInput);
      if(parsed && Object.keys(parsed).length===1 && ["agent_v3_1","agent_v3_2"].includes(parsed.PUBLIC_GAME_STATE?.protocolVersion) && Array.isArray(parsed.PUBLIC_GAME_STATE?.evidence)) state=parsed.PUBLIC_GAME_STATE;
    } catch { /* Legacy free-text public context remains intact. */ }
    const cachePublic=prompt.cache?.boundary!=="instructions";
    if(state && cachePublic) {
      const {evidence,...current}=state;
      const records=evidence as Array<{type:string}>;
      // These outcomes are pinned by both context builders, unlike the rolling speech window.
      input.push(message("user",JSON.stringify({DURABLE_PUBLIC_EVIDENCE:records.filter(r=>DURABLE_EVENTS.has(r.type))}),true));
      input.push(message("user",JSON.stringify({PUBLIC_GAME_STATE:{...current,evidence:records.filter(r=>!DURABLE_EVENTS.has(r.type))}}),true));
    } else input.push(message("user",prompt.publicInput,cachePublic));
  }
  if(prompt.privateInput)input.push(message("user",prompt.privateInput));
  if(prompt.sharedInput)input.push(message("user",prompt.sharedInput,!prompt.publicInput&&prompt.cache?.boundary!=="instructions"));
  input.push(message("user",prompt.input));
  return input;
}

/** One serializer for live calls, replay inspection, and the cache probe. */
export function openAIRequest<T>(request: DecisionRequest<T>, comparisonResponseId?: string): ResponseCreateParamsNonStreaming {
  const prompt = promptFor(request);
  const explicit = Boolean(prompt.cache) && supportsExplicitPromptCaching(request.model);
  const key = prompt.cache && (request.gameId
    ? `moon-council:${hash(`${request.gameId}:${prompt.cache.stablePrefix}`).slice(0,40)}`
    : prompt.cache.stablePrefix);
  return {
    model: request.model,
    store: false,
    service_tier: "default",
    truncation: "disabled",
    ...(explicit ? {
      input: cachedInput(prompt, request.apiResponseFormat?.instructions),
      prompt_cache_key: key,
      prompt_cache_options: { mode: "explicit" as const, ttl: prompt.cache!.ttl, ...(comparisonResponseId ? { comparison_response_id: comparisonResponseId } : {}) },
    } : {
      instructions: prompt.instructions + (request.apiResponseFormat ? `\n\n${request.apiResponseFormat.instructions}` : ""),
      input: [prompt.publicInput, prompt.privateInput, prompt.sharedInput, prompt.input].filter(Boolean).join("\n"),
      ...(key ? { prompt_cache_key: key } : {}),
    }),
    ...(request.maxOutputTokens === null ? {} : { max_output_tokens: request.maxOutputTokens }),
    ...(request.reasoningEffort ? { reasoning: { effort: request.reasoningEffort as NonNullable<ResponseCreateParamsNonStreaming["reasoning"]>["effort"] } } : {}),
    text: { format: { type: "json_schema", name: request.apiResponseFormat?.name ?? request.schemaName, strict: true, schema: providerJsonSchema(request.apiResponseFormat?.schema ?? request.schema) as Record<string, unknown> } },
  };
}

/** Comparisons are diagnostic only; they never supply conversation history or model output. */
export function cacheComparisonGroup<T>(request: DecisionRequest<T>, body: ResponseCreateParamsNonStreaming): string | null {
  if (!body.prompt_cache_options || !request.gameId) return null;
  return hash(JSON.stringify([request.gameId, body.model, body.prompt_cache_key, body.text, body.reasoning, body.service_tier]));
}

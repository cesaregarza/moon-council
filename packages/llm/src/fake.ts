import {
  InitiativeDecisionSchema,
  NightActionDecisionSchema,
  SpeechDecisionSchema,
  TeamPointDecisionSchema,
  VoteDecisionSchema,
  type ActionProposalV2,
  type ContextSourceV2,
  type DecisionReportV2,
  type PrivateJournalV1,
  type PlayerContextV2,
} from "@werewolf/contracts";
import { hashSeed } from "@werewolf/engine";
import type { z } from "zod";
import type { DecisionProvider, DecisionRequest, DecisionResult } from "./provider";

type Initiative = z.infer<typeof InitiativeDecisionSchema>;
type Speech = z.infer<typeof SpeechDecisionSchema>;
type TeamPoint = z.infer<typeof TeamPointDecisionSchema>;
type NightAction = z.infer<typeof NightActionDecisionSchema>;
type Vote = z.infer<typeof VoteDecisionSchema>;

function v2Candidates(context: PlayerContextV2, kind: ActionProposalV2["kind"]): string[] {
  const allies = new Set(context.knownAllies.map((player) => player.id));
  const legal = context.legalTargets.length > 0 ? context.legalTargets : context.players.filter((player) => player.alive).map((player) => player.id);
  return [...new Set(legal)]
    .filter((id) => id !== context.self.id && (kind !== "team_point" || !allies.has(id)))
    .sort()
    .slice(0, 16);
}

function sourceText(source: ContextSourceV2): string {
  try {
    return JSON.stringify(source.data);
  } catch {
    return "";
  }
}

function evidenceTarget(context: PlayerContextV2, candidates: string[]): { targetId?: string; source?: ContextSourceV2 } {
  for (const source of [...context.sources].reverse()) {
    if (source.type === "team.point" && typeof source.data.targetId === "string" && candidates.includes(source.data.targetId)) return { targetId:source.data.targetId,source };
    if (source.type === "inspection.delivered" && source.data.result === "werewolf" && typeof source.data.targetId === "string" && candidates.includes(source.data.targetId)) return { targetId:source.data.targetId,source };
    if (source.type === "speech.public") {
      const acts=source.data.acts as {kind:string;targetId:string|null;claim:string}[] ?? [];
      const claim=acts.find(a=>a.kind === "result_claim" && a.claim.includes("werewolf") && a.targetId && candidates.includes(a.targetId));
      if(claim?.targetId) return {targetId:claim.targetId,source};
    }
  }
  return {};
}

function targetChoice(context: PlayerContextV2, kind: ActionProposalV2["kind"], ids?: string[]): { mode: "direct" | "uniform"; playerIds: string[] } | null {
  const available = ids
    ? [...new Set(ids)].filter((id) => context.legalTargets.length === 0 || context.legalTargets.includes(id))
    : v2Candidates(context, kind);
  const candidates = available
    .filter((id) => (kind === "night_action" || id !== context.self.id) && (kind !== "team_point" || !context.knownAllies.some((ally) => ally.id === id)))
    .sort()
    .slice(0, 16);
  if (candidates.length === 0) return null;
  const evidence = evidenceTarget(context, candidates);
  return evidence.targetId ? { mode: "direct", playerIds: [evidence.targetId] } : { mode: "uniform", playerIds: candidates };
}

function seerSpeech(context: PlayerContextV2): { speech: { text: string; acts: [{ kind: "result_claim"; targetId: string; claim: string; sourceId: string | null }]; respondsTo: string[] } | null; source?: ContextSourceV2 } {
  if (context.self.role.id !== "seer") return { speech: null };
  for (const source of context.sources) {
    if (source.id.length === 0 || source.id.length > 120) continue;
    if (source.type !== "inspection.delivered" || source.scope !== "player") continue;
    const data = source.data;
    const targetId = typeof data.targetId === "string" ? data.targetId : undefined;
    const result = [data.alignment, data.result, data.role].find((value): value is string => typeof value === "string");
    if (!targetId || !result || !context.players.some((player) => player.id === targetId)) continue;
    const targetName = context.players.find((player) => player.id === targetId)?.name ?? targetId;
    const claim = `I inspected ${targetName}: ${result}.`;
    return {
      speech: { text: claim, acts: [{ kind: "result_claim", targetId, claim, sourceId: source.id }], respondsTo: [] },
      source,
    };
  }
  return { speech: null };
}

function fakeV2Report(request: DecisionRequest<unknown>): DecisionReportV2 {
  const context = request.contextV2;
  const kind = request.proposalKind ?? "pass";
  if (!context) {
    return {
      observations: [],
      inferences: [],
      alternatives: [{ id: "pass", description: "Pass because no authorized context was supplied.", advantage: "Preserves legal play.", drawback: "Produces no new information." }],
      selectedAlternativeId: "pass",
      proposal: { kind: "pass", reason: "No authorized context was supplied." },
      confidence: 0.5,
      summary: "No authorized context was supplied; pass safely.",
      journalPatch: [],
      control: { kind: "commit", question: null, reason: null },
    };
  }

  const observations = context.sources
    .map((source) => source.id)
    .filter((id) => id.length > 0 && id.length <= 120)
    .slice(0, 6);
  const seer = seerSpeech(context);
  let proposal: ActionProposalV2;
  let selectedAlternativeId = "uniform";
  if (kind === "discussion") {
    const speech = context.closing ? {text:"I dispute the existing case; uncertainty is not evidence of alignment.",acts:context.responseDocket.slice(0,1).map(sourceId=>({kind:"reply" as const,targetId:null,claim:"Please distinguish an uncertain inference from a verified result.",sourceId})),respondsTo:context.responseDocket.slice(0,6)} : seer.speech ?? ({
      text: "I do not have a decisive authorized result yet; compare the claims carefully.",
      acts: [],
      respondsTo: [],
    });
    proposal = {
      kind: "discussion",
      speech,
      ready: context.closing,
      interests: speech ? ["claims"] : [],
      silenceCase: speech ? null : { speechAlternative: "Stay quiet and preserve information.", advantage: "Avoids unsupported claims." },
    };
    selectedAlternativeId = speech ? "speak" : "silence";
  } else if (kind === "night_action") {
    const action = context.legalActions[0];
    const targets = action ? targetChoice(context, kind, action.targets) : null;
    if (!action || !targets) {
      proposal = { kind: "pass", reason: "No legal night action with an available target." };
      selectedAlternativeId = "pass";
    } else {
      proposal = { kind, actionId: action.actionId, targets };
      selectedAlternativeId = targets.mode === "direct" ? "direct" : "uniform";
    }
  } else if (kind === "team_point") {
    const targets = targetChoice(context, kind);
    if (!targets) {
      proposal = { kind: "pass", reason: "No eligible team target is available." };
      selectedAlternativeId = "pass";
    } else {
      proposal = { kind, targets };
      selectedAlternativeId = targets.mode === "direct" ? "direct" : "uniform";
    }
  } else if (kind === "vote") {
    const targets = targetChoice(context, kind);
    proposal = { kind, targets };
    selectedAlternativeId = targets ? (targets.mode === "direct" ? "direct" : "uniform") : "abstain";
  } else {
    proposal = { kind: "pass", reason: "Unsupported proposal kind; pass safely." };
    selectedAlternativeId = "pass";
  }

  const alternatives = proposal.kind === "pass"
    ? [{ id: "pass", description: "Pass safely.", advantage: "Remains within the legal action set.", drawback: "Gives up an opportunity to act." }]
    : proposal.kind === "discussion"
      ? [
          { id: "speak", description: "Make a concise authorized public statement.", advantage: "Adds accountable evidence to the discussion.", drawback: "May reveal my information strategy." },
          { id: "silence", description: "Stay quiet and compare claims.", advantage: "Preserves uncertainty and information.", drawback: "Contributes less public evidence." },
        ]
      : [
          { id: "direct", description: "Choose the target supported by authorized evidence.", advantage: "Acts on a concrete clue.", drawback: "The clue may be incomplete." },
          { id: "uniform", description: "Choose uniformly among legal targets.", advantage: "Avoids inventing unsupported certainty.", drawback: "May miss a strong but unrecognized clue." },
        ];
  const journalPatch = [
    {
      op: "set_strategy" as const,
      strategy: context.journal.strategy || "Compare authorized claims and preserve uncertainty where evidence is absent.",
      goals: context.journal.goals.slice(0, 4),
    },
    ...(seer.source ? [{ op: "set_questions" as const, questions: [`Will ${seer.source.id} change the public case?`] }] : []),
  ];
  const listenerAuction=kind==="discussion"&&context.rules.speakerSelection==="listener_auction";
  const speakerIntent=listenerAuction?{
    wantsToSpeak:Boolean(proposal.kind==="discussion"&&proposal.speech),
    urge:proposal.kind==="discussion"&&proposal.speech?((hashSeed(`${context.self.id}:${context.day}:${context.sources.at(-1)?.id??"initial"}`)%81)+20)/100:0,
    willingnessToListen:context.players.filter(player=>player.alive&&player.id!==context.self.id).map(player=>({playerId:player.id,willingness:((hashSeed(`${context.self.id}:listen:${player.id}:${context.day}`)%81)+20)/100})),
  }:undefined;
  return {
    observations,
    inferences: [],
    alternatives,
    selectedAlternativeId,
    proposal,
    confidence: seer.source ? 0.84 : 0.5,
    summary: seer.speech?.text ?? (proposal.kind === "pass" ? proposal.reason : "Use only authorized evidence and legal targets."),
    journalPatch,
    control: { kind: request.commitOnly ? "commit" : context.closing ? "commit" : "continue", question: context.closing ? null : `Compare ${alternatives[0]!.id} versus ${alternatives[1]?.id ?? alternatives[0]!.id}: does the current evidence justify the narrower choice?`, reason: context.closing ? null : "compare_alternative" },
    ...(speakerIntent?{speakerIntent}:{}),
  };
}

function fakeV3Submission(request:DecisionRequest<unknown>):unknown {
  const context=request.contextV2!;
  const legacy=JSON.parse(request.preparedPrompt?.sharedInput??"{}").AUTHORIZED_PLAYER_BRIEFING as {task:Record<string,unknown>;legalChoices?:Record<string,{playerId:string;name:string}>;view:{responseDocket:string[]}}|undefined;
  const privateState=JSON.parse(request.preparedPrompt?.privateInput??"{}").AUTHORIZED_PRIVATE_STATE as {legalChoices?:Record<string,{playerId:string;name:string}>;responseDocket?:string[]}|undefined;
  const episode=JSON.parse(request.preparedPrompt?.input??"{}").REQUEST as {task?:Record<string,unknown>}|undefined;
  const briefing=legacy??{task:episode?.task??{},legalChoices:privateState?.legalChoices,view:{responseDocket:privateState?.responseDocket??[]}};
  const task=briefing.task;
  const memory={beliefs:[],hypotheses:[],strategyUpdate:null,questionsUpdate:null,deceptionUpdate:null};
  const stable=request.kind==="decision_v3_1";
  const listen=Object.fromEntries(context.players.filter(player=>stable||player.alive&&player.id!==context.self.id).map(player=>[player.id,player.id===context.self.id||!player.alive?null:((hashSeed(`${context.self.id}:listen:${player.id}:${context.day}`)%81)+20)/100]));
  if(task.type==="discussion_bid"){
    const target=context.players.find(player=>player.alive&&player.id!==context.self.id)?.id??null;
    return {urge:((hashSeed(`${context.self.id}:${context.day}:${context.sources.at(-1)?.id??"initial"}`)%61)+40)/100,ready:context.sources.filter(source=>source.type==="speech.public").length>=4,plan:{kind:"challenge",targetId:target,respondsTo:[],point:"Ask for one specific read that distinguishes the leading possibilities."},listen,memory,rationale:"A specific question can create a useful public commitment."};
  }
  if(task.type==="discussion_listen")return {ready:context.sources.filter(source=>source.type==="speech.public").length>=4,listen,memory,rationale:"I am listening for claims that distinguish alignments."};
  if(task.type==="discussion_speech"){
    const plan=task.plan as {kind:"accusation"|"challenge"|"role_claim"|"result_claim"|"reply";targetId:string|null;respondsTo:string[];point:string};
    const name=context.players.find(player=>player.id===plan.targetId)?.name??plan.targetId??"the table";
    return {text:`${name}, ${plan.point}`,acts:[{kind:plan.kind,targetId:plan.targetId,claim:plan.point,evidence:plan.respondsTo[0]??null}],respondsTo:plan.respondsTo,rationale:"This follows the selected contribution plan.",memory};
  }
  if(task.type==="closing_response"){
    const ref=briefing.view.responseDocket[0];
    return ref?{text:"I dispute the current case; please separate tentative inference from verified fact.",acts:[{kind:"reply",targetId:null,claim:"The accusation remains uncertain.",evidence:ref}],respondsTo:[ref],rationale:"Answer the frozen accusation before voting.",memory}:{text:null,acts:[],respondsTo:[],rationale:"No response obligation remains.",memory};
  }
  const handles=Object.keys(briefing.legalChoices??{}).sort();
  const chosen=handles.length?handles[hashSeed(`${context.self.id}:${context.day}:${String(task.type)}`)%handles.length]!:undefined;
  return {mode:chosen?"direct":task.type==="vote_choice"?"abstain":"direct",choiceHandles:chosen?[chosen]:[],rationale:"Choose one current legal option using the authorized view.",evidence:[],memory,reconsiderationQuestion:null};
}

function journal(request: DecisionRequest<unknown>, targetId?: string): PrivateJournalV1 {
  const existing = request.view?.journal ?? { beliefs: [], goals: [], strategy: "", unresolvedQuestions: [] };
  const beliefs = targetId
    ? [
        ...existing.beliefs.filter((belief) => belief.playerId !== targetId),
        { playerId: targetId, suspicion: 0.62, note: "Current deterministic test focus." },
      ].slice(-12)
    : existing.beliefs;
  return {
    beliefs,
    goals: [`Help ${request.view?.self.role.alignment ?? "my side"} reach its win condition.`],
    strategy: "Track claims, pressure inconsistencies, and keep my role information compartmentalized.",
    unresolvedQuestions: targetId ? [`Is ${targetId} coordinating with another player?`] : [],
  };
}

function candidates(request: DecisionRequest<unknown>): string[] {
  const view = request.view;
  if (!view) return [];
  const allies = new Set(view.knownAllies.map((player) => player.id));
  return view.players
    .filter((player) => player.alive && player.id !== view.self.id && !allies.has(player.id))
    .map((player) => player.id)
    .sort();
}

function choose(request: DecisionRequest<unknown>, values: string[]): string | undefined {
  if (values.length === 0) return undefined;
  const offset = hashSeed(`${request.view?.gameId}:${request.view?.day}:${request.playerId}:${request.kind}`) % values.length;
  return values[offset];
}

export class FakeDecisionProvider implements DecisionProvider {
  async decide<T>(request: DecisionRequest<T>): Promise<DecisionResult<T>> {
    if(request.kind==="decision_v3"||request.kind==="decision_v3_1"){
      const data=request.schema.parse(fakeV3Submission(request as DecisionRequest<unknown>));
      const usage={inputTokens:0,outputTokens:0,totalTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningTokens:0};
      request.onUsage?.(usage,{provider:"fake",model:request.model,outputLimitEnforced:true});request.onRawResponse?.(JSON.stringify(data));
      return {data:data as T,provider:"fake",model:request.model,usage:{inputTokens:0,outputTokens:0,totalTokens:0}};
    }
    if (request.kind === "decision_v2") {
      const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: 0 };
      request.onUsage?.(usage, { provider: "fake", model: request.model, outputLimitEnforced: true });
      request.onRawResponse?.(JSON.stringify(fakeV2Report(request as DecisionRequest<unknown>)));
      return {
        data: request.schema.parse(fakeV2Report(request as DecisionRequest<unknown>)),
        provider: "fake",
        model: request.model,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    }
    const choices = candidates(request);
    const target = choose(request, choices);
    let data: Initiative | Speech | TeamPoint | NightAction | Vote | { text: string };
    switch (request.kind) {
      case "initiative": {
        const transcriptLength = request.view?.publicEvents.filter((event) => event.type === "message.public").length ?? 0;
        const wantsToSpeak = (hashSeed(`${request.playerId}:${transcriptLength}`) + transcriptLength) % 3 === 0;
        data = {
          kind: "initiative",
          intent: wantsToSpeak ? "speak" : transcriptLength > 2 ? "ready_to_vote" : "pass",
          urgency: wantsToSpeak ? "medium" : "low",
          replyToEventId: null,
          topic: target ? `Question ${target}'s recent position.` : null,
          journal: journal(request, target),
        };
        break;
      }
      case "speech":
        data = {
          kind: "speech",
          text: target
            ? `I want to hear more from ${request.view?.players.find((player) => player.id === target)?.name ?? target}. Their position feels under-explained.`
            : "I do not have a strong accusation yet; compare claims carefully before voting.",
          replyToEventId: null,
          journal: journal(request, target),
        };
        break;
      case "team_point": {
        const priorPoint = [...(request.view?.teamEvents ?? [])]
          .reverse()
          .find((event) => event.type === "team.pointed")?.payload.targetId;
        const pointTarget = typeof priorPoint === "string" && choices.includes(priorPoint) ? priorPoint : target;
        data = {
          kind: "team_point",
          targetId: pointTarget ?? "",
          journal: journal(request, pointTarget),
        };
        break;
      }
      case "night_action": {
        const action = request.view?.availableActions[0];
        let actionTarget = target;
        if (action?.target.allowSelf && action.effect === "protect") actionTarget = request.view?.self.id;
        data = {
          kind: "night_action",
          actionId: action?.id ?? "pass",
          targetIds: action && actionTarget ? [actionTarget] : [],
          journal: journal(request, actionTarget),
        };
        break;
      }
      case "vote":
        data = { kind: "vote", targetId: target ?? null, journal: journal(request, target) };
        break;
      case "narration":
        data = { text: `The moderator announces: ${JSON.stringify(request.disclosurePacket ?? {})}` };
        break;
    }
    const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: 0 };
    request.onUsage?.(usage, { provider: "fake", model: request.model, outputLimitEnforced: true });
    request.onRawResponse?.(JSON.stringify(data));
    return {
      data: request.schema.parse(data),
      provider: "fake",
      model: request.model,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
  }
}

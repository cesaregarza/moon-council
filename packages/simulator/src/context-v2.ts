import { journalEvidenceRevision } from "./player-brief";
import { createHash } from "node:crypto";
import { PrivateJournalV2Schema, type ActionProposalV2, type ContextSourceV2, type DecisionReportV2, type DecisionReportWithSpeakerIntentV1, type GameEventV1, type PlayerContextV2, type PrivateJournalV2 } from "@werewolf/contracts";
import { shuffled, validateNightAction, type GameState } from "@werewolf/engine";
import { decisionRequestV2, estimatedTokens } from "./request-v2";
import { isDemotable, tierPayload, type DeliveryTier } from "./evidence-tiers";
import { journalText, journalTokens } from "./freeform-journal";
export { estimatedTokens } from "./request-v2";

export class ContextLimitError extends Error {}
export const contentHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const publicFields: Record<string, string[]> = {
  "speech.public": ["playerId", "playerName", "text", "acts", "respondsTo", "closing"],
  "player.eliminated": ["playerId", "playerName", "roleName", "cause"],
  "role.revealed": ["playerId", "playerName", "roleName"],
  "vote.resolved": ["ballots", "tally", "tied", "targetId", "targetName"],
  "moderator.announcement": ["text"],
  "phase.changed": ["from", "to"],
  "game.ended": ["winnerAlignments", "winnerPlayerIds", "reason"],
};
export function publicPayload(event: GameEventV1): Record<string, unknown> {
  return Object.fromEntries((publicFields[event.type] ?? []).filter(key => event.payload[key] !== undefined).map(key => [key, event.payload[key]]));
}
/**
 * A phase transition cannot support or refute any claim, yet under V3.1 it consumed an
 * `E` number and public budget on every change. V3.2 drops it from the citable ledger.
 * Gated on the protocol rather than a config flag, because removing a record renumbers
 * every handle after it and would invalidate citations recorded under the old numbering.
 */
export function isLedgerProtocol(state: GameState): boolean {
  return state.config.schemaVersion === "game_config_v2" && state.config.protocolVersion === "agent_v3_2";
}
function citableFields(state: GameState): Record<string, string[]> {
  const protocol = state.config.schemaVersion === "game_config_v2" ? state.config.protocolVersion : "";
  if (protocol !== "agent_v3_2") return publicFields;
  return Object.fromEntries(Object.entries(publicFields).filter(([type]) => type !== "phase.changed"));
}
export function authorizedSources(state: GameState, events: GameEventV1[], playerId: string): ContextSourceV2[] {
  const self = state.players.find(p => p.id === playerId)!;
  const fields = citableFields(state);
  const sources: ContextSourceV2[] = [];
  let publicIndex = 0;
  // R1 is the synthetic authorized.self record added by buildContextV2.
  let privateIndex = 1;
  for (const event of events) {
    let scope: ContextSourceV2["scope"] = "public";
    let data: Record<string, unknown> | undefined;
    let sourcePublicIndex: number | undefined;
    let sourcePrivateIndex: number | undefined;
    if (event.visibility === "public" && fields[event.type]) {
      publicIndex += 1;
      sourcePublicIndex = publicIndex;
      data = publicPayload(event);
    }
    if (event.visibility === "player" && event.audienceIds.includes(playerId) && event.type === "inspection.delivered") {
      privateIndex += 1;
      sourcePrivateIndex = privateIndex;
      scope = "player"; data = Object.fromEntries(["actorId", "targetId", "targetName", "result"].map(k => [k, event.payload[k]]));
    }
    if (event.visibility === "team" && self.role.knowledge.includes("team_channel") && event.audienceIds.includes(playerId) && event.type === "team.point") {
      privateIndex += 1;
      sourcePrivateIndex = privateIndex;
      // Team pointing is visible only during the current night, but its index is
      // never reused after the source leaves the active briefing.
      if (event.day === state.day) {
        scope = "team"; data = { playerId: event.payload.playerId, targetId: event.payload.targetId };
      } else if (isLedgerProtocol(state)) {
        // A wolf that cited its own pointing keeps that citation resolvable after the
        // round closes. The content is withheld, not the reference: V3.1 dropped the
        // record entirely, which silently stripped the provenance behind the belief.
        scope = "team"; data = {};
      }
    }
    if (data) sources.push({
      id: event.id, type: event.type, day: event.day, scope, data,
      ...(sourcePublicIndex === undefined ? {} : { publicIndex: sourcePublicIndex }),
      ...(sourcePrivateIndex === undefined ? {} : { privateIndex: sourcePrivateIndex }),
    });
  }
  return sources;
}
export function buildContextV2(state: GameState, events: GameEventV1[], playerId: string, journal: PrivateJournalV2, opportunityKey: string, kind: ActionProposalV2["kind"], docket: string[] = [], closing = false, requestSizer?: (packet:PlayerContextV2)=>number, requiredSources: string[] = []): PlayerContextV2 {
  if (state.config.schemaVersion !== "game_config_v2") throw new Error("V2 context requires V2 game");
  const config = state.config;
  const self = state.players.find(p => p.id === playerId)!;
  const salt = `${config.seed}:presentation:${playerId}:${state.day}:${state.phase}:${opportunityKey}`;
  const knownAllies = self.role.knowledge.includes("alignment_team") ? state.players.filter(p => p.id !== playerId && p.role.alignment === self.role.alignment).map(p => ({ id: p.id, name: p.name })) : [];
  const legalActions = self.role.actions.filter(a => kind === "team_point" ? a.teamAggregation !== "none" && a.effect === "eliminate" : a.teamAggregation === "none").map(action => ({
    actionId: action.id, min: action.target.min, max: action.target.max,
    targets: shuffled(state.players.filter(p => validateNightAction(state, { actorId: playerId, actionId: action.id, targetIds: [p.id] }, { forTeamPoint: kind === "team_point" }).length === 0).map(p => p.id), `${salt}:targets:${action.id}`),
  }));
  const roleCounts: Record<string, number> = {};
  for (const role of [...config.roleDeck].sort((a,b) => a.name.localeCompare(b.name))) roleCounts[role.name] = (roleCounts[role.name] ?? 0) + 1;
  const packet: PlayerContextV2 = {
    schemaVersion: "player_context_v2", phase: state.phase, day: state.day,
    self: { id: self.id, name: self.name, personality: self.personality, role: self.role },
    players: shuffled(state.players.map(p => ({ id: p.id, name: p.name, alive: p.alive, ...(p.revealedRole ? { revealedRole: p.revealedRole } : {}) })), `${salt}:roster`),
    knownAllies: shuffled(knownAllies, `${salt}:allies`),
    rules: { preset: config.preset, roleCounts, firstCycle:config.rules.firstCycle,deathRevealsRole: config.revealRolesOnDeath, tieEliminatesNobody: true, sealedBallots: true, factionObjective: self.role.alignment, wolfVictory: "living parity", villageVictory: "all wolves eliminated", doctor: "Self-protection allowed; cannot repeat the preceding night's selected target, even if blocked.", pack: "Point only. All living wolves must agree within 3 times living wolves committed pointing opportunities. Any unblocked consenting wolf executes the attack; protection still applies.", claimsAreUnverified: true,
      ...(config.decisionEngine.mode==="jev"&&config.decisionEngine.workflow!=="legacy_v1"?{jevWorkflow:config.decisionEngine.workflow,maxJournalTokens:config.deliberation.maxJournalTokens,voting:"Highest nonzero tally eliminates; one vote can suffice when others abstain. A tie eliminates nobody."}:{}),
      speakerSelection:closing?"frozen_closing":config.discussion.speakerSelection,speakerBias:config.discussion.speakerBias,speakerPriorityFormula:"(bias + urge) * normalized aggregate willingness to listen; maximum wins; response rights restrict the candidate set before scoring",listenerIntent:"For listener auctions, privately rate willingness to listen to every other living player. This is scheduling preference, not an alignment fact." },
    sources: [], legalActions,
    legalTargets: kind === "vote" ? shuffled(state.players.filter(p => p.alive && p.id !== playerId).map(p => p.id), `${salt}:votes`) : legalActions[0]?.targets ?? [],
    journal, responseDocket: docket, closing,
  };
  const facts: ContextSourceV2[] = [
    { id: "facts:self", type: "authorized.self", day: state.day, scope: "player", privateIndex: 1, data: { role: self.role.name, alignment: self.role.alignment } },
    { id: "facts:rules", type: "published.rules", day: 0, scope: "public", data: { roleCounts } },
    { id: "facts:roster", type: "public.roster", day: state.day, scope: "public", data: { living: packet.players.filter(p => p.alive).map(p => p.id) } },
  ];
  packet.rules.roles = [...new Map(config.roleDeck.map(r=>[`${r.id}:${r.version}`,r])).values()].sort((a,b)=>a.id.localeCompare(b.id)).map(r=>({id:r.id,version:r.version,name:r.name,alignment:r.alignment,actions:r.actions,passives:r.passives,winCondition:r.winCondition}));
  let all = authorizedSources(state, events, playerId);
  if (config.decisionEngine.mode === "jev" && config.decisionEngine.workflow === "journal_v4") {
    packet.rules.journalRevision = journalEvidenceRevision(all);
  }
  // Set by the V3.2 ladder so the measured request can walk tiers back down; a no-op
  // under every other protocol.
  let applyTiers = () => undefined as void;
  let demoteOldest = (): boolean => false;
  if(config.protocolVersion === "agent_v3_1") {
    // Select the cacheable public-history window without consulting this
    // player's role, journal, or private deliveries. A player-specific cited
    // public record can still be included later, but it travels in L2 rather
    // than making the shared L1 bytes differ between seats.
    const publicBudget=Math.max(600,Math.min(2_000,Math.floor(config.deliberation.maxContextTokens*0.125)));
    const publicSources=all.filter(source=>source.scope === "public");
    const structural=new Set(publicSources.filter(source=>["player.eliminated","role.revealed","vote.resolved","moderator.announcement","game.ended"].includes(source.type)).map(source=>source.id));
    let used=estimatedTokens(publicSources.filter(source=>structural.has(source.id)).map(source=>({type:source.type,day:source.day,data:source.data})));
    const shared=new Set(structural);
    for(const source of [...publicSources].reverse()) {
      if(shared.has(source.id)) continue;
      const cost=estimatedTokens({type:source.type,day:source.day,data:source.data});
      if(used+cost>publicBudget) continue;
      shared.add(source.id);used+=cost;
    }
    all=all.map(source=>shared.has(source.id)?{...source,cacheLayer:"public" as const}:source);
  }
  if(config.protocolVersion === "agent_v3_2") {
    // L1 ledger. Every public record is delivered, so a cited record can never fall through
    // to the private layer and be duplicated per seat -- the growth that exhausted V3.1.
    // Tier assignment reads only public inputs, so L1 stays byte-identical across seats.
    // The V3.1 window carried a selection of public records; this ledger carries all of
    // them, so it needs a larger share of the context. At V3.1's 12.5% the ladder cannot
    // lift a single day above `stub` at an 8k budget, which throws away the fidelity the
    // tiers exist to allocate. Measured L1 on the live pilot was ~2,660 estimated tokens,
    // which this tracks.
    const publicBudget=Math.max(1_000,Math.min(4_000,Math.floor(config.deliberation.maxContextTokens*0.375)));
    const digestChars=config.deliberation.digestChars;
    const publicSources=all.filter(source=>source.scope === "public");
    const cost=(source:ContextSourceV2,tier:DeliveryTier)=>estimatedTokens({type:source.type,day:source.day,data:tierPayload(source,tier,digestChars,()=>"E1")});
    // Only structural records are pinned, because their outcomes cannot be recovered from
    // a summary and they are few. Speech -- including the current day's -- stays in the
    // ladder so the floor is a real floor: every speech can reach `stub` if it has to.
    //
    // Pinning the current day at full looked right for play quality (catching a
    // contradiction wants exact wording) but removed that guarantee, and a talkative Day 2
    // then overran an 8k budget. The ladder promotes newest-first, so the current day is
    // still the first to reach `full` whenever there is room; it simply degrades instead
    // of failing when there is not.
    const pinned=(source:ContextSourceV2)=>!isDemotable(source);
    const floor=publicSources.filter(pinned).reduce((sum,source)=>sum+cost(source,"full"),0);
    const demotable=publicSources.filter(source=>!pinned(source));
    const days=[...new Set(demotable.map(source=>source.day))].sort((a,b)=>a-b);
    const tierForDay=new Map<number,DeliveryTier>(days.map(day=>[day,"stub"]));
    const total=()=>demotable.reduce((sum,source)=>sum+cost(source,tierForDay.get(source.day)??"stub"),floor);
    // Promote whole day blocks, newest first. Demoting a day at a time keeps L1 stable for
    // long stretches, so a warm prefix survives many revisions instead of shifting on each.
    for(const tier of ["digest","full"] as const)
      for(const day of [...days].reverse()) {
        const previous=tierForDay.get(day) ?? "stub";
        if(previous === "full") continue;
        tierForDay.set(day,tier);
        if(total() > publicBudget) { tierForDay.set(day,previous); break; }
      }
    applyTiers=()=>{
      all=all.map(source=>source.scope !== "public"?source:{
        ...source,cacheLayer:"public" as const,
        detail:pinned(source)?"full":tierForDay.get(source.day) ?? "stub",
      });
    };
    // A predicted share cannot know how large L2, the journal, or the schema will be for
    // this seat, so the fraction above is only a starting point. `demoteOldest` lets the
    // measured request walk the ladder back down until the whole thing fits.
    demoteOldest=()=>{
      for(const day of days) {
        const current=tierForDay.get(day) ?? "stub";
        if(current === "stub") continue;
        tierForDay.set(day,current === "full" ? "digest" : "stub");
        applyTiers();
        return true;
      }
      return false;
    };
    applyTiers();
    // The renderer must clip digests exactly as the budget above costed them.
    packet.rules.digestChars=digestChars;
  }
  const citations = new Set([...journal.beliefs.flatMap(b => b.sources), ...journal.hypotheses.flatMap(h => h.sources), ...(journal.attentionNotes??[]).flatMap(n=>n.sources), ...docket, ...requiredSources]);
  // A player can normally make at most opening + two follow-ups + one closing
  // statement in a day. Keep that complete recent commitment window essential;
  // older uncited speeches compete normally for the remaining context budget.
  const recentOwnCommitments=new Set(all.filter(s=>s.type==="speech.public"&&s.data.playerId===playerId).slice(-4).map(s=>s.id));
  const essential = new Set(all.filter(s => s.scope !== "public" || ["player.eliminated", "role.revealed", "vote.resolved"].includes(s.type) || recentOwnCommitments.has(s.id) || citations.has(s.id)).map(s => s.id));
  const selected = new Set(essential);
  for(const source of all)if(source.cacheLayer === "public")selected.add(source.id);
  const materialize = () => { packet.sources = [...facts, ...all.filter(s => selected.has(s.id))]; };
  materialize();
  // Measure the exact prompt AND source-dependent schema before adding optional history.
  const requestSize = () => requestSizer?.(packet) ?? decisionRequestV2(packet,kind,config.deliberation.mode).tokens;
  // Walk the ledger back down against the measured request, oldest day first, until the
  // whole packet fits. Bounded by the number of day blocks, so it always terminates.
  for (let step = 0; step < 64 && requestSize() > config.deliberation.maxContextTokens; step += 1) {
    if (!demoteOldest()) break;
    selected.clear();
    for (const id of essential) selected.add(id);
    for (const source of all) if (source.cacheLayer === "public") selected.add(source.id);
    materialize();
  }
  const essentialSize=requestSize();
  // Under V3.2 every record is already at its floor tier here, so this is genuinely
  // last-resort rather than a budget that can be raised.
  if (essentialSize > config.deliberation.maxContextTokens) throw new ContextLimitError(config.protocolVersion === "agent_v3_2"
    ? "context_limit: the fully demoted delivery floor, journal, and schema still cannot fit"
    : "context_limit: essential authorized facts, commitments, journal, and schema cannot fit");
  const optionalLimit=Math.max(essentialSize,config.deliberation.maxContextTokens-512);
  for (const source of [...all].reverse()) {
    if (selected.has(source.id)) continue;
    selected.add(source.id); materialize();
    if (requestSize() > optionalLimit) selected.delete(source.id);
  }
  materialize();
  return packet;
}

export function journalLimitMessage(base: PrivateJournalV2, maxTokens: number, updatedTokens?: number): string {
  if (base.text !== undefined) return `journal_limit: updated notebook uses ${updatedTokens ?? "too many"} estimated tokens; maximum ${maxTokens}. Summarize the prose faithfully, preserving current reasoning, uncertainty, listening notes, commitments and deception. Size is UTF-8 prose bytes / 3, rounded up.`;
  return `journal_limit: ${updatedTokens === undefined ? "previous update exceeded the limit" : `updated notebook uses ${updatedTokens} estimated tokens`}; maximum ${maxTokens}; current saved notebook ${estimatedTokens(base)}. Size includes stored JSON and full citation IDs, not just prose. Shorten or replace existing sections. attentionUpdate replaces all listening notes; null preserves them. Empty beliefs/hypotheses arrays add nothing; adding a hypothesis retains older entries until slots fill. Condense obsolete or repetitive notes and avoid restating unchanged facts. Keep useful information; you choose the edits.`;
}

export function applyJournalV2(base: PrivateJournalV2, report: DecisionReportV2, maxTokens: number): PrivateJournalV2 {
  const next = structuredClone(base);
  for (const op of report.journalPatch) {
    switch (op.op) {
      case "set_decision_brief": next.decisionBrief = structuredClone(op.value); break;
      case "write_text": {
        const text = op.mode === "append" ? [journalText(next), op.text].filter(Boolean).join("\n\n") : op.text;
        // One source of truth: retire structured fields once prose takes ownership.
        next.text = text; next.beliefs = []; next.hypotheses = []; next.strategy = "";
        next.goals = []; next.unresolvedQuestions = []; next.deceptionPlan = null;
        delete next.attentionNotes;
        break;
      }
      case "upsert_belief": next.beliefs = [...next.beliefs.filter(b => b.playerId !== op.value.playerId), op.value]; break;
      case "upsert_hypothesis": next.hypotheses = [...next.hypotheses.filter(h => h.id !== op.value.id), op.value]; break;
      case "remove_hypothesis": next.hypotheses = next.hypotheses.filter(h => h.id !== op.id); break;
      case "set_strategy": next.strategy = op.strategy; next.goals = op.goals; break;
      case "set_attention": next.attentionNotes = op.notes; break;
      case "set_questions": next.unresolvedQuestions = op.questions; break;
      case "set_deception": next.deceptionPlan = op.plan; break;
    }
  }
  next.version += 1;
  const validated = PrivateJournalV2Schema.parse(next);
  if (journalTokens(validated) > maxTokens) throw new Error(journalLimitMessage(validated, maxTokens, journalTokens(validated)));
  return validated;
}
export function validateReport(report: DecisionReportV2, packet: PlayerContextV2, maxJournalTokens: number): string[] {
  const errors: string[] = [];
  const refs = new Set(packet.sources.map(s => s.id));
  const cited = [...report.observations, ...report.inferences.flatMap(i => i.sources), ...report.journalPatch.flatMap(op => op.op === "upsert_belief" || op.op === "upsert_hypothesis" ? op.value.sources : op.op === "set_attention" ? op.notes.flatMap(n=>n.sources) : [])];
  const proposal = report.proposal;
  if (proposal.kind === "discussion" && proposal.speech) cited.push(...proposal.speech.respondsTo, ...proposal.speech.acts.flatMap(a => a.sourceId ? [a.sourceId] : []));
  if (cited.some(id => !refs.has(id))) {
    errors.push("citations must reference delivered source IDs");
  }
  for(const op of report.journalPatch)if(op.op==="set_decision_brief"&&(op.value.playerId!==packet.self.id||op.value.evidenceRevision!==packet.rules.journalRevision))errors.push("Decision brief must match the acting player and current authorized evidence");
  for(const op of report.journalPatch)if(op.op==="set_attention"&&op.notes.some(n=>!packet.players.some(p=>p.id===n.playerId)))errors.push("attention note names an unknown player");
  for (const op of report.journalPatch) if (op.op === "upsert_belief") {
    if (!packet.players.some(p=>p.id === op.value.playerId)) errors.push("belief names an unknown player");
    if (op.value.basis === "authorized_fact" && !op.value.sources.some(id=>packet.sources.some(s=>s.id === id && (s.type === "inspection.delivered" && s.data.targetId === op.value.playerId || s.type === "authorized.self" && (op.value.playerId === packet.self.id || packet.knownAllies.some(ally=>ally.id===op.value.playerId)))))) errors.push("authorized_fact beliefs require an applicable private result or own-role/team source; public claims are not certified facts");
  }
  if (!report.alternatives.some(a => a.id === report.selectedAlternativeId)) errors.push("selectedAlternativeId must match an alternative");
  if (proposal.kind === "night_action" || proposal.kind === "team_point" || proposal.kind === "vote") {
    const choice = proposal.targets;
    const action = proposal.kind === "night_action" ? packet.legalActions.find(a => a.actionId === proposal.actionId) : packet.legalActions[0];
    const allowed = proposal.kind === "vote" ? packet.legalTargets : action?.targets ?? [];
    if (proposal.kind === "night_action" && !action) errors.push("actionId is not permitted");
    if (choice && (choice.playerIds.some(id => !allowed.includes(id)) || new Set(choice.playerIds).size !== choice.playerIds.length)) errors.push("target set must contain unique legal choices");
    if (choice?.mode === "direct" && choice.playerIds.length !== 1) errors.push("direct proposal must name exactly one target");
  }
  if (proposal.kind === "discussion") {
    if (proposal.speech?.acts.some(a => a.targetId && !packet.players.some(p => p.id === a.targetId))) errors.push("speech act has unknown target");
    if (packet.closing && proposal.speech?.acts.some(a => a.kind === "accusation" || a.kind === "challenge")) errors.push("closing replies cannot open new formal accusations or challenges");
    if (packet.closing && proposal.speech) {
      if (!proposal.speech.respondsTo.some(id => packet.responseDocket.includes(id))) errors.push("closing speech must reply to the frozen docket");
      if (proposal.speech.respondsTo.some(id => !packet.responseDocket.includes(id))) errors.push("closing speech can only reply to the frozen docket");
      if (proposal.speech.acts.some(a => a.kind !== "reply")) errors.push("closing speech acts must be replies");
    }
    if (packet.rules.speakerSelection !== "bid_only" && packet.responseDocket.length && !proposal.speech && !proposal.silenceCase) errors.push("when accused, a pass must compare a feasible speech strategy in silenceCase");
    if(packet.rules.speakerSelection === "listener_auction") {
      const intent=(report as DecisionReportWithSpeakerIntentV1).speakerIntent;
      const expected=packet.players.filter(p=>p.alive&&p.id!==packet.self.id).map(p=>p.id).sort();
      const supplied=intent?.willingnessToListen.map(item=>item.playerId).sort()??[];
      if(!intent) errors.push("listener-auction discussion reports require speakerIntent");
      else {
        if(new Set(supplied).size!==supplied.length||JSON.stringify(supplied)!==JSON.stringify(expected)) errors.push("willingnessToListen must rate every other living player exactly once");
        if(!intent.wantsToSpeak&&intent.urge!==0) errors.push("a player who does not want to speak must bid zero urge");
        if(intent.wantsToSpeak!==Boolean(proposal.speech)) errors.push("wantsToSpeak must match whether a speech proposal is supplied");
      }
    }
  }
  try { applyJournalV2(packet.journal, report, maxJournalTokens); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  return errors;
}

import { JOURNAL_EVIDENCE_TYPES } from "./player-brief";
import type { ActionProposalV2, DecisionOpportunityV1, DecisionReportV2, DecisionReportWithSpeakerIntentV1, DiscussionBidV3, DiscussionPlanV3, GameConfigV2, GameEventV1, ListenerBidV3, SpeakerIntentV1, SpeechSubmissionV3, TargetChoiceSubmissionV3 } from "@werewolf/contracts";
import { DecisionStore, LabRepository } from "@werewolf/db";
import { checkWinners, createGameCreatedEvent, createGameState, reduceGame, resolveNight, resolveVote, seededChoice, shuffled, transition, validateNightAction, type EngineEventInput, type GameState } from "@werewolf/engine";
import type { DecisionProvider } from "@werewolf/llm";
import { authorizedSources, buildContextV2, contentHash, publicPayload } from "./context-v2";
import { assertV2Budget, preparedTokenEstimate, DecisionExecutorV2, DecisionPausedError, V2BudgetError } from "./decisions-v2";
import { discussionAuctionPlan, nextDiscussionWork, publicRevision, rankSpeakerAuction, responseDockets, type DiscussionStage } from "./scheduler-v2";
import { NarrationV2 } from "./narration-v2";
import { usesJournalWorkflow } from "./jev-actions";
import { prepareJevStage, usesJev } from "./jev-decision";
import { canonicalizeV3Plan, decisionRequestV3, normalizeV3Submission, validateV3Submission, type V3TaskSpec } from "./request-v3";
import { canonicalizeV31Plan, decisionRequestV31, decisionRequestV32, normalizeV31Submission, validateV31Submission } from "./request-v3-1";

interface ClosingState { at: number; players: string[]; dockets: Record<string, string[]> }
interface AuctionResolution { selectedPlayerId:string|null; declinedCandidateIds:string[] }
/**
 * Deaths from the night that just ended, as seen from the dawn announcement.
 *
 * A day-first cycle advances the day counter on the way into `day_announcement`, so that
 * night's deaths are recorded under the previous day. Matching on the announcement's own
 * day silently found nothing and reported "nobody died overnight" after every night kill.
 * Restricting to `night_resolution` also keeps the day's own vote out of the dawn report.
 */
export function overnightEliminations(events:GameEventV1[],day:number,firstCycle:"day_first"|"night_first"):GameEventV1[] {
  const nightDay=firstCycle==="day_first"?day-1:day;
  return events.filter(event=>event.day===nightDay&&event.type==="player.eliminated"&&event.phase==="night_resolution");
}

const usesSplitDecisions=(protocol:string):boolean=>protocol==="agent_v3"||protocol==="agent_v3_1"||protocol==="agent_v3_2";
/** V3.1 and its V3.2 ledger successor share the handle contract and the request shape. */
const usesHandleProtocol=(protocol:string):boolean=>protocol==="agent_v3_1"||protocol==="agent_v3_2";
const requestForProtocol=(protocol:string)=>protocol==="agent_v3_2"?decisionRequestV32:decisionRequestV31;
export class V2GameOrchestrator {
  readonly store: DecisionStore;
  private executor: DecisionExecutorV2;
  private narrator: NarrationV2;
  constructor(private repository: LabRepository, provider: DecisionProvider, jevProvider?: DecisionProvider) { this.store = new DecisionStore(repository); this.executor = new DecisionExecutorV2(repository, provider, jevProvider); this.narrator=new NarrationV2(repository,provider); }
  private events(id: string) { return this.repository.listEvents(id); }
  private state(id: string) { return reduceGame(id, this.events(id)); }
  private config(state: GameState): GameConfigV2 {
    if (state.config.schemaVersion !== "game_config_v2") throw new Error("legacy game is replay-only");
    return state.config;
  }
  initialize(id: string): GameState {
    if (!this.events(id).length) this.repository.appendEvent(id, createGameCreatedEvent(createGameState(id, this.repository.getGame(id)!.config)));
    return this.state(id);
  }
  private append(state: GameState, type: string, payload: Record<string, unknown>, visibility: GameEventV1["visibility"] = "public", audienceIds: string[] = []) {
    this.repository.appendEvent(state.gameId, { type, phase: state.phase, day: state.day, visibility, audienceIds, payload });
  }
  async runGameStep(id: string): Promise<void> {
    const game = this.repository.getGame(id)!;
    if (!game || !["queued", "lobby", "running", "stepping"].includes(game.status)) return;
    let state = this.initialize(id);
    if (game.status === "queued" || game.status === "lobby") this.repository.updateGame(id, { status: "running" });
    const initial = `${state.day}:${state.phase}`;
    const stepDecision = this.store.get<string>(id, "stepUnit") === "decision" && game.status === "stepping";
    try {
      for (let work = 0; work < 256; work += 1) {
        if (!["running", "stepping"].includes(this.repository.getGame(id)!.status)) return;
        state = this.state(id);
        if (state.config.schemaVersion !== "game_config_v2") throw new Error("legacy game is replay-only");
        assertV2Budget(this.store, id, state.config, 0, false);
        const committed = await this.advance(state);
        const after = this.state(id);
        if (stepDecision && committed) return;
        if (!stepDecision && `${after.day}:${after.phase}` !== initial) return;
        if (after.phase === "ended") return;
      }
      throw new DecisionPausedError("bounded phase progress limit reached");
    } catch (error) {
      state = this.state(id);
      if (this.repository.getGame(id)!.status === "aborted") return;
      const reason = error instanceof Error ? error.message : String(error);
      if (error instanceof V2BudgetError) {
        this.append(state, "game.budget_exhausted", { reason, terminalClass: "budget", inFlightOvershootPossible: true });
        this.repository.updateGame(id, { status: "budget_exhausted", error: reason });
      } else {
        this.append(state, "game.paused", { reason, unresolved: true });
        this.repository.updateGame(id, { status: "paused", error: reason });
      }
    }
  }
  private finishIfWon(state: GameState): boolean {
    const win = checkWinners(state);
    if (!win) return false;
    this.repository.appendEvent(state.gameId, win);
    this.repository.updateGame(state.gameId, { status: "completed", error: null });
    return true;
  }
  private async parallel<T>(items:T[],limit:number,work:(item:T)=>Promise<boolean>):Promise<boolean> {
    let cursor=0,committed=false;const failures:unknown[]=[];
    const workers=Array.from({length:Math.min(Math.max(1,limit),items.length)},async()=>{
      while(cursor<items.length){const item=items[cursor++]!;try{committed=(await work(item))||committed;}catch(error){failures.push(error);}}
    });
    await Promise.all(workers);
    if(failures.length)throw failures[0];
    return committed;
  }
  private async advance(state: GameState): Promise<boolean> {
    const id = state.gameId;
    const events = this.events(id);
    const living = state.players.filter(p => p.alive);
    const config = this.config(state);
    if (state.phase === "setup") {
      this.store.atomic(() => {
        this.append(state, "game.started", { startedAt: new Date().toISOString() });
        this.repository.appendEvent(id, transition(state, config.rules.firstCycle === "day_first" ? "day_discussion" : "night_team", 1));
      });
      return false;
    }
    if (usesJournalWorkflow(config) && ["day_discussion", "day_vote", "night_team", "night_actions"].includes(state.phase)) {
      if (await this.refreshJournals(state, events)) return true;
    }
    if (state.phase === "night_team") {
      if(config.protocolVersion!=="agent_v2")return this.coordinateTeamsParallel(state,events,living);
      const participants=living.filter(p=>p.role.actions.some(a=>a.teamAggregation!=="none" && a.effect==="eliminate"));
      const groups=new Map<string,typeof participants>();
      for(const player of participants){const channel=player.role.passives.teamChannel ?? player.role.alignment;groups.set(channel,[...(groups.get(channel) ?? []),player]);}
      const frozen=events.filter(e=>e.day===state.day && e.type==="team.agreement_frozen");
      const group=[...groups].sort(([a],[b])=>a.localeCompare(b)).find(([,members])=>!frozen.some(e=>members.every(member=>(e.payload.actorIds as string[] ?? []).includes(member.id))));
      if(!group){
        this.store.atomic(()=>{
          this.repository.appendEvent(id,transition(state,"night_actions"));
          for(const agreement of frozen) if(agreement.payload.targetId) for(const actorId of agreement.payload.actorIds as string[]){
            const actor=participants.find(p=>p.id===actorId); if(!actor) continue;
            const action=actor.role.actions.find(a=>a.teamAggregation!=="none" && a.effect==="eliminate")!;
            this.append(this.state(id),"night.action_submitted",{action:{actorId,actionId:action.id,targetIds:[agreement.payload.targetId]}},"moderator");
          }
        });
        return false;
      }
      const [channel,wolves]=group;
      const points=events.filter(e=>e.day===state.day && e.type==="team.point" && wolves.some(p=>p.id===e.payload.playerId));
      const latest=new Map<string,string>();
      for(const point of points)latest.set(String(point.payload.playerId),String(point.payload.targetId));
      const agreed=wolves.every(p=>latest.has(p.id)) && new Set(wolves.map(p=>latest.get(p.id))).size===1;
      if(agreed || points.length>=3*wolves.length){
        this.append(state,"team.agreement_frozen",{channel,targetId:agreed?latest.get(wolves[0]!.id):null,actorIds:wolves.map(p=>p.id),reason:agreed?"unanimous":"no_agreement"},"moderator");
        return false;
      }
      const order=shuffled(wolves.map(p=>p.id),`${state.config.seed}:discussion:${state.day}:pack:${channel}`);
      const actor=order[points.length%order.length]!;
      const key=`point:${channel}:${points.length}`;
      return this.decide(state,actor,"team_point",key,[],false,undefined,report=>{
        const target=this.target(state,key,actor,report);
        return [...target.events,{type:"team.point",phase:state.phase,day:state.day,visibility:"team",audienceIds:wolves.map(p=>p.id),payload:{playerId:actor,targetId:target.id}}];
      });
    }
    if (state.phase === "night_actions") {
      const actors = shuffled(living.filter(p => p.role.actions.some(a => a.teamAggregation === "none")).map(p => p.id), `${state.config.seed}:discussion:${state.day}:powers`);
      if(config.protocolVersion!=="agent_v2") {
        const remaining=actors.filter(playerId=>!state.pendingNightActions.some(a=>a.actorId===playerId)&&!events.some(e=>e.day===state.day&&e.type==="night.pass"&&e.payload.playerId===playerId));
        if(remaining.length)return this.nightActionsParallel(state,remaining,events.at(-1)!.sequence);
      }
      const actor = actors.find(playerId => !state.pendingNightActions.some(a => a.actorId === playerId) && !events.some(e => e.day === state.day && e.type === "night.pass" && e.payload.playerId === playerId));
      if (actor) {
        const packet = buildContextV2(state, events, actor, this.store.journal(id, actor), `power:${actor}`, "night_action");
        const kind = packet.legalActions.some(a => a.targets.length) ? "night_action" : "pass";
        return this.decide(state, actor, kind, `power:${actor}`, [], false, undefined, report => {
          if (report.proposal.kind === "pass") return [{ type: "night.pass", phase: state.phase, day: state.day, visibility: "player", audienceIds: [actor], payload: { playerId: actor, reason: report.proposal.reason } }];
          const target = this.target(state, `power:${actor}`, actor, report);
          const action = { actorId: actor, actionId: (report.proposal as Extract<ActionProposalV2, {kind:"night_action"}>).actionId, targetIds: [target.id!] };
          const errors = validateNightAction(this.state(id), action);
          if (errors.length) throw new DecisionPausedError(`stale or illegal action: ${errors.join("; ")}`);
          return [...target.events, { type: "night.action_submitted", phase: state.phase, day: state.day, visibility: "player", audienceIds: [actor], payload: { action } }];
        });
      }
      this.store.atomic(() => {
        const resolved = resolveNight(state);
        this.repository.appendEvents(id, resolved);
        const current = this.state(id);
        if (this.finishIfWon(current)) return;
        if(config.rules.firstCycle==="day_first"&&state.day>=config.safety.maxCycles){
          this.append(current,"game.budget_exhausted",{reason:"maximum day/night cycles reached",terminalClass:"budget"});
          this.repository.updateGame(id,{status:"budget_exhausted"});return;
        }
        this.repository.appendEvent(id, transition(current, "day_announcement",config.rules.firstCycle==="day_first"?current.day+1:current.day));
      });
      return false;
    }
    if (state.phase === "day_announcement") {
      const existing=events.some(e=>e.day===state.day && e.type==="moderator.announcement");
      const config=state.config;
      if(config.schemaVersion!=="game_config_v2") throw new Error("V2 narration requires V2 config");
      const eliminated=overnightEliminations(events,state.day,config.rules.firstCycle).map(publicPayload);
      const fallbackText=eliminated.length ? `Dawn: ${eliminated.map(p=>p.playerName).join(", ")} died overnight.` : "Dawn: nobody died overnight.";
      const decisionId=`announcement:${state.day}`,settings=config.modelSettings[config.seats[0]!.id]!;
      const text=existing || !config.moderatorNarration ? fallbackText : await this.narrator.narrate({gameId:id,decisionId,phase:state.phase,day:state.day,model:config.moderatorModel ?? settings.model,reasoningEffort:settings.reasoningEffort,provider:settings.provider,disclosurePacket:{day:state.day,eliminated,fallbackText},fallbackText,mandatoryRemaining:living.length*2,mandatoryTokenReserve:living.length*2*(config.deliberation.maxContextTokens+config.safety.maxOutputTokens)});
      this.store.atomic(()=>{
        const current=this.state(id);
        if(!["running","stepping"].includes(this.repository.getGame(id)!.status) || current.phase!==state.phase || current.day!==state.day) return;
        if(!existing) {
          this.append(current,"moderator.announcement",{text});
          const checkpoint=this.narrator.checkpoint(id,decisionId);
          if(checkpoint?.best) this.narrator.acknowledge(id,decisionId,text);
          else if(checkpoint?.status==="skipped") this.append(current,"decision.narration_skipped",{decisionId,reason:checkpoint.error},"moderator");
        }
        this.repository.appendEvent(id,transition(current,"day_discussion"));
      });
      return false;
    }
    if (state.phase === "day_discussion") return this.discuss(state, events);
    if (state.phase === "day_vote") {
      if(config.protocolVersion!=="agent_v2") {
        const order=shuffled(living.map(p=>p.id),`${state.config.seed}:discussion:${state.day}:ballots`);
        const remaining=order.filter(playerId=>!state.votes.some(v=>v.voterId===playerId));
        if(remaining.length)return this.votesParallel(state,remaining,events.at(-1)!.sequence);
      }
      const actor = shuffled(living.map(p => p.id), `${state.config.seed}:discussion:${state.day}:ballots`).find(playerId => !state.votes.some(v => v.voterId === playerId));
      if (actor) return this.decide(state, actor, "vote", `ballot:${actor}`, [], false, undefined, report => {
        const target = this.target(state, `ballot:${actor}`, actor, report);
        return [...target.events, { type: "vote.cast", phase: state.phase, day: state.day, visibility: "player", audienceIds: [actor], payload: { vote: { voterId: actor, targetId: target.id } } }];
      });
      this.store.atomic(() => {
        const result = resolveVote(state);
        const target = state.players.find(p => p.id === result.targetId);
        this.append(state, "vote.resolved", { ...result, targetId: result.targetId ?? null, ballots: state.votes, targetName: target?.name });
        if (target) this.append(state, "player.eliminated", { playerId: target.id, playerName: target.name, ...(state.config.revealRolesOnDeath ? { roleName: target.role.name } : {}), cause: "vote" });
        const current = this.state(id);
        if (this.finishIfWon(current)) return;
        if (config.rules.firstCycle!=="day_first"&&state.day >= config.safety.maxCycles) {
          this.append(current,"game.budget_exhausted",{reason:"maximum day/night cycles reached",terminalClass:"budget"});
          this.repository.updateGame(id,{status:"budget_exhausted"}); return;
        }
        this.repository.appendEvent(id, transition(current, "night_team", config.rules.firstCycle==="day_first"?current.day:current.day+1));
      });
      return false;
    }
    throw new DecisionPausedError(`unexpected V2 phase ${state.phase}`);
  }
  private async coordinateTeamsParallel(state:GameState,events:GameEventV1[],living:GameState["players"]):Promise<boolean> {
    const config=this.config(state);
    const participants=living.filter(p=>p.role.actions.some(a=>a.teamAggregation!=="none"&&a.effect==="eliminate"));
    const groups=new Map<string,typeof participants>();
    for(const player of participants){const channel=player.role.passives.teamChannel??player.role.alignment;groups.set(channel,[...(groups.get(channel)??[]),player]);}
    const frozen=events.filter(e=>e.day===state.day&&e.type==="team.agreement_frozen");
    const group=[...groups].sort(([a],[b])=>a.localeCompare(b)).find(([,members])=>!frozen.some(e=>members.every(member=>(e.payload.actorIds as string[]??[]).includes(member.id))));
    if(!group){
      this.store.atomic(()=>{
        this.repository.appendEvent(state.gameId,transition(state,"night_actions"));
        for(const agreement of frozen)if(agreement.payload.targetId)for(const actorId of agreement.payload.actorIds as string[]){
          const actor=participants.find(p=>p.id===actorId);if(!actor)continue;
          const action=actor.role.actions.find(a=>a.teamAggregation!=="none"&&a.effect==="eliminate")!;
          this.append(this.state(state.gameId),"night.action_submitted",{action:{actorId,actionId:action.id,targetIds:[agreement.payload.targetId]}},"moderator");
        }
      });
      return false;
    }
    const [channel,wolves]=group;
    const points=events.filter(e=>e.day===state.day&&e.type==="team.point"&&wolves.some(p=>p.id===e.payload.playerId));
    for(let round=0;round<3;round+=1){
      const roundPoints=points.slice(round*wolves.length,(round+1)*wolves.length);
      if(roundPoints.length===wolves.length){
        const latest=new Map(roundPoints.map(e=>[String(e.payload.playerId),String(e.payload.targetId)]));
        const agreed=wolves.every(p=>latest.has(p.id))&&new Set(wolves.map(p=>latest.get(p.id))).size===1;
        if(agreed){this.append(state,"team.agreement_frozen",{channel,targetId:latest.get(wolves[0]!.id),actorIds:wolves.map(p=>p.id),reason:"unanimous",round},"moderator");return false;}
        continue;
      }
      // The opening pick is blind: every wolf is scored against one frozen snapshot, so no
      // wolf can see a teammate's first choice and simply follow it. Later rounds are a
      // round robin from a random start where each wolf does see the picks already made,
      // which is what lets the pack actually converge rather than re-guess in the dark.
      const blind=round===0;
      const boundaryKey=`point-boundary:${state.day}:${channel}:${round}`;
      let at:number|undefined;
      if(blind){
        at=this.store.get<number>(state.gameId,boundaryKey);
        if(at===undefined){at=events.at(-1)!.sequence;this.store.put(state.gameId,boundaryKey,at);}
      }
      const order=shuffled(wolves.map(p=>p.id),`${state.config.seed}:discussion:${state.day}:pack:${channel}:round:${round}`);
      const remaining=order.filter(actor=>!roundPoints.some(e=>e.payload.playerId===actor));
      const call=(actor:string,defer:boolean)=>this.decide(state,actor,"team_point",`point:${channel}:${round}:${actor}`,[],false,at,report=>{
        const target=this.target(state,`point:${channel}:${round}:${actor}`,actor,report);
        return [...target.events,{type:"team.point",phase:state.phase,day:state.day,visibility:"team",audienceIds:wolves.map(p=>p.id),payload:{playerId:actor,targetId:target.id,round,blind}}];
      },defer);
      // Drafting in parallel is only sound while the view is frozen; in a round robin an
      // early draft would be built from a view the wolf no longer has when it commits.
      if(blind)await this.parallel(remaining,config.discussion.maxParallelDecisions,actor=>call(actor,true));
      let committed=false;for(const actor of remaining)committed=(await call(actor,false))||committed;
      return committed;
    }
    this.append(state,"team.agreement_frozen",{channel,targetId:null,actorIds:wolves.map(p=>p.id),reason:"no_agreement",rounds:3},"moderator");
    return false;
  }
  private nightActionCall(state:GameState,actor:string,at:number,defer:boolean):Promise<boolean> {
    const packet=buildContextV2(state,this.events(state.gameId).filter(e=>e.sequence<=at),actor,this.store.journal(state.gameId,actor),`power:${actor}`,"night_action");
    const kind=packet.legalActions.some(a=>a.targets.length)?"night_action":"pass";
    return this.decide(state,actor,kind,`power:${actor}`,[],false,at,report=>{
      if(report.proposal.kind==="pass")return [{type:"night.pass",phase:state.phase,day:state.day,visibility:"player",audienceIds:[actor],payload:{playerId:actor,reason:report.proposal.reason}}];
      const target=this.target(state,`power:${actor}`,actor,report);
      const action={actorId:actor,actionId:(report.proposal as Extract<ActionProposalV2,{kind:"night_action"}>).actionId,targetIds:[target.id!]};
      const errors=validateNightAction(this.state(state.gameId),action);if(errors.length)throw new DecisionPausedError(`stale or illegal action: ${errors.join("; ")}`);
      return [...target.events,{type:"night.action_submitted",phase:state.phase,day:state.day,visibility:"player",audienceIds:[actor],payload:{action}}];
    },defer);
  }
  private async nightActionsParallel(state:GameState,actors:string[],at:number):Promise<boolean> {
    await this.parallel(actors,this.config(state).discussion.maxParallelDecisions,actor=>this.nightActionCall(state,actor,at,true));
    let committed=false;for(const actor of actors)committed=(await this.nightActionCall(state,actor,at,false))||committed;return committed;
  }
  private voteCall(state:GameState,actor:string,at:number,defer:boolean):Promise<boolean> {
    const key=`ballot:${actor}`;
    return this.decide(state,actor,"vote",key,[],false,at,report=>{const target=this.target(state,key,actor,report);return [...target.events,{type:"vote.cast",phase:state.phase,day:state.day,visibility:"player",audienceIds:[actor],payload:{vote:{voterId:actor,targetId:target.id}}}];},defer);
  }
  private async votesParallel(state:GameState,actors:string[],at:number):Promise<boolean> {
    await this.parallel(actors,this.config(state).discussion.maxParallelDecisions,actor=>this.voteCall(state,actor,at,true));
    let committed=false;for(const actor of actors)committed=(await this.voteCall(state,actor,at,false))||committed;return committed;
  }
  private async discuss(state: GameState, events: GameEventV1[]): Promise<boolean> {
    const id = state.gameId;
    const config=this.config(state);
    const closingKey = `closing:${state.day}`;
    let closing = this.store.get<ClosingState>(id, closingKey);
    const auction=!closing&&config.discussion.speakerSelection==="listener_auction"?discussionAuctionPlan(state,events):null;
    if(auction)return usesSplitDecisions(config.protocolVersion)?this.auctionDiscussionV3(state,events,auction):this.auctionDiscussion(state,events,auction);
    const work = closing || config.discussion.speakerSelection==="listener_auction" ? null : nextDiscussionWork(state, events);
    if (work) return this.discussionDecision(state, work.playerId, work.key, work.stage, work.docket);
    if (!closing) {
      const dockets = responseDockets(state, events);
      closing = { at: events.at(-1)!.sequence, players: shuffled(Object.keys(dockets).filter(p => dockets[p]!.length), `${state.config.seed}:discussion:${state.day}:closing`), dockets };
      this.store.put(id, closingKey, closing);
      this.append(state, "discussion.closing_frozen", { players: closing.players, dockets: closing.dockets }, "moderator");
    }
    const remaining=closing.players.filter(p=>!events.some(e=>e.day===state.day&&e.type==="discussion.closing_submitted"&&e.payload.playerId===p));
    if(remaining.length&&config.protocolVersion!=="agent_v2"){
      const call=(playerId:string,defer:boolean)=>this.discussionDecision(state,playerId,`closing:${playerId}`,"closing",closing!.dockets[playerId]!,closing!.at,defer);
      await this.parallel(remaining,config.discussion.maxParallelDecisions,playerId=>call(playerId,true));
      let committed=false;for(const playerId of remaining)committed=(await call(playerId,false))||committed;return committed;
    }
    const playerId = remaining[0];
    if (playerId) return this.discussionDecision(state, playerId, `closing:${playerId}`, "closing", closing.dockets[playerId]!, closing.at);
    this.store.atomic(() => {
      for (const event of this.events(id).filter(e => e.day === state.day && e.type === "discussion.closing_submitted")) {
        const speech = event.payload.speech as {text:string;acts:unknown[];respondsTo:string[]} | null;
        if (speech) this.append(state, "speech.public", { playerId: event.payload.playerId, playerName: event.payload.playerName, ...speech, closing: true });
      }
      this.repository.appendEvent(id, transition(state, "day_vote"));
    });
    return false;
  }
  /** All living seats reflect on new speech/results before any subsequent scoring or action. */
  private async refreshJournals(state: GameState, events: GameEventV1[]): Promise<boolean> {
    const meaningful = JOURNAL_EVIDENCE_TYPES;
    const at = events.at(-1)!.sequence, dockets = responseDockets(state, events);
    const pending = state.players.filter(p => p.alive).flatMap(player => {
      const sources = authorizedSources(state, events, player.id).filter(s => meaningful.has(s.type));
      const revision = contentHash(sources.map(s => s.id));
      const previous = events.findLast(e => e.type === "journal.refreshed" && e.payload.playerId === player.id);
      const brief = this.store.journal(state.gameId, player.id).decisionBrief;
      const currentBrief = this.config(state).decisionEngine.workflow !== "journal_v4" || brief?.playerId === player.id && brief.evidenceRevision === revision;
      if (previous?.payload.revision === revision && currentBrief) return [];
      const reviewed = new Set((previous?.payload.sourceIds as string[] | undefined) ?? []);
      return [{ playerId: player.id, revision, sourceIds: sources.map(s => s.id), newIds: sources.filter(s => !reviewed.has(s.id)).map(s => s.id) }];
    });
    if (!pending.length) return false;
    return this.parallel(pending, this.config(state).discussion.maxParallelDecisions, item => this.decide(
      state, item.playerId, "pass", `journal:${item.playerId}:${item.revision}`, dockets[item.playerId]??[], false, at,
      () => [{ type: "journal.refreshed", phase: state.phase, day: state.day, visibility: "player", audienceIds: [item.playerId], payload: { playerId: item.playerId, revision: item.revision, sourceIds: item.sourceIds } }],
      false, { type: "journal_update", revision: item.revision, sourceIds: item.newIds },
    ));
  }
  private async auctionDiscussionV3(state:GameState,events:GameEventV1[],plan:NonNullable<ReturnType<typeof discussionAuctionPlan>>):Promise<boolean>{
    const config=this.config(state),at=events.at(-1)!.sequence,revision=publicRevision(events),base=`auction-v3:${plan.stage}:${plan.round}:${revision}`;
    const listeners=plan.candidates.length===1?[plan.candidates[0]!]:plan.listeners;
    const bidCall=(playerId:string)=>{
      const eligible=plan.candidates.includes(playerId);
      const task:V3TaskSpec=eligible?{type:usesJournalWorkflow(config)?"discussion_score":"discussion_bid",eligible:true,candidateIds:plan.candidates,revision}:{type:"discussion_listen",eligible:false,candidateIds:plan.candidates,revision};
      return this.decide(state,playerId,"discussion",`${base}:bid:${playerId}`,plan.dockets[playerId]??[],false,at,(report,submission)=>{
        const bid=submission as DiscussionBidV3|ListenerBidV3;
        return [{type:"discussion.bid_submitted",phase:state.phase,day:state.day,visibility:"player",audienceIds:[playerId],payload:{playerId,auctionKey:base,stage:plan.stage,round:plan.round,publicRevision:revision,eligible,submission:bid,intent:(report as DecisionReportWithSpeakerIntentV1).speakerIntent}}];
      },false,task);
    };
    const submitted=new Set(events.filter(event=>event.type==="discussion.bid_submitted"&&event.payload.auctionKey===base).map(event=>String(event.payload.playerId)));
    const missing=listeners.filter(playerId=>!submitted.has(playerId));
    if(missing.length)await this.parallel(missing,config.discussion.maxParallelDecisions,bidCall);
    const bidEvents=this.events(state.gameId).filter(event=>event.type==="discussion.bid_submitted"&&event.payload.auctionKey===base);
    const bids=bidEvents.map(event=>{
      const playerId=String(event.payload.playerId),stored=event.payload.submission as DiscussionBidV3|ListenerBidV3;
      const decisionId=contentHash([state.gameId,state.day,state.phase,`${base}:bid:${playerId}`]).slice(0,32);
      const bidOpportunity=this.store.get<DecisionOpportunityV1>(state.gameId,`decision:${decisionId}`);
      const submission="plan" in stored&&stored.plan&&bidOpportunity
        ? {...stored,plan:usesHandleProtocol(config.protocolVersion)?canonicalizeV31Plan(bidOpportunity.packet,stored.plan):canonicalizeV3Plan(bidOpportunity.packet,stored.plan)}
        : stored;
      return {playerId,intent:event.payload.intent as SpeakerIntentV1,submission};
    });
    if(bids.length!==listeners.length)throw new DecisionPausedError("speaker auction is missing a validated v3 bid");
    const tieOrder=shuffled(plan.candidates,`${state.config.seed}:discussion:${state.day}:auction-v3:${plan.stage}:${plan.round}:${revision}`);
    const scores=rankSpeakerAuction(plan.candidates,bids.map(({playerId,intent})=>({playerId,intent})),config.discussion.speakerBias,tieOrder);
    const resolutionKey=`auction-resolution:${base}`;
    let resolution=this.store.get<AuctionResolution>(state.gameId,resolutionKey);
    if(!resolution){
      const declinedCandidateIds=plan.candidates.filter(playerId=>!bids.find(bid=>bid.playerId===playerId)?.intent.wantsToSpeak);
      resolution={selectedPlayerId:scores[0]?.playerId??null,declinedCandidateIds};
      this.store.atomic(()=>{
        this.store.put(state.gameId,resolutionKey,resolution);
        this.append(state,"discussion.auction_resolved",{protocolVersion:config.protocolVersion,auctionKey:base,stage:plan.stage,round:plan.round,publicRevision:revision,bias:config.discussion.speakerBias,formula:"(bias + urge) * normalized_listening",scores,intents:Object.fromEntries(bids.map(bid=>[bid.playerId,bid.intent])),plans:Object.fromEntries(bids.filter(bid=>"plan" in bid.submission).map(bid=>[bid.playerId,(bid.submission as DiscussionBidV3).plan])),selectedPlayerId:resolution!.selectedPlayerId,declinedCandidateIds},"moderator");
        if(resolution!.selectedPlayerId)this.append(state,"discussion.speaker_selected",{protocolVersion:config.protocolVersion,auctionKey:base,stage:plan.stage,round:plan.round,playerId:resolution!.selectedPlayerId,playerName:state.players.find(player=>player.id===resolution!.selectedPlayerId)!.name});
        for(const playerId of declinedCandidateIds)this.append(state,"discussion.completed",{playerId,stage:plan.stage,docket:plan.dockets[playerId]??[],ready:bids.find(bid=>bid.playerId===playerId)?.submission.ready??false,interests:[],declined:true,publicRevision:revision},"moderator");
      });
    }
    if(!resolution.selectedPlayerId)return true;
    const selected=bids.find(bid=>bid.playerId===resolution!.selectedPlayerId),frozenPlan=(selected?.submission as DiscussionBidV3|undefined)?.plan;
    if(!selected||!usesJournalWorkflow(config)&&!frozenPlan)throw new DecisionPausedError("selected v3 speaker has no frozen contribution plan");
    const task:V3TaskSpec=usesJournalWorkflow(config)?{type:"discussion_free_speech",ready:selected.submission.ready,revision}:{type:"discussion_speech",plan:frozenPlan!,ready:selected.submission.ready,revision};
    const speechDocket=[...new Set([...(plan.dockets[selected.playerId]??[]),...(frozenPlan?.respondsTo??[])])];
    return this.decide(state,selected.playerId,"discussion",`${base}:speech:${selected.playerId}`,speechDocket,false,at,(report,submission)=>{
      const speech=submission as SpeechSubmissionV3,proposal=report.proposal as Extract<ActionProposalV2,{kind:"discussion"}>,name=state.players.find(player=>player.id===selected.playerId)!.name;
      if(!proposal.speech)throw new DecisionPausedError("selected v3 speaker did not produce a publishable speech");
      return [
        {type:"speech.public",phase:state.phase,day:state.day,visibility:"public",payload:{playerId:selected.playerId,playerName:name,...proposal.speech,closing:false,rationale:speech.rationale}},
        {type:"discussion.completed",phase:state.phase,day:state.day,visibility:"moderator",payload:{playerId:selected.playerId,stage:plan.stage,docket:plan.dockets[selected.playerId]??[],ready:selected.submission.ready,interests:[],declined:false,publicRevision:revision}},
      ];
    },false,task);
  }
  private async auctionDiscussion(state:GameState,events:GameEventV1[],plan:NonNullable<ReturnType<typeof discussionAuctionPlan>>):Promise<boolean>{
    const config=this.config(state);
    const at=events.at(-1)!.sequence,revision=publicRevision(events),base=`auction:${plan.stage}:${plan.round}:${revision}`;
    const call=(playerId:string,defer:boolean)=>this.discussionDecision(state,playerId,`${base}:${playerId}`,plan.stage,plan.dockets[playerId]??[],at,defer);
    await this.parallel(plan.listeners,config.discussion.maxParallelDecisions,playerId=>call(playerId,true));
    const bids=plan.listeners.map(playerId=>{
      const id=contentHash([state.gameId,state.day,state.phase,`${base}:${playerId}`]).slice(0,32);
      const opportunity=this.store.get<DecisionOpportunityV1>(state.gameId,`decision:${id}`);
      const intent=(opportunity?.best as DecisionReportWithSpeakerIntentV1|undefined)?.speakerIntent;
      if(!opportunity?.best||!intent)throw new DecisionPausedError(`speaker auction missing a validated bid from ${playerId}`);
      return {playerId,intent,opportunity};
    });
    const tieOrder=shuffled(plan.candidates,`${state.config.seed}:discussion:${state.day}:auction:${plan.stage}:${plan.round}:${revision}`);
    const scores=rankSpeakerAuction(plan.candidates,bids.map(({playerId,intent})=>({playerId,intent})),config.discussion.speakerBias,tieOrder);
    const resolutionKey=`auction-resolution:${base}`;
    let resolution=this.store.get<AuctionResolution>(state.gameId,resolutionKey);
    if(!resolution){
      resolution={selectedPlayerId:scores[0]?.playerId??null,declinedCandidateIds:plan.candidates.filter(playerId=>!bids.find(bid=>bid.playerId===playerId)!.intent.wantsToSpeak)};
      this.store.atomic(()=>{
        this.store.put(state.gameId,resolutionKey,resolution);
        this.append(state,"discussion.auction_resolved",{stage:plan.stage,round:plan.round,publicRevision:revision,bias:config.discussion.speakerBias,formula:"(bias + urge) * normalized_listening",scores,intents:Object.fromEntries(bids.map(b=>[b.playerId,b.intent])),selectedPlayerId:resolution!.selectedPlayerId,declinedCandidateIds:resolution!.declinedCandidateIds},"moderator");
        if(resolution!.selectedPlayerId)this.append(state,"discussion.speaker_selected",{stage:plan.stage,round:plan.round,playerId:resolution!.selectedPlayerId,playerName:state.players.find(p=>p.id===resolution!.selectedPlayerId)!.name});
        for(const bid of bids)if(bid.playerId!==resolution!.selectedPlayerId&&!resolution!.declinedCandidateIds.includes(bid.playerId)&&bid.opportunity.status==="pending"){
          this.store.save({...bid.opportunity,status:"superseded"});
          this.append(state,"decision.superseded",{playerId:bid.playerId,decisionId:bid.opportunity.id,reason:"speaker_not_selected"},"player",[bid.playerId]);
        }
      });
    }
    let committed=false;
    for(const playerId of resolution.declinedCandidateIds)committed=(await call(playerId,false))||committed;
    if(resolution.selectedPlayerId)committed=(await call(resolution.selectedPlayerId,false))||committed;
    return committed;
  }
  private discussionDecision(state: GameState, playerId: string, key: string, stage: DiscussionStage, docket: string[], at?: number,defer=false) {
    if(usesSplitDecisions(this.config(state).protocolVersion)){
      const task:V3TaskSpec={type:"closing_response",revision:publicRevision(this.events(state.gameId).filter(event=>at===undefined||event.sequence<=at))};
      return this.decide(state,playerId,"discussion",key,docket,true,at,(report,submission)=>{
        const proposal=report.proposal as Extract<ActionProposalV2,{kind:"discussion"}>,speech=submission as SpeechSubmissionV3,name=state.players.find(player=>player.id===playerId)!.name;
        return [{type:"discussion.closing_submitted",phase:state.phase,day:state.day,visibility:"player",audienceIds:[playerId],payload:{playerId,playerName:name,speech:proposal.speech,rationale:speech.rationale}},{type:"discussion.completed",phase:state.phase,day:state.day,visibility:"moderator",payload:{playerId,stage,docket,ready:true,interests:[],declined:!proposal.speech,silenceCase:proposal.silenceCase,publicRevision:publicRevision(this.events(state.gameId))}}];
      },defer,task);
    }
    return this.decide(state, playerId, "discussion", key, docket, stage === "closing", at, report => {
      const proposal = report.proposal as Extract<ActionProposalV2,{kind:"discussion"}>;
      const result: EngineEventInput[] = [];
      const name = state.players.find(p => p.id === playerId)!.name;
      if (stage === "closing") result.push({ type: "discussion.closing_submitted", phase: state.phase, day: state.day, visibility: "player", audienceIds: [playerId], payload: { playerId, playerName: name, speech: proposal.speech } });
      else if (proposal.speech) result.push({ type: "speech.public", phase: state.phase, day: state.day, visibility: "public", payload: { playerId, playerName: name, text: proposal.speech.text, acts: proposal.speech.acts, respondsTo: proposal.speech.respondsTo, closing: false } });
      result.push({ type: "discussion.completed", phase: state.phase, day: state.day, visibility: "moderator", payload: { playerId, stage, docket, ready: proposal.ready, interests: proposal.interests, declined: !proposal.speech, silenceCase: proposal.silenceCase, publicRevision: publicRevision(this.events(state.gameId)) } });
      return result;
    },defer);
  }
  private decide(state: GameState, playerId: string, kind: ActionProposalV2["kind"], key: string, docket: string[], closing: boolean, at: number | undefined, eventsForCommit: (report: DecisionReportV2,submission?:unknown) => EngineEventInput[],deferCommit=false,v3Task?:V3TaskSpec) {
    const id = contentHash([state.gameId, state.day, state.phase, key]).slice(0, 32);
    const config=this.config(state);
    const inferredTask:V3TaskSpec|undefined=v3Task??(usesSplitDecisions(config.protocolVersion)?(kind==="vote"?{type:"vote_choice",proposalKind:"vote"}:kind==="night_action"?{type:"night_choice",proposalKind:"night_action"}:kind==="team_point"?{type:"team_point_choice",proposalKind:"team_point"}:undefined):undefined);
    let op = this.store.get<DecisionOpportunityV1>(state.gameId, `decision:${id}`);
    const sourceEvents = () => this.events(state.gameId).filter(e => at === undefined || e.sequence <= at);
    if (!op) {
      const journal = this.store.journal(state.gameId, playerId);
      const requestFor=(candidate:Parameters<typeof decisionRequestV3>[0])=> {
        const request = usesHandleProtocol(config.protocolVersion)?requestForProtocol(config.protocolVersion)(candidate,inferredTask!,true,null,null):decisionRequestV3(candidate,inferredTask!,true,null,null);
        const sizingOpportunity = { packet: candidate, playerId, taskType: inferredTask!.type };
        if (!usesJev(sizingOpportunity, config)) return {...request,tokens:preparedTokenEstimate(request,config.modelSettings[playerId]?.provider==="openai")};
        const stage = prepareJevStage(sizingOpportunity, config, { ...request, schemaName: inferredTask!.type, normalize: () => { throw new Error("Context sizing cannot normalize a decision"); } }, config.deliberation.mode === "gated");
        // Reserve room for one explicit LLM response and the compact routing summary.
        return { ...request, tokens: usesJournalWorkflow(config)?stage.prepared.tokens:Math.max(request.tokens, stage.prepared.tokens) + request.maxOutputTokens + 160 };
      };
      const packet = buildContextV2(state, sourceEvents(), playerId, journal, key, kind, docket, closing,inferredTask?(candidate)=>requestFor(candidate).tokens:undefined,inferredTask?.type==="journal_update"?inferredTask.sourceIds:[]);
      // V3 validates scheduling bids with their own narrow contract. The legacy
      // report validator couples a positive bid to a pre-written speech, which is
      // deliberately not part of the bid -> select -> speak protocol.
      if(inferredTask?.type==="discussion_bid"||inferredTask?.type==="discussion_score"||inferredTask?.type==="discussion_listen")packet.rules.speakerSelection="bid_only";
      if(inferredTask?.type==="discussion_speech"||inferredTask?.type==="discussion_free_speech")packet.rules.speakerSelection="selected_speech";
      op = { id, gameId: state.gameId, playerId, kind, phase: state.phase, day: state.day, epoch: `${state.day}:${state.phase}`, viewId: contentHash(packet), baseJournalVersion: journal.version, packet, status: "open", best: null, recovery: 0, createdAt: new Date().toISOString(),taskType:v3Task?.type };
      this.store.atomic(() => { this.store.save(op!); this.append(state, "decision.opened", { playerId, decisionId: id, viewId: op!.viewId, includedSourceIds: packet.sources.map(s => s.id) }, "player", [playerId]); });
    }
    const opportunity = op;
    if(inferredTask&&!op.taskType){op.taskType=inferredTask.type;this.store.save(op);}
    return this.executor.execute({ opportunity, mandatoryRemaining: state.players.filter(p => p.alive).length,
      ...(inferredTask?{requestForAttempt:(commitOnly:boolean,previous:DecisionReportV2|null,repair:string|null)=>{
        if(usesHandleProtocol(config.protocolVersion)){
          const request=requestForProtocol(config.protocolVersion)(op!.packet,inferredTask,commitOnly,previous,repair);
          return {...request,providerKind:"decision_v3_1" as const,schemaName:inferredTask.type,normalize:(submission:unknown)=>normalizeV31Submission(op!.packet,inferredTask,submission as never,id,commitOnly),validateSubmission:(submission:unknown)=>validateV31Submission(op!.packet,inferredTask,submission as never)};
        }
        const request=decisionRequestV3(op!.packet,inferredTask,commitOnly,previous,repair);
        return {...request,providerKind:"decision_v3" as const,schemaName:inferredTask.type,normalize:(submission:unknown)=>normalizeV3Submission(op!.packet,inferredTask,submission as never,id,commitOnly),validateSubmission:(submission:unknown)=>validateV3Submission(op!.packet,inferredTask,submission as never)};
      },reasoningEffort:inferredTask.type==="discussion_bid"||inferredTask.type==="discussion_listen"?config.deliberation.bidReasoningEffort:config.modelSettings[playerId]!.reasoningEffort}:{}),
      eventsForCommit,deferCommit, validateCurrent: () => {
        const current = this.state(state.gameId);
        if (`${current.day}:${current.phase}` !== opportunity.epoch || this.store.journal(state.gameId, playerId).version !== opportunity.baseJournalVersion) return false;
        // Keep the persisted presentation/context fixed even across a recovery or formatter update.
        // A newly authorized event invalidates the view; private audit writes and other ballots do not.
        const opened=this.events(state.gameId).find(e=>e.type === "decision.opened" && e.payload.decisionId === opportunity.id);
        const newEvents=sourceEvents().filter(e=>e.sequence > (opened?.sequence ?? Infinity));
        return current.players.some(p=>p.id === playerId && p.alive) && contentHash(opportunity.packet) === opportunity.viewId && authorizedSources(current,newEvents,playerId).length === 0;
      } });
  }
  private target(state: GameState, key: string, actor: string, report: DecisionReportV2): {id:string|null;events:EngineEventInput[]} {
    const p = report.proposal;
    if (p.kind !== "night_action" && p.kind !== "team_point" && p.kind !== "vote") return { id: null, events: [] };
    if (!p.targets) return { id: null, events: [] };
    const id = p.targets.mode === "uniform" ? seededChoice([...p.targets.playerIds].sort(), `${state.config.seed}:action_sampling:${state.day}:${state.phase}:${key}`)! : p.targets.playerIds[0]!;
    return { id, events: p.targets.mode === "uniform" ? [{ type: "decision.random_draw", phase: state.phase, day: state.day, visibility: "player", audienceIds: [actor], payload: { playerId: actor, set: p.targets.playerIds, selected: id, stream: "action_sampling" } }] : [] };
  }
}

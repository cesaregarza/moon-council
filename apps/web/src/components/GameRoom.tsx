import { useEffect, useMemo, useRef, useState } from "react";
import type { GameEventV1 } from "@werewolf/contracts";
import { api, type DecisionDetail, type DecisionOpportunity, type GameView, type ObserverGamePayload } from "../api";
import { formatCompactCount } from "../format";

interface Props {
  gameId: string;
  onBack(): void;
  onChanged(): void;
  onClone?(config: ObserverGamePayload["game"]["config"]): void;
}

type Player = ObserverGamePayload["state"]["players"][number];
function playerName(id: unknown, players: Player[]) { return players.find((player) => player.id === id)?.name ?? String(id ?? ""); }
function eventText(event: GameEventV1, players: Player[]): string {
  const payload = event.payload;
  switch (event.type) {
    case "speech.public": case "message.public": return String(payload.text ?? "");
    case "team.point": case "team.pointed": return `${playerName(payload.playerId, players)} points at ${playerName(payload.targetId, players)}.`;
    case "team.consensus_reached": return `The pack unanimously points at ${playerName(payload.targetId, players)}.`;
    case "team.consensus_failed": return "The pack did not agree in time. No kill is attempted.";
    case "moderator.announcement": return String(payload.text ?? "");
    case "player.eliminated": return `${String(payload.playerName ?? "A player")} was eliminated${payload.roleName ? ` · ${String(payload.roleName)}` : ""}.`;
    case "vote.resolved": return payload.tied ? "The vote is tied. Nobody is eliminated." : `The council selected ${playerName(payload.targetId,players) || "nobody"}.`;
    case "game.ended": return `Game over · ${String(payload.reason ?? "completed")}`;
    case "game.budget_exhausted": return `Budget limit reached · ${String(payload.reason ?? "")}`;
    case "game.paused": return `Simulation paused · ${String(payload.reason ?? "")}`;
    case "phase.changed": return `${String(payload.to ?? "next phase").replaceAll("_", " ")} begins.`;
    case "model.failure": return `Model fallback for ${playerName(payload.playerId, players)}.`;
    case "discussion.pass": return `${playerName(payload.playerId, players)} passes.`;
    case "team.agreement_frozen": return payload.targetId
      ? `The pack agreed on ${playerName(payload.targetId, players)} (${String(payload.reason ?? "unanimous")}).`
      : `The pack failed to agree (${String(payload.reason ?? "no agreement")}). No kill is attempted.`;
    case "night.action_submitted": {
      const action = payload.action as { actorId?: unknown; actionId?: unknown; targetIds?: unknown } | undefined;
      const targets = Array.isArray(action?.targetIds) ? action.targetIds.map((id) => playerName(id, players)).join(", ") : "";
      return `${playerName(action?.actorId, players)} submits ${String(action?.actionId ?? "an action").replaceAll("_", " ")}${targets ? ` on ${targets}` : ""}.`;
    }
    case "inspection.delivered": return `${playerName(payload.actorId, players)} learns ${playerName(payload.targetId, players)} is ${String(payload.result ?? "unknown")}.`;
    case "night.resolved": {
      const eliminated = Array.isArray(payload.eliminatedPlayerIds) ? payload.eliminatedPlayerIds.map((id) => playerName(id, players)) : [];
      const protectedIds = Array.isArray(payload.protectedPlayerIds) ? payload.protectedPlayerIds.map((id) => playerName(id, players)) : [];
      const blocked = Array.isArray(payload.blockedActorIds) ? payload.blockedActorIds.map((id) => playerName(id, players)) : [];
      const parts = [
        eliminated.length ? `eliminated ${eliminated.join(", ")}` : "nobody eliminated",
        ...(protectedIds.length ? [`protected ${protectedIds.join(", ")}`] : []),
        ...(blocked.length ? [`blocked ${blocked.join(", ")}`] : []),
      ];
      return `Night resolves · ${parts.join(" · ")}.`;
    }
    case "decision.reported": return `${playerName(payload.playerId, players)} recorded a deliberation report.`;
    default: return event.type;
  }
}
function eventActor(event: GameEventV1, players: Player[]): string {
  if (["speech.public","message.public","team.point","team.pointed","decision.reported","inspection.delivered","discussion.pass","model.failure"].includes(event.type)) {
    return playerName(event.payload.playerId ?? event.payload.actorId, players) || "Player";
  }
  if (event.type === "night.action_submitted") {
    const action = event.payload.action as { actorId?: unknown } | undefined;
    return playerName(action?.actorId, players) || "Player";
  }
  if (event.type.startsWith("moderator") || event.type === "phase.changed") return "Moderator";
  return "System";
}
function recordValue(record: Record<string, unknown> | undefined, key: string): unknown { return record?.[key]; }
function stringList(value: unknown): string[] { return Array.isArray(value) ? value.map(String) : []; }

export function GameRoom({ gameId, onBack, onChanged, onClone }: Props) {
  const [payload, setPayload] = useState<ObserverGamePayload>();
  const [error, setError] = useState("");
  const [perspective, setPerspective] = useState<GameView>("public");
  const [selectedPlayer, setSelectedPlayer] = useState("");
  const [teamId, setTeamId] = useState("");
  const [replaySequence, setReplaySequence] = useState<number | null>(null);
  const [liveMaxSequence, setLiveMaxSequence] = useState(0);
  const [opportunities, setOpportunities] = useState<DecisionOpportunity[]>([]);
  const [selectedDecision, setSelectedDecision] = useState("");
  const [decisionDetail, setDecisionDetail] = useState<DecisionDetail>();
  const [busy, setBusy] = useState(false);
  const fetchRevision=useRef(0);

  async function refresh(): Promise<ObserverGamePayload | undefined> {
    const revision=++fetchRevision.current;
    try {
      const next = await api.game(gameId, { view: perspective, playerId: selectedPlayer || undefined, teamId: teamId || undefined, at: replaySequence });
      if(revision!==fetchRevision.current) return undefined;
      setPayload(next);
      if (replaySequence === null) setLiveMaxSequence((next.events ?? next.state.events ?? []).at(-1)?.sequence ?? 0);
      setError("");
      return next;
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return undefined; }
  }

  useEffect(() => {
    if (perspective === "player" && !selectedPlayer) return;
    if (perspective === "team" && !teamId) return;
    let cancelled=false;
    let source:EventSource|undefined;
    let interval:ReturnType<typeof setInterval>|undefined;
    let refreshTimer:ReturnType<typeof setTimeout>|undefined;
    void refresh().then(next=>{
      if(cancelled || replaySequence !== null || !next) return;
      const after=(next.events ?? next.state.events ?? []).at(-1)?.sequence ?? -1;
      const query=new URLSearchParams({view:perspective,after:String(after)});
      if(selectedPlayer) query.set("playerId",selectedPlayer);
      if(teamId) query.set("teamId",teamId);
      source=new EventSource(`/api/v1/games/${gameId}/events/stream?${query.toString()}`);
      source.addEventListener("game_event",()=>{
        if(refreshTimer) return;
        refreshTimer=setTimeout(()=>{refreshTimer=undefined;void refresh();},250);
      });
      interval=setInterval(()=>void refresh(),15_000);
    });
    return () => { cancelled=true;fetchRevision.current+=1;if(source) source.close();if(interval) clearInterval(interval);if(refreshTimer) clearTimeout(refreshTimer); };
  }, [gameId, perspective, selectedPlayer, teamId, replaySequence]);

  useEffect(() => {
    let cancelled=false;
    setDecisionDetail(undefined);
    if (perspective !== "moderator" && perspective !== "player") { setOpportunities([]); setDecisionDetail(undefined); return; }
    if (perspective === "player" && !selectedPlayer) return;
    void api.decisions(gameId, { view: perspective, playerId: selectedPlayer || undefined, at: replaySequence }).then((items) => {
      if(cancelled) return;
      setOpportunities(items);
      if (!items.some((item) => item.id === selectedDecision)) setSelectedDecision("");
    }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return ()=>{cancelled=true;};
  }, [gameId, perspective, selectedPlayer, replaySequence, payload?.events?.length]);

  useEffect(() => {
    let cancelled=false;
    setDecisionDetail(undefined);
    if (!selectedDecision || (perspective !== "moderator" && perspective !== "player")) { setDecisionDetail(undefined); return; }
    void api.decision(gameId, selectedDecision, { view: perspective, playerId: selectedPlayer || undefined, at: replaySequence }).then(detail=>{if(!cancelled) setDecisionDetail(detail);}).catch((reason) => {if(!cancelled) setError(reason instanceof Error ? reason.message : String(reason));});
    return ()=>{cancelled=true;};
  }, [gameId, perspective, selectedPlayer, replaySequence, selectedDecision, payload?.events?.length]);

  const allEvents = payload?.events ?? payload?.state.events ?? [];
  const events = useMemo(() => allEvents, [allEvents]);
  // Night events are moderator/team scoped, so they only appear in perspectives authorised
  // to see them; omitting them here hid the entire night from the moderator view.
  const transcript = events.filter((event) => ["speech.public", "team.point", "message.public", "team.pointed", "team.consensus_reached", "team.consensus_failed", "team.agreement_frozen", "night.action_submitted", "night.resolved", "inspection.delivered", "moderator.announcement", "player.eliminated", "vote.resolved", "game.ended", "game.budget_exhausted", "game.paused", "phase.changed", "model.failure", "discussion.pass", "decision.reported"].includes(event.type));
  const selected = payload?.state.players.find((player) => player.id === selectedPlayer) ?? payload?.state.players[0];
  const tokenTotal = payload?.usage?.reduce((sum, row) => sum + (row.totalTokens ?? 0), 0) ?? 0;
  const reportedInputTotal = payload?.usage?.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0) ?? 0;
  const cachedInputTotal = payload?.usage?.reduce((sum, row) => sum + (row.cachedInputTokens ?? 0), 0) ?? 0;
  const cacheRate = reportedInputTotal > 0 ? Math.round(cachedInputTotal / reportedInputTotal * 100) : null;
  const isTerminal = ["completed", "aborted", "budget_exhausted", "failed"].includes(payload?.game.status ?? "");
  const maxSequence = Math.max(liveMaxSequence, allEvents.at(-1)?.sequence ?? 0);

  async function control(body: Record<string, unknown>) {
    setBusy(true);
    try { await api.control(gameId, body); await refresh(); onChanged(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  function exportUrl(format: "json" | "jsonl") {
    const query = new URLSearchParams({ format, view: perspective });
    if (selectedPlayer) query.set("playerId", selectedPlayer);
    if (teamId) query.set("teamId", teamId);
    if (replaySequence !== null) query.set("at", String(replaySequence));
    return `/api/v1/games/${gameId}/export?${query.toString()}`;
  }

  if (!payload || payload.view && payload.view!==perspective) return <section className="workspace"><div className="panel empty-state">{error || "Opening the council chamber…"}</div></section>;
  const journals = payload.state.journals ?? {};
  const journal = selected ? journals[selected.id] : undefined;
  const journalRecord = journal && typeof journal === "object" ? journal as Record<string, unknown> : undefined;
  const best = decisionDetail?.opportunity.best;
  const packet = decisionDetail?.opportunity.packet;

  return (
    <section className="workspace game-room">
      <header className="game-header panel">
        <button className="ghost" onClick={onBack}>← All games</button>
        <div><div className="eyebrow">Day {payload.state.day} · {payload.state.phase.replaceAll("_", " ")}{replaySequence !== null ? ` · replay at #${replaySequence}` : ""}</div><h2>{payload.game.name}</h2></div>
        <div className="status-cluster"><span className={`status-pill ${payload.game.status}`}>{payload.game.status}</span><span className="token-pill">{perspective === "public" || perspective === "team" ? "Private usage hidden" : `${payload.state.modelCalls ?? payload.usage?.length ?? 0} attempts · ${formatCompactCount(tokenTotal)} known tokens${payload.usage?.some(row=>row.totalTokens === null) ? " + unknown usage" : ""}${cacheRate === null ? "" : ` · ${formatCompactCount(cachedInputTotal)} cached (${cacheRate}%)`}`}</span></div>
      </header>

      <div className="control-bar panel">
        {!payload.game.legacyReplayOnly && <button disabled={busy || isTerminal || payload.game.status === "running"} onClick={()=>control({action:payload.game.status === "lobby" ? "start" : "resume"})}>{payload.game.status === "lobby" ? "▶ Run game" : "▶ Resume"}</button>}
        {!payload.game.legacyReplayOnly && <button disabled={busy || isTerminal} onClick={() => control({ action: "step" })}>↦ Step phase</button>}
        {!payload.game.legacyReplayOnly && <button disabled={busy || isTerminal} onClick={() => control({ action: "step_decision" })}>↦ Step decision</button>}
        <button disabled={busy || isTerminal || payload.game.legacyReplayOnly} onClick={() => control({ action: "pause" })}>Ⅱ Pause</button>
        <button className="danger" disabled={busy || isTerminal || payload.game.legacyReplayOnly} onClick={() => control({ action: "abort" })}>Abort</button>
        {!payload.game.legacyReplayOnly && <label>Speed <select value={payload.game.speedMs ?? 0} onChange={event=>control({action:"speed",speedMs:Number(event.target.value)})}><option value={0}>Immediate</option><option value={500}>0.5s</option><option value={2000}>2s</option></select></label>}
        {payload.game.legacyReplayOnly && <span className="replay-only-label">Legacy game · run / resume / phase step are replay-only</span>}
        <label className="toggle spoiler-toggle"><input type="checkbox" checked={perspective === "moderator"} onChange={(event) => { setPerspective(event.target.checked ? "moderator" : "public"); setReplaySequence(null); }} /><span>Spoiler glass</span></label>
        <select value={perspective} onChange={(event) => { const next = event.target.value as GameView; setPerspective(next); setReplaySequence(null); if (next === "player" && !selectedPlayer) setSelectedPlayer(payload.state.players[0]?.id ?? ""); if (next === "team") setTeamId("werewolves"); else setTeamId(""); }} aria-label="Observer perspective"><option value="public">Public view</option><option value="moderator">Moderator view</option><option value="player">Player view</option><option value="team">Team view</option></select>
        {perspective === "player" && <select value={selectedPlayer} onChange={(event) => setSelectedPlayer(event.target.value)} aria-label="Player view subject"><option value="">Choose player</option>{payload.state.players.map((player) => <option key={player.id} value={player.id}>{player.name}</option>)}</select>}
        {perspective === "team" && <input className="team-input" value={teamId} placeholder="Team channel (werewolves)" onChange={(event) => setTeamId(event.target.value)} aria-label="Team channel" />}
        <a className="export-link" href={exportUrl("json")}>JSON</a><a className="export-link" href={exportUrl("jsonl")}>JSONL</a>
        {onClone && perspective === "moderator" && payload.game.config && <button className="ghost clone-button" onClick={() => onClone(payload.game.config)}>Clone setup</button>}
      </div>

      <div className="game-grid observer-grid">
        <div className="panel player-panel"><div className="section-heading"><div><div className="eyebrow">Living table</div><h3>Players</h3></div><b>{payload.state.players.filter((player) => player.alive).length}</b></div><div className="player-list">{payload.state.players.map((player) => <button className={`player-card ${player.alive ? "" : "dead"} ${selected?.id === player.id ? "selected" : ""}`} key={player.id} onClick={() => setSelectedPlayer(player.id)}><span className="avatar">{player.name.slice(-1)}</span><span><strong>{player.name}</strong><small>{player.role?.name ?? player.revealedRole ?? (player.alive ? "Role hidden" : "Unknown role")}</small></span><i>{player.alive ? "●" : "×"}</i></button>)}</div>{perspective === "moderator" && selected && <div className="journal"><div className="eyebrow">Private journal · {selected.name}</div><p>{String(recordValue(journalRecord, "strategy") || "No private strategy recorded yet.")}</p><h4>Goals</h4><ul>{stringList(recordValue(journalRecord, "goals")).map((goal) => <li key={goal}>{goal}</li>)}</ul></div>}</div>

        <div className="panel transcript-panel"><div className="section-heading"><div><div className="eyebrow">{replaySequence === null ? "Live transcript" : "Historical replay"}</div><h3>Council record</h3></div><button className="ghost" onClick={() => setReplaySequence(replaySequence === null ? maxSequence : null)}>{replaySequence === null ? "Enter replay" : "Return live"}</button></div>{replaySequence !== null && <div className="replay-control"><input type="range" min={0} max={maxSequence} value={Math.min(replaySequence, maxSequence)} onChange={(event) => setReplaySequence(Number(event.target.value))} /><span>Visible event #{replaySequence} / {maxSequence}</span></div>}<div className="transcript">{transcript.length === 0 && <div className="empty-state">No events are visible in this perspective.</div>}{transcript.map((event) => <article className={`event ${event.type.replaceAll(".", "-")} ${event.visibility}`} key={event.id}><div className="event-meta"><span>{eventActor(event, payload.state.players)}</span><small>#{event.sequence} · {event.visibility}</small></div><p>{eventText(event, payload.state.players)}</p>{event.type === "vote.resolved" && <details><summary>Published individual ballots and tally</summary><pre>{JSON.stringify({ballots:event.payload.ballots,tally:event.payload.tally},null,2)}</pre></details>}{event.type === "speech.public" && Array.isArray(event.payload.acts) && <small>{(event.payload.acts as {kind:string;targetId:string|null}[]).map(act=>`${act.kind.replaceAll("_"," ")} ${act.targetId ? playerName(act.targetId,payload.state.players) : ""}`).join(" · ")} · Claims are unverified</small>}</article>)}</div></div>

        <aside className="panel audit-panel"><div className="eyebrow">Observer ledger</div><h3>Event timeline</h3><div className="timeline">{events.slice().reverse().slice(0, 40).map((event) => <div key={event.id}><span className={`timeline-dot ${event.visibility}`} /><p>{event.type}</p><small>#{event.sequence} · D{event.day}</small></div>)}</div></aside>
      </div>

      {(perspective === "moderator" || perspective === "player") && (
        <section className="panel"><div className="section-heading"><div><div className="eyebrow">Historical private state · {selected?.name}</div><h3>{selected?.role?.name ?? "Private journal"}</h3></div></div><details><summary>Beliefs, hypotheses, plans, and public deception</summary><pre className="packet-inspector">{JSON.stringify(journalRecord ?? {},null,2)}</pre></details><details><summary>Attempt usage (unknown is not zero)</summary><pre className="packet-inspector">{JSON.stringify(payload.usage ?? [],null,2)}</pre></details></section>
      )}
      {(perspective === "moderator" || perspective === "player") && (
        <section className="decision-layout">
          <div className="panel decision-list">
            <div className="section-heading"><div><div className="eyebrow">Decision opportunities</div><h3>Decision ledger</h3></div><b>{opportunities.length}</b></div>
            {opportunities.length === 0 && <div className="empty-state">No decision opportunities for this view or replay position.</div>}
            {opportunities.map((item) => <button key={item.id} className={`decision-row ${item.id === selectedDecision ? "selected" : ""}`} onClick={() => setSelectedDecision(item.id)}><span><strong>{playerName(item.playerId, payload.state.players)} · {(item.taskType ?? item.kind).replaceAll("_", " ")}</strong><small>{item.playerId} · D{item.day} · {item.status}</small></span><i>r{item.recovery}</i></button>)}
          </div>
          <div className="panel decision-detail">
            {!decisionDetail ? <div className="empty-state">Select a decision to inspect its exact context packet and report.</div> : (
              <>
                <div className="section-heading"><div><div className="eyebrow">{decisionDetail.opportunity.status} · {decisionDetail.opportunity.id}</div><h3>{playerName(decisionDetail.opportunity.playerId, payload.state.players)} · {(decisionDetail.opportunity.taskType ?? decisionDetail.opportunity.kind).replaceAll("_", " ")}</h3></div><span className="status-pill">{decisionDetail.turns.length} turns</span></div>
                <div className="decision-columns">
                  <div>
                    <h4>Context packet</h4>
                    <p className="muted compact">Exact player context · {Array.isArray(recordValue(packet, "sources")) ? `${(recordValue(packet, "sources") as unknown[]).length} sources` : "source count unavailable"}</p>
                    <div className="packet-tags"><span>{String(recordValue(packet, "phase") ?? "phase")}</span><span>{String(recordValue(packet, "day") ?? "day")}</span><span>{Array.isArray(recordValue(packet, "legalActions")) ? `${(recordValue(packet, "legalActions") as unknown[]).length} legal actions` : "legal actions"}</span></div>
                    <details className="packet-inspector"><summary>Inspect exact packet</summary><pre>{JSON.stringify(packet, null, 2)}</pre></details>
                  </div>
                  <div>
                    <h4>{decisionDetail.opportunity.taskType ? "Application record" : "Best report"}</h4>
                    {best ? <>
                      <p className="decision-summary">{String(recordValue(best, "summary") ?? "No summary")}</p>
                      <div className="decision-facts"><span>Observations · {stringList(recordValue(best, "observations")).length}</span><span>Proposal · {typeof recordValue(best, "proposal") === "object" ? "recorded" : "none"}</span><span>Journal patch · {Array.isArray(recordValue(best, "journalPatch")) ? (recordValue(best, "journalPatch") as unknown[]).length : 0}</span></div>
                      <div className="alternative-list">{Array.isArray(recordValue(best, "alternatives")) && (recordValue(best, "alternatives") as Record<string, unknown>[]).map((alternative) => <div key={String(alternative.id)} className={alternative.id === recordValue(best, "selectedAlternativeId") ? "alternative selected" : "alternative"}><strong>{String(alternative.description)}</strong><small>＋ {String(alternative.advantage)} · − {String(alternative.drawback)}</small></div>)}</div>
                      {decisionDetail.opportunity.bestSubmission && <details className="packet-inspector"><summary>Inspect small model submission</summary><pre>{JSON.stringify(decisionDetail.opportunity.bestSubmission,null,2)}</pre></details>}
                      <details className="packet-inspector"><summary>Inspect application proposal &amp; journal patch</summary><pre>{JSON.stringify({ observations: recordValue(best, "observations"), proposal: recordValue(best, "proposal"), journalPatch: recordValue(best, "journalPatch") }, null, 2)}</pre></details>
                    </> : <p className="muted">No committed report yet.</p>}
                  </div>
                </div>
                <details><summary>Full report turns, continuation verdicts, and attempt metadata</summary><pre className="packet-inspector">{JSON.stringify({turns:decisionDetail.turns,attempts:decisionDetail.attempts,events:decisionDetail.events},null,2)}</pre></details>
                <div className="turn-strip"><h4>Attempts, turns &amp; report events</h4>{decisionDetail.attempts.map((attempt) => <span key={attempt.id} className="attempt-chip">{attempt.provider ?? "provider"} · {attempt.status}</span>)}{decisionDetail.turns.map((turn) => <span key={`${turn.decisionId}:${turn.turnIndex}`} className="attempt-chip">turn {turn.turnIndex + 1} · {String(recordValue(turn.report, "control") ? (recordValue(turn.report, "control") as Record<string, unknown>).kind : "report")}</span>)}{decisionDetail.events.map((event) => <span key={event.id} className="attempt-chip">{event.type} · {String(event.payload.verdict ?? event.payload.continuation ?? "recorded")}</span>)}</div>
              </>
            )}
          </div>
        </section>
      )}
      {error && <div className="error-banner floating">{error}</div>}
    </section>
  );
}

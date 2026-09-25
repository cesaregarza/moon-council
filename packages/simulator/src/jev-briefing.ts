import type { PlayerContextV2, V3TaskKind } from "@werewolf/contracts";
import { journalText } from "./freeform-journal";

/** Journal-first decision packet. Never copy the full LLM evidence or role catalog. */
export function jevBriefing(packet: PlayerContextV2, task: V3TaskKind | undefined) {
  const name = (id: unknown) => packet.players.find(p => p.id === id)?.name ?? String(id);
  const sources = packet.sources;
  const facts: string[] = [];
  for (const source of sources) {
    const d = source.data;
    if (source.type === "inspection.delivered" && source.scope === "player")
      facts.push(`Night ${source.day}: your verified inspection of ${name(d.targetId)} returned ${JSON.stringify(d.result)}.`);
    if (source.type === "vote.resolved" && source.scope === "public" && Array.isArray(d.ballots)) {
      const ballots = d.ballots as {voterId: string; targetId: string | null}[];
      facts.push(`Day ${source.day} ballots: ${ballots.map(b => `${name(b.voterId)} -> ${b.targetId === null ? "abstain" : name(b.targetId)}`).join("; ")}. Outcome: ${d.targetId ? `${name(d.targetId)} eliminated` : "no elimination"}.`);
    }
  }
  if (task === "team_point_choice") {
    // Only the latest point per ally matters for the current consensus.
    const points = new Map<unknown, unknown>();
    for (const s of sources) if (s.type === "team.point" && s.scope === "team" && s.day === packet.day && s.data.playerId) points.set(s.data.playerId, s.data.targetId);
    facts.push(points.size ? `Current pack points: ${[...points].map(([actor, target]) => `${name(actor)} -> ${name(target)}`).join("; ")}.` : "No pack points yet; initial choices may be simultaneous.");
  }
  const scheduling = task === "discussion_score" || task === "discussion_listen";
  if (scheduling) for (const id of packet.responseDocket) {
    const source = sources.find(s => s.id === id && s.type === "speech.public" && s.scope === "public");
    const acts = source?.data.acts;
    if (Array.isArray(acts)) for (const act of acts) {
      if (act && typeof act === "object" && (act.kind === "accusation" || act.kind === "challenge"))
        facts.push(`Unanswered ${act.kind} by ${name(source!.data.playerId)} to ${name(act.targetId)}: ${String(act.claim)} (unverified claim).`);
    }
  }
  const role = packet.self.role;
  const action = task === "night_choice" || task === "team_point_choice" ? role.actions.find(a => a.id === packet.legalActions[0]?.actionId) : undefined;
  const taskRules = task === "vote_choice"
    ? `Cast an elimination ballot. Your vote weight is ${role.passives.voteWeight}. Highest nonzero tally eliminates; ties eliminate nobody. Abstaining can let one other vote decide the outcome. Ballots are sealed until resolution, then revealed.`
    : task === "team_point_choice" ? String(packet.rules.pack)
    : task === "night_choice" ? `Choose a legal target for your ${action?.id ?? "night action"}. Action: ${JSON.stringify(action ?? {})}. The supplied targets already enforce all restrictions.`
    : `Score urgency and listening interest using the journal's reasons. ${String(packet.rules.speakerPriorityFormula)}. Readiness is independent of urgency. A useful defense can deserve attention even from a suspect.`;
  return {
    journal: journalText(packet.journal) || "No private notes yet; avoid treating absence of evidence as evidence of guilt.",
    situation: [
      `You are ${packet.self.name} (${packet.self.id}), ${role.name}, faction ${role.alignment}. Day ${packet.day}, ${packet.phase}.`,
      `Objective: ${JSON.stringify(role.winCondition)}. Village wins when all wolves are eliminated; wolves win at living parity.`,
      `Living: ${packet.players.filter(p => p.alive).map(p => `${p.name} (${p.id})`).join(", ")}.`,
      `Dead: ${packet.players.filter(p => !p.alive).map(p => `${p.name}${p.revealedRole ? ` (${p.revealedRole})` : " (role unknown)"}`).join(", ") || "none"}.`,
      `Starting roles: ${Object.entries(packet.rules.roleCounts as Record<string, number>).map(([r, n]) => `${n} ${r}`).join(", ")}.`,
      ...(packet.knownAllies.length ? [`Known allies: ${packet.knownAllies.map(p => `${p.name} (${p.id})`).join(", ")}.`] : []),
    ].join("\n"),
    facts: facts.join("\n") || "No additional verified results or resolved ballots.",
    task: {type: task, rules: taskRules},
  };
}

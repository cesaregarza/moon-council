import { useMemo, useState } from "react";
import { seatName } from "@werewolf/contracts";
import type { CreateGameV2Request, RoleDefinitionV1, StoredGameConfig } from "@werewolf/contracts";
import { api } from "../api";

interface Props {
  roles: RoleDefinitionV1[];
  onCreated(gameId: string): void;
  initialConfig?: StoredGameConfig;
}

const standardRoles: Record<string, string[]> = {
  "standard-8-v2": ["werewolf", "werewolf", "seer", "doctor", "villager", "villager", "villager", "villager"],
  "standard-8-v3": ["werewolf", "werewolf", "seer", "bodyguard", "villager", "villager", "villager", "villager"],
};
const lunaModel = "gpt-5.6-luna";

export function GameSetup({ roles, onCreated, initialConfig }: Props) {
  const initialV2 = initialConfig?.schemaVersion === "game_config_v2" ? initialConfig : undefined;
  const [name, setName] = useState(initialConfig?.name ?? "Moon Council");
  const [seed, setSeed] = useState(initialConfig?.seed ?? crypto.randomUUID().slice(0, 8));
  const [preset, setPreset] = useState<"standard-8-v2" | "standard-8-v3" | "custom-v2">(initialV2?.preset ?? (initialConfig ? "custom-v2" : "standard-8-v3"));
  const [seatCount, setSeatCount] = useState(initialConfig?.seats.length ?? 8);
  const [models, setModels] = useState<Record<number, string>>(() =>
    Object.fromEntries((initialConfig?.seats ?? []).map((seat, index) => [index, seat.model ?? ""])),
  );
  const [personalities, setPersonalities] = useState<Record<number, string>>(() =>
    Object.fromEntries((initialConfig?.seats ?? []).map((seat, index) => [index, seat.personality])),
  );
  const [roleIds, setRoleIds] = useState(() =>
    initialConfig?.roleDeck?.map((role) => role.id) ?? standardRoles["standard-8-v3"]!,
  );
  const [narration, setNarration] = useState(initialConfig?.moderatorNarration ?? false);
  // Revealing a dead player's role hands the table a hard fact to reason from. Weaker
  // models lean on it; stronger ones should not need it, so it is an experiment variable.
  const [revealRoles, setRevealRoles] = useState(initialConfig?.revealRolesOnDeath ?? true);
  const [speedMs, setSpeedMs] = useState(initialConfig?.speedMs ?? 500);
  const [deliberationMode, setDeliberationMode] = useState<"single" | "gated">(initialV2?.deliberation.mode ?? "gated");
  const [maxCalls, setMaxCalls] = useState(initialV2?.deliberation.maxCalls ?? 3);
  const [optionalDayCalls, setOptionalDayCalls] = useState(initialV2?.deliberation.optionalDayCalls ?? 4);
  const [optionalNightCalls, setOptionalNightCalls] = useState(initialV2?.deliberation.optionalNightCalls ?? 2);
  const [requestTimeoutMs, setRequestTimeoutMs] = useState(initialV2?.deliberation.requestTimeoutMs ?? 120_000);
  const [episodeTimeoutMs, setEpisodeTimeoutMs] = useState(initialV2?.deliberation.episodeTimeoutMs ?? 300_000);
  const [maxTotalTokens, setMaxTotalTokens] = useState(initialV2?.maxTotalTokens ?? 2_000_000);
  const [maxContextTokens, setMaxContextTokens] = useState(initialV2?.deliberation.maxContextTokens ?? 8_000);
  const [maxJournalTokens, setMaxJournalTokens] = useState(initialV2?.deliberation.maxJournalTokens ?? 1_200);
  const [digestChars] = useState(initialV2?.deliberation.digestChars ?? 140);
  const [speakerBias, setSpeakerBias] = useState(initialV2?.discussion.speakerBias ?? 0.25);
  const [maxParallelDecisions, setMaxParallelDecisions] = useState(initialV2?.discussion.maxParallelDecisions ?? 4);
  const [maxCycles, setMaxCycles] = useState(initialConfig?.safety.maxCycles ?? 8);
  const [maxModelCalls, setMaxModelCalls] = useState(initialConfig?.safety.maxModelCalls ?? 500);
  const [maxOutputTokens, setMaxOutputTokens] = useState(initialConfig?.safety.maxOutputTokens ?? 600);
  const [maxWallClockMs, setMaxWallClockMs] = useState(initialConfig?.safety.maxWallClockMs ?? 1_800_000);
  const [reasoningEffort, setReasoningEffort] = useState("xhigh");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const latestRoles = useMemo(() => {
    const latest = new Map<string, RoleDefinitionV1>();
    for (const role of roles) {
      const current = latest.get(role.id);
      if (!current || role.version > current.version) latest.set(role.id, role);
    }
    return [...latest.values()];
  }, [roles]);
  const fallbackRole = latestRoles.find((role) => role.id === "villager")?.id ?? latestRoles[0]?.id ?? "villager";
  const seats = useMemo(
    () => Array.from({ length: seatCount }, (_, index) => ({
      id: `player-${index + 1}`,
      name: seatName(index),
      personality: personalities[index] ?? "Observant, concise, and socially strategic.",
      ...(models[index] ? { model: models[index] } : {}),
    })),
    [models, personalities, seatCount],
  );

  function changePreset(next: "standard-8-v2" | "standard-8-v3" | "custom-v2") {
    setPreset(next);
    const roster = standardRoles[next];
    if (roster) {
      setSeatCount(8);
      setRoleIds(roster);
    }
  }

  function resize(next: number) {
    const count = Math.max(5, Math.min(16, next || 8));
    setSeatCount(count);
    setMaxParallelDecisions((current) => Math.min(current, count));
    setRoleIds((current) => Array.from({ length: count }, (_, index) => current[index] ?? (index === 0 ? "werewolf" : fallbackRole)));
  }

  async function create() {
    setBusy(true);
    setError("");
    try {
      const input: CreateGameV2Request = {
        name,
        seed,
        preset,
        seats,
        roleRefs: roleIds.slice(0, seatCount).map((id) => ({ id })),
        revealRolesOnDeath: revealRoles,
        moderatorNarration: narration,
        discussion: { readyQuorum: 2 / 3, maxFollowUpsPerPlayer: 2, maxFollowUpSlotsFactor: 0.5, speakerSelection: "listener_auction", speakerBias, maxParallelDecisions },
        safety: { maxCycles, maxModelCalls, maxOutputTokens, maxWallClockMs },
        speedMs,
        deliberation: {
          mode: deliberationMode,
          maxCalls,
          optionalDayCalls,
          optionalNightCalls,
          requestTimeoutMs,
          episodeTimeoutMs,
          maxContextTokens,
          maxJournalTokens,
          bidReasoningEffort: "medium",
          digestChars,
        },
        maxTotalTokens,
        reasoningEffort,
      };
      const game = await api.createGame(input);
      onCreated(game.game.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="workspace setup-grid">
      <div className="panel setup-main">
        <div className="eyebrow">Agent protocol · V3.1</div>
        <h2>{initialConfig ? "Clone the council" : "Seat the council"}</h2>
        <p className="muted">A normal Day 1 ends in an elimination vote before Night 1. Stable public evidence references and cache-aware request ordering keep every player's information isolated.</p>

        <div className="preset-picker" role="group" aria-label="Game preset">
          <button className={preset === "standard-8-v3" ? "preset-card selected" : "preset-card"} onClick={() => changePreset("standard-8-v3")}>
            <strong>Standard eight</strong><span>2 wolves · Seer · Bodyguard · 4 villagers</span><small>Recommended baseline</small>
          </button>
          <button className={preset === "standard-8-v2" ? "preset-card selected" : "preset-card"} onClick={() => changePreset("standard-8-v2")}>
            <strong>Standard eight (Doctor)</strong><span>2 wolves · Seer · Doctor · 4 villagers</span><small>Frozen prior roster</small>
          </button>
          <button className={preset === "custom-v2" ? "preset-card selected" : "preset-card"} onClick={() => changePreset("custom-v2")}>
            <strong>Custom roles</strong><span>Choose seats, roles, and budgets</span><small>Experimental roles · V3.1 agents</small>
          </button>
        </div>

        <div className="form-grid">
          <label>Game name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>Seed<input value={seed} onChange={(event) => setSeed(event.target.value)} /></label>
          <label>Seats<input type="number" min={5} max={16} disabled={preset !== "custom-v2"} value={seatCount} onChange={(event) => resize(Number(event.target.value))} /></label>
          <label>Phase delay<select value={speedMs} onChange={(event) => setSpeedMs(Number(event.target.value))}><option value={0}>Instant</option><option value={500}>0.5 seconds</option><option value={1500}>1.5 seconds</option><option value={4000}>4 seconds</option></select></label>
        </div>

        <div className="section-heading setup-section-heading"><div><div className="eyebrow">Resolved model</div><h3>Player seats</h3></div><span className="resolved-badge">Provider default · {reasoningEffort}</span></div>
        <div className="seat-list">
          {seats.map((seat, index) => (
            <article className="seat-row" key={seat.id}>
              <span className="seat-number">{String(index + 1).padStart(2, "0")}</span>
              <div><strong>{seat.name}</strong><input aria-label={`${seat.name} personality`} value={personalities[index] ?? ""} placeholder="Optional personality override" onChange={(event) => setPersonalities({ ...personalities, [index]: event.target.value })} /></div>
              <select aria-label={`${seat.name} role`} disabled={preset !== "custom-v2"} value={roleIds[index] ?? fallbackRole} onChange={(event) => { const next = [...roleIds]; next[index] = event.target.value; setRoleIds(next); }}>
                {latestRoles.map((role) => <option key={`${role.id}:${role.version}`} value={role.id}>{role.name}{["roleblocker", "mayor"].includes(role.id) ? " · experimental" : ""}</option>)}
              </select>
              <select className="seat-model-select" aria-label={`${seat.name} model`} value={seat.model ?? ""} onChange={(event) => setModels({ ...models, [index]: event.target.value })}><option value="">Provider default</option><option value={lunaModel}>GPT-5.6 Luna</option><option value="gpt-5.6-sol">GPT-5.6 Sol</option><option value="gpt-5.6-terra">GPT-5.6 Terra</option></select>
            </article>
          ))}
        </div>

        <div className="section-heading setup-section-heading"><div><div className="eyebrow">Deliberation policy</div><h3>Bounded private reasoning</h3></div><span className="token-pill">2M token ceiling</span></div>
        <div className="policy-mode">
          <label className="radio-card"><input type="radio" checked={deliberationMode === "single"} onChange={() => setDeliberationMode("single")} /> <span><strong>Single</strong><small>One small action response</small></span></label>
          <label className="radio-card"><input type="radio" checked={deliberationMode === "gated"} onChange={() => setDeliberationMode("gated")} /> <span><strong>Gated</strong><small>One optional consequential reconsideration</small></span></label>
        </div>
        <details className="advanced-details">
          <summary>Advanced discussion &amp; budget controls</summary>
          <div className="form-grid compact-grid">
            <label>Max calls<input type="number" min={1} max={3} value={maxCalls} onChange={(event) => setMaxCalls(Number(event.target.value))} /></label>
            <label>Optional day calls<input type="number" min={0} max={12} value={optionalDayCalls} onChange={(event) => setOptionalDayCalls(Number(event.target.value))} /></label>
            <label>Optional night calls<input type="number" min={0} max={6} value={optionalNightCalls} onChange={(event) => setOptionalNightCalls(Number(event.target.value))} /></label>
            <label>Speaker bias<input type="number" min={0.01} max={1} step={0.01} value={speakerBias} onChange={(event) => setSpeakerBias(Number(event.target.value))} /></label>
            <label>Decision concurrency<input type="number" min={1} max={seatCount} value={maxParallelDecisions} onChange={(event) => setMaxParallelDecisions(Math.max(1,Math.min(seatCount,Number(event.target.value))))} /><small>{maxParallelDecisions === 1 ? "Sequential · strongest warm-cache opportunity, highest latency" : maxParallelDecisions >= seatCount ? "All seats at once · lowest latency, weakest first-wave reuse" : `Pool of ${maxParallelDecisions} · latency/cache compromise`}</small></label>
            <label>Max total tokens<input type="number" min={1000} max={100000000} step={10000} value={maxTotalTokens} onChange={(event) => setMaxTotalTokens(Number(event.target.value))} /></label>
            <label>Request timeout (ms)<input type="number" min={1000} max={300000} step={1000} value={requestTimeoutMs} onChange={(event) => setRequestTimeoutMs(Number(event.target.value))} /></label>
            <label>Episode timeout (ms)<input type="number" min={1000} max={600000} step={1000} value={episodeTimeoutMs} onChange={(event) => setEpisodeTimeoutMs(Number(event.target.value))} /></label>
            <label>Context tokens<input type="number" min={1000} max={32000} step={500} value={maxContextTokens} onChange={(event) => setMaxContextTokens(Number(event.target.value))} /></label>
            <label>Journal tokens<input type="number" min={200} max={4000} step={100} value={maxJournalTokens} onChange={(event) => setMaxJournalTokens(Number(event.target.value))} /></label>
            <label>Max cycles<input type="number" min={1} max={30} value={maxCycles} onChange={(event) => setMaxCycles(Number(event.target.value))} /></label>
            <label>Max model calls<input type="number" min={20} max={10000} value={maxModelCalls} onChange={(event) => setMaxModelCalls(Number(event.target.value))} /></label>
            <label>Output tokens<input type="number" min={100} max={4000} step={100} value={maxOutputTokens} onChange={(event) => setMaxOutputTokens(Number(event.target.value))} /></label>
            <label>Wall clock (ms)<input type="number" min={60000} max={86400000} step={60000} value={maxWallClockMs} onChange={(event) => setMaxWallClockMs(Number(event.target.value))} /></label>
            <label>Reasoning effort<select value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value)}><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">Xhigh</option></select></label>
          </div>
        </details>

        {error && <div className="error-banner">{error}</div>}
        <div className="action-row"><label className="toggle"><input type="checkbox" checked={narration} onChange={(event) => setNarration(event.target.checked)} /><span>LLM moderator narration</span></label><label className="toggle"><input type="checkbox" checked={revealRoles} onChange={(event) => setRevealRoles(event.target.checked)} /><span>Reveal roles on death</span></label><button className="primary" disabled={busy || latestRoles.length === 0} onClick={create}>{busy ? "Preparing…" : initialConfig ? "Clone simulation" : "Create V3.1 simulation"}</button></div>
      </div>
      <aside className="panel rule-card"><div className="moon-mark">◒</div><h3>V3.1 contract</h3><dl><div><dt>Preset</dt><dd>{preset === "standard-8-v3" ? "Standard 8 · Bodyguard" : preset === "standard-8-v2" ? "Standard 8 · Doctor" : "Custom"}</dd></div><div><dt>First cycle</dt><dd>Day 1 · discussion and elimination vote</dd></div><div><dt>Speaking</dt><dd>Reactive bid → selected speech · bias {speakerBias}</dd></div><div><dt>Concurrency</dt><dd>{maxParallelDecisions === 1 ? "Sequential cache-first" : maxParallelDecisions >= seatCount ? `All ${seatCount} seats at once` : `${maxParallelDecisions}-call worker pool`}</dd></div><div><dt>Evidence</dt><dd>Stable public E refs · private R refs</dd></div><div><dt>Resolved model</dt><dd>{models[0] ? `${models[0]} · ${reasoningEffort}` : `Provider default · ${reasoningEffort}`}</dd></div><div><dt>Bid compute</dt><dd>Medium · actions {reasoningEffort}</dd></div><div><dt>Deliberation</dt><dd>{deliberationMode === "gated" ? "Bounded reconsideration" : "Single action"}</dd></div><div><dt>Budgets</dt><dd>{Math.round(requestTimeoutMs / 1000)}s request · {Math.round(episodeTimeoutMs / 1000)}s episode</dd></div><div><dt>Experimental</dt><dd>Roleblocker · Mayor</dd></div></dl></aside>
    </section>
  );
}

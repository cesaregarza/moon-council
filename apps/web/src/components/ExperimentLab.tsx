import { useState } from "react";
import type { ExperimentSpecV1 } from "@werewolf/contracts";
import { api, type ExperimentRecord, type GameListItem } from "../api";
import { formatCompactCount } from "../format";

interface Props {
  games: GameListItem[];
  experiments: ExperimentRecord[];
  onCreated(): void;
}

export function ExperimentLab({ games, experiments, onCreated }: Props) {
  const [gameId, setGameId] = useState(games[0]?.game.id ?? "");
  const [runs, setRuns] = useState(10);
  const [concurrency, setConcurrency] = useState(1);
  const [error, setError] = useState("");
  const [rates,setRates]=useState("{}");
  async function control(id:string,action:"pause"|"resume"){try{await api.controlExperiment(id,action);onCreated();}catch(reason){setError(reason instanceof Error?reason.message:String(reason));}}

  async function create() {
    setError("");
    try {
      if (!gameId) throw new Error("Create a game configuration first.");
      const source = await api.game(gameId, { view: "moderator" });
      if (!source.game.config) throw new Error("The selected game has no stored configuration.");
      const spec: ExperimentSpecV1 | Record<string, unknown> = source.game.config.schemaVersion === "game_config_v2"
        ? { schemaVersion: "experiment_v2", name: `${source.game.name} study`, baseConfig: source.game.config, runs, concurrency, baseSeed: `${source.game.config.seed}-batch`, pricingPerMillionTokens: {} }
        : { schemaVersion: "experiment_v1", name: `${source.game.name} study`, baseConfig: source.game.config, runs, concurrency, baseSeed: `${source.game.config.seed}-batch`, pricingPerMillionTokens: {} } as ExperimentSpecV1;
      spec.pricingPerMillionTokens=JSON.parse(rates);
      await api.createExperiment(spec);
      onCreated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <section className="workspace experiment-layout">
      <div className="panel experiment-create">
        <div className="eyebrow">Repeatable trials</div>
        <h2>Launch an experiment</h2>
        <label>
          Base game
          <select value={gameId} onChange={(event) => setGameId(event.target.value)}>
            <option value="">Select a configured game</option>
            {games.map((game) => <option key={game.game.id} value={game.game.id}>{game.game.name}</option>)}
          </select>
        </label>
        <div className="form-grid">
          <label>Runs<input type="number" min={1} max={50} value={runs} onChange={(event) => setRuns(Number(event.target.value))} /></label>
          <label>Concurrency<input type="number" min={1} max={3} value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))} /></label>
        </div>
        {error && <div className="error-banner">{error}</div>}
        <details><summary>Per-model cost rates (optional)</summary><label>USD per million tokens<textarea value={rates} onChange={event=>setRates(event.target.value)} placeholder={'{"model-id":{"input":0,"output":0}}'} /></label><p className="muted compact">Unknown usage or missing rates makes the cost estimate a lower bound.</p></details>
        <button className="primary wide" onClick={create}>Queue experiment</button>
      </div>
      <div className="experiment-results">
        {experiments.length === 0 && <div className="empty-state">No experiments yet. Start with a small ten-game batch.</div>}
        {experiments.map((experiment) => (
          <article className="panel experiment-card" key={experiment.id}>
            <div className="card-heading">
              <div><div className="eyebrow">{experiment.status}</div><h3>{experiment.name}</h3></div>
              <strong>{experiment.summary?.runsCompleted ?? 0}/{experiment.spec.runs}</strong>
            </div>
            {experiment.summary ? (
              <>
                <div className="metric-row">
                  {Object.entries(experiment.summary.winsByAlignment).map(([alignment, count]) => (
                    <div key={alignment}><small>{alignment} wins</small><b>{count}</b></div>
                  ))}
                  <div><small>vote accuracy</small><b>{Math.round(experiment.summary.voteAccuracy * 100)}%</b></div>
                  <div><small>avg. days</small><b>{experiment.summary.averageCycles.toFixed(1)}</b></div>
                  {experiment.summary.completed !== undefined && <div><small>completed</small><b>{experiment.summary.completed}</b></div>}
                  {experiment.summary.interrupted !== undefined && <div><small>interrupted</small><b>{experiment.summary.interrupted}</b></div>}
                  {experiment.summary.failed !== undefined && <div><small>failed</small><b>{experiment.summary.failed}</b></div>}
                  {experiment.summary.budgetTruncated !== undefined && <div><small>budget truncated</small><b>{experiment.summary.budgetTruncated}</b></div>}
                </div>
                <div className="bar-track">
                  <span style={{ width: `${(experiment.summary.runsCompleted / experiment.spec.runs) * 100}%` }} />
                </div>
                <p className="muted compact">
                  {formatCompactCount(experiment.summary.inputTokens + experiment.summary.outputTokens)} tokens · {experiment.summary.followUps} follow-ups · {experiment.summary.modelFailures} failures{experiment.summary.validOutcomeDenominator !== undefined ? ` · ${experiment.summary.validOutcomeDenominator} valid outcomes` : ""}
                </p>
              </>
            ) : <div className="bar-track"><span className="indeterminate" /></div>}
            {experiment.error && <div className="error-banner">{experiment.error}</div>}
            {experiment.status === "paused" && <button onClick={()=>control(experiment.id,"resume")}>Resume unresolved runs</button>}
            {["running","queued"].includes(experiment.status) && <button onClick={()=>control(experiment.id,"pause")}>Pause batch</button>}
          </article>
        ))}
      </div>
    </section>
  );
}

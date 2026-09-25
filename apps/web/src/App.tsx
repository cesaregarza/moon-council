import { useCallback, useEffect, useState } from "react";
import type { RoleDefinitionV1, StoredGameConfig } from "@werewolf/contracts";
import { api, type ExperimentRecord, type GameListItem, type ProviderHealth } from "./api";
import { ExperimentLab } from "./components/ExperimentLab";
import { GameRoom } from "./components/GameRoom";
import { GameSetup } from "./components/GameSetup";
import { RoleLab } from "./components/RoleLab";

type Tab = "games" | "new" | "roles" | "experiments";

export default function App() {
  const [tab, setTab] = useState<Tab>("games");
  const [roles, setRoles] = useState<RoleDefinitionV1[]>([]);
  const [games, setGames] = useState<GameListItem[]>([]);
  const [experiments, setExperiments] = useState<ExperimentRecord[]>([]);
  const [health, setHealth] = useState<ProviderHealth>();
  const [selectedGame, setSelectedGame] = useState("");
  const [cloneConfig, setCloneConfig] = useState<StoredGameConfig>();
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [nextRoles, nextGames, nextExperiments, nextHealth] = await Promise.all([
        api.roles(),
        api.games(),
        api.experiments(),
        api.health(),
      ]);
      setRoles(nextRoles);
      setGames(nextGames);
      setExperiments(nextExperiments);
      setHealth(nextHealth);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 3_000);
    return () => clearInterval(interval);
  }, [refresh]);

  if (selectedGame) {
    return (
      <GameRoom
        gameId={selectedGame}
        onBack={() => setSelectedGame("")}
        onChanged={() => void refresh()}
        onClone={(config) => {
          setCloneConfig(config);
          setSelectedGame("");
          setTab("new");
        }}
      />
    );
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-sigil">◒</span>
          <div>
            <strong>Moon Council</strong>
            <small>Peer multi-agent research</small>
          </div>
        </div>
        <nav>
          <button className={tab === "games" ? "active" : ""} onClick={() => setTab("games")}>
            <span>⌁</span> Simulations
          </button>
          <button
            className={tab === "new" ? "active" : ""}
            onClick={() => {
              setCloneConfig(undefined);
              setTab("new");
            }}
          >
            <span>＋</span> New game
          </button>
          <button className={tab === "roles" ? "active" : ""} onClick={() => setTab("roles")}>
            <span>◇</span> Role workshop
          </button>
          <button
            className={tab === "experiments" ? "active" : ""}
            onClick={() => setTab("experiments")}
          >
            <span>∷</span> Experiments
          </button>
        </nav>
        <div className="provider-card">
          <span className={`provider-light ${health?.providerReady ? "online" : ""}`} />
          <div>
            <strong>{health?.provider ?? "connecting"}</strong>
            <small>{health?.statusDetail ?? "Checking provider"}</small>
          </div>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div>
            <div className="eyebrow">Research console</div>
            <h1>
              {tab === "games"
                ? "Simulations"
                : tab === "new"
                  ? "Create game"
                  : tab === "roles"
                    ? "Role workshop"
                    : "Experiments"}
            </h1>
          </div>
          <button
            className="primary"
            onClick={() => {
              setCloneConfig(undefined);
              setTab("new");
            }}
          >
            ＋ New simulation
          </button>
        </header>

        {tab === "games" && (
          <section className="workspace">
            <div className="overview">
              <div className="stat">
                <small>Total games</small>
                <strong>{games.length}</strong>
              </div>
              <div className="stat">
                <small>Active</small>
                <strong>
                  {
                    games.filter((game) =>
                      ["running", "queued", "stepping"].includes(game.game.status),
                    ).length
                  }
                </strong>
              </div>
              <div className="stat">
                <small>Role versions</small>
                <strong>{roles.length}</strong>
              </div>
              <div className="stat">
                <small>Experiments</small>
                <strong>{experiments.length}</strong>
              </div>
            </div>
            <div className="game-cards">
              {games.length === 0 && (
                <button className="panel empty-game" onClick={() => setTab("new")}>
                  <span>◒</span>
                  <strong>Seat your first council</strong>
                  <small>Build a role deck, choose a seed, and observe the debate.</small>
                </button>
              )}
              {games.map((item) => (
                <button
                  className="panel game-card"
                  key={item.game.id}
                  onClick={() => setSelectedGame(item.game.id)}
                >
                  <div className="card-heading">
                    <div>
                      <div className="eyebrow">
                        Day {item.state.day} · {item.state.phase.replaceAll("_", " ")}
                      </div>
                      <h3>{item.game.name}</h3>
                    </div>
                    <span className={`status-pill ${item.game.status}`}>{item.game.status}</span>
                  </div>
                  <div className="mini-seats">
                    {item.state.players.map((player) => (
                      <i key={player.id} className={player.alive ? "" : "dead"} title={player.name}>
                        {player.name.slice(-1)}
                      </i>
                    ))}
                  </div>
                  <div className="game-card-footer">
                    <span>{item.state.players.filter((player) => player.alive).length} alive</span>
                    <span>{new Date(item.game.createdAt).toLocaleString()}</span>
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}
        {tab === "new" && (
          <GameSetup
            roles={roles}
            initialConfig={cloneConfig}
            onCreated={(id) => {
              setCloneConfig(undefined);
              setSelectedGame(id);
              void refresh();
            }}
          />
        )}
        {tab === "roles" && <RoleLab roles={roles} onSaved={() => void refresh()} />}
        {tab === "experiments" && (
          <ExperimentLab games={games} experiments={experiments} onCreated={() => void refresh()} />
        )}
        {error && <div className="error-banner floating">{error}</div>}
      </main>
    </div>
  );
}

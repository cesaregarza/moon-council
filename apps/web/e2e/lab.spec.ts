import { expect, test, type Page } from "@playwright/test";

const role = (id: string, name = id) => ({ schemaVersion: "role_v1", id, version: id === "doctor" ? 2 : 1, name, alignment: id === "werewolf" ? "werewolf" : "village", description: "Fixture role", knowledge: ["own_role"], actions: [], passives: { voteWeight: 1 }, winCondition: { terminal: true, predicate: { kind: "alignment_eliminated", alignment: "werewolf" } } });
const roles = [role("villager", "Villager"), role("werewolf", "Werewolf"), role("seer", "Seer"), role("doctor", "Doctor"), role("roleblocker", "Roleblocker"), role("mayor", "Mayor")];
const players = Array.from({ length: 8 }, (_, index) => ({ id: `p${index + 1}`, name: `Player ${index + 1}`, alive: true, role: index < 2 ? roles[1] : roles[0] }));
const config = { schemaVersion: "game_config_v2", name: "V3.1 Fixture", seed: "fixture-seed", preset: "standard-8-v2", protocolVersion: "agent_v3_1", seats: players.map((player) => ({ id: player.id, name: player.name, personality: "Fixture", model: "gpt-5.6-luna" })), roleDeck: [roles[1], roles[1], roles[2], roles[3], roles[0], roles[0], roles[0], roles[0]], revealRolesOnDeath: true, moderatorNarration: false, discussion: { readyQuorum: 2 / 3, maxFollowUpsPerPlayer: 2, maxFollowUpSlotsFactor: 0.5, speakerSelection:"listener_auction",speakerBias:0.25,maxParallelDecisions:4 }, safety: { maxCycles: 8, maxModelCalls: 500, maxOutputTokens: 600, maxWallClockMs: 1_800_000 }, speedMs: 0, deliberation: { mode: "gated", maxCalls: 3, optionalDayCalls: 4, optionalNightCalls: 2, requestTimeoutMs: 120000, episodeTimeoutMs: 300000, maxContextTokens: 8000, maxJournalTokens: 1200,bidReasoningEffort:"medium" }, maxTotalTokens: 2000000, modelSettings: Object.fromEntries(players.map((player) => [player.id, { model: "gpt-5.6-luna", reasoningEffort: "xhigh", provider: "fake" }])) };
const publicEvent = (sequence: number, type = "message.public", payload: Record<string, unknown> = { text: "The village watches the moon." }) => ({ schemaVersion: "game_event_v1", id: `event-${sequence}`, gameId: "g-v2", sequence, type, phase: "day_discussion", day: 1, visibility: "public", audienceIds: [] as string[], payload, createdAt: "2026-01-01T00:00:00.000Z" });
const privateEvent = (sequence: number, visibility: "moderator" | "player" | "team", payload: Record<string, unknown>, audienceIds: string[] = []) => ({ ...publicEvent(sequence, "decision.reported", payload), visibility, audienceIds });

function gamePayload(view: string, at: number | null, legacy = false) {
  const all = [publicEvent(0, "game.started", {}), publicEvent(1), privateEvent(2, "player", { decisionId: "d-1", taskType:"discussion_bid",submission:{urge:0,ready:false,plan:null,rationale:"Wait for another clue"},report: { observations: ["event-1"], alternatives: [{ id: "stay", description: "Stay quiet", advantage: "less exposure", drawback: "less information" }], selectedAlternativeId: "stay", summary: "Wait for another clue", proposal: { kind: "pass", reason: "Fixture" }, journalPatch: [], control: { kind: "continue", question: "What changed?", reason: "resolve_conflict" }, confidence: 0.6 }, continuation: "continue", verdict: "accepted" }, ["p1"]), publicEvent(3, "phase.changed", { from: "day_discussion", to: "day_vote" })];
  const visible = view === "moderator" ? all : view === "player" ? all.filter((event) => event.visibility === "public" || (event.visibility === "player" && event.audienceIds.includes("p1"))) : view === "team" ? all.filter((event) => event.visibility === "public") : all.filter((event) => event.visibility === "public");
  const sliced = at === null ? visible : visible.slice(0, Math.max(1, at + 1)).map((event, sequence) => ({ ...event, sequence }));
  const safePlayers = view === "moderator" ? players : players.map(({ id, name, alive }) => ({ id, name, alive }));
  return { game: { id: "g-v2", name: legacy ? "Legacy Fixture" : "V3.1 Fixture", status: "paused", config: view === "moderator" ? (legacy ? { ...config, schemaVersion: "game_config_v1" } : config) : { schemaVersion: legacy ? "game_config_v1" : "game_config_v2", ...(legacy ? {} : { preset: "standard-8-v2", protocolVersion: "agent_v3_1", deliberation: config.deliberation, maxTotalTokens: config.maxTotalTokens }), discussion: config.discussion, safety: config.safety }, speedMs: 0, legacyReplayOnly: legacy }, state: { gameId: "g-v2", phase: "day_discussion", day: 1, status: "paused", players: safePlayers, events: sliced, journals: view === "moderator" ? { p1: { schemaVersion: "journal_v2", version: 1, beliefs: [], hypotheses: [], strategy: "Keep the table talking.", goals: ["Find a contradiction"], unresolvedQuestions: [], deceptionPlan: null } } : {}, winnerAlignments: [], modelCalls: 3 }, events: sliced, usage: view === "moderator" ? [{ inputTokens: 1_946_911, outputTokens: 83_182, totalTokens: 2_030_093, cachedInputTokens: 400_000, model: "gpt-5.6-luna", estimatedCost: 0 }] : [], at, view };
}

async function mockApi(page: Page, options: { legacy?: boolean } = {}) {
  const requests: string[] = [];
  const controls: Record<string, unknown>[] = [];
  const creations: Record<string, unknown>[] = [];
  let experiment = { id: "exp-1", name: "Fixture batch", status: "running", spec: { schemaVersion: "experiment_v2", name: "Fixture batch", baseConfig: config, runs: 4, concurrency: 1, baseSeed: "batch", pricingPerMillionTokens: {} }, summary: { runsRequested: 4, runsCompleted: 2, winsByAlignment: { village: 1 }, winsByRole: {}, survivalByRole: {}, voteAccuracy: 0.5, averageCycles: 2, averageMessages: 4, averageDurationMs: 100, followUps: 2, modelFailures: 0, inputTokens: 100, outputTokens: 200, estimatedCost: 0, completed: 1, interrupted: 1, failed: 0, budgetTruncated: 0, validOutcomeDenominator: 1 } };
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push(`${url.pathname}${url.search}`);
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/api/v1/health") return json({ ok: true, provider: "fake", providerReady: true, liveModelConfigured: false, authentication: "none", statusDetail: "Fixture" });
    if (url.pathname === "/api/v1/roles") return json(roles);
    if (url.pathname === "/api/v1/games" && request.method() === "GET") return json([{ ...gamePayload(url.searchParams.get("view") ?? "public", null, options.legacy), state: { ...gamePayload("public", null, options.legacy).state, players: players.map(({ id, name, alive }) => ({ id, name, alive })) } }]);
    if (url.pathname === "/api/v1/games" && request.method() === "POST") { creations.push(request.postDataJSON() as Record<string, unknown>); return json(gamePayload("moderator", null), 201); }
    if (url.pathname.endsWith("/events/stream")) return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": fixture heartbeat\n\n" });
    if (url.pathname.endsWith("/control")) { controls.push(request.postDataJSON() as Record<string, unknown>); return json({ ok: true, status: "stepping" }); }
    if (url.pathname.endsWith("/decisions/d-1")) return json({ opportunity: { id: "d-1", gameId: "g-v2", playerId: "p1", kind: "discussion",taskType:"discussion_bid",phase: "day_discussion", day: 1, epoch: "1:day_discussion", viewId: "view-1", baseJournalVersion: 0, packet: { schemaVersion: "player_context_v2", phase: "day_discussion", day: 1, sources: [{ id: "event-1", type: "message.public", day: 1, scope: "public", data: {} }], legalActions: [], players: [] }, status: "pending",bestSubmission:{urge:0,ready:false,plan:null,rationale:"Wait for another clue"},best: { observations: ["event-1"], alternatives: [{ id: "stay", description: "Stay quiet", advantage: "less exposure", drawback: "less information" }], selectedAlternativeId: "stay", summary: "Wait for another clue", proposal: { kind: "pass", reason: "Fixture" }, journalPatch: [], control: { kind: "continue", question: "What changed?", reason: "resolve_conflict" }, confidence: 0.6 }, recovery: 0, createdAt: "2026-01-01T00:00:00.000Z" }, attempts: [], turns: [], events: [privateEvent(2, "player", { decisionId: "d-1", continuation: "continue", verdict: "accepted" }, ["p1"])] });
    if (url.pathname.endsWith("/decisions")) return json(url.searchParams.get("view") === "moderator" || url.searchParams.get("view") === "player" ? [{ id: "d-1", gameId: "g-v2", playerId: "p1", kind: "discussion",taskType:"discussion_bid",phase: "day_discussion", day: 1, epoch: "1:day_discussion", viewId: "view-1", baseJournalVersion: 0, packet: {}, status: "pending", best: null, recovery: 0, createdAt: "2026-01-01T00:00:00.000Z" }] : []);
    if (url.pathname.endsWith("/export")) return json({ schemaVersion: "werewolf_research_bundle_v3_1" });
    if (url.pathname === "/api/v1/experiments" && request.method() === "GET") return json([experiment]);
    if (url.pathname === "/api/v1/experiments" && request.method() === "POST") { experiment = { ...experiment, status: "queued" }; return json(experiment, 201); }
    if (url.pathname.match(/\/games\/g-v2$/)) return json(gamePayload(url.searchParams.get("view") ?? "public", url.searchParams.has("at") ? Number(url.searchParams.get("at")) : null, options.legacy));
    return json({});
  });
  return { requests, controls, creations };
}

test("creates the standard V3.1 setup with editable deliberation, concurrency, and resolved model controls", async ({ page }) => {
  const mock = await mockApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: /new game/i }).click();
  await expect(page.getByRole("heading", { name: "Seat the council" })).toBeVisible();
  await expect(page.getByText("2 wolves · Seer · Doctor · 4 villagers")).toBeVisible();
  await page.getByText("Advanced discussion & budget controls").click();
  await page.getByLabel("Request timeout (ms)").fill("90000");
  await page.getByLabel("Journal tokens").fill("1500");
  await page.getByLabel("Decision concurrency").fill("2");
  await page.getByLabel("Player 1 model").selectOption("gpt-5.6-luna");
  await page.getByRole("button", { name: "Create V3.1 simulation" }).click();
  await expect(page.getByText("Council record")).toBeVisible();
  expect(mock.requests.some((request) => request === "/api/v1/games")).toBeTruthy();
  expect(mock.creations[0]).toMatchObject({ preset: "standard-8-v2", maxTotalTokens: 2000000, reasoningEffort: "xhigh", discussion:{speakerSelection:"listener_auction",speakerBias:0.25,maxParallelDecisions:2},deliberation: { mode: "gated", requestTimeoutMs: 90000, maxJournalTokens: 1500 } });
});

test("keeps observer views safe while covering both stepping controls, decisions, replay, and exports", async ({ page }) => {
  const mock = await mockApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: /v3\.1 fixture/i }).click();
  await expect(page.getByRole("combobox", { name: "Observer perspective" })).toHaveValue("public");
  expect(mock.requests.some((request) => request.includes("/games/g-v2?view=public"))).toBeTruthy();
  await page.getByLabel("Spoiler glass").check();
  await expect(page.getByRole("combobox", { name: "Observer perspective" })).toHaveValue("moderator");
  await expect(page.getByText(/2\.03M known tokens/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Step phase" })).toBeVisible();
  await expect(page.getByRole("button", { name: /discussion.*pending/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "Step decision" })).toBeVisible();
  await page.getByRole("button", { name: "Step phase" }).click();
  await page.getByRole("button", { name: "Step decision" }).click();
  expect(mock.controls.map((body) => body.action)).toEqual(["step", "step_decision"]);
  await page.getByRole("button", { name: /discussion.*pending/i }).click();
  await expect(page.getByText("Inspect exact packet")).toBeVisible();
  await expect(page.getByText("Wait for another clue",{exact:true})).toBeVisible();
  await expect(page.getByText("Inspect small model submission")).toBeVisible();
  await page.getByRole("button", { name: "Enter replay" }).click();
  await page.locator("input[type=range]").fill("1");
  await expect.poll(() => mock.requests.some((request) => request.includes("at=1"))).toBeTruthy();
  await expect(page.locator("a.export-link").first()).toHaveAttribute("href", /view=moderator/);
  await page.getByLabel("Spoiler glass").uncheck();
  await expect(page.getByRole("combobox", { name: "Observer perspective" })).toHaveValue("public");
  expect(mock.requests.some((request) => request.includes("/games/g-v2?view=public"))).toBeTruthy();
});

test("labels legacy games replay-only and clones them into prefilled setup", async ({ page }) => {
  await mockApi(page, { legacy: true });
  await page.goto("/");
  await page.getByRole("button", { name: /legacy fixture/i }).click();
  await expect(page.getByText(/Legacy game · run \/ resume \/ phase step are replay-only/)).toBeVisible();
  await page.getByLabel("Spoiler glass").check();
  await page.getByRole("button", { name: "Clone setup" }).click();
  await expect(page.getByRole("heading", { name: "Clone the council" })).toBeVisible();
});

test("shows V2 batch progress and outcome denominator metrics", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: /experiments/i }).click();
  await expect(page.getByRole("heading", { name: "Launch an experiment" })).toBeVisible();
  await expect(page.getByText("valid outcomes")).toBeVisible();
  await expect(page.getByText("interrupted")).toBeVisible();
});

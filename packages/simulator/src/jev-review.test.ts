import { describe, expect, it } from "vitest";
import { extractJevInput, reviewJevDecisions } from "./jev-review";

const evaluation = JSON.stringify({ answers: { needs_reasoning: { type: "noul", noul: 0.4 }, target: { type: "choice", choice: "a", confidence: 0.2, probabilities: { a: 0.51, b: 0.49 } } } });
const request = (available: boolean) => ({ input: JSON.stringify({ state: { reasoningAvailable: available, public: { evidence: "Zoë spoke" }, private: { journal: "private fixture" }, legalChoices: { a: "Zoë", b: "René" } }, questions: {} }) });
const attempt = { id: "a", decisionId: "d", provider: "jev", status: "valid", promptVersion: "jev_decision_v1", request: request(true), response: evaluation };
const opportunity = { id: "d", playerId: "p1", day: 2, taskType: "vote_choice", packet: { self: { name: "Zoë" } }, bestSubmission: { mode: "direct", choiceHandles: ["a"] } };
const bundle = { attempts: [attempt], decisions: [{ opportunity }], events: [{ sequence: 12, type: "decision.opened", payload: { decisionId: "d" } }] };

describe("offline Jev review", () => {
  it("extracts prose-first evidence and choices without exposing the journal by default", () => {
    const state={journal:"Hear Zoë defend herself before voting.",situation:"Day 2",facts:"Verified result",task:{type:"vote_choice",rules:"Plurality"}};
    const choices={a:"Zoë",b:"René"};
    const data={...bundle,attempts:[{...attempt,promptVersion:"jev_actions_v3",request:{input:JSON.stringify({state,questions:{target:{type:"choice",criteria:choices}}})}}]};
    const brief=reviewJevDecisions(data);
    expect(brief).toMatchObject({journalDecisions:1,records:[{workflow:"journal_v3",legalChoices:choices}]});
    expect(brief.records[0]).not.toHaveProperty("evidence");
    expect(reviewJevDecisions(data,{evidence:true}).records[0]?.evidence).toMatchObject(state);
  });
  it("distinguishes a declined gate from unavailable reasoning and excludes invalid retries", () => {
    const retry = { ...attempt, id: "bad", status: "invalid", response: "broken", error: "invalid JSON" };
    const reviewed = reviewJevDecisions({ ...bundle, attempts: [retry, attempt, attempt] });
    expect(reviewed).toMatchObject({ decisions: 1, reasoned: 0, directWithGate: 1, directWithoutGate: 0 });
    expect(reviewed.records[0]).toMatchObject({ sequence: 12, initial: { needs_reasoning: 0.4, target: { choice: "a", top: [["a", 0.51], ["b", 0.49]] } }, invalidAttempts: [{ attemptId: "bad" }] });
    expect(reviewJevDecisions({ ...bundle, attempts: [{ ...attempt, request: request(false) }] }).directWithoutGate).toBe(1);
  });
  it("preserves explicit advice, final choice and Unicode; evidence requires an explicit option", () => {
    const analysis = { ...attempt, id: "b", provider: "codex", promptVersion: "jev_reasoning_v1", response: JSON.stringify({ rationale: "Compare Zoë and René." }) };
    const final = { ...attempt, id: "c", response: JSON.stringify({ answers: { target: { type: "choice", choice: "b", probabilities: { a: 0.1, b: 0.9 } } } }) };
    const data = { ...bundle, attempts: [attempt, analysis, final] };
    const result = reviewJevDecisions(data);
    expect(result).toMatchObject({ reasoned: 1, directWithGate: 0, records: [{ name: "Zoë", final: { target: { choice: "b" } }, reasoning: [{ response: { rationale: "Compare Zoë and René." } }] }] });
    expect(result.records[0]).not.toHaveProperty("evidence");
    expect(reviewJevDecisions(data, { evidence: true }).records[0]?.evidence?.private).toEqual({ journal: "private fixture" });
  });
  it("filters without changing source IDs and rejects malformed input", () => {
    expect(reviewJevDecisions(bundle, { player: "p2" }).decisions).toBe(0);
    expect(reviewJevDecisions(bundle, { task: "night_choice" }).decisions).toBe(0);
    expect(reviewJevDecisions(bundle, { task: "vote_choice", evidence: true }).records[0]?.evidence).toMatchObject({ attemptId: "a", questions: {} });
    expect(reviewJevDecisions(bundle, { day: 1 }).decisions).toBe(0);
    expect(reviewJevDecisions(bundle, { decision: "missing" }).decisions).toBe(0);
    expect(() => reviewJevDecisions(bundle, { day: 0 })).toThrow();
    expect(() => reviewJevDecisions({})).toThrow();
  });
});


describe("exact offline Jev input export", () => {
  it("preserves every byte, including Unicode, whitespace and private context", () => {
    const input = ' {"model":"fixture", "state":{"note":"Zoë\\nRené","gameReference":{}},"questions":{}}\n';
    expect(extractJevInput({attempts:[{...attempt,request:{input}}]}, {decision:"d"})).toBe(input);
    expect(extractJevInput({attempts:[attempt,attempt]}, {decision:"d"})).toBe(attempt.request.input);
  });
  it("requires an explicit attempt when selection is ambiguous and can select failed inputs", () => {
    const second={...attempt,id:"second"};
    expect(()=>extractJevInput({attempts:[attempt,second]},{decision:"d"})).toThrow("found 2");
    expect(extractJevInput({attempts:[attempt,{...second,status:"invalid"}]},{decision:"d",attempt:"second"})).toBe(second.request.input);
    expect(()=>extractJevInput({attempts:[attempt]},{decision:"missing"})).toThrow("found 0");
    expect(()=>extractJevInput({attempts:[attempt]},{decision:" "})).toThrow("Empty");
    expect(()=>extractJevInput({attempts:[{...attempt,request:{input:"broken"}}]},{decision:"d"})).toThrow("JSON object");
  });
});

import { mkdtemp, mkdir, readFile, writeFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { GameConfigV2Schema, STANDARD_ROLE_IDS, seatName } from "@werewolf/contracts";
import { LabRepository, openDatabase, DecisionStore } from "@werewolf/db";
import { DOCTOR_V2, STARTER_ROLES } from "@werewolf/engine";
import { createDecisionProvider, type DecisionProvider } from "@werewolf/llm";
import { V2GameOrchestrator } from "../packages/simulator/src/orchestrator-v2";
import { auditGameV2 } from "../packages/simulator/src/audit-v2";
import { observerPayload,decisionRecords,decisionDetail } from "../apps/api/src/observer";

const {values}=parseArgs({options:{help:{type:"boolean"},provider:{type:"string",default:"fake"},model:{type:"string"},effort:{type:"string",default:"xhigh"},seed:{type:"string",default:"standard-v3-pilot"},db:{type:"string"},game:{type:"string"},resume:{type:"boolean"},out:{type:"string"},audit:{type:"boolean"},snapshot:{type:"boolean"},mode:{type:"string",default:"gated"},parallel:{type:"string",default:"4"},"speaker-bias":{type:"string",default:"0.25"},"inspect-bundle":{type:"string"},match:{type:"string",multiple:true},day:{type:"string"},limit:{type:"string"},offset:{type:"string"}}});
if(values.help) console.log("Offline inspection (no database writes or model calls): --inspect-bundle research.json [--match NAME_OR_ID ...] [--day DAY] [--limit 30] [--offset 0]. Prints latency/usage and only explicitly matched speech, journal patches, and reports as JSON.");
if(values["inspect-bundle"] && !values.help){
  if(values.resume||values.snapshot||values.db||values.game||values.out)throw new Error("Bundle inspection cannot be combined with game execution or database/output options");
  const {inspectResearchBundle}=await import("../packages/simulator/src/audit-bundle-v2");
  const bundle=JSON.parse(await readFile(await nativePath(values["inspect-bundle"]),"utf8"));
  console.log(JSON.stringify(inspectResearchBundle(bundle,{matches:values.match,day:values.day===undefined?undefined:Number(values.day),limit:values.limit===undefined?undefined:Number(values.limit),offset:values.offset===undefined?undefined:Number(values.offset)}),null,2));
  process.exit(0);
}
if(!values.help && (values.match||values.day||values.limit||values.offset))throw new Error("Inspection filters require --inspect-bundle");
if(values.help){console.log("Usage: npm run pilot -- --provider fake|codex|openai --model MODEL --effort xhigh --seed SEED [--mode gated|single] [--parallel 4] [--speaker-bias 0.25] [--db NATIVE_PATH] [--out DIRECTORY]\nNew games use protocol V3.1: stable public E refs and per-player private R refs, small task-specific model responses, reactive listener bids, selected-only speech generation, sparse memory, and a full Day 1 before Night 1. Resume the SAME game: --db DB --game ID --resume. Audit only: --db DB --game ID --audit. Add --snapshot to export an immutable SQLite backup in the output directory. Live providers require an explicit model; never substitute another model. Artifacts are moderator-spoiler JSON and Markdown; no credentials or hidden reasoning traces.");process.exit(0);}
if(!["fake","codex","openai"].includes(values.provider!)) throw new Error("Invalid provider");
if(values.provider!=="fake"&&!values.model) throw new Error("Explicit --model required for live calls");
if(!["single","gated"].includes(values.mode!)) throw new Error("Invalid deliberation mode");
const maxParallelDecisions=Number(values.parallel),speakerBias=Number(values["speaker-bias"]);
if(!Number.isInteger(maxParallelDecisions)||maxParallelDecisions<1||maxParallelDecisions>8)throw new Error("--parallel must be an integer from 1 to 8");
if(!Number.isFinite(speakerBias)||speakerBias<0.01||speakerBias>1)throw new Error("--speaker-bias must be from 0.01 to 1");
async function nativePath(path:string){const full=resolve(path);if(full==="/mnt"||full.startsWith("/mnt/")) throw new Error("Use a native Linux path");let existing=full;for(;;){try{const real=await realpath(existing);if(real==="/mnt"||real.startsWith("/mnt/"))throw new Error("Windows-mounted symlink target is forbidden");break;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;existing=dirname(existing);}}return full;}
const directory=values.out?await nativePath(values.out):await mkdtemp("/tmp/werewolf-v3-pilot-");await mkdir(directory,{recursive:true});
const databasePath=await nativePath(values.db??join(directory,"game.db"));await mkdir(dirname(databasePath),{recursive:true});
const connection=openDatabase(databasePath),repository=new LabRepository(connection);repository.seedRoles([...STARTER_ROLES,DOCTOR_V2]);
const seats=STANDARD_ROLE_IDS.map((_,i)=>({id:`p${i+1}`,name:seatName(i),personality:"Observant, concise, and strategically independent."}));
const providerKind=values.provider as "fake"|"codex"|"openai",model=values.model??"fake-model";
const game=values.game?repository.getGame(values.game):repository.createGame(GameConfigV2Schema.parse({schemaVersion:"game_config_v2",protocolVersion:"agent_v3_1",name:`${model} ${values.effort} · V3.1 pilot`,preset:"standard-8-v2",seed:values.seed,seats,roleDeck:STANDARD_ROLE_IDS.map(id=>id==="doctor"?DOCTOR_V2:STARTER_ROLES.find(r=>r.id===id)!),rules:{packExecution:"any_unblocked",revealBallots:true,firstCycle:"day_first"},discussion:{speakerSelection:"listener_auction",speakerBias,maxParallelDecisions},deliberation:{mode:values.mode,bidReasoningEffort:"medium"},speedMs:0,modelSettings:Object.fromEntries(seats.map(s=>[s.id,{model,reasoningEffort:values.effort,provider:providerKind}]))}));
if(!game)throw new Error("Unknown existing game");
if(game.config.schemaVersion!=="game_config_v2")throw new Error("Legacy games are replay-only");
if(values.game&&!values.resume&&!values.audit)throw new Error("Existing games require --resume or --audit");
if(values.resume && Object.values(game.config.modelSettings).some(settings=>settings.provider!==providerKind || settings.model!==model || settings.reasoningEffort!==values.effort)) throw new Error("Resume must use the game's frozen --provider, --model, and --effort; no silent model substitution");
console.log(JSON.stringify({kind:"pilot",gameId:game.id,databasePath,directory,modelSettings:game.config.modelSettings}));
if(!values.audit){
const base=createDecisionProvider(providerKind);
const provider:DecisionProvider={decide:async request=>{console.log(JSON.stringify({kind:"call",actor:request.playerId,day:request.contextV2?.day,phase:request.contextV2?.phase,proposalKind:request.proposalKind,model:request.model,effort:request.reasoningEffort}));return base.decide(request);}};
const orchestrator=new V2GameOrchestrator(repository,provider);orchestrator.initialize(game.id);
  if(!["completed","aborted","budget_exhausted","failed"].includes(game.status))repository.updateGame(game.id,{status:"running",error:null});
  for(let step=0;step<128&&["running","stepping"].includes(repository.getGame(game.id)!.status);step++){
    await orchestrator.runGameStep(game.id);
    const current=repository.getGame(game.id)!;
    console.log(JSON.stringify({kind:"progress",status:current.status,attempts:new DecisionStore(repository).attempts(game.id).length,error:current.error}));
  }
}
const audit=auditGameV2(repository,game.id),current=repository.getGame(game.id)!;
const payload=observerPayload(repository,current,{kind:"moderator"},undefined,{includeAttempts:true});
const details=decisionRecords(repository,game.id,{kind:"moderator"}).map(op=>decisionDetail(repository,game.id,op.id,{kind:"moderator"}));
const protocol=game.config.schemaVersion==="game_config_v2"?game.config.protocolVersion:null;
const isSplit=protocol==="agent_v3"||protocol==="agent_v3_1";
const decisions=isSplit?details.map(detail=>detail?{...detail,attemptIds:detail.attempts.map(attempt=>attempt.id),attempts:undefined}:detail):details;
const bundle={schemaVersion:protocol==="agent_v3_1"?"werewolf_research_bundle_v3_1":protocol==="agent_v3"?"werewolf_research_bundle_v3":"werewolf_research_bundle_v2",perspective:"moderator",...payload,attempts:payload.attempts ?? [],decisions};
await writeFile(join(directory,"research.json"),JSON.stringify(bundle,null,2));
await writeFile(join(directory,"research.jsonl"),[JSON.stringify({kind:"metadata",schemaVersion:bundle.schemaVersion,perspective:"moderator",game:bundle.game}),...bundle.events.map(event=>JSON.stringify({kind:"event",event})),...bundle.decisions.map(decision=>JSON.stringify({kind:"decision",decision})),...bundle.attempts.map(attempt=>JSON.stringify({kind:"attempt",attempt}))].join("\n")+"\n");
await writeFile(join(directory,"audit.json"),JSON.stringify(audit,null,2));
const lines=[`# ${protocol==="agent_v3_1"?"V3.1":protocol==="agent_v3"?"V3":"V2"} pilot audit`,"",`Game: ${game.id}`,`Status: ${audit.status}; day ${audit.day}; attempts ${audit.attempts}; known tokens ${audit.totalKnownTokens}; unknown usage attempts ${audit.unknownUsageAttempts}.`,"",`## Invariant findings`,"",...(audit.issues.length?audit.issues.map(i=>`- ${i}`):["No automated audit violations."]),"",`## Every explicit decision (spoilers)`,"",...audit.decisions.flatMap(d=>[`### Day ${d.day} · ${d.playerId} (${d.role}) · ${d.phase}`,"",`Status: ${d.status}. Context estimate ${d.contextEstimate} tokens; ${d.sources} sources. Closing: ${d.closing}. Docket: ${d.docket.join(", ")||"none"}.`,...d.turns.map(t=>`- ${t.summary} [${String(t.continuation)}]`),`Committed: ${JSON.stringify(d.committedProposal)}`,""])];
await writeFile(join(directory,"audit.md"),lines.join("\n"));
console.log(JSON.stringify({kind:"result",gameId:game.id,status:audit.status,issues:audit.issues,attempts:audit.attempts,tokens:audit.totalKnownTokens,artifacts:directory}));
if(values.snapshot){const target=await nativePath(join(directory,game.id+".db"));try{await stat(target);throw new Error("Snapshot target already exists; select a fresh output directory");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}await connection.sqlite.backup(target);console.log(JSON.stringify({kind:"snapshot",path:target}));}
connection.close();
if(audit.issues.length)process.exitCode=1;else if(!values.audit&&audit.status!=="completed")process.exitCode=audit.status==="paused"?3:2;

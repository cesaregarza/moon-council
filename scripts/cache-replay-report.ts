import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cacheReceiptSummary } from "../packages/simulator/src/cache-replay";
import type { UsageV2 } from "@werewolf/contracts";

type Row={attemptId:string;sourcePromptHash:string;model:string;effort:string;task:string;latencyMs:number;usage:UsageV2;original:{latencyMs:number;usage:UsageV2};error:string|null;metadata?:{cacheDiagnostics?:{type?:string;reason?:string}|null}};
type Summary={sourceGame:string;live:boolean;rows:Row[]};
const median=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);return (sorted[Math.floor((sorted.length-1)/2)]!+sorted[Math.floor(sorted.length/2)]!)/2;};
const fmt=(n:number)=>n.toLocaleString("en-US");
const percent=(n:number|null)=>n===null?"unknown":`${(100*n).toFixed(1)}%`;
const money=(n:number|null)=>n===null?"unknown":`$${n.toFixed(6)}`;

/** Compare frozen inputs, never a different sample selected after seeing the results. */
export async function writeCacheComparison(paths:string[],output:string) {
  const summaries=await Promise.all(paths.map(async path=>JSON.parse(await readFile(resolve(path),"utf8")) as Summary));
  const [baseline,revised]=summaries;
  if(!baseline?.live||!revised?.live||!baseline.rows?.length||baseline.sourceGame!==revised.sourceGame||baseline.rows.length!==revised.rows?.length)throw new Error("Need two completed live replays of the same game/sample");
  for(const [index,row] of baseline.rows.entries()) {
    const other=revised.rows[index]!;
    if(row.error||other.error||!row.usage||!other.usage)throw new Error("Cannot call a failed replay a successful comparison");
    if(["attemptId","sourcePromptHash","model","effort"].some(key=>row[key as keyof Row]!==other[key as keyof Row]))throw new Error("Comparison requires identical source prompts, sample order, model and effort");
  }
  const original=baseline.rows.map(row=>({...row,usage:row.original.usage,latencyMs:row.original.latencyMs}));
  const series=[{name:"Recorded Codex",rows:original},{name:"Initial API layout",rows:baseline.rows},{name:"Four-layer API",rows:revised.rows}];
  const luna=baseline.rows.every(row=>row.model==="gpt-6-luna");
  const table=series.map((s,index)=>{
    const totals=cacheReceiptSummary(s.rows);
    const estimate=index>0&&luna&&totals.inputRateEquivalentTokens!==null?(totals.inputRateEquivalentTokens*0.10+totals.outputTokens*0.50)/1_000_000:null;
    return `| ${s.name} | ${fmt(totals.inputTokens)} | ${fmt(totals.cachedInputTokens)} (${percent(totals.cacheReadFraction)}) | ${index?fmt(totals.cacheWriteInputTokens):"not comparable"} | ${fmt(totals.outputTokens)} | ${(median(s.rows.map(r=>r.latencyMs))/1000).toFixed(2)} s | ${money(estimate)} |`;
  });
  const rows=revised.rows.map((row,index)=>{
    const old=baseline.rows[index]!;
    return `| ${index+1}: ${row.task} | ${fmt(old.usage.cachedInputTokens??0)} | ${fmt(row.usage.cachedInputTokens??0)} | ${fmt(row.usage.cacheWriteInputTokens??0)} | ${row.metadata?.cacheDiagnostics?.type??"no comparison"} |`;
  });
  const text=["# Moon Council: recorded-decision cache experiment","",`Source game: ${baseline.sourceGame}. ${baseline.rows.length} frozen decisions replayed in each API layout; all schema and domain checks passed. Model and effort were preserved (${baseline.rows[0]!.model}, ${baseline.rows[0]!.effort}).`,"",
    "| Transport/layout | Input tokens | Cached reads | Cache writes | Output tokens, including reasoning | Median wall time | Estimated API token cost |","| --- | ---: | ---: | ---: | ---: | ---: | ---: |",...table,"",
    "The Codex timings are historical; the two API samples were sequential, not randomized repetitions. Schema and layout changed together. This demonstrates integration and reuse, not a precise causal latency benchmark or complete-game playing strength. Every replay used the original frozen input; generated replies were not fed into the next archived decision. Codex subscription charges are not inferred from API prices.","",
    "## Actual cache receipts","","| Replay | Initial API reads | Four-layer reads | Four-layer writes | Four-layer diagnostic |","| --- | ---: | ---: | ---: | --- |",...rows,"",
    "The initial layout lost reuse across the task-schema change and the shifting public-history window. Four explicit write slots preserve immutable behavior, frozen rules, durable public outcomes, and the current public view. A common strict API response envelope keeps journal, speech and closing schemas identical, while the original task schema and domain validators still reject the wrong task, illegal acts, and invalid journal updates. Private notebooks and player-specific evidence follow the cached section; no omitted evidence or other player's knowledge was added.","",
    "Diagnostics can return unavailable even when some tokens were reused. Reported usage is the source of cache read/write counts; local schema/prefix comparisons provide additional evidence and must not be presented as a server-reported miss reason.","",
    "## Remaining opportunity","","The uncached tail includes the notebook, private role/results, and older public evidence selected separately for each player. Further gains would require redesigning that evidence selection or proving another layer is reused often enough to justify writes. Private text is not cached speculatively merely to increase a hit-rate statistic.","",
    `API cost estimates use GPT-6 Luna Standard list prices fetched ${new Date().toISOString().slice(0,10)}: $0.10/M uncached input, $0.01/M cached input, $0.125/M cache writes, and $0.50/M output, including reasoning. Input categories are mutually exclusive. These are estimates, not an account billing statement. [OpenAI pricing](https://developers.openai.com/api/docs/pricing)`,"",
    "[Cache behavior and four-write limit](https://developers.openai.com/api/docs/guides/prompt-caching) · [Cache diagnostics](https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics)","",
    `Exact receipts: ${paths.join(" and ")}. Requests/outputs in their sibling files contain private game context; credentials and hidden reasoning are not included.`,""].join("\n");
  await writeFile(resolve(output),text,{mode:0o600,flag:"wx"});
  console.log(text);
}

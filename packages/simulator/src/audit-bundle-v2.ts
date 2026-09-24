import { z } from "zod";

const Count = z.number().finite().nonnegative().nullable().optional();
const BundleSchema = z.object({
  schemaVersion:z.enum(["werewolf_research_bundle_v2","werewolf_research_bundle_v3","werewolf_research_bundle_v3_1","werewolf_research_bundle_v4"]),
  attempts:z.array(z.object({id:z.string(),status:z.string(),optional:z.boolean(),latencyMs:Count,model:z.string(),reasoningEffort:z.string(),usage:z.object({inputTokens:Count,outputTokens:Count,totalTokens:Count,cachedInputTokens:Count,reasoningTokens:Count})})),
  events:z.array(z.object({id:z.string(),day:z.number(),phase:z.string(),type:z.string(),payload:z.record(z.string(),z.unknown())})),
});

/** Read an exported artifact only. Never query the provider or modify game state. */
export function inspectResearchBundle(value:unknown,options:{matches?:string[];day?:number;limit?:number;offset?:number}={}) {
  const bundle=BundleSchema.parse(value);
  const {matches=[],day,limit=30,offset=0}=options;
  if(matches.some(term=>!term.trim()) || !Number.isInteger(limit) || limit<1 || limit>200 || !Number.isInteger(offset) || offset<0 || day!==undefined && (!Number.isInteger(day)||day<0)) throw new Error("Invalid inspection filters");
  const attempts=[...new Map(bundle.attempts.map(a=>[a.id,a])).values()];
  const latency=attempts.flatMap(a=>a.latencyMs==null?[]:[a.latencyMs]).sort((a,b)=>a-b);
  const median=latency.length ? (latency[Math.floor((latency.length-1)/2)]!+latency[Math.floor(latency.length/2)]!)/2 : null;
  const tokenFields=["inputTokens","outputTokens","totalTokens","cachedInputTokens","reasoningTokens"] as const;
  const usage=Object.fromEntries(tokenFields.map(key=>[key,{knownTotal:attempts.reduce((n,a)=>n+(a.usage[key]??0),0),unknownAttempts:attempts.filter(a=>a.usage[key]==null).length}]));
  const records=bundle.events.flatMap(event=>{
    if(day!==undefined && event.day!==day)return [];
    const p=event.payload;
    let content:unknown;
    if(event.type==="speech.public")content={text:p.text,acts:p.acts};
    else if(event.type==="journal.v2_updated")content=p.patch;
    else if(event.type==="decision.reported") {
      const report=p.report as Record<string,unknown>|undefined;
      content={taskType:p.taskType,submission:p.submission,summary:report?.summary,inferences:report?.inferences,journalPatch:report?.journalPatch,continuation:p.continuation};
    } else return [];
    const search=JSON.stringify(content)?.toLocaleLowerCase("en-US")??"";
    if(!matches.length || !matches.some(term=>search.includes(term.toLocaleLowerCase("en-US"))))return [];
    return [{eventId:event.id,day:event.day,phase:event.phase,type:event.type,playerId:p.playerId,decisionId:p.decisionId,content}];
  });
  return {schemaVersion:"bundle_inspection_v1",attempts:attempts.length,models:[...new Set(attempts.map(a=>a.model+" / "+a.reasoningEffort))],
    latency:{recorded:latency.length,totalMs:latency.reduce((a,b)=>a+b,0),medianMs:median,maxMs:latency.at(-1)??null,invalidMs:attempts.filter(a=>a.status==="invalid").reduce((n,a)=>n+(a.latencyMs??0),0),optionalMs:attempts.filter(a=>a.optional).reduce((n,a)=>n+(a.latencyMs??0),0)},
    optionalAttempts:attempts.filter(a=>a.optional).length,statusCounts:Object.fromEntries([...new Set(attempts.map(a=>a.status))].sort().map(status=>[status,attempts.filter(a=>a.status===status).length])),usage,
    matchedRecords:records.length,offset,records:records.slice(offset,offset+limit)};
}

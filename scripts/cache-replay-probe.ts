import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { OpenAIResponsesProvider, openAIRequest } from "@werewolf/llm";
import type { UsageV2 } from "@werewolf/contracts";
import { archivedCacheCases, cacheReceiptSummary, prefixComparison, requestFingerprint } from "../packages/simulator/src/cache-replay";

export async function replayCacheProbe(options:{db:string;game:string;attempts:string[];live:boolean;out?:string;model?:string;effort?:string}) {
  const cases = archivedCacheCases(resolve(options.db), options.game, options.attempts);
  if(cases.some(entry=>options.model&&entry.request.model!==options.model||options.effort&&entry.request.reasoningEffort!==options.effort)) throw new Error("Replay model/effort must match the frozen source; no silent substitution");
  const group=`archive-replay-${randomUUID()}`; // start with separate cache accounting for this experiment
  const directory=options.out?resolve(options.out):undefined;
  if(directory){await mkdir(dirname(directory),{recursive:true});await mkdir(directory,{mode:0o700});}
  const provider=options.live?new OpenAIResponsesProvider():null;
  const rows:Array<{usage?:UsageV2;latencyMs:number;original:{usage:UsageV2;latencyMs:number|null}} & Record<string,unknown>>=[];
  let previousBody:Record<string,unknown>|undefined,previousId:string|undefined;
  for(const [index,entry] of cases.entries()) {
    const request={...entry.request,gameId:group,cacheComparisonResponseId:previousId};
    let usage:UsageV2|undefined,metadata:Record<string,unknown>|undefined;
    let body=openAIRequest(request,previousId) as unknown as Record<string,unknown>,raw:string|undefined;
    const bytes=Buffer.byteLength(JSON.stringify(body));
    if(bytes>96_000)throw new Error("Replay request exceeds the 96000-byte input cap");
    const started=Date.now();let error:string|null=null,validation:string[]=[];
    if(provider)try {
      const result=await provider.decide({...request,onUsage:value=>{usage=value;},onProviderMetadata:value=>{metadata=value;},onProviderRequest:value=>{body=value;},onRawResponse:value=>{raw=value;}});
      validation=entry.validate(result.data);
      if(validation.length)error=validation.join("; ");
    }catch(failure){error=failure instanceof Error?failure.message:String(failure);}
    const row={index,attemptId:entry.attempt.id,decisionId:entry.attempt.decisionId,playerId:entry.attempt.playerId,task:entry.request.schemaName,model:request.model,effort:request.reasoningEffort,
      live:options.live,latencyMs:Date.now()-started,requestBytes:bytes,requestHash:requestFingerprint(body),sourcePromptHash:requestFingerprint(entry.attempt.request),
      original:{usage:entry.attempt.usage,latencyMs:entry.attempt.latencyMs},usage,metadata,error,validation,prefix:prefixComparison(previousBody,body)};
    rows.push(row);
    if(directory){
      await writeFile(resolve(directory,`${String(index+1).padStart(2,"0")}-${entry.attempt.id}.json`),JSON.stringify({...row,request:body,response:raw},null,2)+"\n",{mode:0o600});
      await writeFile(resolve(directory,"summary.json"),JSON.stringify({sourceGame:options.game,live:options.live,limits:{calls:cases.length,maxRequestBytes:96000,maxOutputTokens:8192,timeoutMs:120000},totals:cacheReceiptSummary(rows),rows},null,2)+"\n",{mode:0o600});
    }
    console.log(JSON.stringify(row));
    previousBody=body;
    if(metadata?.status==="completed"&&typeof metadata.responseId==="string")previousId=metadata.responseId;
    if(error){process.exitCode=1;break;}
  }
}

#!/usr/bin/env -S npx tsx
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

type TokenUsage = {
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  cacheWriteInputTokens?: number | null;
};

export type CacheAttempt = {
  id: string;
  decisionId: string;
  status: string;
  startedAt: string;
  schemaVersion: string;
  usage?: TokenUsage | null;
  request?: {
    instructions?: unknown;
    schema?: unknown;
    cache?: unknown;
    sharedInput?: unknown;
  } | null;
};

type Bucket = {
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  hitCalls: number;
  invalidCalls: number;
  unknownInputCalls: number;
};

function emptyBucket(): Bucket {
  return {calls:0,inputTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0,hitCalls:0,invalidCalls:0,unknownInputCalls:0};
}

function addAttempt(bucket: Bucket, attempt: CacheAttempt): void {
  bucket.calls += 1;
  const input=attempt.usage?.inputTokens;
  const cached=attempt.usage?.cachedInputTokens;
  const written=attempt.usage?.cacheWriteInputTokens;
  if(typeof input==="number")bucket.inputTokens+=input;
  else bucket.unknownInputCalls+=1;
  if(typeof cached==="number")bucket.cachedInputTokens+=cached;
  if(typeof written==="number")bucket.cacheWriteInputTokens+=written;
  if(typeof cached==="number"&&cached>0)bucket.hitCalls+=1;
  if(attempt.status!=="valid")bucket.invalidCalls+=1;
}

function sortValue(value: unknown): unknown {
  if(Array.isArray(value))return value.map(sortValue);
  if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,sortValue(item)]));
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function rate(bucket: Bucket): number | null {
  return bucket.inputTokens>0?100*bucket.cachedInputTokens/bucket.inputTokens:null;
}

export function summarizeAttempts(attempts: CacheAttempt[]) {
  const total=emptyBucket(),bySchema=new Map<string,Bucket>(),byOrdinal=new Map<number,Bucket>();
  const seenByDecision=new Map<string,number>();
  const prefixBySchema=new Map<string,{instructions:Set<string>;schemas:Set<string>;canonicalSchemas:Set<string>;cache:Set<string>;briefings:Set<string>}>();
  for(const attempt of attempts){
    addAttempt(total,attempt);
    const schema=attempt.schemaVersion||"unknown";
    const schemaBucket=bySchema.get(schema)??emptyBucket();addAttempt(schemaBucket,attempt);bySchema.set(schema,schemaBucket);
    const ordinal=(seenByDecision.get(attempt.decisionId)??0)+1;seenByDecision.set(attempt.decisionId,ordinal);
    const ordinalBucket=byOrdinal.get(ordinal)??emptyBucket();addAttempt(ordinalBucket,attempt);byOrdinal.set(ordinal,ordinalBucket);
    const variants=prefixBySchema.get(schema)??{instructions:new Set(),schemas:new Set(),canonicalSchemas:new Set(),cache:new Set(),briefings:new Set()};
    variants.instructions.add(JSON.stringify(attempt.request?.instructions));
    variants.schemas.add(JSON.stringify(attempt.request?.schema));
    variants.canonicalSchemas.add(canonicalJson(attempt.request?.schema));
    variants.cache.add(canonicalJson(attempt.request?.cache));
    variants.briefings.add(JSON.stringify(attempt.request?.sharedInput));
    prefixBySchema.set(schema,variants);
  }
  const row=(key:string|number,bucket:Bucket)=>({key,...bucket,cachePercent:rate(bucket)});
  return {
    total:row("total",total),
    bySchema:[...bySchema].sort(([a],[b])=>a.localeCompare(b)).map(([key,bucket])=>row(key,bucket)),
    byAttemptOrdinal:[...byOrdinal].sort(([a],[b])=>a-b).map(([key,bucket])=>row(key,bucket)),
    prefixVariants:[...prefixBySchema].sort(([a],[b])=>a.localeCompare(b)).map(([schema,value])=>({schema,instructions:value.instructions.size,schemas:value.schemas.size,canonicalSchemas:value.canonicalSchemas.size,cacheMetadata:value.cache.size,briefings:value.briefings.size})),
  };
}

function compact(value:number):string{
  const scales:[[number,string],[number,string],[number,string],[number,string]]=[[1e12,"T"],[1e9,"B"],[1e6,"M"],[1e3,"K"]];
  for(const [scale,suffix] of scales)if(Math.abs(value)>=scale)return `${(value/scale).toFixed(value>=scale*100?0:value>=scale*10?1:2).replace(/\.0+$/,"")}${suffix}`;
  return String(value);
}

function percent(value:number|null):string{return value===null?"unknown":`${value.toFixed(2)}%`;}
function printRows(title:string,rows:Array<Record<string,unknown>>,columns:string[]):void{
  console.log(`\n${title}`);console.log(columns.join("\t"));
  for(const row of rows)console.log(columns.map(column=>{
    const value=row[column];
    if(column.endsWith("Tokens")&&typeof value==="number")return compact(value);
    if(column==="cachePercent"&&typeof value==="number")return percent(value);
    return String(value??"");
  }).join("\t"));
}

function usage():never{
  console.error("Usage: npm run cache:audit -- --db <sqlite-path> --game <game-id> [--after <attempt-count>] [--schema-suffix <suffix>] [--json]");
  process.exit(2);
}

function parseArgs(argv:string[]){
  let dbPath="",gameId="",after=0,schemaSuffix="",json=false;
  for(let index=0;index<argv.length;index+=1){
    const arg=argv[index];
    if(arg==="--help"||arg==="-h")usage();
    if(arg==="--json"){json=true;continue;}
    const value=argv[++index];if(!value)usage();
    if(arg==="--db")dbPath=resolve(value);
    else if(arg==="--game")gameId=value;
    else if(arg==="--after")after=Number(value);
    else if(arg==="--schema-suffix")schemaSuffix=value;
    else usage();
  }
  if(!dbPath||!gameId||!Number.isInteger(after)||after<0)usage();
  return {dbPath,gameId,after,schemaSuffix,json};
}

function main():void{
  const options=parseArgs(process.argv.slice(2));
  if(!existsSync(options.dbPath))throw new Error(`Database does not exist: ${options.dbPath}`);
  const db=new Database(options.dbPath,{readonly:true,fileMustExist:true});
  try{
    const rows=db.prepare("SELECT id, decision_id AS decisionId, status, value_json AS valueJson FROM provider_attempts WHERE game_id=? ORDER BY json_extract(value_json, '$.startedAt'), id").all(options.gameId) as Array<{id:string;decisionId:string;status:string;valueJson:string}>;
    if(rows.length===0)throw new Error(`No provider attempts found for game: ${options.gameId}`);
    const attempts=rows.map((row,index)=>{
      const value=JSON.parse(row.valueJson) as Partial<CacheAttempt>;
      return {id:row.id,decisionId:row.decisionId,status:row.status,startedAt:value.startedAt??String(index),schemaVersion:value.schemaVersion??"unknown",usage:value.usage,request:value.request} satisfies CacheAttempt;
    }).slice(options.after).filter(attempt=>!options.schemaSuffix||attempt.schemaVersion.endsWith(options.schemaSuffix));
    if(attempts.length===0)throw new Error("No attempts remain after applying filters");
    const summary=summarizeAttempts(attempts),result={gameId:options.gameId,after:options.after,schemaSuffix:options.schemaSuffix||null,...summary};
    if(options.json){console.log(JSON.stringify(result,null,2));return;}
    console.log(`Game ${options.gameId}`);console.log(`Attempts ${summary.total.calls} (after ${options.after})`);
    console.log(`Cache ${compact(summary.total.cachedInputTokens)} / ${compact(summary.total.inputTokens)} = ${percent(summary.total.cachePercent)}; ${summary.total.hitCalls}/${summary.total.calls} hit calls; ${summary.total.invalidCalls} invalid`);
    printRows("By schema",summary.bySchema,["key","calls","inputTokens","cachedInputTokens","cachePercent","hitCalls","invalidCalls"]);
    printRows("By attempt ordinal within decision",summary.byAttemptOrdinal,["key","calls","inputTokens","cachedInputTokens","cachePercent","hitCalls"]);
    printRows("Request variation",summary.prefixVariants,["schema","instructions","schemas","canonicalSchemas","cacheMetadata","briefings"]);
  }finally{db.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main();

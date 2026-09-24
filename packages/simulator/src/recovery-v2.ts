import { DecisionStore, type LabRepository } from "@werewolf/db";
import { reduceGame } from "@werewolf/engine";

/** Expired work becomes an explicit operator pause, never an automatic new call. */
export function recoverStaleWork(repository: LabRepository, now=Date.now()): number {
  const store=new DecisionStore(repository);
  return store.atomic(()=>{
    const jobs=store.staleJobs(now);
    for(const job of jobs){
      const games=job.kind === "game" ? [repository.getGame(job.target_id)].filter(g=>g!==undefined) : repository.listGames(100,job.target_id);
      for(const game of games){
        if(game.config.schemaVersion !== "game_config_v2" || !["running","stepping","queued"].includes(game.status)) continue;
        const events=repository.listEvents(game.id);
        if(events.length){const state=reduceGame(game.id,events);repository.appendEvent(game.id,{type:"game.paused",phase:state.phase,day:state.day,visibility:"public",payload:{reason:"runner recovery requires explicit resume",unresolved:true}});}
        repository.updateGame(game.id,{status:"paused",error:"runner interrupted; persisted reports retained and uncertain requests require recovery"});
      }
      if(job.kind === "experiment") repository.updateExperiment(job.target_id,{status:"paused",error:"runner interrupted; stable run indices retained"});
      repository.finishJob(job.id,"runner interrupted; explicit resume required");
    }
    return jobs.length;
  });
}

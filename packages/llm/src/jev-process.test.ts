import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAskJev } from "./jev";

const directories:string[]=[];
afterEach(async()=>{vi.unstubAllEnvs();await Promise.all(directories.splice(0).map(directory=>rm(directory,{recursive:true,force:true})));});
async function wrapper(body:string) {
  const directory=await mkdtemp(join(tmpdir(),"jev-process-"));directories.push(directory);
  const path=join(directory,"wrapper");await writeFile(path,`#!/usr/bin/env node\n${body}\n`,{mode:0o700});
  vi.stubEnv("ASK_JEV_BIN",path);
  return directory;
}
describe.skipIf(process.platform==="win32")("Jev subprocess lifecycle",()=>{
  it("rounds the CLI timeout to a positive integer without changing the parent deadline",async()=>{
    await wrapper('process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(JSON.stringify(process.argv.slice(2))))');
    expect(JSON.parse(await runAskJev("{}",{timeoutMs:1501}))).toEqual(["--timeout","2"]);
  });
  it("retains a useful exit code when the subprocess closes stdin early",async()=>{
    await wrapper("process.exit(37)");
    await expect(runAskJev("x".repeat(1024*1024),{timeoutMs:5000})).rejects.toThrow("exit 37");
  });
  it("kills a wrapper and its grandchild on timeout",async()=>{
    const directory=await wrapper('const {spawn}=require("node:child_process");const {writeFileSync}=require("node:fs");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"});writeFileSync(__dirname+"/pid",String(child.pid));setInterval(()=>{},1000);');
    await expect(runAskJev("{}",{timeoutMs:700})).rejects.toThrow("timed out");
    const pid=Number(await readFile(join(directory,"pid"),"utf8"));
    let live=true;
    for(let n=0;n<30&&live;n++) {
      try {const stat=await readFile(`/proc/${pid}/stat`,"utf8");live=stat.split(") ")[1]![0]!=="Z";}
      // A process can disappear before open (ENOENT) or between open/read (ESRCH).
      catch(error) {if(["ENOENT","ESRCH"].includes((error as NodeJS.ErrnoException).code??""))live=false;else throw error;}
      if(live) await new Promise(resolve=>setTimeout(resolve,20));
    }
    try {expect(live).toBe(false);} finally {if(live)process.kill(pid,"SIGKILL");}
  });
});

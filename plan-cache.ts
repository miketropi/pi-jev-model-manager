/** Optional session-scoped Markdown mirror outside the user's project.
 * Canonical plan remains in Pi session entries. Mirrors are deleted on exit.
 */
import {existsSync,mkdirSync,writeFileSync,renameSync,unlinkSync,lstatSync,readdirSync} from "node:fs";
import {join} from "node:path";
import {homedir} from "node:os";
import {createHash,randomBytes} from "node:crypto";
export const CACHE_BASE=join(process.env.PI_CODING_AGENT_DIR||join(homedir(),".pi","agent"),"jev-model-manager","plans");
export function planMirrorPath(sessionId:string|undefined):string|undefined {
 if(!sessionId || typeof sessionId!=="string")return;
 const key=createHash("sha256").update(sessionId).digest("hex").slice(0,40);
 return join(CACHE_BASE,key+".md");
}
export function savePlanMirror(id:string|undefined,markdown:string):string|undefined {
 const file=planMirrorPath(id);if(!file)return;
 mkdirSync(CACHE_BASE,{recursive:true,mode:0o700});
 const temp=file+"."+randomBytes(6).toString("hex")+".tmp";
 try{
  writeFileSync(temp,markdown,{flag:"wx",mode:0o600});
  renameSync(temp,file);
  return file;
 }finally{if(existsSync(temp))unlinkSync(temp);}
}
export function cleanPlanMirror(id:string|undefined):void {
 const file=planMirrorPath(id);if(!file)return;
 try{const stat=lstatSync(file);if(stat.isFile()||stat.isSymbolicLink())unlinkSync(file);}
 catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
}

export function pruneOldPlanMirrors(maxAgeMs=86400000,now=Date.now()):number {
 if(!existsSync(CACHE_BASE))return 0;
 let removed=0;
 for(const name of readdirSync(CACHE_BASE).slice(0,3000)){
  if(name.length!==43||!name.endsWith(".md"))continue;
  const stem=name.slice(0,-3);
  if(![...stem].every(c=>"0123456789abcdef".includes(c)))continue;
  const file=join(CACHE_BASE,name);
  try{
   const stat=lstatSync(file);
   if(stat.isFile() && now-stat.mtimeMs>maxAgeMs){unlinkSync(file);removed++;}
  }catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
 }
 return removed;
}

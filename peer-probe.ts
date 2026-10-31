/** Pure diagnostics: optional CLI availability is not a workflow error. */
/** Handle CLI runners that print a JSON error with exit code 0. */
export function probeSucceeded(output:string):boolean {
 const str=output.trim();
 if(!str)return false;
 try {
  const value=JSON.parse(str);
  if(value && typeof value==="object" && !Array.isArray(value)) {
   if(value.error || value.ok===false || value.success===false ||
     value.status==="error" || value.status==="unavailable") return false;
  }
 } catch { /* human-readable healthy output is valid */ }
 return !/(?:server_not_running|connection refused|cannot connect|daemon not running|service unavailable)/i.test(str);
}
export function isPeerUnavailableError(e:unknown):boolean {
 const x=e as {code?:string;message?:string;stderr?:string};
 const code=String(x?.code??"");
 const message=String(x?.message??"")+" "+String(x?.stderr??"");
 return ["ENOENT","ECONNREFUSED","ETIMEDOUT","EACCES"].includes(code) ||
  /(?:server_not_running|no .*server is running|not running|ECONNREFUSED|connection refused|cannot connect|socket.*not found|socket unavailable|service unavailable|backend unreachable|unreachable|timed out|timeout|command not found|spawn .*ENOENT)/i.test(message);
}

/**
 * Read-only curl transport for Pi runtimes where Node fetch cannot use the
 * user's working HTTPS proxy / system certificate configuration.
 *
 * Never runs through a shell, never reads ~/.curlrc, never writes project files,
 * and never follows redirects on its own. Redirect validation is done by caller.
 */
import { spawn } from "node:child_process";

const MAX_OUTPUT = 420_000;
export function curlErrorText(value: unknown): string {
  const e = value as { message?: string; code?: string; cause?: {code?: string;message?: string}};
  const name = typeof e?.code === "string" ? e.code
    : typeof e?.cause?.code === "string" ? e.cause.code : "";
  const text = String(e?.message ?? value ?? "unknown error")
    .replace(/(https?:\/\/)[^\s/@]+@/gi, "$1[redacted]@").slice(0, 240);
  return name ? name + ": " + text : text;
}

export function parseCurlResponse(output: Uint8Array): Response {
  const buf=Buffer.from(output);
  let start=0;
  for(let i=0;i<6;i++){
    let end=buf.indexOf("\r\n\r\n",start), separator=4;
    if(end<0){end=buf.indexOf("\n\n",start);separator=2;}
    if(end<0)throw Error("curl returned no complete HTTP response headers");
    const lines=buf.subarray(start,end).toString("latin1").split(/\r?\n/);
    const statusLine=lines[0]??"";
    const match=/^HTTP\/(?:1\.0|1\.1|2|3)\s+(\d{3})(?:\s|$)/i.exec(statusLine);
    if(!match)throw Error("curl returned an unrecognized HTTP status line");
    const status=Number(match[1]);
    const headers=new Headers();
    for(const line of lines.slice(1)){
      const colon=line.indexOf(":");
      if(colon>0){
        const key=line.slice(0,colon).trim();
        const value=line.slice(colon+1).trim();
        try{headers.append(key,value);}catch{ /* ignore malformed server headers */ }
      }
    }
    start=end+separator;
    // Proxy tunnel header and informational response precede the final status.
    if(status<200 || /connection established/i.test(statusLine))continue;
    const body=buf.subarray(start);
    return new Response(status===204||status===304?null:body,{status,headers});
  }
  throw Error("Too many intermediary HTTP status blocks");
}

export function curlGetResponse(url:string):Promise<Response>{
  return new Promise((resolve,reject)=>{
    const argv=[
      "-q","--silent","--show-error","--include","--compressed",
      "--request","GET","--proto","=https","--max-redirs","0",
      "--connect-timeout","7","--max-time","15","--max-filesize","350000",
      "--header","Accept: application/json, text/plain, text/markdown, text/html, application/xml;q=0.9",
      "--header","User-Agent: jev-model-manager/0.8.1 (read-only research)",
      url,
    ];
    const child=spawn("curl",argv,{stdio:["ignore","pipe","pipe"],windowsHide:true});
    const chunks:Buffer[]=[];
    let bytes=0,stderr="",settled=false;
    const fail=(e:Error)=>{
      if(settled)return;settled=true;
      child.kill();
      reject(e);
    };
    child.once("error",(e)=>fail(Error("curl unavailable: "+curlErrorText(e))));
    child.stdout.on("data",(chunk:Buffer)=>{
      bytes+=chunk.byteLength;
      if(bytes>MAX_OUTPUT){fail(Error("curl response exceeded 420 KB limit"));return;}
      chunks.push(chunk);
    });
    child.stderr.on("data",(chunk:Buffer)=>{
      stderr=(stderr+chunk.toString("utf8")).slice(-1000);
    });
    child.once("close",(exitCode)=>{
      if(settled)return;settled=true;
      if(exitCode!==0){
        reject(Error("curl exited "+exitCode+(stderr?": "+stderr.trim():"")));
        return;
      }
      try{resolve(parseCurlResponse(Buffer.concat(chunks)));}
      catch(e){reject(e);}
    });
  });
}

import test from "node:test";
import assert from "node:assert/strict";
import { fetchPublicText } from "../planning-tools.ts";
import { parseCurlResponse } from "../curl-fetch.ts";
const url="https://wordpress.org/news/2026/10/wordpress-7-1-4/";
const networkError=async()=>{
 const cause=Object.assign(new Error("DNS lookup failed"),{code:"ENOTFOUND"});
 throw Object.assign(new TypeError("fetch failed"),{cause});
};
test("Node network error falls back to curl and preserves source URL",async()=>{
 let used=0;
 const result=await fetchPublicText(url,networkError,async requested=>{
  used++;assert.equal(requested,url);
  return new Response("<html><body>WordPress 7.1.4 security fixes</body></html>",
    {status:200,headers:{"content-type":"text/html"}});
 });
 assert.equal(used,1);assert.equal(result.transport,"curl");assert.equal(result.status,200);
 assert.match(result.text,/WordPress 7.1.4/);
 assert.equal(result.url,url);
});
test("real HTTP 404 is not misdiagnosed as connectivity and never falls back",async()=>{
 let used=false;
 await assert.rejects(fetchPublicText(url,async()=>new Response("Not found",
   {status:404,headers:{"content-type":"text/plain"}}),async()=>{
   used=true;throw Error("fallback should never run");
 }),/HTTP 404/);
 assert.equal(used,false);
});
test("both transports failing show DNS cause and curl failure",async()=>{
 await assert.rejects(fetchPublicText(url,networkError,async()=>{
   throw Error("curl exited 60: SSL certificate problem");
 }),e=>/ENOTFOUND/.test(e.message)&&/curl exited 60/.test(e.message));
});
test("curl redirect cannot escape public HTTPS restrictions",async()=>{
 await assert.rejects(fetchPublicText(url,networkError,async()=>
  new Response(null,{status:302,headers:{location:"http://localhost/secrets"}})),/HTTPS/);
});
test("curl parser handles proxy CONNECT response before final HTTP body",()=>{
 const nl=String.fromCharCode(13,10);
 const content=["HTTP/1.1 200 Connection established","","HTTP/2 200",
  "content-type: application/json","",JSON.stringify({ok:true})].join(nl);
 const res=parseCurlResponse(Buffer.from(content));
 assert.equal(res.status,200);
 assert.equal(res.headers.get("content-type"),"application/json");
});

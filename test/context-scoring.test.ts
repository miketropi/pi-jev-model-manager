import {test} from "node:test";
import {strict as assert} from "node:assert";
import {assessRelevance} from "../context/scoring.ts";
const input={id:"a",kind:"research" as const,summary:"API docs",task:"implement payment"};
test("validated semantic scoring",async()=>{
 const out=await assessRelevance(input,async()=>({score:0.95,reason:"Relevant API documentation"}));
 assert.equal(out.source,"semantic");assert.equal(out.action,"keep");
});
test("invalid model output fails safe",async()=>{
 const out=await assessRelevance(input,async()=>({score:5,reason:"broken"}));
 assert.equal(out.source,"fallback");assert.equal(out.action,"store");
});
test("protected evidence never sent to evaluator",async()=>{
 const out=await assessRelevance({...input,kind:"checkpoint"},async()=>{throw Error("must not be called")});
 assert.equal(out.action,"keep");
});

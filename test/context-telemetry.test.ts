import {test} from "node:test";
import {strict as assert} from "node:assert";
import {contextHealth,isModelSwitchSafe} from "../context/telemetry.ts";
test("thresholds use actual observed context",()=>{
 assert.equal(contextHealth({usedTokens:95000,contextWindow:128000,reserveTokens:16000,at:"now"}).level,"warning");
 assert.equal(contextHealth({usedTokens:120000,contextWindow:128000,reserveTokens:16000,at:"now"}).level,"overflow");
 assert.throws(()=>contextHealth({usedTokens:NaN,contextWindow:128000,reserveTokens:1,at:"now"}));
});
test("model-switch budget safety margin",()=>{
 assert.equal(isModelSwitchSafe(100000,128000,16000),true);
 assert.equal(isModelSwitchSafe(110000,128000,16000),false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { presentChoice, fetchPublicText, registerPlanningTools } from '../planning-tools.ts';
test('yes', () => assert.ok(true));
test('choose option in Pi TUI', async () => {
 const options = [{label:'A',description:'Simple'}, {label:'B',description:'Scalable'}];
 const ui = { select: async (_q,choices) => choices[1], input: async () => '' };
 const result = await presentChoice(ui,{question:'Select architecture',options},true);
 assert.deepEqual(result,{status:'selected',index:1,label:'B',description:'Scalable'});
});
test('read-only GitHub release research', async () => {
 let opts;
 const fakeFetch = async (_url, init) => { opts = init;
   return new Response(JSON.stringify([{tag_name:'v4.0'}]),{headers:{'content-type':'application/json'}});
 };
 const url = 'https:' + '//api.github.com/repos/coollabsio/coolify/releases';
 const result = await fetchPublicText(url,fakeFetch);
 assert.equal(opts.method,'GET');
 assert.match(result.text,/tag_name/);
});
test('registers LLM-callable tools that return native menu results',async()=>{
 const tools={};
 registerPlanningTools({registerTool:t=>{tools[t.name]=t;}});
 assert.equal(tools.jev_ask_user.parameters.type,'object');
 assert.equal(tools.jev_web_fetch.parameters.type,'object');
 const ctx={hasUI:true,ui:{select:async(_,choices)=>choices[0],input:async()=>undefined}};
 const result=await tools.jev_ask_user.execute('id',
   {question:'Pick',options:[{label:'A'},{label:'B'}]},undefined,undefined,ctx);
 assert.deepEqual(result.details,{status:'selected',index:0,label:'A'});
});

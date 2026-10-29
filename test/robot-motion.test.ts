import test from "node:test";
import assert from "node:assert/strict";
import { RobotMotion } from "../robot-motion.ts";
import { mascotLines } from "../mascot.ts";

test("original robot has subtle animated expressions without layout jitter", () => {
 const status={mood:"routing",task:"implement",model:"DeepSeek"};
 const frames=[0,1,2,3,4].map(n=>mascotLines("mascot",status,n));
 for(const f of frames){
  assert.equal(f.length,3);
  assert.equal(f[0].indexOf("JEV"),frames[0][0].indexOf("JEV"));
  assert.equal(f[1].indexOf("DeepSeek"),frames[0][1].indexOf("DeepSeek"));
 }
 assert.match(frames[0][1],/•ᴗ•/);
 assert.match(frames[1][1],/·ᴗ•/);
 assert.match(frames[2][1],/•ᴗ·/);
 assert.match(frames[4][0],/◆/);
 assert.equal(mascotLines("mascot",{mood:"ready"},2)[1],
   mascotLines("mascot",{mood:"ready"},0)[1]);
 assert.deepEqual(mascotLines("off",status,3),[]);
});
test("animation is single scheduled frame, slow, stops without leaked timer",()=>{
 const scheduled=new Map();
 const frames=[];
 let current=0;
 const scheduler={
  schedule(cb,ms){const id=++current;scheduled.set(id,{cb,ms});return id;},
  cancel(id){scheduled.delete(id)}
 };
 const robot=new RobotMotion(frame=>frames.push(frame),scheduler);
 robot.start();robot.start();
 assert.equal(scheduled.size,1);
 const [id,first]=scheduled.entries().next().value;
 assert.equal(first.ms,1700);
 scheduled.delete(id);first.cb();
 assert.equal(frames.at(-1),1);
 assert.equal(scheduled.size,1);
 const [id2,second]=scheduled.entries().next().value;
 assert.equal(second.ms,220);
 scheduled.delete(id2);second.cb();
 assert.equal(frames.at(-1),0);
 robot.stop();assert.equal(scheduled.size,0);
 assert.equal(frames.at(-1),0);
 robot.start();assert.equal(scheduled.size,1);
 robot.stop();assert.equal(scheduled.size,0);
});

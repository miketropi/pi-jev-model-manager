import test from "node:test";
import assert from "node:assert/strict";
import { DuckAnimator, mascotLines, DUCK_MIN_PAUSE_MS, DUCK_FRAME_MS } from "../mascot.ts";

test("duck wobble/blink/wing art preserves status alignment and stays within three lines", () => {
  const status = {mood:"routing",task:"implement",model:"DeepSeek V4"} as const;
  const frames = [0,1,2,3,4].map(frame=>mascotLines("mascot",status,frame));
  for(const f of frames) {
    assert.equal(f.length,3);
    assert.equal(f[0].indexOf("JEV"),frames[0][0].indexOf("JEV"),"status text stays fixed");
    assert.equal(f[1].indexOf("implement"),frames[0][1].indexOf("implement"));
    assert.match(f[0],/\)>/);
  }
  assert.notEqual(frames[0][0],frames[1][0],"head tilts right");
  assert.notEqual(frames[0][0],frames[2][0],"head tilts left");
  assert.match(frames[3][0],/_\(- \)>/);
  assert.notEqual(frames[0][1],frames[4][1],"wing wiggle");
  assert.deepEqual(mascotLines("off",status,3),[]);
  assert.equal(mascotLines("compact",status,3).length,1);
  assert.equal(mascotLines("mascot",{mood:"ready"},3)[0],
               mascotLines("mascot",{mood:"ready"},0)[0],"no animation when idle");
});

test("duck scheduler is sparse, cancellable, has no stale async redraw after stop", () => {
  let id=0;
  const queued=new Map<number,{callback:()=>void,delay:number}>();
  const frames:number[]=[];
  const scheduler={
    schedule(callback:()=>void, delay:number) {
      const key=++id;queued.set(key,{callback,delay});return key;
    },
    cancel(handle:unknown) {queued.delete(handle as number);},
  };
  const flush=()=>{
    const [key,entry]=queued.entries().next().value ?? [];
    assert.ok(entry);queued.delete(key);entry.callback();return entry.delay;
  };
  const animator=new DuckAnimator(frame=>frames.push(frame),()=>0,scheduler);
  animator.start();
  animator.start();
  assert.equal(queued.size,1,"double start is idempotent");
  assert.equal(flush(),DUCK_MIN_PAUSE_MS);
  assert.equal(frames.at(-1),1);
  assert.equal(flush(),DUCK_FRAME_MS);
  assert.equal(frames.at(-1),2);
  assert.equal(flush(),DUCK_FRAME_MS);
  assert.equal(frames.at(-1),0);
  assert.equal(queued.size,1);
  animator.stop();
  assert.equal(animator.running,false);
  assert.equal(queued.size,0);
  assert.equal(frames.at(-1),0);
  animator.start();
  assert.equal(queued.size,1);
  animator.stop();
  assert.equal(queued.size,0);
});

test("random gestures include blink and wing without full-time rendering", () => {
  for(const [gesture,expected] of [[.6,3],[.95,4]] as const) {
    const frames:number[]=[];
    let i=0;
    const randoms=[.4,gesture];
    let queued:(()=>void)|undefined;
    const scheduler={
      schedule(callback:()=>void) {queued=callback;return 1;},
      cancel() {queued=undefined;},
    };
    const animator=new DuckAnimator(f=>frames.push(f),()=>randoms[i++]??.5,scheduler);
    animator.start();
    const fn=queued;assert.ok(fn);fn();
    assert.equal(frames.at(-1),expected);
    animator.stop();assert.equal(queued,undefined);
  }
});

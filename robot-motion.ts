/** Gentle robot motion only while Pi is actively processing. Timers never retain the CLI. */
export interface MotionScheduler {
 schedule(fn: () => void, ms: number): unknown;
 cancel(handle: unknown): void;
}
export class RobotMotion {
 private handle: unknown;
 private playing = false;
 private tickCount = 0;
 private readonly paint: (frame: number) => void;
 private readonly timer: MotionScheduler;
 constructor(paint: (frame: number) => void, timer?: MotionScheduler) {
  this.paint = paint;
  this.timer = timer ?? {
   schedule: (fn,ms) => { const t = setTimeout(fn,ms); t.unref?.(); return t; },
   cancel: h => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
 }
 get running() { return this.playing; }
 start() {
  if(this.playing)return;
  this.playing=true; this.tickCount=0; this.paint(0); this.next(1700);
 }
 private next(delay:number) {
  this.handle=this.timer.schedule(()=>{
    this.handle=undefined;
    if(!this.playing)return;
    const frames=[1,0,2,0,3,0,4,0];
    this.paint(frames[this.tickCount % frames.length]);
    this.tickCount++;
    this.next(this.tickCount % 2 ? 220 : 2100);
  },delay);
 }
 stop() {
  this.playing=false;
  if(this.handle !== undefined) this.timer.cancel(this.handle);
  this.handle=undefined;
  this.paint(0);
 }
}

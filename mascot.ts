/**
 * Jevling is now an original tiny terminal duck. Animation is opt-in by configuration
 * and rendered only by the host Pi TUI; there are no ANSI escapes or external assets.
 */
export type MascotStyle = "mascot" | "compact" | "off";
export type MascotMood = "ready" | "routing" | "recovery" | "disabled";
export interface MascotStatus {
  mood: MascotMood;
  task?: string;
  model?: string;
  subtitle?: string;
}
export const MASCOT_WIDGET_KEY = "jev-manager:mascot";

/** Slow, sparse animations: idle gaps plus a tiny left/right head wobble or blink. */
export const DUCK_MIN_PAUSE_MS = 1800;
export const DUCK_EXTRA_PAUSE_MS = 2100;
export const DUCK_FRAME_MS = 230;

export function normalizeMascotStyle(value: unknown): MascotStyle {
  return value === "off" || value === "compact" || value === "mascot" ? value : "mascot";
}

/** Strip control codes (including ANSI CSI/OSC introducers) from unknown model labels. */
export function cleanMascotText(value: string | undefined, maxLength = 36): string {
  if (!value) return "";
  const safe = value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ").trim();
  return [...safe].length > maxLength ? [...safe].slice(0, maxLength - 1).join("") + "…" : safe;
}

export function mascotLines(style: MascotStyle, status: MascotStatus, frame = 0): string[] {
  if (style === "off") return [];
  const label = status.mood === "recovery" ? "RECOVERING"
    : status.mood === "routing" ? "ROUTING"
    : status.mood === "disabled" ? "STANDBY" : "READY";
  const marker = status.mood === "recovery" ? "↻"
    : status.mood === "disabled" ? "○"
    : status.mood === "routing" ? "◆" : "●";
  const task = cleanMascotText(status.task, 20);
  const model = cleanMascotText(status.model, 36);
  const subtitle = cleanMascotText(status.subtitle, 72)
    || (model ? `${task ? task + " · " : ""}${model}`
      : status.mood === "disabled" ? "Routing off · /jev-on" : "Smart model routing · /jev-config");

  if (style === "compact") return [`(•)> JEV ${marker} ${label.toLowerCase()} · ${subtitle}`];

  const stateFrame = status.mood === "routing" || status.mood === "recovery"
    ? Math.max(0, Math.min(4, Math.trunc(frame) || 0)) : 0;
  const face = status.mood === "disabled" ? "–" : status.mood === "recovery" ? "•" :
    stateFrame === 3 ? "-" : "•";
  const headOffset = stateFrame === 1 ? 4 : stateFrame === 2 ? 2 : 3;
  const head = " ".repeat(headOffset) + `_(${face} )>`;
  const body = stateFrame === 4 ? " <( >  )"
    : status.mood === "recovery" ? " <( ﹏  )"
    : status.mood === "disabled" ? " <( -  )" : " <( ᴗ  )";
  const pad = (part: string) => part.padEnd(13, " ");
  return [
    `${pad(head)}JEV  ${marker} ${label}`,
    `${pad(body)}${subtitle}`,
    `${pad("   ^^ ^^")} /jev-mascot · display`,
  ];
}

export interface DuckScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

/**
 * Event-driven timer: no work outside active agent turns. The tick scheduler is
 * injectable so timing and cleanup can be regression tested without sleeps.
 */
export class DuckAnimator {
  private timeout?: unknown;
  private active = false;
  private readonly schedule: DuckScheduler;
  private readonly renderFrame: (frame: number) => void;
  private readonly random: () => number;
  constructor(renderFrame: (frame: number) => void,
    random: () => number = Math.random,
    scheduler?: DuckScheduler,
  ) {
    this.renderFrame = renderFrame;
    this.random = random;
    this.schedule = scheduler ?? {
      schedule: (cb, ms) => {
        const timeout = setTimeout(cb, ms);
        timeout.unref?.(); // never keep a CLI process open because of a mascot
        return timeout;
      },
      cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }
  get running(): boolean { return this.active; }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.renderFrame(0);
    this.queueBurst();
  }

  stop(): void {
    this.active = false;
    if (this.timeout !== undefined) this.schedule.cancel(this.timeout);
    this.timeout = undefined;
    this.renderFrame(0); // settle expression, no stale frame left in terminal
  }

  private tick(callback: () => void, delay: number): void {
    this.timeout = this.schedule.schedule(() => {
      this.timeout = undefined;
      if (this.active) callback();
    }, delay);
  }

  private queueBurst(): void {
    const r = Math.max(0, Math.min(.999999, this.random()));
    this.tick(() => this.burst(), DUCK_MIN_PAUSE_MS + Math.floor(r * DUCK_EXTRA_PAUSE_MS));
  }

  private burst(): void {
    const value = Math.max(0, Math.min(.999999, this.random()));
    // Two-frame head wobble, blink, or tiny wing flap. No vertical layout changes.
    const sequence = value < .45 ? [1, 2, 0] : value < .78 ? [3, 0] : [4, 0];
    const play = (index: number) => {
      if (!this.active) return;
      this.renderFrame(sequence[index]);
      if (index + 1 < sequence.length) this.tick(() => play(index + 1), DUCK_FRAME_MS);
      else this.queueBurst();
    };
    play(0);
  }
}

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Config } from "../core/config.ts";
import { RobotMotion } from "../robot-motion.ts";
import { mascotLines, MASCOT_WIDGET_KEY, type MascotStatus } from "../mascot.ts";
const ROUTER_PROVIDER = "jev-manager";
const ROUTER_ID = "auto";
export function isJevSelected(model: { provider: string; id: string } | undefined): boolean {
  return model?.provider === ROUTER_PROVIDER && model.id === ROUTER_ID;
}

export function isRoutingActive(config: Config, ctx: ExtensionContext): boolean {
  return config.enabled && config.mode === "auto" && isJevSelected(ctx.model);
}

let robotView: { ctx: ExtensionContext; config: Config; status: MascotStatus } | undefined;
let robotFrame = 0;
let robotAnimator: RobotMotion | undefined;
let planReviewActive = false;

function paintRobot(frame: number): void {
  robotFrame = frame;
  if (!robotView) return;
  const { ctx, config, status } = robotView;
  // A review overlay owns the viewport; asynchronous routing/animation
  // events must not repaint the robot underneath the plan reader.
  if (planReviewActive) {
    ctx.ui.setWidget(MASCOT_WIDGET_KEY, undefined);
    return;
  }
  const display: MascotStatus = isRoutingActive(config, ctx) ? status : {
    mood: "disabled",
    subtitle: config.enabled
      ? config.mode === "observe" && isJevSelected(ctx.model)
        ? "Observe only · /jev-on to route"
        : "Inactive · run /jev-on"
      : "Routing off · run /jev-on",
  };
  const lines = mascotLines(config.mascot, display, robotFrame);
  ctx.ui.setWidget(MASCOT_WIDGET_KEY, lines.length ? lines : undefined);
}

export function updateJevling(ctx: ExtensionContext, config: Config, status: MascotStatus): void {
  if (ctx.mode !== "tui") return;
  robotView = { ctx, config, status };
  if ((config.mascot !== "mascot" || !config.robotMotion || !isRoutingActive(config, ctx))
    && robotAnimator?.running) robotAnimator.stop();
  paintRobot(robotFrame);
}


export function resetJevling(): void {
  robotAnimator?.stop();
  robotView = undefined;
  robotFrame = 0;
  planReviewActive = false;
  robotAnimator = new RobotMotion(paintRobot);
}
export function setPlanReviewActive(value: boolean): void {planReviewActive = value;}
export function clearJevling(): void {robotView = undefined;}
export function stopJevling(): void {robotAnimator?.stop();}
export function startJevling(): void {robotAnimator?.start();}
export function repaintJevling(): void {paintRobot(robotFrame);}

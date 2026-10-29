/**
 * Jevling — original terminal mascot for Jev Model Manager.
 * Pure three-line character renderer; sparse animation is driven separately by RobotMotion.
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

export function normalizeMascotStyle(value: unknown): MascotStyle {
  return value === "off" || value === "compact" || value === "mascot" ? value : "mascot";
}

/** Safely limit displayed provider/model names to prevent TUI control-sequence injection. */
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
  const subtitle = status.subtitle || (model ? `${task ? task + " · " : ""}${model}`
    : status.mood === "disabled" ? "Routing off · /jev-on" : "Smart model routing · /jev-config");
  if (style === "compact") return [`◇ JEV ${marker} ${label.toLowerCase()} · ${subtitle}`];
  // Fixed-width eye and antenna frames: text columns never move.
  const animated = status.mood === "routing" && Number.isInteger(frame);
  const n = animated ? Math.max(0, Math.min(4, frame)) : 0;
  const face = status.mood === "recovery" ? "•﹏•"
    : status.mood === "disabled" ? "·_·"
    : n === 1 ? "·ᴗ•" : n === 2 ? "•ᴗ·" : n === 3 ? "–ᴗ–" : "•ᴗ•";
  const antenna = n === 4 ? "◆" : "◇";
  return [
    `  ╭─${antenna}─╮   JEV  ${marker} ${label}`,
    `  │${face}│   ${subtitle}`,
    "  ╰─┬─╯   /jev-mascot · change display",
  ];
}

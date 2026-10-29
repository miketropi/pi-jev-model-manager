/**
 * Jevling — original terminal mascot for Jev Model Manager.
 * No animations/timers, no terminal escape sequences, no extra network calls.
 */
export type MascotStyle = "mascot" | "compact" | "off";
export type MascotMood = "ready" | "routing" | "recovery" | "disabled";
export interface MascotStatus {
  mood: MascotMood;
  task?: string;
  model?: string;
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

export function mascotLines(style: MascotStyle, status: MascotStatus): string[] {
  if (style === "off") return [];
  const label = status.mood === "recovery" ? "RECOVERING"
    : status.mood === "routing" ? "ROUTING"
    : status.mood === "disabled" ? "STANDBY" : "READY";
  const marker = status.mood === "recovery" ? "↻"
    : status.mood === "disabled" ? "○"
    : status.mood === "routing" ? "◆" : "●";
  const task = cleanMascotText(status.task, 20);
  const model = cleanMascotText(status.model, 36);
  const subtitle = model ? `${task ? task + " · " : ""}${model}`
    : status.mood === "disabled" ? "Routing off · /jev-config" : "Smart model routing · /jev-config";
  if (style === "compact") return [`◇ JEV ${marker} ${label.toLowerCase()} · ${subtitle}`];
  return [
    `  ╭─◇─╮   JEV  ${marker} ${label}`,
    `  │${status.mood === "recovery" ? "•﹏•" : status.mood === "disabled" ? "·_·" : "•ᴗ•"}│   ${subtitle}`,
    "  ╰─┬─╯   /jev-mascot · change display",
  ];
}

/** Interactive configuration helpers. Secret input never uses Pi's plain-text input dialog. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Return undefined on cancel, including RPC where masked terminal input is unavailable. */
export async function maskedInput(ctx: ExtensionContext, title: string): Promise<string | undefined> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Secure key entry requires Pi terminal UI. In RPC/print mode use environment variables instead.", "warning");
    return undefined;
  }
  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
    let value = "";
    return {
      invalidate() {},
      render(width: number) {
        const mask = "•".repeat(Math.min(Array.from(value).length, 48));
        return [
          theme.fg("accent", title).slice(0, width),
          theme.fg("muted", "Key: ") + theme.fg("text", mask || "(paste or type here)"),
          theme.fg("dim", "Enter to save · Esc to cancel · Backspace to edit"),
        ];
      },
      handleInput(data: string) {
        if (keybindings.matches(data, "tui.select.cancel") || data === "\x1b") { done(undefined); return; }
        if (keybindings.matches(data, "tui.select.confirm") || data === "\r" || data === "\n") {
          done(value.trim() || undefined);
          value = "";
          return;
        }
        if (data === "\x7f" || data === "\b" || data === "\x1b[3~") {
          value = Array.from(value).slice(0, -1).join("");
        } else if (data && !/[\x00-\x1f\x7f]/.test(data) && value.length + data.length <= 8192) {
          value += data;
        }
        tui.requestRender();
      },
    };
  });
}

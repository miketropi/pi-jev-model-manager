/** Masked key input with terminal paste and explicit OS clipboard support. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const MAX_KEY_LENGTH = 8192;

/** Never return a partial, truncated or multiline credential. */
export function normalizeSecretInput(raw: string): string {
  const value = raw.trim();
  if (!value || /[\x00-\x1f\x7f\s]/u.test(value)) {
    throw new Error("Enter a single-line API key without whitespace.");
  }
  if (value.length > MAX_KEY_LENGTH) {
    throw new Error("API key exceeds the maximum supported length.");
  }
  return value;
}

/** Read clipboard without putting a secret in the command line or invoking a shell. */
export async function readSystemClipboardText(): Promise<string | undefined> {
  const commands: Array<[string, string[]]> =
    process.platform === "darwin" ? [["pbpaste", []]] :
    process.platform === "win32" ? [["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"]]] :
    [["wl-paste", ["--no-newline"]], ["xclip", ["-selection", "clipboard", "-o"]], ["xsel", ["--clipboard", "--output"]]];
  for (const [command, args] of commands) {
    try {
      const { stdout } = await execFileAsync(command, args, {
        encoding: "utf8", timeout: 2500, maxBuffer: 64 * 1024, windowsHide: true,
        // Avoid tools accidentally printing clipboard content/errors into the TUI.
      });
      if (stdout.trim()) return stdout;
    } catch { /* Try next clipboard backend; never show raw clipboard errors. */ }
  }
  return undefined;
}

/** Return undefined on cancel; never render the credential or log clipboard content. */
export async function maskedInput(
  ctx: ExtensionContext, title: string,
  readClipboard: () => Promise<string | undefined> = readSystemClipboardText,
): Promise<string | undefined> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Secure key entry requires Pi terminal UI. In RPC/print mode use environment variables instead.", "warning");
    return undefined;
  }
  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
    let value = "";
    let pasteBuffer = "";
    let inPaste = false;
    let error = "";
    let closed = false;
    let readingClipboard = false;

    function append(raw: string, pasted = false) {
      try {
        // On paste, trim the newline that clipboard tools often append.
        const addition = pasted ? normalizeSecretInput(raw) : raw;
        if (value.length + addition.length > MAX_KEY_LENGTH) {
          throw new Error("API key exceeds the maximum supported length.");
        }
        if (!pasted && /[\x00-\x1f\x7f\s]/u.test(addition)) {
          throw new Error("API key cannot contain whitespace or control characters.");
        }
        value += addition;
        error = "";
      } catch (e) {
        error = e instanceof Error ? e.message : "Invalid API key";
      }
      tui.requestRender();
    }

    function handleInput(data: string): void {
      if (closed) return;
      // Pi sends bracketed paste markers around Cmd+V terminal text; these can
      // arrive in several handleInput chunks. Process them before Escape/Enter.
      if (data.includes(PASTE_START)) {
        inPaste = true;
        pasteBuffer = "";
        data = data.replace(PASTE_START, "");
      }
      if (inPaste) {
        pasteBuffer += data;
        if (pasteBuffer.length > MAX_KEY_LENGTH + PASTE_END.length + 8) {
          pasteBuffer = "";
          inPaste = false;
          error = "Pasted credential is too long.";
          tui.requestRender();
          return;
        }
        const end = pasteBuffer.indexOf(PASTE_END);
        if (end !== -1) {
          const pasted = pasteBuffer.slice(0, end);
          const remaining = pasteBuffer.slice(end + PASTE_END.length);
          pasteBuffer = "";
          inPaste = false;
          append(pasted, true);
          if (remaining) handleInput(remaining);
        }
        return;
      }
      if (keybindings.matches(data, "tui.select.cancel") || data === "\x1b") {
        closed = true;
        value = "";
        done(undefined);
        return;
      }
      if (keybindings.matches(data, "tui.select.confirm") || data === "\r" || data === "\n") {
        if (readingClipboard) return;
        try {
          const key = normalizeSecretInput(value);
          closed = true;
          value = "";
          done(key);
        } catch (e) {
          error = e instanceof Error ? e.message : "Invalid API key";
          tui.requestRender();
        }
        return;
      }
      // Ctrl+V reads the OS clipboard explicitly. Cmd+V usually arrives as
      // a bracketed paste from the macOS terminal instead.
      if (data === "\x16" || data === "\x1b[118;5u") {
        if (readingClipboard) return;
        readingClipboard = true;
        void readClipboard().then((clip) => {
          if (closed) return;
          if (!clip) { error = "No text found in clipboard. Use your terminal's Paste command."; tui.requestRender(); return; }
          append(clip, true);
        }).catch(() => {
          if (!closed) { error = "Could not read clipboard. Use your terminal's Paste command."; tui.requestRender(); }
        }).finally(() => { readingClipboard = false; });
        return;
      }
      if (data === "\x7f" || data === "\b" || data === "\x1b[3~") {
        value = Array.from(value).slice(0, -1).join("");
        error = "";
        tui.requestRender();
      } else if (data && !/[\x00-\x1f\x7f\s]/u.test(data)) {
        append(data);
      }
    }

    return {
      invalidate() {},
      render(width: number) {
        const mask = "•".repeat(Math.min(Array.from(value).length, 48));
        return [
          theme.fg("accent", title).slice(0, width),
          theme.fg("muted", "Key: ") + theme.fg("text", mask || "(paste or type here)"),
          theme.fg("dim", "Cmd+V / terminal Paste · Ctrl+V clipboard · Enter save · Esc cancel"),
          ...(error ? [theme.fg("warning", error)] : []),
        ];
      },
      handleInput,
    };
  });
}

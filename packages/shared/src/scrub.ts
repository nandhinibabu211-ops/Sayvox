/**
 * Make a stack trace safe to send and store (Constitution I, T076). Used on the client
 * before sending a crash report AND on the server before logging it, so neither side has
 * to trust the other.
 *
 * - The error *message* is dropped: only the error name of the first line is kept, because
 *   messages can quote user text ("Cannot parse 'tell priya…'").
 * - Only frame lines are kept (`at fn (file:line:col)` / `fn@file:line:col`).
 * - In frames: string literals, e-mail addresses, URL queries/fragments and the Windows /
 *   home-directory user name are replaced.
 */

export const MAX_STACK_CHARS = 8_000;
const MAX_FRAMES = 50;

const FRAME = /^\s*(at\s.+|[\w$.<>[\]]*@\S+:\d+(?::\d+)?)\s*$/;
const STRING_LITERAL = /(["'`])(?:\\.|(?!\1)[^\\\r\n])*\1/g;
// Not followed by ":line": `fn@main.js:1:2` is a Firefox frame, not an address.
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+(?![\w.-]*:\d)/g;
const WIN_USER = /([A-Za-z]:[\\/]+Users[\\/]+)[^\\/:)\s]+/gi;
const NIX_USER = /(\/(?:home|Users)\/)[^/:)\s]+/g;
const URL_TAIL = /(https?:\/\/[^\s?#)]+)[?#][^\s:)]*/g;

function scrubFrame(line: string): string {
  return line
    .replace(URL_TAIL, "$1")
    .replace(STRING_LITERAL, '"…"')
    .replace(EMAIL, "<email>")
    .replace(WIN_USER, "$1<user>")
    .replace(NIX_USER, "$1<user>")
    .trim();
}

export function scrubStack(stack: string | undefined | null): string {
  if (!stack) return "";
  const lines = stack.split(/\r?\n/);
  const name = /^\s*([A-Za-z_$][\w$.]*)/.exec(lines[0] ?? "")?.[1];
  const head = name && !FRAME.test(lines[0]!) ? [name] : [];
  const frames = lines
    .filter((l) => FRAME.test(l))
    .slice(0, MAX_FRAMES)
    .map(scrubFrame);
  return [...head, ...frames].join("\n").slice(0, MAX_STACK_CHARS);
}

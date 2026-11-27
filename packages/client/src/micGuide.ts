/**
 * What to tell someone whose microphone is blocked, step by step. Shared by the web app's
 * dialog and the desktop app's guide so both say the same thing.
 */
export type MicProblem =
  /** The browser (or this embedded view) refused, or the user clicked Block. */
  | "browser-denied"
  /** Shown inside a view that can't use the mic at all (an iframe or an app's web pane). */
  | "embedded"
  /** Windows privacy settings block desktop apps (or every app) from the mic. */
  | "windows-off"
  /** No microphone plugged in / found. */
  | "no-device";

export interface MicGuide {
  title: string;
  intro: string;
  steps: string[];
}

export function micGuide(problem: MicProblem): MicGuide {
  switch (problem) {
    case "browser-denied":
      return {
        title: "Allow the microphone",
        intro:
          "Sayvox needs your microphone to hear you. Your browser is blocking it for this site.",
        steps: [
          "Click the lock or settings icon at the left of the address bar.",
          'Find "Microphone" and set it to "Allow".',
          "Reload the page, then hold the button or Space bar and speak.",
          'Still blocked? In Windows Settings → Privacy & security → Microphone, turn on "Microphone access" and "Let apps access your microphone".',
          "Opened inside another app's window (for example a browser pane in a chat or code app)? Those block the microphone: open this page in Chrome or Edge instead.",
        ],
      };
    case "embedded":
      return {
        title: "Open Sayvox in your browser",
        intro: "This window can't use the microphone. Open the page in Chrome or Edge instead.",
        steps: [
          "Copy this page's address (the button below).",
          "Open Chrome or Edge and paste it into the address bar.",
          'When the browser asks to use your microphone, click "Allow".',
        ],
      };
    case "windows-off":
      return {
        title: "Turn on microphone access in Windows",
        intro: "Windows is blocking Sayvox from your microphone.",
        steps: [
          'Click "Open Windows settings" below (Privacy & security → Microphone opens).',
          'Turn on "Microphone access".',
          'Turn on "Let desktop apps access your microphone" (near the bottom).',
          "Come back and hold your shortcut again. No restart needed.",
        ],
      };
    case "no-device":
      return {
        title: "No microphone found",
        intro: "Sayvox couldn't find a microphone on this PC.",
        steps: [
          "Plug in a headset or USB microphone (or turn on your laptop's built-in mic).",
          "In Windows Settings → System → Sound → Input, check it's selected and the level moves when you speak.",
          "Try again.",
        ],
      };
  }
}

/** Map a getUserMedia error to the problem to explain. */
export function micProblemFromError(err: unknown, embedded: boolean): MicProblem {
  const name = err instanceof DOMException || err instanceof Error ? err.name : "";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "no-device";
  // A blocked iframe / app pane fails the same way as a denied prompt.
  return embedded ? "embedded" : "browser-denied";
}

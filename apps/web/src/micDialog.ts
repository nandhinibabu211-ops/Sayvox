import { micGuide, type MicProblem } from "@sayvox/client";

/**
 * Microphone help for the web app: a modal with the steps for the problem at hand and a
 * "Try again" button that asks the browser for the mic again. Uses <dialog> (keyboard and
 * screen-reader friendly, Esc closes).
 */
export function isEmbedded(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true; // cross-origin parent: definitely embedded
  }
}

/** "granted" | "denied" | "prompt", or "unknown" where the Permissions API can't say. */
export async function micPermission(): Promise<PermissionState | "unknown"> {
  try {
    const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
    return status.state;
  } catch {
    return "unknown";
  }
}

/** Ask for the mic and release it at once; true if the browser now allows it. */
export async function requestMic(): Promise<boolean> {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    return false;
  }
}

let dialog: HTMLDialogElement | undefined;

function build(): HTMLDialogElement {
  const d = document.createElement("dialog");
  d.className = "mic-dialog";
  d.setAttribute("aria-labelledby", "mic-title");
  d.innerHTML = `
    <h2 id="mic-title"></h2>
    <p class="mic-intro"></p>
    <ol class="mic-steps"></ol>
    <p class="mic-result" role="status" aria-live="polite"></p>
    <div class="row">
      <button type="button" class="primary" data-act="retry">Try again</button>
      <button type="button" data-act="copy" hidden>Copy page address</button>
      <button type="button" class="link" data-act="close">Close</button>
    </div>`;
  document.body.append(d);
  return d;
}

/** Show the guide; resolves true once the mic works (after "Try again"). */
export function showMicDialog(problem: MicProblem): Promise<boolean> {
  dialog ??= build();
  const d = dialog;
  const g = micGuide(problem);
  d.querySelector("#mic-title")!.textContent = g.title;
  d.querySelector(".mic-intro")!.textContent = g.intro;
  const steps = d.querySelector(".mic-steps")!;
  steps.replaceChildren(
    ...g.steps.map((s) => {
      const li = document.createElement("li");
      li.textContent = s;
      return li;
    }),
  );
  const result = d.querySelector<HTMLParagraphElement>(".mic-result")!;
  result.textContent = "";
  const retry = d.querySelector<HTMLButtonElement>('[data-act="retry"]')!;
  const copy = d.querySelector<HTMLButtonElement>('[data-act="copy"]')!;
  const close = d.querySelector<HTMLButtonElement>('[data-act="close"]')!;
  retry.hidden = problem === "embedded";
  copy.hidden = problem !== "embedded";

  return new Promise((resolve) => {
    let ok = false;
    retry.onclick = () => {
      result.textContent = "Checking…";
      void requestMic().then((granted) => {
        if (granted) {
          ok = true;
          d.close();
        } else {
          result.textContent =
            "Still blocked. Follow the steps above (the browser may need a reload after you change the setting).";
        }
      });
    };
    copy.onclick = () => {
      void navigator.clipboard.writeText(location.href).then(
        () => (result.textContent = "Copied. Paste it into Chrome or Edge."),
        () => (result.textContent = location.href),
      );
    };
    close.onclick = () => d.close();
    d.onclose = () => resolve(ok);
    if (!d.open) d.showModal();
  });
}

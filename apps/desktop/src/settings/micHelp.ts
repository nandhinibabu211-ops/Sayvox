import { micGuide, type MicProblem } from "@sayvox/client";
import { openMicrophoneSettings } from "../onboarding/permissions";
import { h } from "./dom";

/**
 * Microphone guide in the Sayvox window (opened from the overlay's "Fix it" when capture
 * fails). Windows has no permission prompt for desktop apps, so the fix is always a setting
 * the user changes; this lists the exact steps and opens the right Windows page.
 */
let dialog: HTMLDialogElement | undefined;

export function showMicHelp(problem: MicProblem): void {
  const g = micGuide(problem);
  dialog?.remove();
  const openBtn = h("button", { type: "button", class: "primary" }, "Open Windows settings");
  openBtn.addEventListener("click", () => {
    void openMicrophoneSettings().catch(() => {});
  });
  const closeBtn = h("button", { type: "button" }, "Done");
  const d = h(
    "dialog",
    { class: "mic-help", "aria-labelledby": "mic-help-title" },
    h("h2", { id: "mic-help-title" }, g.title),
    h("p", {}, g.intro),
    h("ol", {}, ...g.steps.map((s) => h("li", {}, s))),
    h("div", { class: "row" }, ...(problem === "windows-off" ? [openBtn] : []), closeBtn),
  );
  closeBtn.addEventListener("click", () => d.close());
  d.addEventListener("close", () => d.remove());
  document.body.append(d);
  dialog = d;
  d.showModal();
}

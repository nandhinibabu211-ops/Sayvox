import {
  HOTKEY_OPTIONS,
  type Hotkey,
  type InsertMode,
  type SettingsResponse,
} from "@sayvox/shared";
import { invoke } from "@tauri-apps/api/core";
import { openMicrophoneSettings } from "../onboarding/permissions";
import { h, save, select, type SettingsContext } from "./dom";
import {
  HotkeyRecorder,
  hotkeyLabel,
  LANGUAGE_CHOICES,
  languageSetting,
  languageValue,
} from "./model";

/** Settings → General (T067): hotkey, insert behaviour, language, reply context, mic. */
export function mountGeneral(root: HTMLElement, ctx: SettingsContext): void {
  // ── Hotkey ──
  const current = h("kbd", { class: "hotkey" });
  const recordBtn = h("button", { type: "button" }, "Change");
  const hotkeySelect = select(
    HOTKEY_OPTIONS.map((o) => ({ value: o, label: hotkeyLabel(o) })),
    { "aria-label": "Hotkey" },
    (v) => save(ctx, { hotkey: v }),
  );
  const recordHint = h("p", { class: "hint", "aria-live": "polite" });

  let recorder: HotkeyRecorder | undefined;
  const onDown = (e: KeyboardEvent) => {
    if (!recorder) return;
    e.preventDefault();
    if (e.key === "Escape") return stop("Cancelled.");
    if (!e.repeat) recorder.keyDown(e.key);
  };
  const onUp = (e: KeyboardEvent) => {
    if (!recorder) return;
    e.preventDefault();
    const r = recorder.keyUp(e.key);
    if (!r) return;
    if ("hotkey" in r) {
      stop(`New hotkey: ${hotkeyLabel(r.hotkey)}.`);
      save(ctx, { hotkey: r.hotkey });
    } else {
      recordHint.textContent = `${r.error} Try again, or press Esc.`;
    }
  };
  function start(): void {
    recorder = new HotkeyRecorder();
    // Pause hold-to-talk so trying a chord doesn't start a dictation.
    void invoke("hotkey_suspend", { suspended: true }).catch(() => {});
    recordBtn.textContent = "Press two keys…";
    recordBtn.setAttribute("aria-pressed", "true");
    recordHint.textContent = "Hold two modifier keys, then let go. Esc cancels.";
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    window.addEventListener("blur", onBlur);
  }
  function stop(message: string): void {
    recorder = undefined;
    void invoke("hotkey_suspend", { suspended: false }).catch(() => {});
    recordBtn.textContent = "Change";
    recordBtn.setAttribute("aria-pressed", "false");
    recordHint.textContent = message;
    window.removeEventListener("keydown", onDown, true);
    window.removeEventListener("keyup", onUp, true);
    window.removeEventListener("blur", onBlur);
  }
  const onBlur = () => stop("");
  recordBtn.addEventListener("click", () => (recorder ? stop("Cancelled.") : start()));

  // ── Insert behaviour ──
  const radios = (["auto", "review"] as const).map((v) =>
    h("input", {
      type: "radio",
      name: "insert-mode",
      value: v,
      on: { change: () => save(ctx, { insertMode: v as InsertMode }) },
    }),
  );

  // ── Language ──
  const language = select(LANGUAGE_CHOICES, { id: "language" }, (v) =>
    save(ctx, { languageHint: languageSetting(v) }),
  );

  // ── Reply context (local only, T063) ──
  const reply = h("input", { type: "checkbox", id: "reply-context" });
  try {
    reply.checked = localStorage.getItem("sayvox.replyContext") === "on";
  } catch {
    reply.disabled = true;
  }
  reply.addEventListener("change", () => {
    try {
      localStorage.setItem("sayvox.replyContext", reply.checked ? "on" : "off");
    } catch {
      // ignore
    }
    void invoke("set_reply_context", { enabled: reply.checked });
  });

  root.replaceChildren(
    h("h2", {}, "General"),
    h(
      "section",
      { "aria-labelledby": "hk-title" },
      h("h3", { id: "hk-title" }, "Hold-to-talk hotkey"),
      h("div", { class: "row" }, current, recordBtn, hotkeySelect),
      recordHint,
      h(
        "p",
        { class: "hint" },
        "Ctrl + Shift also switches keyboard layout on PCs with several input languages; " +
          "if that happens, pick another.",
      ),
    ),
    h(
      "section",
      {},
      h("h3", {}, "After an AI rewrite"),
      h("label", { class: "check" }, radios[0]!, "Insert right away"),
      h(
        "label",
        { class: "check" },
        radios[1]!,
        "Let me review it first (Enter inserts, Esc discards)",
      ),
    ),
    h(
      "section",
      {},
      h("h3", {}, h("label", { for: "language" }, "Language")),
      language,
      h("p", { class: "hint" }, "Hinglish lets you mix Hindi and English in one sentence."),
    ),
    h(
      "section",
      {},
      h("h3", {}, "Email replies"),
      h(
        "label",
        { class: "check" },
        reply,
        "Use the text I've selected as the email I'm replying to",
      ),
      h(
        "p",
        { class: "hint" },
        "Off by default. When on, Sayvox reads only the text you've selected at the moment " +
          "you press the hotkey, uses it for that one reply, and never stores it.",
      ),
    ),
    h(
      "section",
      {},
      h("h3", {}, "Microphone"),
      h(
        "p",
        { class: "hint" },
        "If dictation says microphone access is off, turn on “Let desktop apps access your " +
          "microphone” in Windows settings.",
      ),
      h(
        "button",
        { type: "button", on: { click: () => void openMicrophoneSettings() } },
        "Open microphone settings",
      ),
    ),
  );

  const render = (s: SettingsResponse) => {
    current.textContent = hotkeyLabel(s.hotkey);
    hotkeySelect.value = s.hotkey satisfies Hotkey;
    for (const r of radios) r.checked = r.value === s.insertMode;
    language.value = languageValue(s);
  };
  if (ctx.store.current) render(ctx.store.current);
  ctx.store.subscribe(render);
}

import type { Mode, SettingsResponse } from "@sayvox/shared";
import { invoke } from "@tauri-apps/api/core";
import { BUILT_IN_MODES } from "../services/modeResolver";
import { h, save, select, type SettingsContext } from "./dom";
import { addOverride, appLabel, MODE_CHOICES, parseAppId, removeOverride } from "./model";

/** Settings → Modes (T068): default mode and per-app overrides. */
export function mountModes(root: HTMLElement, ctx: SettingsContext): void {
  const defaultMode = select(MODE_CHOICES, { id: "default-mode" }, (v) =>
    save(ctx, { defaultMode: v }),
  );

  const tbody = h("tbody");
  const empty = h("p", { class: "hint" }, "No overrides yet. Built-in choices apply.");
  const appsList = h("datalist", { id: "running-apps" });
  const appInput = h("input", {
    type: "text",
    id: "add-app",
    list: "running-apps",
    placeholder: "slack.exe",
    autocomplete: "off",
    spellcheck: false,
  });
  const addMode = select(MODE_CHOICES, { "aria-label": "Mode for the new app" }, () => {});
  const addError = h("p", { class: "error", role: "alert" });

  async function loadApps(): Promise<void> {
    const running = await invoke<string[]>("list_running_apps").catch(() => [] as string[]);
    const ids = [...new Set([...running, ...Object.keys(BUILT_IN_MODES)])];
    appsList.replaceChildren(...ids.map((id) => h("option", { value: id }, appLabel(id))));
  }
  appInput.addEventListener("focus", () => void loadApps(), { once: false });

  function overrides(): Readonly<Record<string, Mode>> {
    return ctx.store.current?.appModeOverrides ?? {};
  }

  const form = h(
    "form",
    {
      class: "row",
      on: {
        submit: (e) => {
          e.preventDefault();
          const parsed = parseAppId(appInput.value);
          if ("error" in parsed) {
            addError.textContent = parsed.error;
            return;
          }
          const next = addOverride(overrides(), parsed.id, addMode.value as Mode);
          if ("error" in next) {
            addError.textContent = String(next.error);
            return;
          }
          addError.textContent = "";
          appInput.value = "";
          save(ctx, { appModeOverrides: next as Record<string, Mode> });
        },
      },
    },
    h("label", { for: "add-app", class: "sr-only" }, "App"),
    appInput,
    appsList,
    addMode,
    h("button", { type: "submit" }, "Add app"),
  );

  root.replaceChildren(
    h("h2", {}, "Modes"),
    h(
      "section",
      {},
      h("h3", {}, h("label", { for: "default-mode" }, "Default mode")),
      defaultMode,
      h("p", { class: "hint" }, "Used for apps without a built-in choice or an override."),
    ),
    h(
      "section",
      {},
      h("h3", {}, "Per-app overrides"),
      h(
        "p",
        { class: "hint" },
        "Built in: Cursor and VS Code → Prompt; Gmail and Outlook → Email; Slack and Teams → " +
          "chat message. Add an app here to change that.",
      ),
      h(
        "table",
        { class: "overrides" },
        h("thead", {}, h("tr", {}, h("th", {}, "App"), h("th", {}, "Mode"), h("th", {}, ""))),
        tbody,
      ),
      empty,
      form,
      addError,
    ),
  );

  const render = (s: SettingsResponse) => {
    defaultMode.value = s.defaultMode;
    const entries = Object.entries(s.appModeOverrides).sort(([a], [b]) => a.localeCompare(b));
    empty.hidden = entries.length > 0;
    tbody.replaceChildren(
      ...entries.map(([id, mode]) => {
        const modeSel = select(MODE_CHOICES, { "aria-label": `Mode for ${appLabel(id)}` }, (v) =>
          save(ctx, { appModeOverrides: { ...overrides(), [id]: v } }),
        );
        modeSel.value = mode;
        return h(
          "tr",
          {},
          h("td", {}, appLabel(id)),
          h("td", {}, modeSel),
          h(
            "td",
            {},
            h(
              "button",
              {
                type: "button",
                class: "link",
                "aria-label": `Remove ${appLabel(id)}`,
                on: {
                  click: () => save(ctx, { appModeOverrides: removeOverride(overrides(), id) }),
                },
              },
              "Remove",
            ),
          ),
        );
      }),
    );
  };
  if (ctx.store.current) render(ctx.store.current);
  ctx.store.subscribe(render);
}

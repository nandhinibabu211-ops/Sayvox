import type { SettingsResponse } from "@sayvox/shared";
import { h, save, type SettingsContext } from "./dom";
import { presetCards } from "./model";

/** Settings → Preset (T069): three cards; presets outside the plan are shown locked. */
export function mountPreset(root: HTMLElement, ctx: SettingsContext): void {
  const group = h("div", { class: "cards", role: "radiogroup", "aria-label": "Preset" });

  root.replaceChildren(
    h("h2", {}, "Preset"),
    h(
      "p",
      { class: "hint" },
      "Chooses the AI models for Prompt and Email modes. Dictation isn't affected.",
    ),
    group,
  );

  const render = (s: SettingsResponse) => {
    const cards = presetCards(s);
    group.replaceChildren(
      ...cards.map((c) =>
        h(
          "button",
          {
            type: "button",
            role: "radio",
            class: `card${c.selected ? " selected" : ""}${c.locked ? " locked" : ""}`,
            "aria-checked": String(c.selected),
            "aria-disabled": String(c.locked),
            tabindex: c.selected ? 0 : -1,
            on: {
              click: () => {
                if (c.locked) {
                  ctx.status(`${c.name} is on paid plans. Upgrade to unlock it.`);
                } else if (!c.selected) {
                  save(ctx, { preset: c.id });
                }
              },
              keydown: (e) => {
                // Arrow keys move between cards (radio group pattern).
                const i = cards.indexOf(c);
                const d =
                  e.key === "ArrowRight" || e.key === "ArrowDown"
                    ? 1
                    : e.key === "ArrowLeft" || e.key === "ArrowUp"
                      ? -1
                      : 0;
                if (!d) return;
                e.preventDefault();
                const next = group.children[(i + d + cards.length) % cards.length] as HTMLElement;
                next.focus();
              },
            },
          },
          h("strong", {}, c.name),
          c.recommended ? h("span", { class: "tag" }, "Recommended") : null,
          h("span", { class: "hint" }, c.hint),
          c.locked ? h("span", { class: "lock" }, "🔒 Paid plans") : null,
        ),
      ),
    );
  };
  if (ctx.store.current) render(ctx.store.current);
  ctx.store.subscribe(render);
}

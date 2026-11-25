import type { DictionaryList, DictionaryTerm } from "@sayvox/shared";
import { errorMessage, h, type SettingsContext } from "./dom";
import { dictionaryCounter } from "./model";

/**
 * Settings → Dictionary (T070): names and jargon Sayvox should spell right. Terms are sent
 * to speech recognition as keyterms on the next dictation.
 */
export function mountDictionary(root: HTMLElement, ctx: SettingsContext): void {
  let terms: DictionaryTerm[] = [];
  let limit = ctx.store.current?.plan.dictionaryLimit ?? 0;

  const counter = h("span", { class: "counter", "aria-live": "polite" });
  const list = h("ul", { class: "terms" });
  const input = h("input", {
    type: "text",
    id: "term",
    maxLength: 64,
    placeholder: "Zoho CRM",
    autocomplete: "off",
    spellcheck: false,
  });
  const addBtn = h("button", { type: "submit" }, "Add");
  const error = h("p", { class: "error", role: "alert" });

  function render(): void {
    const c = dictionaryCounter(terms.length, limit);
    counter.textContent = c.text;
    input.disabled = c.full;
    addBtn.disabled = c.full;
    error.textContent = c.full ? `Dictionary limit reached (${limit} terms on your plan).` : "";
    list.replaceChildren(
      ...terms.map((t) =>
        h(
          "li",
          {},
          h("span", {}, t.term),
          h(
            "button",
            {
              type: "button",
              class: "link",
              "aria-label": `Delete ${t.term}`,
              on: { click: () => void remove(t) },
            },
            "Delete",
          ),
        ),
      ),
    );
  }

  async function load(): Promise<void> {
    try {
      const r = await ctx.api.json<DictionaryList>("/v1/dictionary");
      terms = r.terms;
      limit = r.limit;
      render();
    } catch (err) {
      error.textContent = errorMessage(err);
    }
  }

  async function add(): Promise<void> {
    const term = input.value;
    if (!term.trim()) return;
    addBtn.disabled = true;
    try {
      const created = await ctx.api.json<DictionaryTerm>("/v1/dictionary", {
        method: "POST",
        body: JSON.stringify({ term }),
      });
      terms = [...terms, created];
      input.value = "";
      render();
      ctx.status(`Added “${created.term}”.`);
    } catch (err) {
      error.textContent = errorMessage(err);
      addBtn.disabled = false;
    }
  }

  async function remove(t: DictionaryTerm): Promise<void> {
    const before = terms;
    terms = terms.filter((x) => x.id !== t.id); // optimistic
    render();
    try {
      await ctx.api.json(`/v1/dictionary/${t.id}`, { method: "DELETE" });
      ctx.status(`Deleted “${t.term}”.`);
    } catch (err) {
      terms = before;
      render();
      error.textContent = errorMessage(err);
    }
  }

  root.replaceChildren(
    h("h2", {}, "Dictionary ", counter),
    h(
      "p",
      { class: "hint" },
      "Names, products and jargon you say often. Sayvox listens for these and spells them " +
        "your way.",
    ),
    h(
      "form",
      {
        class: "row",
        on: {
          submit: (e) => {
            e.preventDefault();
            void add();
          },
        },
      },
      h("label", { for: "term", class: "sr-only" }, "New term"),
      input,
      addBtn,
    ),
    error,
    list,
  );
  render();
  void load();
}

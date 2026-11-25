import type { ApiClient } from "../services/apiClient";
import type { SettingsStore } from "../services/settingsStore";

/** Tiny DOM builder: no innerHTML, so user text (terms, app ids) is always plain text. */
type Handlers = Partial<{ [K in keyof HTMLElementEventMap]: (e: HTMLElementEventMap[K]) => void }>;
type Props = { [attr: string]: string | boolean | number | undefined | Handlers; on?: Handlers };
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "on") {
      for (const [ev, fn] of Object.entries(v as Handlers)) {
        el.addEventListener(ev, fn as EventListener);
      }
    } else if (k === "class") {
      el.className = String(v);
    } else if (typeof v === "boolean") {
      if (k in el) (el as unknown as Record<string, boolean>)[k] = v;
      else el.toggleAttribute(k, v);
    } else if (v !== undefined) {
      if (k in el && k !== "list") (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, String(v));
    }
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

export interface SettingsContext {
  store: SettingsStore;
  api: ApiClient;
  /** Announce a result in the window's live region. */
  status: (message: string) => void;
}

export function errorMessage(err: unknown): string {
  if (err instanceof TypeError) return "No internet connection. Your change wasn't saved.";
  if (err instanceof Error && err.message) return err.message;
  return "Couldn't save. Try again.";
}

/** Save a change; on failure the store has already rolled back, so just say why. */
export function save(ctx: SettingsContext, change: Parameters<SettingsStore["update"]>[0]): void {
  ctx.store
    .update(change)
    .then(() => ctx.status("Saved."))
    .catch((err: unknown) => ctx.status(errorMessage(err)));
}

export function select<T extends string>(
  options: readonly { value: T; label: string }[],
  props: Props,
  onChange: (v: T) => void,
): HTMLSelectElement {
  const el = h(
    "select",
    { ...props, on: { change: () => onChange(el.value as T) } },
    ...options.map((o) => h("option", { value: o.value }, o.label)),
  );
  return el;
}

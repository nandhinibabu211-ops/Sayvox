import { Settings, SettingsResponse } from "@sayvox/shared";

/**
 * The user's settings on this PC (Story 2.6 AC 2): hydrated from `/v1/settings` at start,
 * updated optimistically and rolled back if the server refuses.
 *
 * Only server-confirmed settings are cached (localStorage, same origin for both windows),
 * so the overlay picks up a change through the `storage` event and works offline with the
 * last known values.
 */

export const SETTINGS_CACHE_KEY = "sayvox.settings";

export interface SettingsApi {
  get(): Promise<SettingsResponse>;
  put(s: Settings): Promise<SettingsResponse>;
}

export interface KeyValue {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export const browserStorage: KeyValue = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // storage unavailable: settings still work for this session
    }
  },
};

export function parseCached(raw: string | null): SettingsResponse | null {
  if (!raw) return null;
  try {
    const parsed = SettingsResponse.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Strip the plan info: PUT takes exactly the settings fields. */
function toSettings(s: SettingsResponse): Settings {
  return Settings.parse({
    preset: s.preset,
    defaultMode: s.defaultMode,
    appModeOverrides: s.appModeOverrides,
    insertMode: s.insertMode,
    languageHint: s.languageHint,
    hotkey: s.hotkey,
    translateHotkey: s.translateHotkey,
  });
}

/** A change to some settings: the response's fields (translateHotkey is never undefined). */
export type SettingsPatch = Partial<Omit<SettingsResponse, "plan">>;

type Listener = (s: SettingsResponse) => void;

export class SettingsStore {
  /** Last state the server confirmed. */
  private confirmed: SettingsResponse | null;
  /** Optimistic changes not yet confirmed, oldest first. */
  private pending: { patch: SettingsPatch }[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly api: SettingsApi,
    private readonly storage: KeyValue = browserStorage,
  ) {
    this.confirmed = parseCached(storage.get(SETTINGS_CACHE_KEY));
  }

  /** What the UI shows: confirmed settings plus pending changes. */
  get current(): SettingsResponse | null {
    if (!this.confirmed) return null;
    return this.pending.reduce<SettingsResponse>((s, p) => ({ ...s, ...p.patch }), this.confirmed);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const s = this.current;
    if (s) for (const fn of this.listeners) fn(s);
  }

  private confirm(s: SettingsResponse): void {
    this.confirmed = s;
    this.storage.set(SETTINGS_CACHE_KEY, JSON.stringify(s));
  }

  async load(): Promise<SettingsResponse> {
    const s = await this.api.get();
    this.confirm(s);
    this.emit();
    return this.current!;
  }

  /**
   * Apply `patch` now; save it in order with earlier changes. On failure the change is
   * undone (later pending changes are kept) and the error is rethrown for the UI.
   */
  update(patch: SettingsPatch): Promise<SettingsResponse> {
    if (!this.confirmed) return Promise.reject(new Error("Settings not loaded"));
    const entry = { patch };
    this.pending.push(entry);
    this.emit();

    const run = async (): Promise<SettingsResponse> => {
      const drop = () => {
        this.pending = this.pending.filter((p) => p !== entry);
      };
      try {
        const saved = await this.api.put(toSettings({ ...this.confirmed!, ...patch }));
        drop();
        this.confirm(saved);
        return saved;
      } catch (err) {
        drop();
        throw err;
      } finally {
        this.emit();
      }
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => {});
    return result;
  }
}

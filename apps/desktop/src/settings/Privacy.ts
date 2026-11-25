import { openUrl } from "@tauri-apps/plugin-opener";
import { canConfirmDeletion, deleteAccount, DELETE_CONFIRMATION } from "../services/account";
import { credentialSessionStore } from "../services/session";
import { errorMessage, h, type SettingsContext } from "./dom";

export const PRIVACY_URL = "https://sayvox-app-2026.web.app/privacy";
export const TERMS_URL = "https://sayvox-app-2026.web.app/terms";

/**
 * Settings → Privacy & Account (T074, Story 5.6 AC 1 / 5.7 AC 2): the same plain-language
 * summary as the privacy page, and account deletion behind a typed confirmation.
 */
export function mountPrivacy(
  root: HTMLElement,
  ctx: SettingsContext & { email: () => string; onDeleted: () => void },
): void {
  const link = (url: string, label: string) =>
    h(
      "button",
      { type: "button", class: "link", on: { click: () => void openUrl(url).catch(() => {}) } },
      label,
    );

  // ── Delete account ──
  const confirmInput = h("input", {
    type: "text",
    id: "confirm-delete",
    autocomplete: "off",
    spellcheck: false,
    "aria-describedby": "confirm-help",
  });
  const confirmBtn = h(
    "button",
    { type: "submit", class: "danger", disabled: true },
    "Delete my account",
  );
  const deleteError = h("p", { class: "error", role: "alert" });
  const dialog = h(
    "form",
    {
      class: "confirm",
      hidden: true,
      on: {
        submit: (e) => {
          e.preventDefault();
          void confirm();
        },
      },
    },
    h(
      "p",
      { id: "confirm-help" },
      "This permanently deletes your account, settings, dictionary and usage history, and " +
        `signs you out on this PC. It can't be undone. Type ${DELETE_CONFIRMATION} to confirm.`,
    ),
    h("label", { for: "confirm-delete", class: "sr-only" }, `Type ${DELETE_CONFIRMATION}`),
    h(
      "div",
      { class: "row" },
      confirmInput,
      confirmBtn,
      h(
        "button",
        {
          type: "button",
          on: {
            click: () => {
              dialog.hidden = true;
              openBtn.hidden = false;
              openBtn.focus();
            },
          },
        },
        "Cancel",
      ),
    ),
    deleteError,
  );
  const openBtn = h(
    "button",
    {
      type: "button",
      class: "danger-outline",
      on: {
        click: () => {
          openBtn.hidden = true;
          dialog.hidden = false;
          confirmInput.value = "";
          confirmBtn.disabled = true;
          deleteError.textContent = "";
          confirmInput.focus();
        },
      },
    },
    "Delete account…",
  );
  confirmInput.addEventListener("input", () => {
    confirmBtn.disabled = !canConfirmDeletion(confirmInput.value);
  });

  async function confirm(): Promise<void> {
    if (!canConfirmDeletion(confirmInput.value)) return;
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Deleting…";
    try {
      await deleteAccount(ctx.api, credentialSessionStore);
      ctx.onDeleted();
    } catch (err) {
      deleteError.textContent = `${errorMessage(err)} Nothing on this PC was changed; you can try again.`;
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Delete my account";
    }
  }

  root.replaceChildren(
    h("h2", {}, "Privacy & Account"),
    h(
      "section",
      {},
      h("h3", {}, "Where your words go"),
      h(
        "ul",
        { class: "facts" },
        h(
          "li",
          {},
          h("strong", {}, "Audio → ElevenLabs"),
          " for speech recognition, straight from this PC. ElevenLabs may keep audio and " +
            "transcripts under its own terms.",
        ),
        h(
          "li",
          {},
          h("strong", {}, "Text → your preset's AI model via OpenRouter"),
          ", in Prompt and Email modes only, and only to providers that don't train on or keep " +
            "your text.",
        ),
        h(
          "li",
          {},
          h("strong", {}, "Sayvox stores none of it."),
          " No audio, transcripts or rewrites. We keep your email, settings, dictionary and " +
            "usage numbers (seconds, mode, app name, timings).",
        ),
        h(
          "li",
          {},
          "Text is pasted through the clipboard; clipboard history tools may capture it briefly.",
        ),
      ),
      h(
        "div",
        { class: "row" },
        link(PRIVACY_URL, "Full privacy notice"),
        link(TERMS_URL, "Terms"),
      ),
    ),
    h(
      "section",
      {},
      h("h3", {}, "Account"),
      h("p", {}, "Signed in as ", h("strong", {}, ctx.email()), "."),
      openBtn,
      dialog,
    ),
  );
}

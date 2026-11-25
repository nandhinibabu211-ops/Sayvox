import { initializeApp } from "firebase/app";
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  browserPopupRedirectResolver,
  initializeAuth,
  inMemoryPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
  type User,
} from "firebase/auth";
import { webConfig } from "./config";
import { deepLink, parseHandoff, sendToDesktop } from "./handoff";

// Identity Platform client config (public; see config.ts).
const config = webConfig();
const firebase = initializeApp({
  apiKey: config.apiKey,
  authDomain: config.authDomain,
  projectId: "sayvox-app-2026",
});
// In-memory only from the start: tokens go to the desktop app and are never kept in this
// browser (and the SDK never touches IndexedDB).
const auth = initializeAuth(firebase, {
  persistence: inMemoryPersistence,
  popupRedirectResolver: browserPopupRedirectResolver,
});

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $<HTMLParagraphElement>("status");
const buttons = () => document.querySelectorAll<HTMLButtonElement>("button");

function show(text: string, isError = false): void {
  status.textContent = text;
  status.classList.toggle("error", isError);
}

const handoff = parseHandoff(window.location.search);
if (!handoff) {
  show("Open this page from the Sayvox app to sign in.", true);
  buttons().forEach((b) => (b.disabled = true));
}

async function finish(user: User): Promise<void> {
  if (!handoff) return;
  show("Signing you in to the app…");
  const result = await user.getIdTokenResult();
  const expiresIn = Math.max(
    60,
    Math.round((Date.parse(result.expirationTime) - Date.now()) / 1000),
  );
  const ok = await sendToDesktop(handoff, {
    idToken: result.token,
    refreshToken: user.refreshToken,
    expiresIn,
    email: user.email ?? "",
  });
  // The browser keeps nothing: persistence is in-memory and we sign out right away.
  await auth.signOut();
  if (!ok) {
    show("Couldn't reach the Sayvox app. Go back to the app and try signing in again.", true);
    return;
  }
  show("Signed in. You can close this tab.");
  window.location.href = deepLink(handoff.state);
}

async function run(action: () => Promise<{ user: User }>): Promise<void> {
  buttons().forEach((b) => (b.disabled = true));
  try {
    await finish((await action()).user);
  } catch (err) {
    const code = (err as { code?: string }).code ?? "";
    show(
      code.includes("invalid-credential") || code.includes("wrong-password")
        ? "Email or password is incorrect."
        : code.includes("email-already-in-use")
          ? "An account with this email exists. Sign in instead."
          : code.includes("popup-closed")
            ? "Sign-in was cancelled."
            : "Sign-in failed. Please try again.",
      true,
    );
    buttons().forEach((b) => (b.disabled = false));
  }
}

const email = () => $<HTMLInputElement>("email").value.trim();
const password = () => $<HTMLInputElement>("password").value;

// Google sign-in needs an OAuth consent screen + client in Identity Platform (owner step);
// until VITE_GOOGLE_SIGNIN=true the button is hidden rather than failing on click.
const googleButton = $<HTMLButtonElement>("google");
if (config.googleSignIn) {
  googleButton.addEventListener("click", () => {
    void run(() => signInWithPopup(auth, new GoogleAuthProvider()));
  });
} else {
  googleButton.remove();
}
$<HTMLFormElement>("email-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void run(() => signInWithEmailAndPassword(auth, email(), password()));
});
$<HTMLButtonElement>("create").addEventListener("click", () => {
  if (!$<HTMLFormElement>("email-form").reportValidity()) return;
  void run(() => createUserWithEmailAndPassword(auth, email(), password()));
});

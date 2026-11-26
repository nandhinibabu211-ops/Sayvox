import { initializeApp } from "firebase/app";
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  browserPopupRedirectResolver,
  initializeAuth,
  inMemoryPersistence,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  type User,
} from "firebase/auth";
import { authErrorMessage, RESET_SENT } from "./authMessages";
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

// From the desktop app the URL carries ?port&state and the session is handed to the app.
// Opened directly, the page still lets people create an account, check their password or
// reset it; it then signs out and keeps nothing.
const handoff = parseHandoff(window.location.search);
if (!handoff) {
  show(
    "You can create your account or reset your password here. To dictate, sign in from the Sayvox app.",
  );
}

async function finish(user: User): Promise<void> {
  if (!handoff) {
    const who = user.email ?? "your account";
    await auth.signOut();
    show(
      `Done: ${who} works. Now open the Sayvox app and sign in there with the same email and password.`,
    );
    return;
  }
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
    show(authErrorMessage((err as { code?: string }).code), true);
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
$<HTMLButtonElement>("reset").addEventListener("click", () => {
  const address = email();
  if (!address) return show(authErrorMessage("missing-email"), true);
  void sendPasswordResetEmail(auth, address)
    .then(() => show(RESET_SENT))
    .catch((err: unknown) => {
      const code = (err as { code?: string }).code ?? "";
      // Unknown accounts get the same answer as known ones (no account discovery).
      if (code.includes("user-not-found") || code.includes("invalid-credential")) show(RESET_SENT);
      else show(authErrorMessage(code), true);
    });
});
$<HTMLButtonElement>("create").addEventListener("click", () => {
  if (!$<HTMLFormElement>("email-form").reportValidity()) return;
  void run(() => createUserWithEmailAndPassword(auth, email(), password()));
});

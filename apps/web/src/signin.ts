import { initializeApp } from "firebase/app";
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  getAuth,
  inMemoryPersistence,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
  type User,
} from "firebase/auth";
import { deepLink, parseHandoff, sendToDesktop } from "./handoff";

// Public Firebase web config (not secrets). Set in apps/web/.env for builds.
const firebase = initializeApp({
  apiKey: import.meta.env["VITE_FIREBASE_API_KEY"] as string,
  authDomain: import.meta.env["VITE_FIREBASE_AUTH_DOMAIN"] as string,
  projectId: "sayvox-app-2026",
});
const auth = getAuth(firebase);

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
    await setPersistence(auth, inMemoryPersistence);
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

$<HTMLButtonElement>("google").addEventListener("click", () => {
  void run(() => signInWithPopup(auth, new GoogleAuthProvider()));
});
$<HTMLFormElement>("email-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void run(() => signInWithEmailAndPassword(auth, email(), password()));
});
$<HTMLButtonElement>("create").addEventListener("click", () => {
  if (!$<HTMLFormElement>("email-form").reportValidity()) return;
  void run(() => createUserWithEmailAndPassword(auth, email(), password()));
});

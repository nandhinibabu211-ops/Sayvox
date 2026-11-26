/**
 * Plain-language messages for Identity Platform (Firebase Auth SDK) error codes on the
 * sign-in page. Unknown codes fall back to a generic line; raw error text is never shown.
 */
const MESSAGES: [string, string][] = [
  ["invalid-credential", "Email or password is incorrect."],
  ["wrong-password", "Email or password is incorrect."],
  ["user-not-found", "Email or password is incorrect."],
  ["invalid-email", "That doesn't look like an email address."],
  ["email-already-in-use", "An account with this email exists. Sign in instead."],
  ["weak-password", "Use a longer password: at least 8 characters."],
  ["password-does-not-meet-requirements", "Use a longer password: at least 8 characters."],
  ["too-many-requests", "Too many attempts. Wait a few minutes and try again."],
  ["user-disabled", "This account is disabled. Contact support."],
  ["network-request-failed", "No internet connection. Check it and try again."],
  ["popup-closed", "Sign-in was cancelled."],
  ["missing-email", "Enter your email address first."],
];

export function authErrorMessage(code: string | undefined): string {
  const c = code ?? "";
  for (const [needle, text] of MESSAGES) if (c.includes(needle)) return text;
  return "Sign-in failed. Please try again.";
}

/**
 * Same answer whether or not the account exists, so the page can't be used to find out
 * which emails have Sayvox accounts.
 */
export const RESET_SENT =
  "If an account exists for this email, we've sent a link to reset the password. Check your inbox and spam folder.";

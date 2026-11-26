/** API failures for the in-browser app, in plain language. */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
    readonly serverMessage?: string,
  ) {
    super(`API ${status}${code ? ` ${code}` : ""}`);
    this.name = "ApiFailure";
  }
}

export function apiErrorMessage(err: unknown): string {
  if (!(err instanceof ApiFailure)) {
    return err instanceof TypeError
      ? "Can't reach the Sayvox server. Check your connection and try again."
      : "Something went wrong. Please try again.";
  }
  switch (err.code) {
    case "PROVIDER_UNAVAILABLE":
      return "Speech recognition isn't connected on this server yet. Please try again later.";
    case "QUOTA_EXCEEDED":
      return `${(err.serverMessage ?? "Limit reached").replace(/\.$/, "")}. It resets automatically.`;
    case "RATE_LIMITED":
      return "Too many dictations in a row. Wait a few seconds and try again.";
    case "KILL_SWITCH":
      return err.serverMessage ?? "Sayvox is temporarily paused.";
    case "UNAUTHENTICATED":
      return "Your sign-in expired. Sign out and sign in again.";
    case "CLIENT_OUTDATED":
      return "This page is out of date. Reload it.";
    default:
      return err.status >= 500
        ? "The Sayvox server had a problem. Please try again."
        : "Something went wrong. Please try again.";
  }
}

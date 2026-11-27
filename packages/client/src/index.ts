/**
 * Browser-side Sayvox client pieces shared by the desktop app (Tauri webview) and the web
 * app: the metered speech stream (Scribe protocol via /v1/stream), the rewrite SSE client
 * and local dictation cleanup. Plain web APIs only (WebSocket, fetch), no Tauri.
 */
export * from "./scribeClient";
export * from "./rewriteClient";
export * from "./cleanup";
export * from "./micGuide";

# Contract: `POST /v1/rewrite` Server-Sent Events

Response `Content-Type: text/event-stream`, `Cache-Control: no-store`. Each event is `event: <name>\ndata: <json>\n\n`.

| Event | When | Data |
| --- | --- | --- |
| `meta` | Immediately after validation | `{ "sessionId", "mode", "preset", "model", "templateVersion" }` |
| `token` | Each streamed delta | `{ "text": "<delta>" }` |
| `fallback` | Attempt aborted (error or TTFT > 1.5 s) | `{ "from": "<slug>", "to": "<slug>", "reason": "timeout" \| "error" }` |
| `done` | Stream complete | `{ "model", "inputTokens", "outputTokens", "ttftMs", "totalMs" }` |
| `error` | All attempts failed / total > 8 s | `{ "code": "PROVIDER_UNAVAILABLE", "message" }` → client pastes raw transcript |

Rules:
1. Exactly one terminal event (`done` or `error`).
2. Heartbeat comment `: ping` every 5 s if no event was sent.
3. Client abort (connection close) MUST abort the upstream OpenRouter request.
4. No event payload or log line contains the transcript.

## Upstream request built by backend (one per attempt)
Verified 2026-11-25 (research R2). Each attempt names **one** model, because the lowest reasoning
effort differs per model; the backend walks the preset list itself (R3).
```json
{
  "model": "<slug for this attempt>",
  "stream": true,
  "max_tokens": 600,
  "temperature": 0.2,
  "reasoning": { "effort": "<per-model lowest: none | minimal>" },
  "provider": { "data_collection": "deny", "zdr": true },
  "messages": [
    { "role": "system", "content": "<templates[mode] — byte-stable>" },
    { "role": "user", "content": "<target_app>{app}</target_app>\n<transcript>{transcript}</transcript>" }
  ]
}
```

| Model | `reasoning.effort` |
| --- | --- |
| `anthropic/claude-haiku-5.5` | `none` |
| `openai/gpt-6-luna` | `none` |
| `google/gemini-3.5-flash-lite` | `minimal` (reasoning is mandatory) |

## Upstream stream handling
- Skip SSE comment lines (start with `:`, e.g. `: OPENROUTER PROCESSING`).
- `data: [DONE]` ends the stream; `usage` comes in the last chunk before it.
- A chunk with a top-level `error` (and `finish_reason: "error"`) is a mid-stream failure: if no token was relayed yet, fall back to the next model; otherwise end with `error` (client pastes the raw transcript).
- Log `X-Generation-Id`, model, status and timings only.

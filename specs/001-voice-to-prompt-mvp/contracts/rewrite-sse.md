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

## Upstream request built by backend
```json
{
  "models": ["<primary>", "<fallback1>", "<fallback2>"],
  "stream": true,
  "max_tokens": 600,
  "temperature": 0.2,
  "reasoning": { "effort": "<lowest>" },
  "provider": { "data_collection": "deny" },
  "messages": [
    { "role": "system", "content": "<templates[mode] — byte-stable>" },
    { "role": "user", "content": "<target_app>{app}</target_app>\n<transcript>{transcript}</transcript>" }
  ]
}
```
Field names for `reasoning` and `provider` MUST be verified (research R2).

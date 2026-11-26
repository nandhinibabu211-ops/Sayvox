# How Sayvox works

## 1. Speak → text (speech recognition)

1. **Hold the shortcut and speak.** Your microphone audio goes through Sayvox's server to a
   speech-to-text model on OpenRouter (Whisper large-v3 turbo; ElevenLabs Scribe v2 if that
   fails). Sayvox measures how long the audio is for your usage limit and never stores it.
2. **Let go.** The model writes what you said. While you speak, the text so far appears in
   the overlay every couple of seconds.
3. **Sayvox shapes the text** by the mode (section 3) and types it where your cursor is.

## 2. Languages: Settings → General → Language

| Setting | You say | You get |
| --- | --- | --- |
| **Auto-detect** (default) | English / Tamil | Each dictation in the language you spoke (Tamil in Tamil script) |
| **English**, **English (India)** | English | English |
| **Tamil** | Tamil | Tamil script (தமிழ்) |
| **Tanglish** | Tamil + English mixed | Tamil words in English letters, English words as English: "naalaiku meeting irukku" |
| **Hinglish** | Hindi + English mixed | The same mix |

The AI never translates in Dictation, Prompt or Email mode: it keeps your language and the
way you write it. Only the **English** shortcut/mode changes the language.

## 3. Modes: what Sayvox does with your words

| Mode | Result | Picked when |
| --- | --- | --- |
| **Dictation** | Your words, cleaned (no "um", self-corrections applied) | Most apps (Notepad, Word, browser forms) |
| **Prompt** | A structured prompt | ChatGPT, Claude, Cursor, VS Code |
| **Email** | A tidy email or chat message | Gmail, Outlook, Slack, Teams, WhatsApp |
| **English** | Whatever you said, in natural English | The translate shortcut (below), or chosen by hand |

Change the mode per app in Settings → Modes, or click the mode badge in the overlay while you
speak (it cycles Dictation → Prompt → Email → English for that one dictation).

## 4. Shortcuts (no clicking)

| Hold | Then | Result |
| --- | --- | --- |
| **Ctrl + Shift** | speak, let go | Text in the mode for this app, in your language, typed at the cursor |
| **Ctrl + Alt** | speak (any language), let go | English text, typed at the cursor |

- Both are changeable in Settings → General (two modifier keys each: Ctrl+Shift, Ctrl+Alt,
  Alt+Shift, Ctrl+Win, Shift+Win). The two must differ; the English one can be turned off.
- Letter shortcuts such as Ctrl+T aren't offered: holding a letter would also type it or
  trigger the app's own shortcut (Ctrl+T opens a new browser tab).
- A quick tap is ignored; pressing another key while holding cancels.
- If "Review before insert" is on, Enter inserts the AI text and Esc discards it.

**In the browser (`/app`):** hold the button or the **Space bar**, speak, let go, then **Copy**.
Pick the mode (including English) and your language at the top of the page.

# Phase 1 timing phrases (Story 1.8)

Run a **debug** build (`pnpm --filter @sayvox/desktop tauri dev`), sign in, open Notepad, and dictate each phrase once with Ctrl+Shift held. Then run:

```powershell
pnpm --filter @sayvox/eval timing:report
```

Gate: all 20 inserted, each **< 1 s** from key release to text in Notepad. Record on a home connection and an office network; keep both result files.

| # | Say | Expect (after cleanup) |
| --- | --- | --- |
| 1 | um so let's meet on Thursday no wait Friday | So let's meet on Friday. |
| 2 | please send the invoice to Priya today | Please send the invoice to Priya today. |
| 3 | the build is green ship it | The build is green, ship it. *(punctuation from Scribe may vary)* |
| 4 | book the call for 3 pm sorry I mean 4 pm | Book the call for 4 pm. |
| 5 | can you check the Zoho dashboard | Can you check the Zoho dashboard? |
| 6 | ask Zia to summarise the leads | Ask Zia to summarise the leads. |
| 7 | I will reach office by ten only | I will reach office by ten only. |
| 8 | kindly do the needful and revert | Kindly do the needful and revert. |
| 9 | send me the file na | Send me the file na. |
| 10 | uh the meeting is postponed to next week | The meeting is postponed to next week. |
| 11 | we need three more test cases for login | We need three more test cases for login. |
| 12 | what is the status of order number four five six | What is the status of order number 456? |
| 13 | thanks for the update I'll take a look | Thanks for the update, I'll take a look. |
| 14 | the total is 40 actually no 45 rupees | The total is 45 rupees. |
| 15 | please call me back after lunch | Please call me back after lunch. |
| 16 | let's move the standup to ten thirty | Let's move the standup to 10:30. |
| 17 | I am working from home tomorrow | I am working from home tomorrow. |
| 18 | can we push the release by one day | Can we push the release by one day? |
| 19 | yaar this bug is really annoying | Yaar, this bug is really annoying. |
| 20 | good morning team quick update from my side | Good morning team, quick update from my side. |

Notes: speakers should include Indian English accents. Only timings and pass/fail are saved; no audio or text leaves the machine through this harness.

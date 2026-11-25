# Sayvox — Voice-to-Prompt Dictation

Hold **Ctrl+Shift**, speak, release: clean dictation or a structured AI prompt / email is typed at your cursor on Windows.

## Developer setup (Windows 10/11)

**Prerequisites**
- Node.js 24 LTS and pnpm 10 (`npm install -g pnpm@10`)
- Rust stable with the MSVC target (`winget install Rustlang.Rustup`)
- Visual Studio 2022 Build Tools with the "Desktop development with C++" workload
- Microsoft Edge WebView2 Runtime (preinstalled on Windows 11)
- Docker Desktop (local Postgres + Redis)

**First run**
```powershell
pnpm install
Copy-Item apps/api/.env.example apps/api/.env
docker compose up -d
pnpm --filter @sayvox/api dev            # API on http://localhost:8787/healthz
pnpm --filter @sayvox/desktop tauri dev  # desktop shell
```

**Checks**
```powershell
pnpm check       # lint + typecheck + unit tests (all TypeScript packages)
pnpm lint:rust   # cargo fmt --check + clippy -D warnings
pnpm test:rust   # cargo test
pnpm format      # prettier
```

**Layout:** `apps/desktop` (Tauri v2: Vite + TS UI, Rust core in `src-tauri/`), `apps/api` (Fastify 5), `packages/shared` (Zod schemas from the OpenAPI contract), `packages/prompts` (system prompts + version). Planned folders such as `eval/` and `infra/` arrive with their stories.

## Planning artifacts

### BMAD Method (`docs/`, `.bmad-core/`)
| File | Role |
| --- | --- |
| [docs/project-brief.md](docs/project-brief.md) | Analyst — problem, users, goals, scope |
| [docs/prd.md](docs/prd.md) | PM — FR/NFR, UI goals, epic list |
| [docs/front-end-spec.md](docs/front-end-spec.md) | UX — IA, flows, overlay state machine, screens |
| [docs/architecture.md](docs/architecture.md) | Architect — stack, components, APIs, deployment, standards, ADRs |
| [docs/epics/](docs/epics/) | Epics 1–6 with stories and acceptance criteria |
| [docs/stories/](docs/stories/) | 45 dev-ready stories (1.1–6.8; 5.1 removed, Windows only), status Draft — tasks, dev notes, testing |
| [docs/adr/](docs/adr/README.md) | Decision records (ADR-001–010); only ADR-002 waits on the timing test |
| [docs/checklists/pm-checklist-results.md](docs/checklists/pm-checklist-results.md) | PM checklist outcome |
| [.bmad-core/core-config.yaml](.bmad-core/core-config.yaml) | BMAD paths config |

### Spec Kit (`.specify/`, `specs/`)
| File | Command it corresponds to |
| --- | --- |
| [.specify/memory/constitution.md](.specify/memory/constitution.md) | `/speckit.constitution` |
| [specs/001-voice-to-prompt-mvp/spec.md](specs/001-voice-to-prompt-mvp/spec.md) | `/speckit.specify` + `/speckit.clarify` |
| [specs/001-voice-to-prompt-mvp/plan.md](specs/001-voice-to-prompt-mvp/plan.md) | `/speckit.plan` |
| [research.md](specs/001-voice-to-prompt-mvp/research.md), [data-model.md](specs/001-voice-to-prompt-mvp/data-model.md), [quickstart.md](specs/001-voice-to-prompt-mvp/quickstart.md), [contracts/](specs/001-voice-to-prompt-mvp/contracts/) | `/speckit.plan` outputs |
| [specs/001-voice-to-prompt-mvp/tasks.md](specs/001-voice-to-prompt-mvp/tasks.md) | `/speckit.tasks` (T001–T101) |
| [checklists/requirements.md](specs/001-voice-to-prompt-mvp/checklists/requirements.md) | `/speckit.checklist` |

Source: `Voice-to-Prompt Dictation App — Production System Architecture (1).md`.

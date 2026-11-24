# Sayvox — Voice-to-Prompt Dictation

Hold **Ctrl+Shift**, speak, release: clean dictation or a structured AI prompt / email is typed at your cursor on macOS and Windows.

## Planning artifacts

### BMAD Method (`docs/`, `.bmad-core/`)
| File | Role |
| --- | --- |
| [docs/project-brief.md](docs/project-brief.md) | Analyst — problem, users, goals, scope |
| [docs/prd.md](docs/prd.md) | PM — FR/NFR, UI goals, epic list |
| [docs/front-end-spec.md](docs/front-end-spec.md) | UX — IA, flows, overlay state machine, screens |
| [docs/architecture.md](docs/architecture.md) | Architect — stack, components, APIs, deployment, standards, ADRs |
| [docs/epics/](docs/epics/) | Epics 1–6 with stories and acceptance criteria |
| [docs/stories/](docs/stories/) | 46 dev-ready stories (1.1–6.8), status Draft — tasks, dev notes, testing |
| [docs/adr/](docs/adr/README.md) | Decision records (ADR-001–008); only ADR-002 waits on the timing test |
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

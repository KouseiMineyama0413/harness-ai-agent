# dev-harness

**日本語版: [README.md](README.md)**

A framework-agnostic **development harness** usable across any kind of application development (web, API, SaaS, CLI, AI apps, internal systems). It wraps the development loop — requirements → design → implementation → testing → review → CI — with **quality gates** and **guardrails for AI agents**.

## Design philosophy

1. **The harness is a frame, not an actor** — humans or AI agents write the code; the harness builds a verifiable structure around them (profiles, gates, budgets, reports).
2. **All knowledge lives in files** — stack detection in `project_profile.json`, run results in `.harness/reports/`, requirements in `.harness/requirements/`. Everything is committable and human-reviewable.
3. **Inference is welcome, configuration always wins** — test/build commands are auto-inferred, but explicit settings in `harness.yaml` take precedence; `command: null` disables a gate.
4. **Stack knowledge is isolated in adapters** — the core knows no languages. Node/Python/Go/infra knowledge lives in adapters; supporting a new stack = adding one file.
5. **Agents are not trusted** — change budgets (files/lines), protected paths, a dangerous-command policy, and secret detection are enforced mechanically, not by goodwill.

## Installation

Requires **Node.js >= 22.5** (uses the built-in `node:sqlite`; no native dependencies. On 22.5–22.12 the `--experimental-sqlite` flag may be needed).

```bash
# In an existing repository (adds no dependencies to the repo itself)
pnpm add -g @kouseimineyama/harness-ai-agent   # or run ad hoc with pnpm dlx
# While unpublished on npm, install from GitHub:
pnpm add -g github:KouseiMineyama0413/harness-ai-agent
cd your-project
harness init        # create harness.yaml and .harness/
harness analyze     # detect the stack -> .harness/project_profile.json
harness context     # generate AI-agent context
harness gate run    # run quality gates -> .harness/reports/
```

## CLI

| Command | Description |
|---|---|
| `harness init` | Scaffold `harness.yaml` and `.harness/` |
| `harness analyze [--json]` | Detect the tech stack, write `project_profile.json` |
| `harness context [--print]` | Generate structured agent context (`context.json` / `context.md`) |
| `harness gate run [--only lint,test]` | Run quality gates; exit 1 on failure; report saved to `.harness/reports/` |
| `harness gate run --changed [base]` | Run only tests/lint related to changed files |
| `harness guard check-command "<cmd>"` | Evaluate a shell command against the safety policy (allow / confirm / deny) |
| `harness guard scan-diff [--base origin/main]` | Check the diff against change budget, protected paths, claims, plan, secrets |
| `harness req new "<title>"` | Create a structured requirement skeleton (acceptance criteria / NFRs) |
| `harness req lint <REQ-id>` | Detect vague wording and missing acceptance criteria |
| `harness session start "<task>" --agent claude` | Start a shared agent session |
| `harness session prompt/note/decision "<text>"` | Record events (prompts also go to history) |
| `harness session handoff --agent codex` | Write a handoff document for the next agent |
| `harness session cost --usd 0.42 --tokens-in N` | Record token/cost usage for the session |
| `harness session summarize [id]` | Summarize a session with an LLM; fold lessons into the project profile |
| `harness session list / show / end` | Session management |
| `harness history [--limit 50] [--search <q> [--agent X]]` | Browse / search prompt history (SQLite) |
| `harness team list` | List observed agents |
| `harness team activity [--agent X]` | Per-agent activity incl. cost (SQLite) |
| `harness team sessions <agent>` | Sessions an agent participated in |
| `harness reindex` | Rebuild the SQLite index from files |
| `harness claim add/release/release-all/list` | Exclusive path claims (concurrent-agent conflict prevention) |
| `harness plan new/approve/reject/complete/list/show` | Implementation plans with human approval |
| `harness pr-summary [--base ref] [--out f]` | PR description from session decisions, diff stats, gate results |
| `harness brief [task] [--req id] [--plan id]` | Compose requirement + plan + environment + done-criteria into one kickoff prompt |
| `harness skill sync` | Generate/update Claude Code skill & slash commands from project knowledge |
| `harness docs generate [--only a,b] [--force]` | LLM-draft docs for under-documented services |
| `harness docs check [--strict]` | Detect missing / stale docs (CI-friendly) |
| `harness doctor` | Environment diagnosis (node / sqlite / git / config / integrations) |
| `harness integrate claude\|codex\|git-hooks` | Install agent integrations / git hooks |
| `harness mcp` | Run as an MCP server (agents call the harness as native tools) |
| `harness report list` | List generated reports |

Exit codes: `0` success / `1` check failed / `2` config or usage error. stdout carries machine-readable output; progress goes to stderr.

## Quality gates

Eight gates: `lint` / `typecheck` / `test` / `build` / `security` / `deps` / `coverage` / `breaking`. Command resolution order:

1. `gates.<id>.command` in `harness.yaml` (`null` disables the gate)
2. Adapter inference (e.g. package.json scripts, `go test ./...`, `pytest`)
3. Otherwise skipped, with a reason

`security` / `deps` / `coverage` are advisory by default (their failures don't fail the run); promote with `required: true`. `breaking` is config-only (e.g. oasdiff, api-extractor) — the harness never runs breaking-change detection it wasn't explicitly given.

## Shared sessions & prompt history (Claude ⇄ Codex)

Multiple agents **share the same session through files**. All state is plain files under `.harness/`, so any tool that can read the repo can join.

```
.harness/sessions/S-001.json           # session meta (participating agents, status)
.harness/sessions/S-001.events.jsonl   # append-only event log (prompt/note/decision/handoff)
.harness/sessions/S-001.handoff.md     # handoff document
.harness/prompt_history.jsonl          # prompt history (cross-session, on by default)
```

Typical flow — Claude starts, Codex picks up:

```bash
# Claude
harness session start "Implement CSV export" --agent claude
harness session decision "Use streaming writes" --agent claude
harness session handoff --agent claude        # write the handoff document

# Codex (same repository)
harness context                               # context.md includes the active session and recent events
harness session note "Resuming from tests" --agent codex   # automatically joins the same session
```

- **Prompt history is kept by default** (`session.promptHistory: true`). Even without an active session, `harness session prompt` records to `.harness/prompt_history.jsonl`, browsable via `harness history`.
- All text is **secret-redacted before persisting**, so credentials can't leak through history.
- `harness integrate claude` installs a Claude Code **UserPromptSubmit hook** in `.claude/settings.json` so prompts are recorded **automatically** (the hook always exits 0 and never blocks the user).
- Codex has no prompt hook, so `harness integrate codex` writes operating rules into **AGENTS.md** (record prompts, record decisions, hand off) which Codex follows.

## Agent team management & the SQLite index

The "team" is **the set of agents working in this repo (claude / codex / human / …)**. Their sessions, prompts, and decisions can be queried across the board with SQLite.

Hybrid design: **plain git-tracked files are the source of truth; SQLite is a disposable query index rebuilt from them** (`.harness/cache/harness.db`, git-ignored).

```bash
$ harness team activity
agent   sessions  prompts  decisions  notes  tokens  usd      last active
codex   2         1        0          1      0       -        2026-06-12T04:32:41Z
claude  1         1        1          0      15500   $0.4200  2026-06-12T04:32:41Z

$ harness team sessions codex
session  status  title               events  last event
S-001    closed  Implement CSV export  1       2026-06-12T04:32:41Z
S-002    active  Pagination            3       2026-06-12T05:01:02Z
```

- `harness history --search <q> [--agent X]` — substring search over prompt history (CJK-friendly)
- The index is rebuilt from files on every query, so **losing or corrupting the DB loses nothing** (explicit rebuild: `harness reindex`)
- Uses Node's built-in `node:sqlite` — no `better-sqlite3`-style native builds

## Concurrent-agent conflict prevention (claims)

```bash
harness claim add src/billing --agent claude --reason "refactoring invoices"
# Another agent claiming an overlapping path fails immediately.
# guard scan-diff also flags changes to files under another agent's claim:
harness guard scan-diff --agent codex   # -> VIOLATIONS: claimed by claude
```

Claims live in `.harness/claims.json` (committed). `harness doctor` warns about claims older than 24h.

## Plan enforcement

Agents create plans with `harness plan new`; humans approve with `harness plan approve PLAN-001 --by <name>`. With `agent.enforcePlan: true`, **`guard scan-diff` fails until an approved plan exists** (off by default, so adopting the harness never breaks an existing workflow). Lifecycle: draft → approved → completed / rejected.

## MCP server

`harness mcp` runs a stdio MCP server. Register with Claude Code:

```bash
claude mcp add harness -- harness mcp
```

Exposed tools: `get_context` / `run_gates` / `check_command` / `scan_diff` / `record_event` / `search_history` / `team_activity` / `claim_paths` / `write_handoff`. Agents use the harness through native tool calls instead of shelling out.

## LLM authentication (session summarize / docs generate)

`llm.provider: auto` (the default) resolves in this order — **works with just a local Claude Code login, no API key needed**:

1. If `ANTHROPIC_API_KEY` (or the env named by `llm.apiKeyEnv`) is set → **anthropic** (official SDK, default model `claude-opus-4-8`). Without the env var, the SDK's default credential resolution (`ANTHROPIC_AUTH_TOKEN` / `ant auth login` profiles) still applies.
2. If the local Claude Code CLI is available → **claude-cli** (`claude -p` headless mode, **billed to your logged-in Claude Code session/subscription**).

Pin with `llm.provider: anthropic | claude-cli`; CI should use `anthropic` with a real key. If multiple `claude` binaries are on PATH, pin one via the `HARNESS_CLAUDE_BIN` env var or `llm.claudeBin`.

`harness session summarize` distills a session's event log into `<id>.summary.md` and appends lessons to `project_profile.json` notes (which feed future `harness context` / `skill sync` output). Providers are pluggable via the `LlmProvider` interface.

## Opus 4.8 tuning (maximizing model performance)

Claude Opus 4.8 is highly capable, but has documented default behaviors that cost performance in agentic work: it under-reaches for tools, subagents, and memory; asks about minor decisions; narrates more than needed; and self-filters review findings. The harness injects a **tuning pack distilled from Anthropic's official migration guidance** into `context.md` / `SKILL.md` / briefs to correct this (`agent.tuning: auto`; disable with `none`).

Included rules: proceed on minor choices without asking / check for unexecuted promises before ending a turn / verify unknown information with tools / fan independent work out to subagents / read & record project lessons / silence by default between tool calls / ground progress claims in tool results / answer questions with assessments only / run gates at checkpoints / report all review findings (filter downstream).

**`harness brief`** — Opus 4.8 does its best long-horizon work when the full task specification arrives in **one well-specified opening turn**. The brief composes the requirement (acceptance criteria, NFRs, out-of-scope), the approved plan, stack/commands, guardrails, a **checkable definition of done**, and the tuning rules into a single prompt:

```bash
harness brief --req REQ-001 | claude -p   # or paste as the agent's first instruction
```

Combined with the lesson loop (`session summarize` → profile notes → `context` / `skill sync` / `brief`), project-specific accuracy improves the more you use it.

## Skill / slash-command generation

`harness skill sync` generates and updates Claude Code artifacts from project knowledge (stack, commands, guardrails, accumulated lessons):

```
.claude/skills/dev-harness/SKILL.md   # project-conventions skill (fully harness-owned, idempotent)
.claude/commands/harness-gate.md      # /harness-gate     run gates and summarize
.claude/commands/harness-handoff.md   # /harness-handoff  wrap up and hand off
.claude/commands/harness-plan.md      # /harness-plan     create a plan, request approval
.claude/commands/harness-pr.md        # /harness-pr       generate a PR description
```

Generation is deterministic (no LLM), so it can run in CI on every build. CLAUDE.md / AGENTS.md are managed via **marker-delimited blocks** (`<!-- dev-harness:integration -->` … `<!-- /dev-harness:integration -->`): re-running `integrate` updates only the managed region and never touches human-written content.

## Docs generation

For services with no documentation, `harness docs generate` drafts **architecture / api / onboarding** docs with an LLM:

- Inputs are a **size-capped extraction**, not the whole repo (layout, manifests, entry points, route definitions, .env.example, migration listings — ≤64KB total)
- Output goes to `docs/*.md` with an AUTO-GENERATED header. **Human-written files are never overwritten, even with `--force`** (only harness-generated files can be regenerated)
- The prompt forbids invention: unknowns are emitted as `TODO (confirm):`
- `harness docs check --strict` detects missing or stale docs (30+ days older than the newest source) and can fail CI

## Working with AI agents

Give agents `.harness/context.md` at the top of their prompt. It contains the stack, layout, commands, the active shared session, and the **mandatory guardrails** (change budget, protected paths, plan requirement, no secrets).

Standard agent loop:

```
harness context              # 1. get context
harness req lint REQ-00x     # 2. check requirement ambiguity
(present a plan, get approval)  # 3. requirePlan
(implement)
harness guard check-command  # 4. vet risky commands before running
harness guard scan-diff      # 5. check the change is within budget
harness gate run             # 6. quality gates
(report a diff summary with the gate report)
```

## Configuration (`harness.yaml`)

The scaffold from `harness init` documents every field. Highlights:

```yaml
version: 1
project: { name: my-app }
agent:
  requirePlan: true
  changeBudget: { maxFiles: 20, maxLinesAdded: 800, maxLinesDeleted: 400 }
  protectedPaths: [.github/, infra/]
gates:
  test: { command: pnpm test -- --ci, required: true }
  coverage: { command: pnpm vitest run --coverage, threshold: 80, required: false }
context:
  rules: ["All DB schema changes go through migrations"]
```

## CI integration

Copy `templates/github-actions-harness.yml` to `.github/workflows/harness.yml` in the target repository. Every PR runs `guard scan-diff` + `gate run`, uploads reports as artifacts, and posts the report as a PR comment. GitLab CI / CircleCI work the same way — they just invoke the same CLI.

## Directory layout

```
src/
  cli.ts                 # CLI (commander) — thin wrapper over the core
  index.ts               # programmatic API (for embedding)
  types.ts               # shared domain types
  config/                # harness.yaml schema (zod) + loader
  adapters/              # per-stack adapters (node/python/go/infra) + registry
  analyze/               # profile generation (.harness/project_profile.json)
  context/               # agent context, tuning packs, task briefs
  gates/                 # quality-gate resolution & execution
  guardrails/            # command policy / secrets / diff budget / claims
  plans/                 # implementation plans with approval lifecycle
  session/               # shared agent sessions, prompt history, summarize
  db/                    # SQLite query index (node:sqlite)
  llm/                   # LLM providers (anthropic SDK / claude CLI)
  docs/                  # doc-source extraction & generation
  integrations/          # claude/codex/git-hooks installers, skill sync
  mcp/                   # MCP server
  report/                # Markdown/JSON reports, PR summaries
  requirements/          # structured requirements + ambiguity linter
  doctor/                # environment diagnosis
templates/               # CI templates
```

## Extending

- **New stack**: implement `StackAdapter` and call `registerAdapter()` (`src/adapters/registry.ts`). No core changes.
- **New LLM provider**: implement `LlmProvider` and call `registerProvider()` (`src/llm/provider.ts`).
- **New gate**: extend `GateId`, set `defaultRequired`, optionally add adapter inference.
- **Plugins (future)**: dynamically load external adapters from a `plugins:` entry in `harness.yaml`.

## Development

```bash
pnpm install
pnpm test          # vitest
pnpm run build     # tsc -> dist/
pnpm run dev -- analyze   # run from source
```

The Node version is pinned to 22.x via `mise.toml` (`mise install` to match).

# Future Work — Codeman

Items not yet in a worktree. Create worktrees from these when ready.

---

## Feature: Keeps Orchestrator / Project Coordinator Hub

**Priority:** High (large feature — needs GSD scoping first)

A dedicated area in Codeman for managing external integrations and orchestrating tasks.
The `keeps-orchestrator` session at `/home/siggi/codeman-cases/keeps-orchestrator` has an
initial skill implementation to build from.

### Goals
- Quickly spin up sessions for a project from within a coordinator panel
- Orchestrate tasks across sessions (status, ask questions, get state)
- Custom skills within the coordinator context
- Connect to external services: Gmail, Outlook, Asana, Linear, GitHub Issues, etc.

### Scope guidance
- Start with GSD new-project scoping (`/gsd:new-project` in keeps-orchestrator session)
- UX analysis phase needed before implementation
- Define MVP integrations (suggested: Linear + GitHub Issues first)
- Design for generalization so it can be distributed as a standalone add-on
- Custom skill registry within the coordinator area

### Notes
- User already has initial skill in keeps-orchestrator (`/home/siggi/codeman-cases/keeps-orchestrator`)
- Should eventually be distributable: generalized Codeman + specialized profiles

---

## Feature: Bug Reporting Template (Generalized Skill)

**Priority:** Medium

Improve bug reporting in Codeman to include a structured template with:
- Template fields: description, reproduction steps, expected vs actual, affected session/project
- Skill hints: which Codeman skills to invoke to investigate (e.g. codeman-fix)
- Image attachment: auto-pull recent screenshots from `~/.codeman/screenshots/` to attach to reports
- Guidance on asking for clarification before fixing
- Cross-session image sharing: let a bug report in one session reference a screenshot from another

### Notes
- User has an existing initial skill in keeps-orchestrator for this
- Must be generalized so it works across any project, not just keeps
- Distributable as part of the shared Codeman application
- Consider: "Report bug" button per session that pre-fills template from session state

---

## Feature: Safe Mode Improvements (future iteration)

**In progress:** `feat/safe-mode-session-analyzer` worktree handles the core safe mode.

Future iteration ideas:
- "Debug mode" that logs all CLI args and environment on startup
- Integration with Claude version detection to warn when a version bump may break --resume
- Auto-suggest safe mode when session fails to start 2+ times in a row

---

## Feature: Codeman as Distributable Application

**Priority:** Low (longer term)

The goal is to share Codeman (including skills and the Keeps Orchestrator) as an
application others can boot on their own servers.

- Generalized version: works with any project, no keeps-specific config
- Specialized versions (profiles): keeps-cms, etc.
- Distribution: Docker image or install script
- Skills bundled or installable from a registry
- Documentation for self-hosters

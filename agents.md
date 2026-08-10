# Agent Instructions

## General guidance

Work primarily from the repository root and the source-code directories relevant to the current task.

Avoid loading, scanning, or summarizing large parts of the repository unless they are necessary to complete the user's request.

Prefer targeted file access over broad repository-wide exploration.

## Documentation directory

The `docs/` directory contains extensive project documentation, historical notes, architecture references, roadmaps, and changelogs.

Do not read, search, index, summarize, or inspect files under `docs/` during normal repository exploration.

Treat `docs/` as excluded from the default working context in order to reduce unnecessary context usage and avoid pulling large amounts of documentation into routine coding tasks.

Only access files under `docs/` when the user explicitly asks to:

- review or reference documentation
- update documentation
- investigate architecture or historical decisions
- consult a roadmap or changelog
- use information specifically contained in `docs/`

When working on normal implementation, debugging, refactoring, or code review tasks, use the source files and relevant repository-root files first.

If information from `docs/` appears necessary, ask before reading it unless the user's request clearly requires documentation access.

## Scope

These instructions apply to all AI assistants, coding agents, and automated tools that recognize repository-level agent instructions.

They are intended to reduce unnecessary context usage, not to prevent access for security purposes.

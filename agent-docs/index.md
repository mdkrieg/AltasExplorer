# Atlas Explorer Documentation

Atlas Explorer is a desktop file explorer (Electron + Node.js + SQLite) that sits as a richer layer atop the plain filesystem. It's built for users who work with files in environments that don't offer (or don't want) heavyweight document-management suites — the philosophy is **files are files, and files are king**.

This documentation captures the *why* behind the project: vision, architecture, design principles, and core concepts. It's the place to read before making non-trivial decisions about the codebase.

## Contents

- [Vision and Users](vision.md) — what the app is for, who it's for, and the core problem framing.
- [Architecture](architecture.md) — Electron rationale, the SQLite-vs-flat-file split, and the user-control principle.
- [Design Principles](design-principles.md) — UX rules that define what "done" feels like.
- [Core Concepts](concepts.md) — Panels, the P1-Pn+1 pattern, URIs, categories, tags, reminders, and aggregation.
- [Module Map](modules.md) — what each major source file owns, and what *not* to put in it.

## How to use these docs

If you're contributing code (or directing an AI to), skim **Vision**, **Design Principles**, and **Core Concepts** first. They establish the framing that determines whether a given change feels right for this project.

The **Architecture** doc answers questions of the form *"where should this data/logic live?"*

The **Module Map** answers questions of the form *"which file owns this responsibility?"*

## Living document

This documentation is a living document. If you discover a constraint, rationale, or decision that isn't captured here, add it. The goal is that nobody — human or model — has to re-derive context from scratch.

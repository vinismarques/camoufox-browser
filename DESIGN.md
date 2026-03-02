# Design Notes

## Scope

A fresh runtime (no legacy compatibility) with:

- Camoufox only
- Persistent profiles
- Shared auth across headful/headless by default (single active profile session with reuse/handoff policy)
- High-level actions for agents
- Deep low-level access for debugging/data extraction

## Main entities

- **Session**: browser context lifecycle (`persistent=true|false`)
- **Tab**: a page with refs, events, downloads
  - ARIA refs (semantic/stable)
  - DOM fallback refs (heuristic selectors for non-semantic click targets)
- **Event**: append-only timeline item (request, response, download, console, etc.)

## Persistence

- Profile state: `profiles/<profileName>`
- Artifacts: `artifacts/sessions/<sessionId>/tabs/<tabId>`
- Logs: `logs/sessions/<sessionId>/tabs/<tabId>/network.jsonl`

## API shape

- Session lifecycle: create/list/get/delete
- Tab lifecycle: create/list/delete
- Actions: navigate, snapshot, act
- Low-level: network query, downloads, authenticated fetch

## Why this design

- Keeps agent ergonomics (snapshot + refs)
- Handles modern non-semantic UIs by adding DOM fallback refs + text-click fallback
- Exposes low-level primitives for complex workflows (e.g. ATS reverse-engineering)
- Supports long-running authenticated automation through persistent profiles

## Debugging philosophy

Use UI-first debugging before API reverse engineering:

1. snapshot (refs)
2. snapshot with screenshot + DOM (`includeScreenshot=true&includeDom=true`)
3. fallback actions (`clickText`, `force` click, `dispatchClick`, `selectOption`)
4. explicit waits (`urlContains`, `goneText`, `selector`, `networkIdle`) before next mutation
5. network/API inspection only if UI path is genuinely blocked

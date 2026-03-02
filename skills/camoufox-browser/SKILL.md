---
name: camoufox-browser
description: Operate websites through the local Camoufox browser runtime with persistent sessions, inspect/query/act flows, event inspection, authenticated fetches, and download handling.
---

# Camoufox Browser Runtime Skill

Use this skill when browser tasks should run through the Camoufox runtime API exposed by this repository.

## Runtime assumptions

- Runtime default URL: `http://127.0.0.1:9487`
- Health endpoint: `GET /health`
- Capabilities endpoint: `GET /capabilities`

If the runtime is not running yet:

```bash
cd /path/to/camoufox-browser
npm install
npx camoufox-js fetch
npm start
```

Or use the bundled helpers from this skill:

```bash
./scripts/start.sh
./scripts/stop.sh
```

(`start.sh` runs the runtime from the package/repo root and waits for `/health`.)

Before any browser task, do a quick preflight:

```bash
curl -s http://127.0.0.1:9487/health
curl -s http://127.0.0.1:9487/capabilities
```

## Recommended execution flow

1. Create or reuse a session (`POST /sessions`)
2. Create a tab (`POST /sessions/:sessionId/tabs`)
3. Inspect (`POST /tabs/:tabId/inspect`)
4. Query specific targets when needed (`POST /tabs/:tabId/query`)
5. Execute actions with retries (`POST /tabs/:tabId/act`)
6. Confirm expected state (`POST /tabs/:tabId/wait`)
7. Use `eval` only for edge cases (`POST /tabs/:tabId/eval`)
8. Read events/downloads/fetch APIs for debugging and extraction

## Minimal API snippets

Create session:

```bash
curl -s -X POST http://127.0.0.1:9487/sessions \
  -H "Content-Type: application/json" \
  -d '{"persistent":true}'
```

Create tab:

```bash
curl -s -X POST http://127.0.0.1:9487/sessions/<sessionId>/tabs \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

Inspect:

```bash
curl -s -X POST http://127.0.0.1:9487/tabs/<tabId>/inspect \
  -H "Content-Type: application/json" \
  -d '{"limit":200,"offset":0,"includeScreenshot":false,"includeDom":false}'
```

Act:

```bash
curl -s -X POST http://127.0.0.1:9487/tabs/<tabId>/act \
  -H "Content-Type: application/json" \
  -d '{
    "action":"click",
    "target":{"by":"role","role":"button","name":"Continue"},
    "retry":{"maxAttempts":3,"backoffMs":150}
  }'
```

Wait:

```bash
curl -s -X POST http://127.0.0.1:9487/tabs/<tabId>/wait \
  -H "Content-Type: application/json" \
  -d '{
    "mode":"all",
    "conditions":[{"kind":"networkIdle"}],
    "timeoutMs":10000
  }'
```

## Notes

- Prefer semantic targeting (`ref`, `role`, `label`) before brittle selectors.
- Use `/tabs/:tabId/events` for timeline debugging (network, console, page errors, actions).
- Use `/tabs/:tabId/fetch` for authenticated HTTP calls using browser cookies.
- Use `/tabs/:tabId/downloads` + `/save` to persist downloaded artifacts.

For complete endpoint coverage and payload details, read `../../README.md` before complex or long-running workflows.

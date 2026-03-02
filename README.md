# camoufox-browser

Camoufox-only browser runtime for agents.

This runtime combines:

1. **Agent-friendly browser control** (inspect/query/act/wait)
2. **Low-level observability** (events, console, page errors, network, downloads, eval)

---

## Highlights

- Persistent sessions with profile reuse (`authMode=shared` by default)
- Tab lifecycle API (create, navigate, close)
- `inspect` endpoint for paginated interactive targets
- `query` endpoint for robust target discovery
- Unified `act` endpoint with retries and traces
- Composable `wait` endpoint (`all` / `any` conditions)
- Controlled page-context `eval` endpoint
- Unified event timeline (`/events`) including network + console + page errors + action traces
- Authenticated `fetch` via browser session cookies
- Download capture and save API

---

## Install runtime (local dev)

```bash
cd ~/dev/camoufox-browser
npm install
npx camoufox-js fetch
```

## Install as a Pi skill (from GitHub)

This repository exposes `skills/camoufox-browser` as a Pi package skill.

```bash
pi install git:github.com/vinismarques/camoufox-browser
```

What `pi install` does:

- Adds this repo to your Pi `packages` settings
- Clones it under Pi's package directory (for example `~/.pi/agent/git/...`)
- Runs `npm install` in the cloned package
- Makes the skill available to Pi from `skills/camoufox-browser/SKILL.md`

What `pi install` does **not** do:

- It does not symlink/copy into `~/.agents/skills` (or `~/.pi/agent/skills`)
- It does not start the runtime (`npm start`)
- It does not guarantee Camoufox binary prefetch (run `npx camoufox-js fetch` if needed)

## Install for non-Pi tools (`~/.agents/skills`)

If your tool discovers skills from `~/.agents/skills`, clone, install dependencies, and symlink:

```bash
git clone https://github.com/vinismarques/camoufox-browser ~/.local/share/camoufox-browser
cd ~/.local/share/camoufox-browser && npm install && npx camoufox-js fetch
mkdir -p ~/.agents/skills
ln -sfn ~/.local/share/camoufox-browser/skills/camoufox-browser ~/.agents/skills/camoufox-browser
```

To update later:

```bash
cd ~/.local/share/camoufox-browser
git pull --ff-only
npm install
npx camoufox-js fetch
```

## Optional: link your local dev clone into skills folders

If you are developing this repo locally and want it discoverable via shared skill folders:

```bash
./scripts/link-skill.sh         # link to ~/.agents/skills
./scripts/link-skill.sh --all   # also link ~/.pi/agent/skills
```

## Run

```bash
npm start
# default: http://127.0.0.1:9487
```

## Smoke test

```bash
./scripts/smoke.sh
```

---

## Configuration

- `BROWSER_RUNTIME_PORT` (default `9487`)
- `BROWSER_RUNTIME_HOST` (default `127.0.0.1`)
- `BROWSER_RUNTIME_DATA_DIR` (default `~/.cache/camoufox-browser`)
- `CAMOUFOX_HEADLESS` (`false` by default)
- `CAMOUFOX_OS` (`macos`/`linux`/`windows`, auto-detected by default)
- `CAMOUFOX_HUMANIZE` (`true` by default)
- `CAMOUFOX_ENABLE_CACHE` (`true` by default)
- `TAB_ACTION_TIMEOUT_MS` (default `30000`)
- `SESSION_TIMEOUT_MS` (default 24h)
- `MAX_EVENTS_PER_TAB` (default `5000`)
- `CAPTURE_RESPONSE_BODIES` (`false` by default)
- `MAX_CAPTURED_BODY_BYTES` (default `262144`)
- `MAX_DOM_CHARS` (default `220000`)
- `MAX_DOM_FALLBACK_REFS` (default `240`)

---

## API overview

### Health and capabilities

```bash
curl -s http://127.0.0.1:9487/health
curl -s http://127.0.0.1:9487/capabilities
```

### Sessions

```bash
# create session (defaults: persistent=true, authMode=shared)
curl -s -X POST http://127.0.0.1:9487/sessions \
  -H "Content-Type: application/json" \
  -d '{"persistent":true,"authMode":"shared","profileName":"main","onProfileBusy":"reuse"}'

# list + inspect + close session
curl -s http://127.0.0.1:9487/sessions
curl -s http://127.0.0.1:9487/sessions/<sessionId>
curl -s -X DELETE http://127.0.0.1:9487/sessions/<sessionId>
```

Cookies:

```bash
# import cookies
curl -s -X POST http://127.0.0.1:9487/sessions/<sessionId>/cookies \
  -H "Content-Type: application/json" \
  -d '{"cookies":[{"name":"sid","value":"...","domain":"example.com","path":"/"}]}'

# list cookies (optional ?url=https://example.com)
curl -s "http://127.0.0.1:9487/sessions/<sessionId>/cookies"
```

### Tabs

```bash
# create tab
curl -s -X POST http://127.0.0.1:9487/sessions/<sessionId>/tabs \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'

# navigate
curl -s -X POST http://127.0.0.1:9487/tabs/<tabId>/navigate \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

### Inspect (page + interactive targets)

```bash
curl -s -X POST http://127.0.0.1:9487/tabs/<tabId>/inspect \
  -H "Content-Type: application/json" \
  -d '{"limit":200,"offset":0,"includeScreenshot":false,"includeDom":false}'
```

Returns paginated `targets[]` with refs/handles, role/name/text, selector hints, and visibility metadata.

### Query (target discovery)

```bash
curl -s -X POST http://127.0.0.1:9487/tabs/<tabId>/query \
  -H "Content-Type: application/json" \
  -d '{
    "target": {"by":"role","role":"button","name":"Save","exact":true},
    "filters": {"visible":true},
    "limit": 20,
    "offset": 0
  }'
```

### Act (unified action execution)

```bash
curl -s -X POST http://127.0.0.1:9487/tabs/<tabId>/act \
  -H "Content-Type: application/json" \
  -d '{
    "action":"click",
    "target":{"by":"ref","ref":"e12"},
    "options":{"force":false},
    "retry":{"maxAttempts":3,"backoffMs":150,"on":["ELEMENT_INTERCEPTED","STALE_REF"]},
    "waitAfter":{
      "mode":"all",
      "conditions":[{"kind":"networkIdle"}],
      "timeoutMs":10000
    }
  }'
```

Common `action` values:

- `click`, `dispatchClick`, `clickText`
- `type`, `setField`
- `select`, `chooseMenuItem`
- `press`, `scroll`, `wait`
- `hover`, `focus`, `clear`, `check`, `uncheck`
- `drag`, `upload`

`target.by` options:

- `ref`
- `handle`
- `selector`
- `label`
- `role`
- `text`

### Wait (composable)

```bash
curl -s -X POST http://127.0.0.1:9487/tabs/<tabId>/wait \
  -H "Content-Type: application/json" \
  -d '{
    "mode":"all",
    "conditions":[
      {"kind":"urlContains","value":"/dashboard"},
      {"kind":"textGone","value":"Loading..."}
    ],
    "timeoutMs":15000
  }'
```

Supported condition kinds include:

- `sleep`
- `url`
- `urlContains`
- `selector`
- `text` (alias: `textPresent`)
- `goneText` (alias: `textGone`)
- `networkIdle` (case-insensitive; `networkidle` also works)

### Eval (low-level page context)

```bash
curl -s -X POST http://127.0.0.1:9487/tabs/<tabId>/eval \
  -H "Content-Type: application/json" \
  -d '{
    "script":"(args) => document.title",
    "args": {},
    "timeoutMs": 3000
  }'
```

With scoped element target:

```bash
curl -s -X POST http://127.0.0.1:9487/tabs/<tabId>/eval \
  -H "Content-Type: application/json" \
  -d '{
    "target":{"by":"selector","selector":"button.save"},
    "script":"(el, args) => el.textContent"
  }'
```

### Events

```bash
curl -s "http://127.0.0.1:9487/tabs/<tabId>/events?since=0&limit=200"
```

Filter by kind:

```bash
curl -s "http://127.0.0.1:9487/tabs/<tabId>/events?kind=request,response,action"
```

### Authenticated fetch

```bash
curl -s -X POST http://127.0.0.1:9487/tabs/<tabId>/fetch \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/api/me","responseType":"json"}'
```

### Downloads

```bash
curl -s "http://127.0.0.1:9487/tabs/<tabId>/downloads"

curl -s -X POST http://127.0.0.1:9487/tabs/<tabId>/downloads/<downloadId>/save \
  -H "Content-Type: application/json" \
  -d '{"path":"/tmp/file.pdf"}'
```

---

## Execution discipline for agents

Recommended default flow:

1. check `GET /health` and `GET /capabilities`
2. `inspect` the page
3. `query` if target ambiguity exists
4. execute `act` with retry policy
5. verify with `wait`
6. use `eval` only for edge cases

---

## Data layout

Inside `BROWSER_RUNTIME_DATA_DIR`:

- `profiles/<profileName>/...` persistent browser profile state
- `artifacts/sessions/<sessionId>/tabs/<tabId>/downloads/...` downloaded files
- `artifacts/sessions/<sessionId>/tabs/<tabId>/network-bodies/...` captured response bodies (opt-in)
- `logs/sessions/<sessionId>/tabs/<tabId>/network.jsonl` append-only event log

# AgentBridge ALT (Gemini / Google AI Studio)

Fork of [Ryo448/AgentBridge](https://github.com/Ryo448/AgentBridge) that targets the
Gemini API's OpenAI-compatible endpoint instead of NVIDIA NIM. Use Gemini models
from OpenAI-compatible clients, Codex CLI, and Claude Code.

> **Prototype.** Built without live Gemini traffic yet — expect to tune quotas.

### What's different from upstream

- **Upstream:** `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`
  (override with `AGENTBRIDGE_ALT_UPSTREAM_URL`).
- **Keys:** AI Studio **auth keys** (`AQ.…`, from `aistudio.google.com/apikey`). Per the
  [AI Studio key docs](https://aistudio.google.com/docs/api-key), new keys are auth keys
  since May 28 2026, unrestricted standard keys are rejected, and standard (`AIza…`) keys
  stop working in September 2026. AI Studio creates at most 10 projects at a time.
  Keys the API rejects (invalid / blocked / unrestricted) are taken out of rotation. Gemini rate limits are
  **per project**, so register **one key per project** — extra keys in the same
  project add no capacity.
- **Smarter 429 penalties:** the `RESOURCE_EXHAUSTED` body is parsed. Daily quota
  (RPD) → the (key, model) pair rests until midnight Pacific time. Per-minute
  quota → rests for Google's `retryDelay` (default 60 s).
- **Thought signatures:** Gemini 3+ tool calls carry
  `extra_content.google.thought_signature`, which must be sent back next turn.
  Claude Code / Codex drop it, so the proxy caches signatures by tool-call id and
  re-injects them; if missing, it sends Google's `skip_thought_signature_validator`
  placeholder. Parallel Responses `function_call` items are merged into one turn.
- **Key-level failures** (ported from AliveNPCs' `GeminiClient`): `API_KEY_INVALID` /
  `UNAUTHENTICATED` or `FAILED_PRECONDITION` (billing/region) take that key out of
  rotation for **all models** for 24 h and retry on another key — no model failover.
  503 "high demand" is retried like a 500, then fails over to the next model.
  Upstream error logs now show Gemini's own message instead of `Bad Request`.
- **Daily budget per key and model:** free tier is Flash 5 RPM / 20 RPD, Flash-Lite
  15 RPM / 500 RPD, Gemma 4 30 RPM / 16K TPM / 14.4K RPD, and Pro 0 RPD per project, per model (set `AGENTBRIDGE_ALT_PAID_TIER=1`
  to disable these local limits on billed keys). The gateway counts every request (failed ones
  too) per key per model, skips a key for a model once it reaches the daily limit (resets
  at midnight Pacific), and fails over to the next model in auto mode. Counts persist in
  `daily_usage.json` (key hashes only). The **Usage & penalties** screen shows used/limit
  per key and model next to active 429 penalties; model cards show today's total.
- **Reasoning (thinking) setting:** the desktop app (and the terminal Models screen) has a
  Client decides / Off / Low / Medium / High switch applied to every request via
  `reasoning_effort`. "Off" uses the lowest level each model accepts (3.8 Flash: low;
  other Gemini 3.x and Gemma: minimal). If Gemini rejects the value, the request is
  retried once without the override. Saved in the vault config.
- **Side-by-side with the original AgentBridge:** nothing is shared.
  - Vault / keys / penalties / token usage: `Documents\AgentBridge-ALT\` (override with `AGENTBRIDGE_ALT_DATA_DIR`)
  - Electron app data (`%APPDATA%`): `AgentBridge ALT`; installer appId `com.gabrieljamh.agentbridge.alt`
  - Default port **3001** (original uses 3000)
  - Codex provider `agentbridge-alt` with `env_key = "AGENTBRIDGE_ALT_API_KEY"`
  - Env vars prefixed `AGENTBRIDGE_ALT_` (`_LOCAL_KEY`, `_UPSTREAM_URL`, `_DATA_DIR`)
- Headless env vars: `GEMINI_API_KEYS` (comma-separated) or `GEMINI_API_KEY`.

## Desktop

```powershell
npm install
npm run desktop
```

On first launch, set the password used to encrypt your API keys. The vault is saved at:

```text
Documents\AgentBridge-ALT\config.json
```

The password is never persisted. Decrypted keys live only in memory while the app is open.

### Local key (client authentication)

This is the key that Codex, Claude Code, and other clients must send (as
`Authorization: Bearer ...` or `x-api-key`) to use the proxy. The first time
you open an empty vault, the app asks you to **set your own key**. It is then
saved **encrypted** inside `config.json` and read on startup — you are **not**
prompted again on every launch.

To change it later, use the **"Change key"** button in the **Direct API** tab.
Callers without the correct key receive only a generic authentication error — the
expected key is never revealed in the response.

## Building the installer (Windows .exe)

Generates an NSIS installer in `release-agentbridge\`:

```powershell
npm install
npm run dist:win
```

The installer lets you choose the installation directory and creates desktop and
Start Menu shortcuts. The generated executable is at
`release-agentbridge\AgentBridge Setup x.y.z.exe`.

## Local API

- **Authentication**: the **local key** you define (factory default is
  `EuAmoORyo` until you set your own). See [Local key](#local-key-client-authentication).
- Chat Completions: `http://localhost:3001/v1/chat/completions`
- Responses: `http://localhost:3001/v1/responses`
- Anthropic Messages: `http://localhost:3001/v1/messages`
- Health: `http://localhost:3001/health`

Requests are automatically distributed across keys to stay within 35 RPM without
creating long bursts. The default extra delay is 0 ms.
Each key accepts at most 35 reservations per minute. When all keys hit the limit,
new requests wait for the next minute window before proceeding.

## Model selection from the client

The **standard** endpoints honor whatever model the client sends — this is how an
OpenAI-compatible workspace (Open WebUI, Odysseus, etc.) lists and selects models
on its own:

- `GET /v1/models` lists the **real catalog** of models (ids `provider/model`,
  each with `available: true/false`) **plus** the pseudo-model `AgentBridge`.
  This populates the client's model selector with real model IDs.
- `POST /v1/chat/completions` (and also `/v1/responses` and `/v1/messages`) routes
  based on the incoming `model`:
  - `model: "AgentBridge"` (or empty) → **redirects** to the model selected in
    the app (auto-toggle mode still applies). This is what Codex/Claude send, so
    nothing changes for them.
  - `model: "<real id>"` → goes **directly** to that model, provided a free key
    is available. If not, it falls back to the effective model instead of
    returning an error — meaning the request never breaks because of model choice.

Example of selecting a specific model:

```bash
# replace "EuAmoORyo" with your local key if you have set one
curl http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer EuAmoORyo" \
  -H "Content-Type: application/json" \
  -d '{"model":"moonshotai/kimi-k2.6","messages":[{"role":"user","content":"hi"}]}'
```

### Extra routes (shortcuts for scripts)

In addition to the standard endpoints, there are equivalent dedicated routes:

- `GET /v1/models/available` — same catalog listing; accepts
  `?only_available=1` to return only models with a free key right now.
- `POST /v1/direct/chat/completions` · `/v1/direct/responses` ·
  `/v1/direct/messages` — **strict** passthrough: always honors the `model` in
  the body and requires a real id (returns 400 if empty or `AgentBridge`).

Key rotation and 429 penalties (per model) apply on every route.

## Terminal mode

**AgentBridge** now has native terminal support — with or without an interactive
interface. A single command (`npm start`) automatically decides which mode to
activate.

| Situation                                    | Mode activated         |
|----------------------------------------------|------------------------|
| Interactive terminal (PowerShell, bash, etc) | Full **TUI**           |
| Pipe, redirection, CI, systemd               | **Headless** automatic |
| `--headless` or `--no-ui`                    | **Headless** forced    |

### TUI (interactive terminal interface)

TUI mode offers **100% of the desktop app's features** in a beautiful ANSI
interface, without Electron or graphical dependencies:

```powershell
npm install
npm start
```

> **Windows tip:** use **Windows Terminal** (recommended) or any ANSI-compatible
> terminal. The default Windows 11 PowerShell works fine.

**First run:** AgentBridge shows the unlock screen. If no vault exists yet, it
guides you through creating a master password and registering your NVIDIA keys.

**Subsequent runs:** it reads the **same encrypted vault** as the desktop
(`Documents\AgentBridge-ALT\config.json`). The password is never saved — keys are
only decrypted in memory during the session.

#### Live dashboard

Once you unlock the vault, the gateway starts automatically and the dashboard
shows:

- **Proxy:** server status, port, key count, extra delay
- **Model:** manual/auto mode, target model, catalog, RPM per minute
- **Live log:** every request passing through the proxy, with timestamp and status

Footer shortcuts:

    S start/stop · A APIs · M models · P port · D delay · K local key · P penalties · I integration · L clear log · Q quit

#### Configuration screens (shortcuts)

| Key | Screen          | Description                                                              |
|-----|-----------------|--------------------------------------------------------------------------|
| `A` | **APIs**        | Add, edit or remove NVIDIA keys (encrypted with AES-256-GCM)             |
| `M` | **Models**      | Select model, enable **auto-toggle**, reorder priority,                  |
|     |                 | test a model, and edit the catalog                                       |
| `C` | **Penalties**   | View APIs on cooldown with live countdown                                |
| `P` | **Port**        | Change the gateway listen port (1–65535)                                 |
| `D` | **Delay**       | Set extra delay in ms before each NVIDIA call (0–600000)                 |
| `K` | **Local key**   | Set/change the key clients must send to use the proxy                    |
| `I` | **Integration** | Generate ready-to-use snippets for Codex CLI, Claude Code, and direct API|

Penalty persistence (`penalties.json`) is shared with the desktop — 429 cooldowns
survive even if you switch between TUI and Electron.

### Headless (pure server)

For servers, containers, Docker, or systemd — where you don't want an interactive
interface — pass keys via environment variables:

```powershell
# PowerShell
$env:NVIDIA_API_KEYS = "nvapi-key-1,nvapi-key-2"
npm start -- --headless
```

```bash
# bash / zsh
export NVIDIA_API_KEYS="nvapi-key-1,nvapi-key-2"
npm start -- --headless
```

The shortcut `npm run start:headless` does the same thing.

In headless mode you can set the local key required from clients via the
`AGENTBRIDGE_LOCAL_KEY` variable (if omitted, the factory default is used):

```bash
export AGENTBRIDGE_LOCAL_KEY="my-secret-key"
```

Headless mode is also activated automatically when output **is not an interactive
terminal** — such as pipes (`npm start | tee log.txt`), CI/CD, systemd, or
Docker. This means the same `npm start` command works in both scenarios without
needing to remember flags.


---

## Tutorial: How to Get Free NVIDIA APIs

To use **AgentBridge** with the NVIDIA API, follow the steps below:

### 1. Visit the NVIDIA Build website

1. Open your browser and go to: [https://build.nvidia.com/](https://build.nvidia.com/)
2. Create an account and log in.

### 2. Generate your API Key

1. In the NVIDIA dashboard, go to the **API Keys** section.
2. Click **Generate API Key**.
3. Copy the generated key.

### 3. How many API keys you need

For **AgentBridge** to work well, you need multiple NVIDIA API keys. **Unfortunately, multiple keys from the same account won't work** — each key requires a separate account.

| Quantity | Performance Level                 |
|----------|-----------------------------------|
| 8 keys   | Usable with decent quality        |
| 15 keys  | Ideal for regular use             |
| 25 keys  | Perfect (maximum performance)     |

### 4. Set up AgentBridge

After collecting the keys:

1. Open **AgentBridge**.
2. Set a password to encrypt the keys (stored locally).
3. In the APIs field, enter all the keys you collected.
4. Done! The proxy will automatically distribute requests across keys to respect the 35 RPM limit per key.

> **Important Tip**: Each NVIDIA account supports up to 40 requests per minute, but AgentBridge limits to 35 to avoid hitting the RPM cap. With 8+ accounts, AgentBridge rotates between them to provide stable, continuous responses.

---
## License

GPL-3.0
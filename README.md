# Vocence — SDK Dashboard (Agents + Real-Time Voice)

A full **agent management dashboard** built on the **`vocence` Python SDK**:
create / edit / delete real Vocence agents, browse voices, and **talk to any
agent live** — all from one beautiful local web app.

Because the voice call uses the agent's **hosted brain** (the LLM you set in
Studio runs on Vocence's side), this needs **only your Vocence API key — no LLM
key**. The secret `voc_live_…` stays on the server; the browser only talks to
your server.

```
Browser (dashboard + mic + audio)
      ⇅ REST + WebSocket
your server ── vocence SDK ──▶ api.vocence.ai
                               (account · agents CRUD · voices · agents.session)
```

> Sibling repos:
> • **Widget** ([vocence-voice-agent-demo](https://github.com/concil859856/vocence-voice-agent-demo)) — no-code, browser-only embed.
> • **Plugins pipeline** — the BYO `VocenceSTT → your LLM → VocenceTTS` loop, included here in [`examples/byo_pipeline.py`](examples/byo_pipeline.py) (that one needs your own LLM key).

---

## What you can do

| Feature | How |
|---|---|
| **See your account** | plan + live credit balance in the top bar (`client.account`) |
| **List agents** | left sidebar (`client.agents.list`) |
| **Create an agent** | **+ New** → fill the form → **Save** (`client.agents.create`) |
| **Edit every setting** | name, type, **voice** (from the catalog), language, LLM model, temperature, status, greeting, purpose, **system prompt**, knowledge, record (`client.agents.update`) |
| **Delete an agent** | **Delete** (`client.agents.delete`) |
| **Browse voices** | the Voice dropdown (`client.voices.builtin`) |
| **Talk to an agent live** | pick an agent → **Call** → speak (or type) — `client.agents.session()` streams audio both ways |

---

## Quick start

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env       # then set:
#   VOCENCE_API_KEY=voc_live_...   (Premium → vocence.ai/account/developer)

python server.py           # → http://localhost:8100
```

Open it, pick an agent (or create one), click **Call**, allow your mic, and
talk. **That's the only key you need.**

> **Microphone needs a secure context** — `localhost` or HTTPS — and works best
> in **Chrome** (the app uses 16 kHz / 24 kHz `AudioContext`s for clean PCM).

---

## How the live call works

`server.py` opens `client.agents.session(agent_id)` per call and bridges it to
the browser:

- browser mic **PCM16 @ 16 kHz** → `session.send_pcm(...)`
- the hosted agent does **STT → its LLM → TTS** server-side and streams back
  `transcript` (your words), `token` (its reply text), and **PCM16 @ 24 kHz**
  audio, which the browser plays gaplessly.
- VAD / turn-taking / barge-in are handled by the hosted agent — the browser
  just streams continuously.

No LLM, STT, or TTS code lives here for the chat — the SDK and the hosted agent
do it all.

---

## Configuration (`.env`)

| Var | Required | Default | Purpose |
|---|:---:|---|---|
| `VOCENCE_API_KEY` | ✅ | — | `voc_live_…` developer key (Premium) |
| `PORT` | — | `8100` | Server port |
| `VOCENCE_BASE_URL` | — | `https://api.vocence.ai` | API host override |

There is **no LLM key** — the agent's brain is configured in Vocence Studio (or
via the `llm_model` field in the editor) and runs on Vocence's side.

---

## REST API (what the dashboard calls)

| Method · Path | SDK call |
|---|---|
| `GET /api/account` | `account.get()` |
| `GET /api/voices` | `voices.builtin()` |
| `GET /api/agents` | `agents.list()` |
| `GET /api/agents/{id}` | `agents.get(id)` |
| `POST /api/agents` | `agents.create(**fields)` |
| `PATCH /api/agents/{id}` | `agents.update(id, **fields)` |
| `DELETE /api/agents/{id}` | `agents.delete(id)` |
| `WS /ws?agent_id={id}` | `agents.session(id)` (live call) |

---

## The plugins path (BYO pipeline)

If you want to build the agent yourself instead of using a hosted one — your own
LLM, full control — see [`examples/byo_pipeline.py`](examples/byo_pipeline.py):
`VocenceSTT` (transcribe) → your LLM → `VocenceTTS` (speak), in ~60 lines.

```bash
VOCENCE_API_KEY=voc_live_... \
LLM_API_KEY=sk-... LLM_MODEL=gpt-4o-mini \
python examples/byo_pipeline.py
```

That path needs an LLM key (Vocence sells STT + TTS, not a brain). The dashboard
above does **not** — it uses hosted agents.

---

## Deploy

Run `server.py` on your machine or backend (the key stays there). For real
users, host it behind HTTPS and serve the page from it.

> **Network note:** the SDK opens WebSockets to `api.vocence.ai`. Normal
> machines are fine; from a flagged datacenter IP you can point
> `VOCENCE_BASE_URL` at a non-CDN host.

---

## Repo structure

```
server.py              FastAPI: REST CRUD (SDK) + /ws bridge to agents.session
static/
  index.html           dashboard (agents · editor · live chat)
  app.js               REST calls + editor + voice chat + audio
  style.css            UI
  capture-worklet.js   mic → PCM16@16k
  player-worklet.js    PCM16@24k → speakers
examples/byo_pipeline.py   the vocence-plugins BYO pipeline (needs your LLM key)
requirements.txt  .env.example  README.md  LICENSE  .gitignore
```

## License

MIT.

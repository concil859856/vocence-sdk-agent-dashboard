"""Vocence SDK dashboard — manage agents and talk to them in real time.

Everything goes through the **`vocence` Python SDK**:

  • account · agents CRUD · voices  →  REST  (`client.account` / `.agents` / `.voices`)
  • the live voice call             →  `client.agents.session(agent_id)` (HOSTED agent)

The hosted agent runs its own brain (the LLM you picked in Studio), so this app
needs **only your Vocence key — no LLM key**. The secret `voc_live_…` key stays
on the server; the browser only ever talks to this server.

  Browser (dashboard + mic + audio)
        ⇅  REST + WebSocket
  this server  ── vocence SDK ──▶  api.vocence.ai

The plugins (BYO STT→LLM→TTS pipeline) are shown separately in
``examples/byo_pipeline.py``.

Run:  python server.py        (reads .env → VOCENCE_API_KEY)
"""

from __future__ import annotations

import asyncio
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Body, FastAPI, HTTPException, WebSocket
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from vocence import AsyncVocence
from vocence._streaming import AudioFrame

load_dotenv()

VOCENCE_API_KEY = os.environ.get("VOCENCE_API_KEY", "")
VOCENCE_BASE_URL = os.environ.get("VOCENCE_BASE_URL", "https://api.vocence.ai")
if not VOCENCE_API_KEY:
    raise SystemExit("Set VOCENCE_API_KEY (voc_live_…) in .env — see .env.example")

STATIC = Path(__file__).resolve().parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.voc = AsyncVocence(api_key=VOCENCE_API_KEY, base_url=VOCENCE_BASE_URL)
    yield
    await app.state.voc.aclose()


app = FastAPI(title="Vocence SDK dashboard", lifespan=lifespan)


def voc() -> AsyncVocence:
    return app.state.voc


def _dump(obj):
    return obj.model_dump() if hasattr(obj, "model_dump") else obj


# ----------------------------- REST (SDK) --------------------------------
@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")


@app.get("/api/account")
async def account():
    return _dump(await voc().account.get())


@app.get("/api/voices")
async def voices():
    vs = await voc().voices.builtin()
    return [{"id": v.id, "name": getattr(v, "name", v.id), "description": getattr(v, "description", "")} for v in vs]


@app.get("/api/agents")
async def agents_list():
    return [{"id": a.id, "name": a.name} for a in await voc().agents.list()]


@app.get("/api/agents/{agent_id}")
async def agent_get(agent_id: str):
    try:
        return _dump(await voc().agents.get(agent_id))
    except Exception as e:
        raise HTTPException(404, str(e))


@app.post("/api/agents")
async def agent_create(body: dict = Body(...)):
    # `create()` takes no `status` (new agents start as draft) — apply it
    # afterwards via update so the UI's single Save flow still works.
    status = body.pop("status", None)
    try:
        agent = await voc().agents.create(**body)
        if status and status != "draft":
            agent = await voc().agents.update(agent.id, status=status)
        return _dump(agent)
    except Exception as e:
        raise HTTPException(400, str(e))


@app.patch("/api/agents/{agent_id}")
async def agent_update(agent_id: str, body: dict = Body(...)):
    try:
        return _dump(await voc().agents.update(agent_id, **body))
    except Exception as e:
        raise HTTPException(400, str(e))


@app.delete("/api/agents/{agent_id}")
async def agent_delete(agent_id: str):
    await voc().agents.delete(agent_id)
    return {"ok": True}


app.mount("/static", StaticFiles(directory=STATIC), name="static")


# ----------------------- Live call (hosted agent) ------------------------
@app.websocket("/ws")
async def ws(browser: WebSocket) -> None:
    await browser.accept()
    agent_id = browser.query_params.get("agent_id")
    if not agent_id:
        await browser.close(code=4400)
        return

    try:
        async with voc().agents.session(agent_id) as sess:
            await sess.start_stream()                      # open the audio channel

            async def to_browser():
                async for ev in sess:
                    if isinstance(ev, AudioFrame):
                        await browser.send_bytes(ev.data)  # agent speech (PCM16@24k)
                    else:
                        await browser.send_text(json.dumps(ev.data))  # token/transcript/turn_end/…

            async def from_browser():
                while True:
                    msg = await browser.receive()
                    if msg.get("type") == "websocket.disconnect":
                        return
                    if (data := msg.get("bytes")) is not None:
                        await sess.send_pcm(data)          # mic PCM16@16k
                    elif (txt := msg.get("text")) is not None:
                        body = json.loads(txt)
                        if body.get("type") == "text" and body.get("text"):
                            await sess.send_text(body["text"].strip())

            await asyncio.gather(to_browser(), from_browser())
    except Exception:
        pass
    finally:
        try:
            await browser.close()
        except Exception:
            pass


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8100"))
    print(f"\n  Vocence SDK dashboard → http://localhost:{port}\n")
    uvicorn.run("server:app", host="127.0.0.1", port=port)

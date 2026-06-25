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


@app.middleware("http")
async def no_cache(request, call_next):
    # Dev demo: never let the browser cache the page/JS/CSS, so edits show up
    # on a plain refresh (no stale stylesheet making `hidden` modals appear).
    resp = await call_next(request)
    resp.headers["Cache-Control"] = "no-store, must-revalidate"
    return resp


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


@app.get("/api/models")
async def models():
    """LLM models the agent picker offers → [{id, label}]."""
    return await voc().agents.models()


@app.get("/api/tools")
async def tools():
    """Tool catalog: built-in tools + account-level custom webhook tools."""
    builtin = await voc().agents.builtin_tools()
    custom = [_dump(t) for t in await voc().agent_tools.list()]
    return {"builtin": builtin, "custom": custom}


@app.post("/api/custom-tools")
async def custom_tool_create(body: dict = Body(...)):
    """Register a custom webhook tool (name, description, parameters, endpoint_url, …)."""
    try:
        return _dump(await voc().agent_tools.create(**body))
    except Exception as e:
        raise HTTPException(400, str(e))


@app.delete("/api/custom-tools/{tool_id}")
async def custom_tool_delete(tool_id: str):
    await voc().agent_tools.delete(tool_id)
    return {"ok": True}


async def _reconcile_bindings(agent_id: str, desired: list[str] | None):
    """Bind/unbind custom tools on an agent to match the desired id set."""
    if desired is None:
        return
    binder = voc().agents.tools(agent_id)
    current = {t.id for t in await binder.list()}
    want = set(desired)
    for tid in want - current:
        await binder.bind(tid)
    for tid in current - want:
        await binder.unbind(tid)


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
    bound = body.pop("bound_tools", None)        # custom-tool ids to bind
    try:
        agent = await voc().agents.create(**body)
        if status and status != "draft":
            agent = await voc().agents.update(agent.id, status=status)
        await _reconcile_bindings(agent.id, bound)
        return _dump(await voc().agents.get(agent.id))
    except Exception as e:
        raise HTTPException(400, str(e))


@app.patch("/api/agents/{agent_id}")
async def agent_update(agent_id: str, body: dict = Body(...)):
    bound = body.pop("bound_tools", None)
    try:
        if body:
            await voc().agents.update(agent_id, **body)
        await _reconcile_bindings(agent_id, bound)
        return _dump(await voc().agents.get(agent_id))
    except Exception as e:
        raise HTTPException(400, str(e))


@app.delete("/api/agents/{agent_id}")
async def agent_delete(agent_id: str):
    await voc().agents.delete(agent_id)
    return {"ok": True}


# --------------------- Call history / recordings -------------------------
@app.get("/api/agents/{agent_id}/calls")
async def agent_calls(agent_id: str, range: str = "30d", limit: int = 50):
    """Recent calls (newest first). Each has session_id + has_recording."""
    return await voc().agents.calls(agent_id).list(range=range, limit=limit)


@app.get("/api/agents/{agent_id}/calls/{session_id}/transcript")
async def agent_call_transcript(agent_id: str, session_id: str):
    """Per-turn transcript: [{role, text, at_ms}, …]."""
    try:
        return await voc().agents.calls(agent_id).transcript(session_id)
    except Exception as e:
        raise HTTPException(404, str(e))


@app.get("/api/agents/{agent_id}/calls/{session_id}/recording")
async def agent_call_recording(agent_id: str, session_id: str, download: bool = False):
    """Presigned URL for the stereo WAV (recording must have been enabled)."""
    try:
        return await voc().agents.calls(agent_id).recording(session_id, download=download)
    except Exception as e:
        raise HTTPException(404, str(e))


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

            # On barge-in the agent's already-generated audio is still buffered
            # in this event stream; forwarding it all would delay the abort ack
            # and the new reply by many seconds. So after a cancel we DROP audio
            # until the next turn boundary, racing to the live content.
            drop_audio = {"v": False}
            BOUNDARY = {"interrupt", "cancelled", "transcript"}

            async def to_browser():
                async for ev in sess:
                    if isinstance(ev, AudioFrame):
                        if drop_audio["v"]:
                            continue                       # skip stale post-barge audio
                        await browser.send_bytes(ev.data)  # agent speech (PCM16@24k)
                    else:
                        if ev.data.get("type") in BOUNDARY:
                            drop_audio["v"] = False        # new turn started → resume audio
                        await browser.send_text(json.dumps(ev.data))

            async def from_browser():
                while True:
                    msg = await browser.receive()
                    if msg.get("type") == "websocket.disconnect":
                        return
                    if (data := msg.get("bytes")) is not None:
                        await sess.send_pcm(data)          # mic PCM16@16k
                    elif (txt := msg.get("text")) is not None:
                        body = json.loads(txt)
                        typ = body.get("type")
                        if typ == "text" and body.get("text"):
                            await sess.send_text(body["text"].strip())
                        elif typ == "cancel":              # barge-in / abort current turn
                            drop_audio["v"] = True          # stop pumping the dead reply's audio
                            await sess.cancel()
                        elif typ == "audio_started":       # speakers active → server mutes mic echo
                            await sess.notify_audio_started()
                        elif typ == "audio_settled":       # speakers silent → server unmutes mic
                            await sess.notify_audio_settled()

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

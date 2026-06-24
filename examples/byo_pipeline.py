"""The vocence-plugins voice-agent loop, distilled — no web layer.

Runs one full turn entirely from the plugins:

    (sample question) ─VocenceTTS─▶ speech
                       ─VocenceSTT─▶ transcript
                       ─your LLM──▶ reply text
                       ─VocenceTTS─▶ reply.wav

This is the same pipeline `server.py` bridges to the browser, shown in ~60
self-contained lines so you can see exactly how the plugins fit together.

    VOCENCE_API_KEY=voc_live_... python examples/byo_pipeline.py
    # optional real brain:  LLM_API_KEY=sk-... LLM_MODEL=gpt-4o-mini ...
"""

from __future__ import annotations

import asyncio
import audioop  # std-lib (3.12); resamples 24 kHz TTS → 16 kHz STT
import os
import wave

from videosdk.agents import SpeechEventType
from vocence_plugins import VocenceSTT, VocenceTTS

KEY = os.environ.get("VOCENCE_API_KEY", "")
VOICE = os.environ.get("VOICE", "design-aria")
LLM_API_KEY = os.environ.get("LLM_API_KEY", "")
LLM_MODEL = os.environ.get("LLM_MODEL", "gpt-4o-mini")
QUESTION = "What is the capital of France?"


async def _one(s: str):
    yield s


async def llm(prompt: str) -> str:
    if not LLM_API_KEY:
        return f"You asked: {prompt} — set LLM_API_KEY to plug in a real model."
    from openai import AsyncOpenAI

    client = AsyncOpenAI(api_key=LLM_API_KEY, base_url=os.environ.get("LLM_BASE_URL") or None)
    r = await client.chat.completions.create(
        model=LLM_MODEL,
        messages=[{"role": "system", "content": "Answer in one short spoken sentence."},
                  {"role": "user", "content": prompt}],
    )
    await client.close()
    return r.choices[0].message.content.strip()


async def main() -> None:
    if not KEY:
        raise SystemExit("Set VOCENCE_API_KEY (voc_live_…)")

    # 1) Make a spoken question with VocenceTTS, then resample 24k → 16k.
    tts = VocenceTTS(api_key=KEY, voice=VOICE, language="English", sample_rate=24000)
    speech = b"".join([c async for c in tts.stream_synthesize(_one(QUESTION))])
    pcm16, _ = audioop.ratecv(speech, 2, 1, 24000, 16000, None)

    # 2) Recognize it with VocenceSTT (feed frames + trailing silence for the VAD).
    stt = VocenceSTT(api_key=KEY, language="auto", sample_rate=16000, vad_events=True, enable_partials=True)

    async def frames():
        step = 640
        for i in range(0, len(pcm16), step):
            yield pcm16[i:i + step]
            await asyncio.sleep(0.012)
        for _ in range(120):                 # ~1.5 s silence → final
            yield b"\x00" * step
            await asyncio.sleep(0.012)

    transcript = ""
    async for resp in stt.stream_transcribe(frames()):
        if resp.event_type == SpeechEventType.FINAL and getattr(resp, "data", None) and resp.data.text:
            transcript = resp.data.text
            break
    await stt.aclose()
    print(f"heard : {transcript!r}")

    # 3) Brain.
    reply = await llm(transcript or QUESTION)
    print(f"reply : {reply!r}")

    # 4) Speak the reply with VocenceTTS → reply.wav.
    out = b"".join([c async for c in tts.stream_synthesize(_one(reply))])
    await tts.aclose()
    with wave.open("reply.wav", "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(out)
    print(f"wrote : reply.wav ({len(out)} bytes, 24 kHz PCM16)")


if __name__ == "__main__":
    asyncio.run(main())

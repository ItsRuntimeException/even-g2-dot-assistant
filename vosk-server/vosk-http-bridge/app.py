import asyncio
import io
import json
import logging
import os
import re
import secrets
import wave

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from websockets.asyncio.client import connect
from websockets.exceptions import WebSocketException

app = FastAPI(title="Dot Vosk HTTP bridge")
logger = logging.getLogger("uvicorn.error")
VOSK_WS_URL = os.getenv("VOSK_WS_URL", "ws://vosk:2700")
VOSK_WAKE_WS_URL = os.getenv("VOSK_WAKE_WS_URL", "ws://vosk-wake:2700")
SAMPLE_RATE = 16_000
MAX_AUDIO_BYTES = 2_000_000
WAKE_PHRASE = "hey dot"


def normalize_words(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", text.lower())).strip()


def has_wake_phrase(text: str) -> bool:
    text = normalize_words(text)
    return bool(re.search(r"\bhey\s+dot\b", text))


def contains_wake_phrase(result: dict) -> bool:
    return has_wake_phrase(str(result.get("text", "")))


def contains_partial_wake_phrase(result: dict) -> bool:
    return has_wake_phrase(str(result.get("partial", "")))


async def open_recognizer(url: str = VOSK_WS_URL):
    ws = await connect(url, open_timeout=10, close_timeout=5, max_size=2_000_000)
    await ws.send(json.dumps({"config": {"sample_rate": SAMPLE_RATE}}))
    return ws


async def send_audio_frame(vosk_ws, audio: bytes) -> dict:
    await vosk_ws.send(audio)
    return json.loads(await asyncio.wait_for(vosk_ws.recv(), timeout=10))


@app.get("/health")
async def health():
    return {"ok": True}


@app.post("/transcribe")
async def transcribe(request: Request):
    encoded = await request.body()
    if not encoded or len(encoded) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="Audio is empty or exceeds the 2 MB limit.")
    try:
        with wave.open(io.BytesIO(encoded), "rb") as wav:
            if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getframerate() != SAMPLE_RATE:
                raise HTTPException(status_code=415, detail="Expected mono 16-bit PCM WAV at 16 kHz.")
            pcm = wav.readframes(wav.getnframes())
    except (wave.Error, EOFError) as error:
        raise HTTPException(status_code=400, detail="Invalid WAV audio.") from error
    if not pcm:
        raise HTTPException(status_code=400, detail="WAV contains no audio samples.")

    try:
        async with connect(VOSK_WS_URL, open_timeout=10, close_timeout=5, max_size=2_000_000) as ws:
            await ws.send(json.dumps({"config": {"sample_rate": SAMPLE_RATE}}))
            for offset in range(0, len(pcm), 8_000):
                await ws.send(pcm[offset : offset + 8_000])
            # Vosk's websocket server compares this control message as an exact string.
            await ws.send('{"eof" : 1}')
            while True:
                message = json.loads(await asyncio.wait_for(ws.recv(), timeout=45))
                if "text" in message:
                    transcript = str(message["text"]).strip()
                    if not transcript:
                        raise HTTPException(status_code=422, detail="No speech was recognized.")
                    return {"transcript": transcript}
    except HTTPException:
        raise
    except (OSError, TimeoutError, WebSocketException, json.JSONDecodeError) as error:
        raise HTTPException(status_code=502, detail="Could not transcribe audio with the Vosk server.") from error


@app.websocket("/listen")
async def listen(websocket: WebSocket):
    await websocket.accept()
    stream_token = os.getenv("VOSK_STREAM_TOKEN", "")
    if not stream_token:
        await websocket.close(code=1011, reason="VOSK_STREAM_TOKEN is not configured on the bridge.")
        return

    try:
        auth = json.loads(await asyncio.wait_for(websocket.receive_text(), timeout=10))
        if not secrets.compare_digest(str(auth.get("token", "")), stream_token):
            await websocket.close(code=4401, reason="Invalid stream token.")
            return

        wake_ws = await open_recognizer(VOSK_WAKE_WS_URL)
        mode = "wake"
        partial_wake_streak = 0
        wake_audio_frames = 0
        logger.info("Wake stream authenticated; Vosk wake recognizer is ready")
        await websocket.send_json({"type": "ready", "mode": mode})

        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break

            control = message.get("text")
            if control:
                command = json.loads(control)
                if command.get("type") == "ping":
                    await websocket.send_json({"type": "pong"})
                elif command.get("type") == "resume" and mode == "paused":
                    await wake_ws.close()
                    wake_ws = await open_recognizer(VOSK_WAKE_WS_URL)
                    mode = "wake"
                    partial_wake_streak = 0
                    wake_audio_frames = 0
                    logger.info("Wake recognizer resumed after the reply")
                    await websocket.send_json({"type": "ready", "mode": mode})
                continue

            audio = message.get("bytes")
            if not audio or mode == "paused":
                continue

            if mode == "wake":
                wake_audio_frames += 1
                if wake_audio_frames == 1 or wake_audio_frames % 100 == 0:
                    logger.info("Wake audio frames received since resume: %s", wake_audio_frames)
                wake_result = await send_audio_frame(wake_ws, audio)
                final_match = contains_wake_phrase(wake_result)
                partial_match = contains_partial_wake_phrase(wake_result)
                partial_wake_streak = partial_wake_streak + 1 if partial_match else 0
                if final_match or partial_wake_streak >= 2:
                    mode = "paused"
                    partial_wake_streak = 0
                    logger.info("Wake phrase matched; pausing wake recognition for question capture")
                    await websocket.send_json({"type": "wake_detected", "phrase": WAKE_PHRASE})
    except WebSocketDisconnect:
        pass
    except (asyncio.TimeoutError, OSError, TimeoutError, WebSocketException, json.JSONDecodeError) as error:
        try:
            await websocket.send_json({"type": "error", "message": "Vosk stream failed: " + str(error)})
        except Exception:
            pass
    finally:
        for recognizer in (locals().get("wake_ws"),):
            if recognizer:
                try:
                    await recognizer.close()
                except Exception:
                    pass

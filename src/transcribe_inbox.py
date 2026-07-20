#!/usr/bin/env python3
"""
Transcribe a received WhatsApp voice note (OGG/Opus) and write a .txt beside it.
Called by whatsapp.js via spawn with the audio file path as argv[1].
Uses faster-whisper (isolated venv to avoid WDAC-blocked PyAV in other venvs).
"""
import sys, os, subprocess

AUDIO = sys.argv[1] if len(sys.argv) > 1 else None
if not AUDIO or not os.path.exists(AUDIO):
    sys.exit(1)

# Path to the venv that has a working faster-whisper + av.
VENV_PY = r"C:\Users\ricar\AppData\Local\hermes\.venv_transcribe\Scripts\python.exe"
if not os.path.exists(VENV_PY):
    # fallback: try to use whatever python3 is on PATH
    VENV_PY = "python3"

OUT = AUDIO.rsplit(".", 1)[0] + ".txt"

# ffmpeg is on PATH via WinGet; convert ogg/opus -> 16k wav for whisper.
WAV = AUDIO.rsplit(".", 1)[0] + ".wav"
ff = subprocess.run(["ffmpeg", "-y", "-i", AUDIO, "-ar", "16000", "-ac", "1", WAV],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
if ff.returncode != 0 or not os.path.exists(WAV):
    # if ffmpeg missing, just bail (text stays empty)
    open(OUT, "w", encoding="utf-8").write("")
    sys.exit(0)

code = '''
from faster_whisper import WhisperModel
import sys
m = WhisperModel("base", device="cpu", compute_type="int8")
segs, _ = m.transcribe(sys.argv[1], language="pt", beam_size=5)
with open(sys.argv[2], "w", encoding="utf-8") as f:
    for s in segs:
        f.write(s.text + "\\n")
'''
# run transcription in the dedicated venv
res = subprocess.run([VENV_PY, "-c", code, WAV, OUT],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
sys.exit(res.returncode)

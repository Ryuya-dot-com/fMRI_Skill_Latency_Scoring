#!/usr/bin/env python3
"""
Analyze stimulus MP3 files to find the true speech content duration.
Outputs data/stimulus_durations.json for use by the scoring app.

The green reference marker in the scoring app currently uses
playback_end_ms_rel, which includes MP3 padding/trailing silence.
This script measures the actual speech content end time via
energy-based Voice Activity Detection (reverse search from end).

Usage:
    python build/analyze_stimuli.py
"""

import json
import os
import subprocess
import sys
import unicodedata
from datetime import datetime, timezone

import numpy as np


# ── Paths ──
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
STIMULI_ROOT = os.path.normpath(os.path.join(
    SCRIPT_DIR, '../../Experiment/L2_to_L1/Target_Stimuli'
))
OUTPUT_PATH = os.path.join(SCRIPT_DIR, '../data/stimulus_durations.json')

FFMPEG = '/opt/homebrew/bin/ffmpeg'
FFPROBE = '/opt/homebrew/bin/ffprobe'

# ── VAD Parameters (same as analyze_latency.py) ──
THRESHOLD_DB = -40.0
FRAME_MS = 10.0
MIN_FRAMES = 4
VOICES = ['male', 'female']


def strip_accents(s):
    """Remove diacritical marks (matches csv-loader.js stripAccents)."""
    return ''.join(
        ch for ch in unicodedata.normalize('NFD', s)
        if unicodedata.category(ch) != 'Mn'
    )


def get_sample_rate(mp3_path):
    """Get audio sample rate via ffprobe."""
    result = subprocess.run(
        [FFPROBE, '-i', mp3_path,
         '-show_entries', 'stream=sample_rate',
         '-v', 'quiet', '-of', 'csv=p=0'],
        capture_output=True, text=True
    )
    return int(result.stdout.strip())


def decode_mp3(mp3_path):
    """Decode MP3 to raw float32 PCM via ffmpeg pipe."""
    sample_rate = get_sample_rate(mp3_path)
    result = subprocess.run(
        [FFMPEG, '-i', mp3_path,
         '-f', 'f32le', '-acodec', 'pcm_f32le',
         '-ac', '1', '-v', 'quiet', '-'],
        capture_output=True
    )
    if result.returncode != 0:
        raise RuntimeError(f'ffmpeg failed for {mp3_path}')
    samples = np.frombuffer(result.stdout, dtype=np.float32)
    return samples, sample_rate


def rolling_energy_db(signal, sample_rate, frame_ms=10.0):
    """Compute rolling mean-square energy in dB with given frame size."""
    frame_length = max(1, int(round(sample_rate * frame_ms / 1000.0)))
    window = np.ones(frame_length, dtype=np.float32) / frame_length
    energy = np.convolve(np.square(signal), window, mode='valid')
    energy_db = 10.0 * np.log10(np.maximum(energy, 1e-12))
    return energy_db, frame_length


def detect_speech_end(energy_db, sample_rate, frame_length,
                      threshold_db=-40.0, min_frames=4):
    """
    Reverse-search from end of file to find the last sustained speech.

    Returns the end time in ms, or None if no speech found.
    Searches backward for a run of >= min_frames consecutive frames
    above the energy threshold.
    """
    n = len(energy_db)
    if n < min_frames:
        return None

    above = energy_db > threshold_db

    i = n - 1
    while i >= 0:
        if not above[i]:
            i -= 1
            continue
        # Found an above-threshold frame at i.
        # Walk backward to find start of this consecutive run.
        run_end = i
        run_start = i
        while run_start > 0 and above[run_start - 1]:
            run_start -= 1
        run_length = run_end - run_start + 1
        if run_length >= min_frames:
            # Speech ends at run_end + frame_length (end of last frame)
            speech_end_sample = run_end + frame_length
            speech_end_ms = speech_end_sample / sample_rate * 1000.0
            return speech_end_ms
        # Run too short (noise spike), skip past it
        i = run_start - 1

    return None


def main():
    if not os.path.isdir(STIMULI_ROOT):
        print(f'ERROR: Stimuli directory not found: {STIMULI_ROOT}',
              file=sys.stderr)
        sys.exit(1)

    print(f'Stimuli root: {STIMULI_ROOT}')
    print(f'Parameters: threshold={THRESHOLD_DB}dB, '
          f'frame={FRAME_MS}ms, min_frames={MIN_FRAMES}')
    print()

    durations = {}
    errors = []

    for voice in VOICES:
        voice_dir = os.path.join(STIMULI_ROOT, voice)
        if not os.path.isdir(voice_dir):
            print(f'WARNING: Voice directory not found: {voice_dir}')
            continue

        print(f'── {voice} ──')
        mp3_files = sorted(f for f in os.listdir(voice_dir)
                           if f.endswith('.mp3'))

        for mp3_file in mp3_files:
            mp3_path = os.path.join(voice_dir, mp3_file)
            word = mp3_file.replace('.mp3', '')
            word_normalized = strip_accents(word)
            key = f'{voice}_{word_normalized}'

            try:
                samples, sr = decode_mp3(mp3_path)
                total_ms = len(samples) / sr * 1000.0

                energy_db, frame_length = rolling_energy_db(
                    samples, sr, FRAME_MS)
                end_ms = detect_speech_end(
                    energy_db, sr, frame_length,
                    THRESHOLD_DB, MIN_FRAMES)

                if end_ms is None:
                    errors.append(f'{key}: no speech detected')
                    end_ms = total_ms  # fallback to full duration

                durations[key] = round(end_ms, 1)
                trimmed = total_ms - end_ms
                print(f'  {key:25s}  content={end_ms:7.1f}ms  '
                      f'total={total_ms:7.1f}ms  '
                      f'trimmed={trimmed:5.1f}ms  ({sr}Hz)')

            except Exception as e:
                errors.append(f'{key}: {e}')
                print(f'  ERROR {key}: {e}')

    # Write output JSON
    output = {
        '_generated': datetime.now(timezone.utc).isoformat(),
        '_description': (
            'Speech content duration (ms) for each stimulus MP3. '
            'Measured from file start to last sustained speech activity. '
            'Used by the scoring app to correct the green reference marker.'
        ),
        '_parameters': {
            'threshold_db': THRESHOLD_DB,
            'frame_ms': FRAME_MS,
            'min_frames': MIN_FRAMES,
        },
        'durations': durations,
    }

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, 'w') as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f'\nWrote {len(durations)} entries to {OUTPUT_PATH}')

    if errors:
        print(f'\nWarnings/Errors ({len(errors)}):')
        for err in errors:
            print(f'  - {err}')


if __name__ == '__main__':
    main()

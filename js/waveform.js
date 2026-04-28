/**
 * waveform.js - WaveSurfer.js wrapper with Praat-style zoom,
 * minimap, timeline, and onset marker management.
 */
const WaveformViewer = (() => {
  let wavesurfer = null;
  let regionsPlugin = null;
  let minimapPlugin = null;
  let timelinePlugin = null;
  let onsetRegion = null;
  let offsetRegion = null;
  let utteranceRegions = [];
  let referenceRegion = null;
  let _onOnsetChanged = null;
  let _onOffsetChanged = null;
  let _onFirstSpeechChanged = null;
  let _clickToSetMode = null; // null | 'onset' | 'offset' | 'utterance:N'
  let _currentOnsetMs = null;
  let _currentOffsetMs = null;
  let _currentUtteranceMs = [];
  let _autoDetectedOnsetMs = null;
  let _autoDetectedOffsetMs = null;
  let _autoDetectionSummary = null;
  const ADDITIONAL_UTTERANCE_COLORS = [
    'rgba(255, 159, 67, 0.95)',
    'rgba(156, 89, 255, 0.95)',
    'rgba(38, 222, 129, 0.95)'
  ];
  const MARKER_Z_INDEX = {
    reference: 10,
    utterance: 30,
    offset: 50,
    onset: 70
  };

  // Zoom state
  let _zoomLevel = 1;
  const BASE_PX_PER_SEC = 100;
  const MIN_ZOOM = 1;
  const MAX_ZOOM = 20;
  const MARKER_WIDTH_SEC = 0.035;
  const DETECTION_WINDOW_SEC = 0.01;
  const DETECTION_SKIP_START_SEC = 0.15;
  const DETECTION_MIN_THRESHOLD = 0.008;
  const DETECTION_SUSTAINED_FRAMES = 5;
  const DETECTION_MIN_HIT_FRAMES = 3;
  const DETECTION_CLUSTER_SILENCE_FRAMES = 40; // 400ms below threshold closes the first speech cluster.

  const containerEl = '#waveform-container';

  function init() {
    if (wavesurfer) wavesurfer.destroy();

    wavesurfer = WaveSurfer.create({
      container: containerEl,
      waveColor: '#4F8EF7',
      progressColor: '#2B5EA7',
      cursorColor: '#e4e4e4',
      height: 150,
      normalize: true,
      barWidth: 2,
      barGap: 1,
      minPxPerSec: BASE_PX_PER_SEC,
      autoScroll: true,
      autoCenter: true
    });

    regionsPlugin = wavesurfer.registerPlugin(WaveSurfer.Regions.create());

    // Minimap plugin
    try {
      minimapPlugin = wavesurfer.registerPlugin(
        WaveSurfer.Minimap.create({
          container: '#waveform-minimap',
          height: 30,
          waveColor: '#3a5f8f',
          progressColor: '#1a3f6f',
          cursorColor: '#e4e4e4'
        })
      );
    } catch (e) {
      console.warn('Minimap plugin not available');
    }

    // Timeline plugin
    try {
      timelinePlugin = wavesurfer.registerPlugin(
        WaveSurfer.Timeline.create({
          container: '#waveform-timeline',
          timeInterval: 0.5,
          primaryLabelInterval: 1,
          style: {
            fontSize: '11px',
            color: '#999'
          }
        })
      );
    } catch (e) {
      console.warn('Timeline plugin not available');
    }

    wavesurfer.on('audioprocess', updateTimeDisplay);
    wavesurfer.on('seeking', updateTimeDisplay);
    wavesurfer.on('interaction', (time) => {
      const clickMs = time * 1000;
      if (_clickToSetMode === 'onset') {
        setOnsetMarker(clickMs);
        if (_onOnsetChanged) _onOnsetChanged(clickMs, 'manual');
      } else if (_clickToSetMode === 'offset') {
        setOffsetMarker(clickMs);
        if (_onOffsetChanged) _onOffsetChanged(clickMs, 'manual');
      } else if (_clickToSetMode && _clickToSetMode.startsWith('utterance:')) {
        const index = parseInt(_clickToSetMode.split(':')[1], 10);
        setUtteranceMarker(index, clickMs);
        if (_onFirstSpeechChanged) _onFirstSpeechChanged(clickMs, index);
      }
    });

    // Reset zoom
    _zoomLevel = 1;
    updateZoomDisplay();

    // Zoom button listeners
    const zoomInBtn = document.getElementById('zoom-in');
    const zoomOutBtn = document.getElementById('zoom-out');
    const zoomResetBtn = document.getElementById('zoom-reset');
    if (zoomInBtn) zoomInBtn.onclick = zoomIn;
    if (zoomOutBtn) zoomOutBtn.onclick = zoomOut;
    if (zoomResetBtn) zoomResetBtn.onclick = zoomReset;

    return wavesurfer;
  }

  function updateTimeDisplay() {
    if (!wavesurfer) return;
    const current = wavesurfer.getCurrentTime().toFixed(3);
    const total = wavesurfer.getDuration().toFixed(3);
    const el = document.getElementById('waveform-time');
    if (el) el.textContent = `${current}s / ${total}s`;
  }

  // ── Zoom Controls ──

  function zoomIn() {
    _zoomLevel = Math.min(_zoomLevel * 1.5, MAX_ZOOM);
    applyZoom();
  }

  function zoomOut() {
    _zoomLevel = Math.max(_zoomLevel / 1.5, MIN_ZOOM);
    applyZoom();
  }

  function zoomReset() {
    _zoomLevel = 1;
    applyZoom();
  }

  function applyZoom() {
    if (!wavesurfer) return;
    wavesurfer.zoom(_zoomLevel * BASE_PX_PER_SEC);
    updateZoomDisplay();
  }

  function updateZoomDisplay() {
    const el = document.getElementById('zoom-level');
    if (el) el.textContent = `${_zoomLevel.toFixed(1)}x`;
  }

  // ── Audio Loading ──

  async function loadAudio(url) {
    if (!wavesurfer) init();
    clearMarkers();
    _clickToSetMode = null;
    _currentOnsetMs = null;
    _currentOffsetMs = null;
    _currentUtteranceMs = [];
    _autoDetectedOnsetMs = null;
    _autoDetectedOffsetMs = null;
    _autoDetectionSummary = null;
    _zoomLevel = 1;
    updateZoomDisplay();

    return new Promise((resolve, reject) => {
      wavesurfer.once('ready', () => {
        updateTimeDisplay();
        applyZoom();
        _autoDetectionSummary = detectSpeechBounds();
        _autoDetectedOnsetMs = _autoDetectionSummary.onsetMs;
        _autoDetectedOffsetMs = _autoDetectionSummary.offsetMs;
        resolve();
      });
      wavesurfer.once('error', (err) => reject(err));
      wavesurfer.load(url);
    });
  }

  // ── Markers ──

  function styleMarkerRegion(region, className, zIndex, title) {
    if (!region || !region.element) return;
    region.element.classList.add(className);
    region.element.style.zIndex = String(zIndex);
    if (title) region.element.title = title;
  }

  function clearMarkers() {
    if (regionsPlugin) {
      regionsPlugin.clearRegions();
    }
    onsetRegion = null;
    offsetRegion = null;
    utteranceRegions = [];
    referenceRegion = null;
  }

  function setOnsetMarker(onsetMs) {
    if (onsetRegion) {
      onsetRegion.remove();
      onsetRegion = null;
    }

    if (onsetMs == null || isNaN(onsetMs)) {
      _currentOnsetMs = null;
      updateOnsetDisplay(null);
      updateDurationDisplay();
      return;
    }

    _currentOnsetMs = onsetMs;
    const duration = wavesurfer.getDuration();
    const startSec = onsetMs / 1000;

    if (startSec > duration) return;

    onsetRegion = regionsPlugin.addRegion({
      start: startSec,
      end: Math.min(startSec + MARKER_WIDTH_SEC, duration),
      color: 'rgba(255, 35, 35, 0.95)',
      drag: true,
      resize: false
    });
    styleMarkerRegion(onsetRegion, 'marker-onset', MARKER_Z_INDEX.onset, 'Onset');

    onsetRegion.on('update-end', () => {
      const newMs = onsetRegion.start * 1000;
      _currentOnsetMs = newMs;
      updateOnsetDisplay(newMs);
      updateDurationDisplay();
      if (_onOnsetChanged) _onOnsetChanged(newMs, 'corrected');
    });

    updateOnsetDisplay(onsetMs);
    updateDurationDisplay();
  }

  function setUtteranceMarker(index, ms) {
    if (index == null || index < 0) return;

    if (utteranceRegions[index]) {
      utteranceRegions[index].remove();
      utteranceRegions[index] = null;
    }

    if (ms == null || isNaN(ms)) {
      _currentUtteranceMs[index] = null;
      updateUtteranceDisplay();
      return;
    }

    _currentUtteranceMs[index] = ms;
    const duration = wavesurfer.getDuration();
    const startSec = ms / 1000;

    if (startSec > duration) return;

    utteranceRegions[index] = regionsPlugin.addRegion({
      start: startSec,
      end: Math.min(startSec + MARKER_WIDTH_SEC, duration),
      color: ADDITIONAL_UTTERANCE_COLORS[index] || ADDITIONAL_UTTERANCE_COLORS[ADDITIONAL_UTTERANCE_COLORS.length - 1],
      drag: true,
      resize: false
    });
    styleMarkerRegion(utteranceRegions[index], 'marker-utterance', MARKER_Z_INDEX.utterance, `U${index + 2}`);

    utteranceRegions[index].on('update-end', () => {
      const newMs = utteranceRegions[index].start * 1000;
      _currentUtteranceMs[index] = newMs;
      updateUtteranceDisplay();
      if (_onFirstSpeechChanged) _onFirstSpeechChanged(newMs, index);
    });

    updateUtteranceDisplay();
  }

  function setUtteranceMarkers(markers) {
    clearUtteranceMarkers();
    (markers || []).forEach((ms, index) => {
      if (ms != null && !isNaN(ms)) setUtteranceMarker(index, ms);
      else _currentUtteranceMs[index] = null;
    });
    updateUtteranceDisplay();
  }

  function clearUtteranceMarkers() {
    utteranceRegions.forEach(region => {
      if (region) region.remove();
    });
    utteranceRegions = [];
    _currentUtteranceMs = [];
    updateUtteranceDisplay();
  }

  function setFirstSpeechMarker(ms) {
    setOnsetMarker(ms);
  }

  function setReferenceMarker(ms, label) {
    if (ms == null || isNaN(ms)) return;
    if (referenceRegion) {
      referenceRegion.remove();
      referenceRegion = null;
    }
    const duration = wavesurfer.getDuration();
    const startSec = ms / 1000;
    if (startSec > duration) return;

    referenceRegion = regionsPlugin.addRegion({
      start: startSec,
      end: Math.min(startSec + 0.005, duration),
      color: 'rgba(190, 200, 215, 0.35)',
      drag: false,
      resize: false
    });
    styleMarkerRegion(referenceRegion, 'marker-reference', MARKER_Z_INDEX.reference, label || 'Reference');
  }

  function updateOnsetDisplay(ms) {
    const el = document.getElementById('onset-display');
    if (el) el.textContent = ms != null ? `Onset: ${ms.toFixed(1)} ms` : 'Onset: -- ms';
    const input = document.getElementById('onset-ms-input');
    if (input && ms != null) input.value = ms.toFixed(1);
  }

  function updateFirstSpeechDisplay(ms) {
    if (ms !== undefined) {
      _currentOnsetMs = ms;
    }
    updateUtteranceDisplay();
  }

  function updateUtteranceDisplay() {
    const values = _currentUtteranceMs
      .map((ms, i) => ms != null ? `U${i + 2}: ${ms.toFixed(1)} ms` : null)
      .filter(Boolean);
    const el = document.getElementById('first-speech-display');
    if (el) {
      const onsetValue = _currentOnsetMs != null ? [`U1/Onset: ${_currentOnsetMs.toFixed(1)} ms`] : [];
      const allValues = onsetValue.concat(values);
      el.textContent = allValues.length ? `Utterances: ${allValues.join(', ')}` : 'Utterances: -- ms';
    }

    _currentUtteranceMs.forEach((ms, index) => {
      const input = document.getElementById(`utterance-ms-input-${index}`);
      if (input) input.value = ms != null ? ms.toFixed(1) : '';
    });
  }

  // ── Speech Boundary Detection & Markers ──
  // Auto-detected onset/offset are INITIAL ESTIMATES only. The ground truth
  // for fMRI analysis is the rater-confirmed onset_ms_rater/offset_ms_rater.

  function quantile(sortedValues, q) {
    if (!sortedValues.length) return 0;
    const pos = (sortedValues.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    const next = sortedValues[base + 1];
    return next == null ? sortedValues[base] : sortedValues[base] + rest * (next - sortedValues[base]);
  }

  function computeRmsFrames(audioBuffer, windowSamples) {
    const frames = [];
    const channelCount = audioBuffer.numberOfChannels;
    for (let start = 0; start < audioBuffer.length; start += windowSamples) {
      const end = Math.min(start + windowSamples, audioBuffer.length);
      let sumSq = 0;
      let count = 0;
      for (let ch = 0; ch < channelCount; ch++) {
        const data = audioBuffer.getChannelData(ch);
        for (let i = start; i < end; i++) {
          sumSq += data[i] * data[i];
          count++;
        }
      }
      frames.push(Math.sqrt(sumSq / Math.max(1, count)));
    }
    return frames;
  }

  function hasSustainedSignal(frames, index, threshold) {
    let hits = 0;
    const end = Math.min(frames.length, index + DETECTION_SUSTAINED_FRAMES);
    for (let i = index; i < end; i++) {
      if (frames[i] >= threshold) hits++;
    }
    return hits >= DETECTION_MIN_HIT_FRAMES;
  }

  function classifyDetection(onsetMs, offsetMs, peakRms, threshold) {
    if (onsetMs == null || offsetMs == null) return { quality: 'missing', issue: 'no_speech_detected' };
    const durationMs = offsetMs - onsetMs;
    if (durationMs < 0) return { quality: 'review', issue: 'offset_before_onset' };
    if (durationMs < 250) return { quality: 'review', issue: 'speech_duration_short' };
    if (durationMs > 3000) return { quality: 'review', issue: 'speech_duration_long' };
    if (threshold > 0 && peakRms / threshold < 1.8) return { quality: 'review', issue: 'low_signal_margin' };
    return { quality: 'ok', issue: '' };
  }

  function detectSpeechBounds() {
    const blank = {
      onsetMs: null,
      offsetMs: null,
      threshold: null,
      noiseFloor: null,
      peakRms: null,
      quality: 'missing',
      issue: 'no_audio'
    };

    if (!wavesurfer) return blank;
    const backend = wavesurfer.getDecodedData();
    if (!backend || backend.numberOfChannels === 0) return blank;

    const sampleRate = backend.sampleRate;
    const windowSamples = Math.max(1, Math.floor(sampleRate * DETECTION_WINDOW_SEC));
    const frames = computeRmsFrames(backend, windowSamples);
    if (!frames.length) return blank;

    const sorted = frames.slice().sort((a, b) => a - b);
    const noiseFloor = quantile(sorted, 0.2);
    const noiseMedian = quantile(sorted, 0.5);
    const noiseHigh = quantile(sorted, 0.8);
    const peakRms = sorted[sorted.length - 1] || 0;
    const threshold = Math.max(
      DETECTION_MIN_THRESHOLD,
      noiseFloor * 4,
      noiseMedian * 2.5,
      noiseHigh * 1.35,
      peakRms * 0.06
    );
    const lowThreshold = Math.max(DETECTION_MIN_THRESHOLD * 0.5, noiseMedian * 1.4, threshold * 0.45);
    const startFrame = Math.min(frames.length - 1, Math.ceil(DETECTION_SKIP_START_SEC / DETECTION_WINDOW_SEC));

    if (peakRms < DETECTION_MIN_THRESHOLD) {
      return { ...blank, threshold, noiseFloor, peakRms, issue: 'low_signal' };
    }

    let onsetFrame = null;
    for (let i = startFrame; i < frames.length; i++) {
      if (frames[i] >= threshold && hasSustainedSignal(frames, i, threshold)) {
        onsetFrame = i;
        break;
      }
    }

    if (onsetFrame == null) {
      return { ...blank, threshold, noiseFloor, peakRms, issue: 'no_speech_detected' };
    }

    while (onsetFrame > startFrame && frames[onsetFrame - 1] >= lowThreshold) {
      onsetFrame--;
    }

    let offsetFrame = onsetFrame;
    let silenceFrames = 0;
    for (let i = onsetFrame; i < frames.length; i++) {
      if (frames[i] >= lowThreshold) {
        offsetFrame = i;
        silenceFrames = 0;
      } else {
        silenceFrames++;
        if (silenceFrames >= DETECTION_CLUSTER_SILENCE_FRAMES) break;
      }
    }

    const onsetMs = (onsetFrame * windowSamples / sampleRate) * 1000;
    const offsetMs = (Math.min((offsetFrame + 1) * windowSamples, backend.length) / sampleRate) * 1000;
    const classification = classifyDetection(onsetMs, offsetMs, peakRms, threshold);

    return {
      onsetMs,
      offsetMs,
      threshold,
      noiseFloor,
      peakRms,
      quality: classification.quality,
      issue: classification.issue
    };
  }

  function setOffsetMarker(ms) {
    if (offsetRegion) {
      offsetRegion.remove();
      offsetRegion = null;
    }

    if (ms == null || isNaN(ms)) {
      _currentOffsetMs = null;
      updateOffsetDisplay(null);
      return;
    }

    _currentOffsetMs = ms;
    const duration = wavesurfer.getDuration();
    const startSec = ms / 1000;

    if (startSec > duration) return;

    offsetRegion = regionsPlugin.addRegion({
      start: startSec,
      end: Math.min(startSec + MARKER_WIDTH_SEC, duration),
      color: 'rgba(0, 214, 255, 0.95)',
      drag: true,
      resize: false
    });
    styleMarkerRegion(offsetRegion, 'marker-offset', MARKER_Z_INDEX.offset, 'Offset');

    offsetRegion.on('update-end', () => {
      const newMs = offsetRegion.start * 1000;
      _currentOffsetMs = newMs;
      updateOffsetDisplay(newMs);
      updateDurationDisplay();
      if (_onOffsetChanged) _onOffsetChanged(newMs, 'corrected');
    });

    updateOffsetDisplay(ms);
    updateDurationDisplay();
  }

  function updateOffsetDisplay(ms) {
    const el = document.getElementById('offset-display');
    if (el) el.textContent = ms != null ? `Offset: ${ms.toFixed(1)} ms` : 'Offset: -- ms';
    const input = document.getElementById('offset-ms-input');
    if (input && ms != null) input.value = ms.toFixed(1);
  }

  function updateDurationDisplay() {
    const el = document.getElementById('duration-display');
    if (!el) return;
    if (_currentOnsetMs != null && _currentOffsetMs != null) {
      const dur = _currentOffsetMs - _currentOnsetMs;
      el.textContent = `Duration: ${dur.toFixed(1)} ms`;
      el.style.color = dur < 0 ? '#e74c3c' : '';
    } else {
      el.textContent = 'Duration: -- ms';
      el.style.color = '';
    }
  }

  /**
   * @param {string|false} mode - 'onset', 'offset', 'utterance:N', or false
   */
  function enableClickToSet(mode) {
    _clickToSetMode = mode || null;
    const container = document.querySelector(containerEl);
    if (container) {
      container.style.cursor = mode ? 'crosshair' : 'default';
    }
  }

  // ── Playback ──

  function play() { if (wavesurfer) wavesurfer.playPause(); }
  function stop() { if (wavesurfer) { wavesurfer.stop(); } }

  function playFromOnset() {
    if (!wavesurfer || _currentOnsetMs == null) return;
    const sec = Math.max(0, _currentOnsetMs / 1000 - 0.2);
    wavesurfer.play(sec);
  }

  function setPlaybackRate(rate) {
    if (wavesurfer) wavesurfer.setPlaybackRate(rate);
  }

  function isPlaying() { return wavesurfer ? wavesurfer.isPlaying() : false; }
  function getCurrentOnsetMs() { return _currentOnsetMs; }
  function getCurrentOffsetMs() { return _currentOffsetMs; }
  function getCurrentFirstSpeechMs() { return _currentOnsetMs; }
  function getCurrentUtteranceMarkersMs() { return _currentUtteranceMs.slice(); }
  function getAutoDetectedOnsetMs() { return _autoDetectedOnsetMs; }
  function getAutoDetectedOffsetMs() { return _autoDetectedOffsetMs; }
  function getAutoDetectionSummary() { return _autoDetectionSummary ? { ..._autoDetectionSummary } : null; }

  function onOnsetChanged(fn) { _onOnsetChanged = fn; }
  function onOffsetChanged(fn) { _onOffsetChanged = fn; }
  function onFirstSpeechChanged(fn) { _onFirstSpeechChanged = fn; }

  function destroy() {
    if (wavesurfer) { wavesurfer.destroy(); wavesurfer = null; }
    minimapPlugin = null;
    timelinePlugin = null;
  }

  return {
    init, loadAudio, setOnsetMarker, setOffsetMarker, setFirstSpeechMarker,
    setUtteranceMarker, setUtteranceMarkers, clearUtteranceMarkers,
    setReferenceMarker, clearMarkers,
    enableClickToSet, play, stop, playFromOnset, setPlaybackRate,
    isPlaying, getCurrentOnsetMs, getCurrentOffsetMs,
    getCurrentFirstSpeechMs, getCurrentUtteranceMarkersMs,
    getAutoDetectedOnsetMs, getAutoDetectedOffsetMs, getAutoDetectionSummary,
    onOnsetChanged, onOffsetChanged, onFirstSpeechChanged,
    updateOnsetDisplay, updateOffsetDisplay, updateFirstSpeechDisplay, updateUtteranceDisplay, updateDurationDisplay,
    zoomIn, zoomOut, zoomReset, destroy
  };
})();

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
  let _autoDetectedOffsetMs = null;
  const UTTERANCE_COLORS = [
    'rgba(255, 159, 67, 0.85)',
    'rgba(156, 89, 255, 0.85)',
    'rgba(38, 222, 129, 0.85)',
    'rgba(69, 170, 242, 0.85)'
  ];

  // Zoom state
  let _zoomLevel = 1;
  const BASE_PX_PER_SEC = 100;
  const MIN_ZOOM = 1;
  const MAX_ZOOM = 20;
  const MARKER_WIDTH_SEC = 0.035;

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
        if (_onOffsetChanged) _onOffsetChanged(clickMs);
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
    _autoDetectedOffsetMs = null;
    _zoomLevel = 1;
    updateZoomDisplay();

    return new Promise((resolve, reject) => {
      wavesurfer.once('ready', () => {
        updateTimeDisplay();
        applyZoom();
        // Auto-detect offset from audio buffer
        _autoDetectedOffsetMs = detectOffset();
        resolve();
      });
      wavesurfer.once('error', (err) => reject(err));
      wavesurfer.load(url);
    });
  }

  // ── Markers ──

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
      color: UTTERANCE_COLORS[index % UTTERANCE_COLORS.length],
      drag: true,
      resize: false
    });

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
    setUtteranceMarker(0, ms);
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
      color: 'rgba(50, 200, 50, 0.6)',
      drag: false,
      resize: false
    });
  }

  function updateOnsetDisplay(ms) {
    const el = document.getElementById('onset-display');
    if (el) el.textContent = ms != null ? `Onset: ${ms.toFixed(1)} ms` : 'Onset: -- ms';
    const input = document.getElementById('onset-ms-input');
    if (input && ms != null) input.value = ms.toFixed(1);
  }

  function updateFirstSpeechDisplay(ms) {
    if (ms !== undefined) {
      _currentUtteranceMs[0] = ms;
    }
    updateUtteranceDisplay();
  }

  function updateUtteranceDisplay() {
    const values = _currentUtteranceMs
      .map((ms, i) => ms != null ? `U${i + 1}: ${ms.toFixed(1)} ms` : null)
      .filter(Boolean);
    const el = document.getElementById('first-speech-display');
    if (el) el.textContent = values.length ? `Utterances: ${values.join(', ')}` : 'Utterances: -- ms';

    _currentUtteranceMs.forEach((ms, index) => {
      const input = document.getElementById(`utterance-ms-input-${index}`);
      if (input) input.value = ms != null ? ms.toFixed(1) : '';
    });
  }

  // ── Offset Detection & Marker ──
  // Auto-detected offset is an INITIAL ESTIMATE only (end-of-signal RMS scan).
  // The ground truth for fMRI analysis is the rater-confirmed offset_ms_rater
  // stored in the exported CSV/Excel, after manual verification and correction.

  function detectOffset() {
    if (!wavesurfer) return null;
    const backend = wavesurfer.getDecodedData();
    if (!backend || backend.numberOfChannels === 0) return null;

    const data = backend.getChannelData(0);
    const sampleRate = backend.sampleRate;
    const windowSamples = Math.floor(sampleRate * 0.01); // 10ms window
    const threshold = 0.01;

    // Scan from end backwards to find last sample above threshold
    for (let i = data.length - windowSamples; i >= 0; i -= windowSamples) {
      let sumSq = 0;
      for (let j = i; j < i + windowSamples && j < data.length; j++) {
        sumSq += data[j] * data[j];
      }
      const rms = Math.sqrt(sumSq / windowSamples);
      if (rms > threshold) {
        // Found signal — offset is end of this window
        const offsetMs = ((i + windowSamples) / sampleRate) * 1000;
        return offsetMs;
      }
    }
    return null;
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

    offsetRegion.on('update-end', () => {
      const newMs = offsetRegion.start * 1000;
      _currentOffsetMs = newMs;
      updateOffsetDisplay(newMs);
      updateDurationDisplay();
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
  function getCurrentFirstSpeechMs() { return _currentUtteranceMs[0] != null ? _currentUtteranceMs[0] : null; }
  function getCurrentUtteranceMarkersMs() { return _currentUtteranceMs.slice(); }
  function getAutoDetectedOffsetMs() { return _autoDetectedOffsetMs; }

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
    getCurrentFirstSpeechMs, getCurrentUtteranceMarkersMs, getAutoDetectedOffsetMs,
    onOnsetChanged, onOffsetChanged, onFirstSpeechChanged,
    updateOnsetDisplay, updateOffsetDisplay, updateFirstSpeechDisplay, updateUtteranceDisplay, updateDurationDisplay,
    zoomIn, zoomOut, zoomReset, destroy
  };
})();

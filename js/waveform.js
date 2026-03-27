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
  let referenceRegion = null;
  let _onOnsetChanged = null;
  let _clickToSetEnabled = false;
  let _currentOnsetMs = null;

  // Zoom state
  let _zoomLevel = 1;
  const BASE_PX_PER_SEC = 100;
  const MIN_ZOOM = 1;
  const MAX_ZOOM = 20;

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
      if (_clickToSetEnabled) {
        const clickMs = time * 1000;
        setOnsetMarker(clickMs);
        if (_onOnsetChanged) _onOnsetChanged(clickMs, 'manual');
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
    _clickToSetEnabled = false;
    _currentOnsetMs = null;
    _zoomLevel = 1;
    updateZoomDisplay();

    return new Promise((resolve, reject) => {
      wavesurfer.once('ready', () => {
        updateTimeDisplay();
        applyZoom();
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
    referenceRegion = null;
  }

  function setOnsetMarker(onsetMs) {
    if (onsetRegion) {
      onsetRegion.remove();
      onsetRegion = null;
    }

    if (onsetMs == null || isNaN(onsetMs)) return;

    _currentOnsetMs = onsetMs;
    const duration = wavesurfer.getDuration();
    const startSec = onsetMs / 1000;

    if (startSec > duration) return;

    onsetRegion = regionsPlugin.addRegion({
      start: startSec,
      end: Math.min(startSec + 0.005, duration),
      color: 'rgba(255, 50, 50, 0.8)',
      drag: true,
      resize: false
    });

    onsetRegion.on('update-end', () => {
      const newMs = onsetRegion.start * 1000;
      _currentOnsetMs = newMs;
      updateOnsetDisplay(newMs);
      if (_onOnsetChanged) _onOnsetChanged(newMs, 'corrected');
    });

    updateOnsetDisplay(onsetMs);
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

  function enableClickToSet(enabled) {
    _clickToSetEnabled = enabled;
    const container = document.querySelector(containerEl);
    if (container) {
      container.style.cursor = enabled ? 'crosshair' : 'default';
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

  function onOnsetChanged(fn) { _onOnsetChanged = fn; }

  function destroy() {
    if (wavesurfer) { wavesurfer.destroy(); wavesurfer = null; }
    minimapPlugin = null;
    timelinePlugin = null;
  }

  return {
    init, loadAudio, setOnsetMarker, setReferenceMarker, clearMarkers,
    enableClickToSet, play, stop, playFromOnset, setPlaybackRate,
    isPlaying, getCurrentOnsetMs, onOnsetChanged, updateOnsetDisplay,
    zoomIn, zoomOut, zoomReset, destroy
  };
})();

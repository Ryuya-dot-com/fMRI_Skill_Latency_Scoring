/**
 * app.js - Main application controller for fMRI Voice Onset Scorer
 */
const App = (() => {
  let _index = null;
  let _loadGeneration = 0;
  let _currentDataset = null;

  async function init() {
    try {
      _index = await CsvLoader.loadIndex();
    } catch (e) {
      document.body.innerHTML = '<div style="padding:40px;color:#e74c3c;">' +
        '<h1>Error loading data</h1><p>Make sure participants.json exists in data/ directory.</p>' +
        '<p>Run: <code>node build/prepare-fmri-data.js</code></p></div>';
      return;
    }

    renderSetupScreen();
    setupKeyboardShortcuts();
  }

  function getIndex() { return _index; }

  // ── Setup Screen ──

  let _setupListenersAttached = false;

  function renderSetupScreen() {
    document.getElementById('setup-screen').style.display = '';
    document.getElementById('scoring-screen').style.display = 'none';

    renderParticipantSelector();
    renderFilterSelectors();

    if (!_setupListenersAttached) {
      _setupListenersAttached = true;

      document.getElementById('select-all-btn').addEventListener('click', () => {
        document.querySelectorAll('#participant-selector input').forEach(cb => cb.checked = true);
        updateStartButton();
      });
      document.getElementById('deselect-all-btn').addEventListener('click', () => {
        document.querySelectorAll('#participant-selector input').forEach(cb => cb.checked = false);
        updateStartButton();
      });

      document.getElementById('rater-id').addEventListener('input', () => {
        checkResume();
        updateStartButton();
      });

      document.getElementById('start-btn').addEventListener('click', startScoring);
      document.getElementById('resume-btn').addEventListener('click', resumeScoring);
    }

    checkResume();
  }

  function renderParticipantSelector() {
    const ds = _index.datasets[0];
    if (!ds) return;

    const container = document.getElementById('participant-selector');
    container.innerHTML = '';

    ds.participants.forEach(pid => {
      const label = document.createElement('label');
      label.innerHTML = `<input type="checkbox" value="${pid}" checked> ${pid}`;
      container.appendChild(label);
    });

    document.getElementById('participant-count').textContent = ds.participants.length;

    // Use onclick to avoid duplicate listeners on re-render
    container.onclick = () => setTimeout(updateStartButton, 0);
    updateStartButton();
  }

  function renderFilterSelectors() {
    // Session filter
    const sessionContainer = document.getElementById('session-filter');
    if (!sessionContainer) return;
    sessionContainer.innerHTML = '<option value="">All Sessions</option>';
    for (let s = 1; s <= 5; s++) {
      sessionContainer.innerHTML += `<option value="${s}">Session ${s}</option>`;
    }

    // Verb filter
    const verbContainer = document.getElementById('verb-filter');
    if (!verbContainer) return;
    const verbs = _index.verbs || {};
    verbContainer.innerHTML = '<option value="">All Verbs</option>';
    for (const [label, info] of Object.entries(verbs)) {
      verbContainer.innerHTML += `<option value="${label}">${label} (${info.japanese})</option>`;
    }
  }

  function getSelectedParticipants() {
    return Array.from(document.querySelectorAll('#participant-selector input:checked'))
      .map(cb => cb.value);
  }

  function getSelectedSessionFilter() {
    const el = document.getElementById('session-filter');
    return el && el.value ? parseInt(el.value) : null;
  }

  function getSelectedVerbFilter() {
    const el = document.getElementById('verb-filter');
    return el && el.value ? el.value : null;
  }

  function updateStartButton() {
    const raterId = document.getElementById('rater-id').value.trim();
    const participants = getSelectedParticipants();
    document.getElementById('start-btn').disabled = !raterId || participants.length === 0;
  }

  function checkResume() {
    const raterId = document.getElementById('rater-id').value.trim();
    const dsId = _index.datasets[0].id;
    const resumeSection = document.getElementById('resume-section');

    if (!raterId) {
      resumeSection.style.display = 'none';
      return;
    }

    const existing = State.load(raterId, dsId);
    if (existing) {
      const scored = Object.values(existing.scores).filter(s => s.accuracy != null || s.onsetStatus != null).length;
      document.getElementById('resume-info').textContent =
        `${scored} trials scored across ${existing.assignedParticipants.length} participants. ` +
        `Last saved: ${new Date(existing.lastSaved).toLocaleString()}`;
      resumeSection.style.display = 'block';
    } else {
      resumeSection.style.display = 'none';
    }
  }

  // ── Start / Resume ──

  function startScoring() {
    const raterId = document.getElementById('rater-id').value.trim();
    const dsId = _index.datasets[0].id;
    const participantIds = getSelectedParticipants();

    State.create(raterId, dsId, participantIds);
    enterScoringScreen(dsId, participantIds, 0, 0);
  }

  function resumeScoring() {
    const state = State.get();
    if (!state) return;

    enterScoringScreen(
      state.datasetId,
      state.assignedParticipants,
      state.currentParticipantIndex,
      state.currentTrialIndex
    );
  }

  let _scoringListenersAttached = false;

  function enterScoringScreen(dsId, participantIds, startPIndex, startTIndex) {
    document.getElementById('setup-screen').style.display = 'none';
    document.getElementById('scoring-screen').style.display = '';

    const dataset = _index.datasets.find(d => d.id === dsId);
    _currentDataset = dataset;

    document.getElementById('dataset-label').textContent = dataset.label;

    // Init waveform
    WaveformViewer.init();
    WaveformViewer.onOnsetChanged((ms, source) => {
      ScoringUI.handleOnsetAction(source);
    });
    WaveformViewer.onOffsetChanged(() => {
      ScoringUI.saveCurrentScore();
      showSaveStatus();
    });
    WaveformViewer.onFirstSpeechChanged(() => {
      ScoringUI.saveCurrentScore();
      showSaveStatus();
    });

    if (!_scoringListenersAttached) {
      _scoringListenersAttached = true;

      document.getElementById('back-to-setup').addEventListener('click', () => {
        ScoringUI.saveCurrentScore();
        WaveformViewer.destroy();
        CsvLoader.clearCache();
        Navigation.clearAudioCache();
        renderSetupScreen();
      });

      document.getElementById('play-btn').addEventListener('click', () => {
        WaveformViewer.play();
        updatePlayButton();
      });
      document.getElementById('stop-btn').addEventListener('click', () => {
        WaveformViewer.stop();
        updatePlayButton();
      });
      document.getElementById('play-from-onset').addEventListener('click', () => {
        WaveformViewer.playFromOnset();
        updatePlayButton();
      });
      document.getElementById('playback-speed').addEventListener('change', (e) => {
        WaveformViewer.setPlaybackRate(parseFloat(e.target.value));
      });

      // Export buttons
      document.getElementById('export-csv').addEventListener('click', () => Export.exportAllCSV(_currentDataset));
      document.getElementById('export-events-csv').addEventListener('click', () => Export.exportEventsCSV(_currentDataset));
      document.getElementById('export-json').addEventListener('click', () => Export.exportJSON());
      document.getElementById('export-participant').addEventListener('click', () => Export.exportCurrentParticipant(_currentDataset));

      // Scoring screen filter controls
      const sessionFilterScoring = document.getElementById('session-filter-scoring');
      const verbFilterScoring = document.getElementById('verb-filter-scoring');
      if (sessionFilterScoring) {
        sessionFilterScoring.addEventListener('change', applyInlinFilter);
      }
      if (verbFilterScoring) {
        verbFilterScoring.addEventListener('change', applyInlinFilter);
      }
    }

    // Populate inline filter dropdowns
    populateInlineFilters();

    // Apply filters from setup screen
    const sessionFilter = getSelectedSessionFilter();
    const verbFilter = getSelectedVerbFilter();

    // Init scoring UI
    ScoringUI.init(() => {
      Navigation.updateProgress();
      showSaveStatus();
    });

    // Init instructions panel
    Instructions.init();

    // Init navigation with filter
    Navigation.init(dataset, participantIds, (pIndex, tIndex, participant, trial) => {
      loadTrial(dataset, participant, trial);
    });
    Navigation.setFilter(sessionFilter, verbFilter);

    // Clamp indices
    const safePIndex = Math.min(startPIndex, participantIds.length - 1);
    Navigation.navigate(safePIndex, startTIndex);
  }

  function populateInlineFilters() {
    const verbs = _index.verbs || {};

    const sessionEl = document.getElementById('session-filter-scoring');
    if (sessionEl && sessionEl.options.length <= 1) {
      for (let s = 1; s <= 5; s++) {
        sessionEl.innerHTML += `<option value="${s}">S${s}</option>`;
      }
    }

    const verbEl = document.getElementById('verb-filter-scoring');
    if (verbEl && verbEl.options.length <= 1) {
      for (const [label, info] of Object.entries(verbs)) {
        verbEl.innerHTML += `<option value="${label}">${label}</option>`;
      }
    }
  }

  function applyInlinFilter() {
    const sessionEl = document.getElementById('session-filter-scoring');
    const verbEl = document.getElementById('verb-filter-scoring');
    const session = sessionEl && sessionEl.value ? parseInt(sessionEl.value) : null;
    const verb = verbEl && verbEl.value ? verbEl.value : null;
    Navigation.setFilter(session, verb);
    Navigation.navigate(0, 0); // restart from first matching trial
  }

  async function loadTrial(dataset, participant, trial) {
    const generation = ++_loadGeneration;

    // Render scoring UI
    ScoringUI.renderTrial(trial, participant, dataset);

    // Clear onset display
    WaveformViewer.updateOnsetDisplay(null);
    WaveformViewer.clearUtteranceMarkers();
    WaveformViewer.updateOffsetDisplay(null);

    // Load audio
    const audioUrl = Navigation.getAudioUrl(trial);
    try {
      await WaveformViewer.loadAudio(audioUrl);

      if (generation !== _loadGeneration) return;

      // Set 4-second reference marker (picture display duration)
      WaveformViewer.setReferenceMarker(4000);

      // Set onset marker from saved score, auto-detection, or default (0ms)
      const existingScore = State.getScore(participant.id, trial.trial);
      if (existingScore && existingScore.onsetMs != null) {
        WaveformViewer.setOnsetMarker(existingScore.onsetMs);
      } else if (trial.onset_ms_from_recording_start != null) {
        WaveformViewer.setOnsetMarker(trial.onset_ms_from_recording_start);
      } else {
        WaveformViewer.setOnsetMarker(0);
      }

      const utteranceCount = existingScore && existingScore.utteranceCount
        ? existingScore.utteranceCount
        : (existingScore && existingScore.doubleAnswerCode ? 2 : 1);
      const utteranceMarkers = existingScore && Array.isArray(existingScore.utteranceMarkersMs)
        ? existingScore.utteranceMarkersMs
        : (existingScore && existingScore.firstSpeechMs != null ? [existingScore.firstSpeechMs] : []);
      if (utteranceCount > 1) {
        WaveformViewer.setUtteranceMarkers(utteranceMarkers.slice(0, utteranceCount));
      } else {
        WaveformViewer.clearUtteranceMarkers();
      }

      // Set offset marker from saved score or auto-detection
      const autoOffset = WaveformViewer.getAutoDetectedOffsetMs();
      const autoOffsetEl = document.getElementById('auto-offset-value');
      if (autoOffsetEl) {
        autoOffsetEl.textContent = autoOffset != null ? autoOffset.toFixed(1) : 'N/A';
      }

      if (existingScore && existingScore.offsetMs != null) {
        WaveformViewer.setOffsetMarker(existingScore.offsetMs);
      } else if (autoOffset != null) {
        WaveformViewer.setOffsetMarker(autoOffset);
      } else {
        WaveformViewer.updateOffsetDisplay(null);
      }
    } catch (e) {
      if (generation === _loadGeneration) {
        console.error('Failed to load audio:', e);
      }
    }

    if (generation === _loadGeneration) updatePlayButton();
  }

  function updatePlayButton() {
    const btn = document.getElementById('play-btn');
    if (btn) btn.textContent = WaveformViewer.isPlaying() ? 'Pause' : 'Play';
  }

  function showSaveStatus() {
    const el = document.getElementById('save-status');
    el.textContent = 'Saving...';
    el.style.color = 'var(--warning)';
    setTimeout(() => {
      el.textContent = 'Saved';
      el.style.color = 'var(--success)';
    }, 600);
  }

  // ── Keyboard Shortcuts ──

  function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      const tag = e.target.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        if (e.key === 'Escape') e.target.blur();
        return;
      }

      if (document.getElementById('scoring-screen').style.display === 'none') return;

      // Shift + score key = score + auto-advance
      if (e.shiftKey) {
        switch (e.key) {
          case '!': // Shift+1
            ScoringUI.scoreByKey('1');
            setTimeout(() => Navigation.nextTrial(), 100);
            return;
          case ')': // Shift+0
            ScoringUI.scoreByKey('0');
            setTimeout(() => Navigation.nextTrial(), 100);
            return;
          case '(': // Shift+9
            ScoringUI.scoreByKey('9');
            setTimeout(() => Navigation.nextTrial(), 100);
            return;
        }
      }

      switch (e.key) {
        case ' ':
          e.preventDefault();
          WaveformViewer.play();
          updatePlayButton();
          break;
        case '9':
          ScoringUI.scoreByKey('9');
          break;
        case '0':
          ScoringUI.scoreByKey('0');
          break;
        case '1':
          ScoringUI.scoreByKey('1');
          break;
        case 'ArrowRight':
        case 'Enter':
          e.preventDefault();
          Navigation.nextTrial();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          Navigation.prevTrial();
          break;
        case 'c':
        case 'C':
          ScoringUI.confirmOnset();
          break;
        case 't':
        case 'T':
          ScoringUI.handleOnsetAction('no_speech_true');
          break;
        case 'f':
        case 'F':
          ScoringUI.handleOnsetAction('no_speech_technical');
          break;
        case 'g':
        case 'G':
          ScoringUI.handleOnsetAction('no_speech_nonlexical');
          break;
        case 'o':
        case 'O':
          ScoringUI.handleOnsetAction('offset_manual');
          break;
        case 'r':
        case 'R':
          WaveformViewer.playFromOnset();
          updatePlayButton();
          break;
        case 'n':
        case 'N':
          document.getElementById('trial-notes').focus();
          break;
        case 'i':
        case 'I':
          Instructions.toggle();
          break;
        case '+':
        case '=':
          WaveformViewer.zoomIn();
          break;
        case '-':
          WaveformViewer.zoomOut();
          break;
        case '?':
          toggleShortcutsPanel();
          break;
      }
    });
  }

  function toggleShortcutsPanel() {
    const panel = document.getElementById('shortcuts-panel');
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  }

  // ── Init ──
  document.addEventListener('DOMContentLoaded', init);

  return { getIndex };
})();

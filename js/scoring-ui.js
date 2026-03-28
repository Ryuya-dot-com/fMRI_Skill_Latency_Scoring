/**
 * scoring-ui.js - Scoring interface for fMRI naming task
 * Simplified accuracy (NR/0/1) + onset verification
 */
const ScoringUI = (() => {
  const NO_SPEECH_STATUSES = ['no_speech_true', 'no_speech_technical', 'no_speech_nonlexical', 'no_speech'];

  const ONSET_STATUS_LABELS = {
    confirmed: 'confirmed', corrected: 'corrected', manual: 'manual',
    no_speech_true: '真の無発話', no_speech_technical: 'Tech Failure',
    no_speech_nonlexical: '非語彙音のみ', no_speech: 'No Speech'
  };

  function isNoSpeechStatus(status) {
    return NO_SPEECH_STATUSES.includes(status);
  }

  let _currentTrial = null;
  let _currentParticipant = null;
  let _dataset = null;
  let _onScoreChanged = null;
  let _initialized = false;

  function init(onScoreChanged) {
    _onScoreChanged = onScoreChanged;
    if (!_initialized) {
      _initialized = true;
      setupScoreButtons();
      setupOnsetButtons();
      setupOnsetManualInput();
      setupOffsetManualInput();
      setupNotesField();
    }
  }

  function setupScoreButtons() {
    document.querySelectorAll('.btn-score').forEach(btn => {
      btn.addEventListener('click', () => {
        const raw = btn.dataset.score;
        const score = raw === 'NR' ? 'NR' : parseFloat(raw);
        setAccuracyScore(score);
      });
    });
  }

  function setupOnsetButtons() {
    document.querySelectorAll('.btn-onset').forEach(btn => {
      btn.addEventListener('click', () => {
        const status = btn.dataset.status;
        handleOnsetAction(status);
      });
    });
  }

  function setupOnsetManualInput() {
    const applyBtn = document.getElementById('onset-ms-apply');
    if (applyBtn) {
      applyBtn.addEventListener('click', () => {
        const input = document.getElementById('onset-ms-input');
        const ms = parseFloat(input.value);
        if (!isNaN(ms) && ms >= 0) {
          WaveformViewer.setOnsetMarker(ms);
          setOnsetStatus('manual');
        }
      });
    }
  }

  function setupOffsetManualInput() {
    const applyBtn = document.getElementById('offset-ms-apply');
    if (applyBtn) {
      applyBtn.addEventListener('click', () => {
        const input = document.getElementById('offset-ms-input');
        const ms = parseFloat(input.value);
        if (!isNaN(ms) && ms >= 0) {
          WaveformViewer.setOffsetMarker(ms);
          saveCurrentScore();
          if (_onScoreChanged) _onScoreChanged();
        }
      });
    }
  }

  function setupNotesField() {
    const textarea = document.getElementById('trial-notes');
    if (textarea) {
      textarea.addEventListener('input', () => {
        saveCurrentScore();
      });
    }
  }

  function setOnsetStatus(status) {
    highlightOnsetButton(status);
    saveCurrentScore();
    if (_onScoreChanged) _onScoreChanged();
  }

  function renderTrial(trial, participant, dataset) {
    _currentTrial = trial;
    _currentParticipant = participant;
    _dataset = dataset;

    const verbs = CsvLoader.getVerbs();
    const verbInfo = verbs[trial.pictureLabel] || {};

    // Word display: show verb label + sprang form
    const wordEl = document.getElementById('trial-word');
    wordEl.textContent = trial.sprangForm || trial.pictureLabel;

    // Details: session, repetition, Japanese meaning
    const detailsEl = document.getElementById('trial-details');
    const japanese = verbInfo.japanese || '';
    const sessionTrialNum = ((trial.trial - 1) % 60) + 1;
    detailsEl.innerHTML =
      `<span class="session-tag">Session ${trial.session}</span> ` +
      `<span class="trial-tag">Trial ${sessionTrialNum}/60</span> ` +
      `<span class="rep-tag">Rep ${trial.totalRepetition}/25</span> ` +
      `<span class="verb-label">${trial.pictureLabel}</span> ` +
      (japanese ? `<span class="ja-translation">${japanese}</span>` : '');

    // Stimulus image
    const imgContainer = document.getElementById('stimulus-image-container');
    if (trial.pictureLabel) {
      const img = document.getElementById('stimulus-image');
      img.src = `data/images/${trial.pictureLabel}.jpg`;
      img.alt = trial.pictureLabel;
      imgContainer.style.display = '';
    } else {
      imgContainer.style.display = 'none';
    }

    // Auto-detected onset info
    const autoOnsetEl = document.getElementById('auto-onset-value');
    autoOnsetEl.textContent = trial.onset_ms_from_recording_start != null
      ? trial.onset_ms_from_recording_start.toFixed(1)
      : 'N/A';

    // Auto-detected offset info (set after audio loads in app.js)
    const autoOffsetEl = document.getElementById('auto-offset-value');
    if (autoOffsetEl) autoOffsetEl.textContent = '--';

    const statusEl = document.getElementById('latency-status-display');
    statusEl.textContent = '--';
    statusEl.style.color = 'var(--text-muted)';

    // Score hint
    const hintEl = document.getElementById('score-hint');
    hintEl.textContent = `NR = 無回答, 0 = 不正確, 1 = 正確 (正解: ${trial.sprangForm})`;

    // Load existing score
    const existingScore = State.getScore(participant.id, trial.trial);
    if (existingScore) {
      highlightScoreButton(existingScore.accuracy);
      highlightOnsetButton(existingScore.onsetStatus);
      document.getElementById('trial-notes').value = existingScore.notes || '';
      document.getElementById('onset-ms-input').value =
        existingScore.onsetMs != null ? existingScore.onsetMs.toFixed(1) : '';
      const offsetInput = document.getElementById('offset-ms-input');
      if (offsetInput) offsetInput.value =
        existingScore.offsetMs != null ? existingScore.offsetMs.toFixed(1) : '';
      // Update status display
      if (existingScore.onsetStatus) {
        statusEl.textContent = ONSET_STATUS_LABELS[existingScore.onsetStatus] || existingScore.onsetStatus;
        statusEl.style.color = existingScore.onsetStatus === 'confirmed' ? 'var(--success)' : 'var(--warning)';
      }
    } else {
      clearScoreButtons();
      clearOnsetButtons();
      document.getElementById('trial-notes').value = '';
      document.getElementById('onset-ms-input').value =
        trial.onset_ms_from_recording_start != null ? trial.onset_ms_from_recording_start.toFixed(1) : '';
      const offsetInput = document.getElementById('offset-ms-input');
      if (offsetInput) offsetInput.value = '';
    }

    // Onset click-to-set mode
    WaveformViewer.enableClickToSet(false);
  }

  function setAccuracyScore(score) {
    highlightScoreButton(score);
    if (score === 'NR') {
      const currentStatus = getActiveOnsetStatus();
      if (!isNoSpeechStatus(currentStatus)) {
        handleOnsetAction('no_speech_true');
      }
    }
    saveCurrentScore();
    if (_onScoreChanged) _onScoreChanged();
  }

  function handleOnsetAction(status) {
    highlightOnsetButton(status);

    if (status === 'manual') {
      WaveformViewer.enableClickToSet(true);
    } else {
      WaveformViewer.enableClickToSet(false);
    }

    // Update status display
    const statusEl = document.getElementById('latency-status-display');
    if (statusEl) {
      statusEl.textContent = ONSET_STATUS_LABELS[status] || status;
      statusEl.style.color = status === 'confirmed' ? 'var(--success)' : 'var(--warning)';
    }

    saveCurrentScore();
    if (_onScoreChanged) _onScoreChanged();
  }

  function highlightScoreButton(score) {
    document.querySelectorAll('.btn-score').forEach(btn => {
      const raw = btn.dataset.score;
      const btnScore = raw === 'NR' ? 'NR' : parseFloat(raw);
      btn.classList.toggle('active', btnScore === score);
    });
  }

  function highlightOnsetButton(status) {
    document.querySelectorAll('.btn-onset').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.status === status);
    });
  }

  function clearScoreButtons() {
    document.querySelectorAll('.btn-score').forEach(btn => btn.classList.remove('active'));
  }

  function clearOnsetButtons() {
    document.querySelectorAll('.btn-onset').forEach(btn => btn.classList.remove('active'));
  }

  function getActiveScore() {
    const active = document.querySelector('.btn-score.active');
    if (!active) return null;
    const raw = active.dataset.score;
    return raw === 'NR' ? 'NR' : parseFloat(raw);
  }

  function getActiveOnsetStatus() {
    const active = document.querySelector('.btn-onset.active');
    return active ? active.dataset.status : null;
  }

  function saveCurrentScore() {
    if (!_currentTrial || !_currentParticipant) return;

    const accuracy = getActiveScore();
    const onsetStatus = getActiveOnsetStatus();
    const notes = document.getElementById('trial-notes').value;
    let onsetMs = WaveformViewer.getCurrentOnsetMs();

    if (isNoSpeechStatus(onsetStatus)) {
      onsetMs = null;
    }

    if (accuracy == null && onsetStatus == null) return;

    const offsetMs = WaveformViewer.getCurrentOffsetMs();

    State.setScore(_currentParticipant.id, _currentTrial.trial, {
      accuracy,
      onsetMs,
      offsetMs,
      onsetStatus,
      notes
    });
  }

  function scoreByKey(key) {
    if (key === '9') setAccuracyScore('NR');
    else if (key === '0') setAccuracyScore(0);
    else if (key === '1') setAccuracyScore(1);
  }

  function confirmOnset() {
    handleOnsetAction('confirmed');
  }

  return {
    init, renderTrial, setAccuracyScore, handleOnsetAction,
    saveCurrentScore, scoreByKey, confirmOnset, getActiveScore, getActiveOnsetStatus
  };
})();

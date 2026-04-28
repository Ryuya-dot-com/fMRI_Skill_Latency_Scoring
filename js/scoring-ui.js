/**
 * scoring-ui.js - Scoring interface for fMRI naming task
 * Simplified accuracy (NR/0/1) + onset verification
 */
const ScoringUI = (() => {
  const NO_SPEECH_STATUSES = ['no_speech_true', 'no_speech_technical', 'no_speech_nonlexical', 'no_speech'];

  const ONSET_STATUS_LABELS = {
    confirmed: 'confirmed', corrected: 'corrected', manual: 'manual',
    offset_manual: 'offset click',
    no_speech_true: '無発話', no_speech_technical: '機器不良',
    no_speech_nonlexical: '非語彙音', no_speech: 'No Speech'
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
      setupUtteranceControls();
      setupProductionFields();
      setupDoubleAnswerField();
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
    const clickBtn = document.getElementById('offset-click-set');
    if (clickBtn) {
      clickBtn.addEventListener('click', () => {
        setMarkerClickMode('offset', clickBtn.id);
      });
    }
  }

  function setupUtteranceControls() {
    const countSelect = document.getElementById('utterance-count');
    if (countSelect) {
      countSelect.addEventListener('change', () => {
        const count = getUtteranceCount();
        if (count < 2) {
          const da = document.getElementById('double-answer-code');
          if (da) da.value = '';
        }
        if (count < 2) {
          WaveformViewer.clearUtteranceMarkers();
          renderUtteranceControls(count, []);
        } else {
          const markers = ensureVisibleUtteranceMarkers(count);
          renderUtteranceControls(count, markers);
        }
        saveCurrentScore();
        if (_onScoreChanged) _onScoreChanged();
      });
    }

    const container = document.getElementById('utterance-marker-controls');
    if (container) {
      container.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-utterance-action]');
        if (!btn) return;

        const index = parseInt(btn.dataset.index, 10);
        const action = btn.dataset.utteranceAction;
        if (action === 'apply') {
          const input = document.getElementById(`utterance-ms-input-${index}`);
          const ms = input ? parseFloat(input.value) : NaN;
          if (!isNaN(ms) && ms >= 0) {
            WaveformViewer.setUtteranceMarker(index, ms);
            saveCurrentScore();
            if (_onScoreChanged) _onScoreChanged();
          }
        } else if (action === 'click') {
          setMarkerClickMode(`utterance:${index}`, btn.id);
        } else if (action === 'clear') {
          WaveformViewer.setUtteranceMarker(index, null);
          saveCurrentScore();
          if (_onScoreChanged) _onScoreChanged();
        } else if (action === 'copy_onset') {
          const ms = WaveformViewer.getCurrentUtteranceMarkersMs()[index];
          if (ms != null && !isNaN(ms)) {
            WaveformViewer.setOnsetMarker(ms);
            setOnsetStatus('manual');
          }
        }
      });
    }
  }

  function setupProductionFields() {
    const productionType = document.getElementById('production-type');
    if (productionType) {
      productionType.addEventListener('change', () => {
        const value = productionType.value;
        if (value === 'double_answer' || value === 'false_start' || value === 'self_correction') {
          ensureUtteranceCountAtLeast(2);
        }
        saveCurrentScore();
        if (_onScoreChanged) _onScoreChanged();
      });
    }

    const timingQuality = document.getElementById('timing-quality');
    if (timingQuality) {
      timingQuality.addEventListener('change', () => {
        saveCurrentScore();
        if (_onScoreChanged) _onScoreChanged();
      });
    }
  }

  function setupDoubleAnswerField() {
    const select = document.getElementById('double-answer-code');
    if (select) {
      select.addEventListener('change', () => {
        const code = select.value;
        if (code === 'DA_FC' || code === 'DA_SC') {
          highlightScoreButton(1);
          ensureUtteranceCountAtLeast(2);
          setProductionType('double_answer');
        } else if (code === 'DA_IC') {
          highlightScoreButton(0);
          ensureUtteranceCountAtLeast(2);
          setProductionType('double_answer');
        }
        saveCurrentScore();
        if (_onScoreChanged) _onScoreChanged();
      });
    }
  }

  function ensureUtteranceCountAtLeast(count) {
    const select = document.getElementById('utterance-count');
    if (!select) return;
    const current = getUtteranceCount();
    if (current >= count) return;
    select.value = String(count);
    const markers = ensureVisibleUtteranceMarkers(count);
    renderUtteranceControls(count, markers);
  }

  function setProductionType(value) {
    const select = document.getElementById('production-type');
    if (select) select.value = value;
  }

  function getUtteranceCount() {
    const el = document.getElementById('utterance-count');
    const count = el ? parseInt(el.value, 10) : 1;
    return Number.isFinite(count) ? Math.max(1, Math.min(4, count)) : 1;
  }

  function getScoreUtteranceMarkers(score) {
    if (!score) return [];
    if (Array.isArray(score.utteranceMarkersMs)) return score.utteranceMarkersMs;
    if (score.firstSpeechMs != null) return [score.firstSpeechMs];
    return [];
  }

  function renderUtteranceControls(count, markers) {
    const container = document.getElementById('utterance-marker-controls');
    if (!container) return;

    if (count < 2) {
      container.innerHTML = '';
      return;
    }

    const values = markers || [];
    container.innerHTML = Array.from({ length: count }, (_, index) => {
      const value = values[index] != null ? Number(values[index]).toFixed(1) : '';
      const n = index + 1;
      return `
        <div class="utterance-marker-row">
          <label for="utterance-ms-input-${index}">U${n} (ms):</label>
          <input type="number" id="utterance-ms-input-${index}" step="0.1" min="0" value="${value}">
          <button type="button" id="utterance-click-${index}" class="btn btn-sm btn-marker-click" data-utterance-action="click" data-index="${index}" title="波形クリックで U${n} を設定">U${n} Click</button>
          <button type="button" class="btn btn-sm" data-utterance-action="copy_onset" data-index="${index}">Set Onset</button>
          <button type="button" class="btn btn-sm" data-utterance-action="apply" data-index="${index}">Apply</button>
          <button type="button" class="btn btn-sm" data-utterance-action="clear" data-index="${index}">Clear</button>
        </div>
      `;
    }).join('');
  }

  function ensureVisibleUtteranceMarkers(count) {
    const markers = WaveformViewer.getCurrentUtteranceMarkersMs().slice(0, count);
    const onsetMs = WaveformViewer.getCurrentOnsetMs();
    const offsetMs = WaveformViewer.getCurrentOffsetMs();
    const startMs = onsetMs != null && !isNaN(onsetMs) ? onsetMs : 0;
    const hasSpeechWindow = offsetMs != null && !isNaN(offsetMs) && offsetMs > startMs;

    for (let i = 0; i < count; i++) {
      if (markers[i] != null && !isNaN(markers[i])) continue;
      if (hasSpeechWindow) {
        const fraction = i / count;
        markers[i] = startMs + (offsetMs - startMs) * fraction;
      } else {
        markers[i] = startMs + (i * 500);
      }
    }

    WaveformViewer.setUtteranceMarkers(markers);
    return markers;
  }

  function setupNotesField() {
    const textarea = document.getElementById('trial-notes');
    if (textarea) {
      textarea.addEventListener('input', () => {
        saveCurrentScore();
      });
    }
  }

  function setMarkerClickMode(mode, activeId) {
    WaveformViewer.enableClickToSet(mode);
    document.querySelectorAll('.btn-marker-click').forEach(btn => {
      btn.classList.toggle('active', btn.id === activeId);
    });
  }

  function clearMarkerClickButtons() {
    document.querySelectorAll('.btn-marker-click').forEach(btn => btn.classList.remove('active'));
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
      const utteranceCount = existingScore.utteranceCount || (existingScore.doubleAnswerCode ? 2 : 1);
      const utteranceCountEl = document.getElementById('utterance-count');
      if (utteranceCountEl) utteranceCountEl.value = String(utteranceCount);
      renderUtteranceControls(utteranceCount, getScoreUtteranceMarkers(existingScore));
      const offsetInput = document.getElementById('offset-ms-input');
      if (offsetInput) offsetInput.value =
        existingScore.offsetMs != null ? existingScore.offsetMs.toFixed(1) : '';
      const doubleAnswer = document.getElementById('double-answer-code');
      if (doubleAnswer) doubleAnswer.value = existingScore.doubleAnswerCode || '';
      const productionType = document.getElementById('production-type');
      if (productionType) productionType.value = existingScore.productionType || inferProductionType(existingScore);
      const timingQuality = document.getElementById('timing-quality');
      if (timingQuality) timingQuality.value = existingScore.timingQuality || 'clear';
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
      const utteranceCountEl = document.getElementById('utterance-count');
      if (utteranceCountEl) utteranceCountEl.value = '1';
      renderUtteranceControls(1, []);
      const offsetInput = document.getElementById('offset-ms-input');
      if (offsetInput) offsetInput.value = '';
      const doubleAnswer = document.getElementById('double-answer-code');
      if (doubleAnswer) doubleAnswer.value = '';
      const productionType = document.getElementById('production-type');
      if (productionType) productionType.value = 'single';
      const timingQuality = document.getElementById('timing-quality');
      if (timingQuality) timingQuality.value = 'clear';
    }

    // Onset click-to-set mode
    WaveformViewer.enableClickToSet(false);
    clearMarkerClickButtons();
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
      clearMarkerClickButtons();
      WaveformViewer.enableClickToSet('onset');
    } else if (status === 'offset_manual') {
      setMarkerClickMode('offset', 'offset-click-set');
    } else {
      WaveformViewer.enableClickToSet(false);
      clearMarkerClickButtons();
    }

    // Remove onset/offset markers when No Speech is selected
    if (isNoSpeechStatus(status)) {
      WaveformViewer.setOnsetMarker(null);
      WaveformViewer.setOffsetMarker(null);
      WaveformViewer.clearUtteranceMarkers();
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
    const doubleAnswerEl = document.getElementById('double-answer-code');
    const doubleAnswerCode = doubleAnswerEl ? doubleAnswerEl.value : '';
    const productionTypeEl = document.getElementById('production-type');
    const productionType = productionTypeEl ? productionTypeEl.value : 'single';
    const timingQualityEl = document.getElementById('timing-quality');
    const timingQuality = timingQualityEl ? timingQualityEl.value : 'clear';
    const utteranceCount = getUtteranceCount();
    let onsetMs = WaveformViewer.getCurrentOnsetMs();
    let utteranceMarkersMs = utteranceCount > 1
      ? WaveformViewer.getCurrentUtteranceMarkersMs().slice(0, utteranceCount)
      : [];
    let firstSpeechMs = utteranceMarkersMs[0] != null ? utteranceMarkersMs[0] : null;

    if (isNoSpeechStatus(onsetStatus)) {
      onsetMs = null;
      firstSpeechMs = null;
      utteranceMarkersMs = [];
    }

    const offsetMs = WaveformViewer.getCurrentOffsetMs();
    const hasData = accuracy != null || onsetStatus != null || notes.trim() ||
      doubleAnswerCode || productionType !== 'single' || timingQuality !== 'clear' ||
      utteranceCount !== 1 || onsetMs != null || firstSpeechMs != null || offsetMs != null;
    if (!hasData) return;

    State.setScore(_currentParticipant.id, _currentTrial.trial, {
      accuracy,
      onsetMs,
      firstSpeechMs,
      utteranceCount,
      utteranceMarkersMs,
      offsetMs,
      onsetStatus,
      productionType,
      timingQuality,
      doubleAnswerCode,
      notes
    });
  }

  function inferProductionType(score) {
    if (!score) return 'single';
    if (score.doubleAnswerCode) return 'double_answer';
    if (score.utteranceCount && score.utteranceCount > 1) return 'other';
    return 'single';
  }

  function getCurrentScoreSnapshot() {
    return {
      accuracy: getActiveScore(),
      onsetStatus: getActiveOnsetStatus(),
      onsetMs: WaveformViewer.getCurrentOnsetMs(),
      offsetMs: WaveformViewer.getCurrentOffsetMs(),
      utteranceCount: getUtteranceCount(),
      utteranceMarkersMs: WaveformViewer.getCurrentUtteranceMarkersMs(),
      productionType: document.getElementById('production-type')?.value || 'single',
      timingQuality: document.getElementById('timing-quality')?.value || 'clear'
    };
  }

  function getCompletionIssues() {
    const score = getCurrentScoreSnapshot();
    const issues = [];
    const isNR = score.accuracy === 'NR' || isNoSpeechStatus(score.onsetStatus);

    if (score.accuracy == null) issues.push('Accuracy');
    if (!isNR) {
      if (score.onsetMs == null) issues.push('Onset');
      if (score.offsetMs == null) issues.push('Offset');
      if (score.onsetMs != null && score.offsetMs != null && score.offsetMs < score.onsetMs) {
        issues.push('Offset < Onset');
      }
      if (score.utteranceCount > 1) {
        const missing = score.utteranceMarkersMs
          .slice(0, score.utteranceCount)
          .some(ms => ms == null || isNaN(ms));
        if (missing) issues.push('U markers');
      }
    }

    return issues;
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
    saveCurrentScore, scoreByKey, confirmOnset, getActiveScore, getActiveOnsetStatus,
    getCompletionIssues
  };
})();

/**
 * navigation.js - Trial/participant navigation for fMRI onset scorer
 * Sequential trial order (no shuffle), lazy CSV loading.
 */
const Navigation = (() => {
  let _dataset = null;
  let _participantIds = [];
  let _participantData = new Map();
  let _pIndex = 0;
  let _tIndex = 0;
  let _onNavigate = null;
  let _audioCache = new Map();
  let _pendingIncompleteKey = null;

  let _initialized = false;
  let _sessionFilter = null;   // null = all, 1-5 = specific session
  let _verbFilter = null;      // null = all, or verb label string
  let _filteredIndices = null;  // indices into participant.trials after filtering

  function init(dataset, participantIds, onNavigate) {
    _dataset = dataset;
    _participantIds = participantIds;
    _participantData.clear();
    _pIndex = 0;
    _tIndex = 0;
    _onNavigate = onNavigate;
    _sessionFilter = null;
    _verbFilter = null;
    _filteredIndices = null;

    if (!_initialized) {
      _initialized = true;
      document.getElementById('prev-trial').addEventListener('click', prevTrial);
      document.getElementById('next-trial').addEventListener('click', nextTrial);
      document.getElementById('prev-participant').addEventListener('click', prevParticipant);
      document.getElementById('next-participant').addEventListener('click', nextParticipant);
      document.getElementById('jump-unscored').addEventListener('click', jumpToUnscored);
    }
  }

  function setPosition(pIndex, tIndex) {
    _pIndex = pIndex;
    _tIndex = tIndex;
  }

  function setFilter(session, verb) {
    _sessionFilter = session;
    _verbFilter = verb;
    _filteredIndices = null; // invalidate cache
  }

  function getFilter() {
    return { session: _sessionFilter, verb: _verbFilter };
  }

  /**
   * Build filtered trial indices for a participant.
   */
  function buildFilteredIndices(participant) {
    if (!_sessionFilter && !_verbFilter) return null; // no filter
    const indices = [];
    participant.trials.forEach((t, i) => {
      if (_sessionFilter && t.session !== _sessionFilter) return;
      if (_verbFilter && t.pictureLabel !== _verbFilter) return;
      indices.push(i);
    });
    return indices;
  }

  function getFilteredTrialCount(participant) {
    if (!_sessionFilter && !_verbFilter) return participant.trials.length;
    const indices = buildFilteredIndices(participant);
    return indices.length;
  }

  /**
   * Navigate to a specific participant + trial index.
   * tIndex refers to position within filtered view if filter is active.
   */
  async function navigate(pIndex, tIndex) {
    _pendingIncompleteKey = null;
    const oldPIndex = _pIndex;
    _pIndex = pIndex;

    const pid = _participantIds[_pIndex];

    // Lazy load participant CSV if not cached
    if (!_participantData.has(pid)) {
      const participant = await CsvLoader.loadParticipant(_dataset.id, pid);
      _participantData.set(pid, participant);
    }

    // Clear audio cache on participant switch
    if (pIndex !== oldPIndex) {
      clearAudioCache();
    }

    const participant = _participantData.get(pid);

    // Build filtered indices
    _filteredIndices = buildFilteredIndices(participant);
    const trialCount = _filteredIndices ? _filteredIndices.length : participant.trials.length;

    // Clamp tIndex within filtered view
    _tIndex = Math.max(0, Math.min(tIndex, trialCount - 1));

    // Save position
    State.setPosition(_pIndex, _tIndex);
    updateIndicators();

    // Map filtered index to actual trial
    const actualIdx = _filteredIndices ? _filteredIndices[_tIndex] : _tIndex;
    const trial = participant.trials[actualIdx];

    if (_onNavigate) {
      _onNavigate(_pIndex, _tIndex, participant, trial);
    }

    // Preload audio for current session
    preloadSessionAudio(participant, actualIdx);

    // Preload next participant in background
    if (_pIndex + 1 < _participantIds.length) {
      const nextPid = _participantIds[_pIndex + 1];
      if (!_participantData.has(nextPid)) {
        CsvLoader.loadParticipant(_dataset.id, nextPid).then(p => {
          _participantData.set(nextPid, p);
        }).catch(() => {});
      }
    }
  }

  function getFilteredCount() {
    const p = getCurrentParticipant();
    if (!p) return 300;
    return _filteredIndices ? _filteredIndices.length : p.trials.length;
  }

  function nextTrial() {
    ScoringUI.saveCurrentScore();
    const participant = getCurrentParticipant();
    if (!participant) return;

    const currentTrial = getCurrentTrialForPosition(participant);
    const issues = ScoringUI.getCompletionIssues();
    const issueKey = currentTrial
      ? `${participant.id}_${currentTrial.trial}_${issues.join('|')}`
      : `${participant.id}_${_tIndex}_${issues.join('|')}`;
    if (issues.length && _pendingIncompleteKey !== issueKey) {
      _pendingIncompleteKey = issueKey;
      showIncompleteMessage(issues);
      return;
    }

    const count = getFilteredCount();
    if (_tIndex < count - 1) {
      navigate(_pIndex, _tIndex + 1);
    } else if (_pIndex < _participantIds.length - 1) {
      if (State.isParticipantComplete(participant.id, participant.trials)) {
        Export.showParticipantExportPopup(participant, _dataset);
      }
      navigate(_pIndex + 1, 0);
    }
  }

  function prevTrial() {
    ScoringUI.saveCurrentScore();
    if (_tIndex > 0) {
      navigate(_pIndex, _tIndex - 1);
    } else if (_pIndex > 0) {
      navigate(_pIndex - 1, 999); // will be clamped
    }
  }

  function nextParticipant() {
    ScoringUI.saveCurrentScore();
    const participant = getCurrentParticipant();
    if (participant && State.isParticipantComplete(participant.id, participant.trials)) {
      Export.showParticipantExportPopup(participant, _dataset);
    }
    if (_pIndex < _participantIds.length - 1) {
      navigate(_pIndex + 1, 0);
    }
  }

  function prevParticipant() {
    ScoringUI.saveCurrentScore();
    if (_pIndex > 0) {
      navigate(_pIndex - 1, 0);
    }
  }

  function jumpToUnscored() {
    ScoringUI.saveCurrentScore();
    const startP = _pIndex;
    const startT = _tIndex + 1;

    for (let pi = startP; pi < _participantIds.length; pi++) {
      const pid = _participantIds[pi];
      const p = _participantData.get(pid);
      if (!p) { navigate(pi, 0); return; }

      const tStart = (pi === startP) ? startT : 0;
      for (let ti = tStart; ti < p.trials.length; ti++) {
        const trial = p.trials[ti];
        const score = State.getScore(pid, trial.trial);
        if (!State.isScored(score)) {
          navigate(pi, ti);
          return;
        }
      }
    }

    // Wrap around
    for (let pi = 0; pi <= startP; pi++) {
      const pid = _participantIds[pi];
      const p = _participantData.get(pid);
      if (!p) { navigate(pi, 0); return; }

      const tEnd = (pi === startP) ? _tIndex : p.trials.length;
      for (let ti = 0; ti < tEnd; ti++) {
        const trial = p.trials[ti];
        const score = State.getScore(pid, trial.trial);
        if (!State.isScored(score)) {
          navigate(pi, ti);
          return;
        }
      }
    }

    // All trials scored — show message
    showAllScoredMessage();
  }

  function showAllScoredMessage() {
    const existing = document.querySelector('.all-scored-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'all-scored-toast';
    toast.textContent = '全試行の採点が完了しました';
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  function showIncompleteMessage(issues) {
    const existing = document.querySelector('.incomplete-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'all-scored-toast incomplete-toast';
    toast.textContent = `未入力または要確認: ${issues.join(', ')}。もう一度 Next/Enter で進みます。`;
    toast.style.background = 'var(--warning)';
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
  }

  function getCurrentParticipant() {
    const pid = _participantIds[_pIndex];
    return _participantData.get(pid) || null;
  }

  function getCurrentTrial() {
    const p = getCurrentParticipant();
    if (!p) return null;
    return getCurrentTrialForPosition(p);
  }

  function getCurrentTrialForPosition(participant) {
    const actualIdx = (_filteredIndices && participant) ? _filteredIndices[_tIndex] : _tIndex;
    return participant ? participant.trials[actualIdx] : null;
  }

  function updateIndicators() {
    const p = getCurrentParticipant();
    const count = getFilteredCount();
    const actualIdx = (_filteredIndices && p) ? _filteredIndices[_tIndex] : _tIndex;
    const trial = p ? p.trials[actualIdx] : null;
    const sessionInfo = trial ? ` (S${trial.session})` : '';
    const filterInfo = (_sessionFilter || _verbFilter) ? ' [filtered]' : '';

    document.getElementById('trial-indicator').textContent =
      `Trial ${_tIndex + 1}/${count}${sessionInfo}${filterInfo}`;
    document.getElementById('participant-indicator').textContent =
      `P ${_participantIds[_pIndex]} (${_pIndex + 1}/${_participantIds.length})`;
    updateProgress();
  }

  function updateProgress() {
    let totalTrials = 0;
    for (const pid of _participantIds) {
      const p = _participantData.get(pid);
      totalTrials += p ? p.trials.length : 300;
    }
    const scored = State.getTotalScoredCount();
    const pct = totalTrials > 0 ? (scored / totalTrials * 100) : 0;
    document.getElementById('progress-bar').style.width = `${pct}%`;
    document.getElementById('progress-text').textContent = `${scored} / ${totalTrials} scored`;
  }

  // ── Audio Preloading (session-scoped) ──

  function getAudioUrl(trial) {
    const cached = _audioCache.get(trial.audioFileNormalized);
    if (cached) return cached;
    const pid = _participantIds[_pIndex];
    return `data/${trial._audioPath}/${pid}/${trial.audioFileNormalized}`;
  }

  async function preloadSessionAudio(participant, currentIndex) {
    // Preload trials in the current session (60 trials around current position)
    const sessionStart = Math.floor(currentIndex / 60) * 60;
    const sessionEnd = Math.min(sessionStart + 60, participant.trials.length);

    const pid = participant.id;

    for (let i = sessionStart; i < sessionEnd; i++) {
      const trial = participant.trials[i];
      if (_audioCache.has(trial.audioFileNormalized)) continue;

      const url = `data/${trial._audioPath}/${pid}/${trial.audioFileNormalized}`;
      try {
        const resp = await fetch(url);
        if (resp.ok) {
          const blob = await resp.blob();
          _audioCache.set(trial.audioFileNormalized, URL.createObjectURL(blob));
        }
      } catch (e) {
        // Silent fail for preload
      }
    }
  }

  function clearAudioCache() {
    for (const [, url] of _audioCache) {
      if (url.startsWith('blob:')) URL.revokeObjectURL(url);
    }
    _audioCache.clear();
  }

  return {
    init, setPosition, navigate, nextTrial, prevTrial,
    nextParticipant, prevParticipant, jumpToUnscored,
    getCurrentParticipant, getCurrentTrial,
    updateIndicators, updateProgress, getAudioUrl, clearAudioCache,
    setFilter, getFilter, getFilteredCount
  };
})();

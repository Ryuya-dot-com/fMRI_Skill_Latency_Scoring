/**
 * state.js - localStorage persistence for fMRI onset scorer
 */
const State = (() => {
  let _state = null;
  let _saveTimeout = null;
  const STORAGE_PREFIX = 'fmriOnsetScorer_';

  function key(raterId, datasetId) {
    return `${STORAGE_PREFIX}${raterId}_${datasetId}`;
  }

  function create(raterId, datasetId, participantIds) {
    _state = {
      raterId,
      datasetId,
      assignedParticipants: participantIds,
      currentParticipantIndex: 0,
      currentTrialIndex: 0,
      scores: {},
      lastSaved: new Date().toISOString()
    };
    save();
    return _state;
  }

  function load(raterId, datasetId) {
    try {
      const data = localStorage.getItem(key(raterId, datasetId));
      if (data) {
        _state = JSON.parse(data);
        migrateScores();
        return _state;
      }
    } catch (e) {
      console.error('Failed to load state:', e);
    }
    return null;
  }

  /** Migrate old no_speech → no_speech_true for backward compatibility */
  function migrateScores() {
    if (!_state || !_state.scores) return;
    let migrated = 0;
    for (const k of Object.keys(_state.scores)) {
      if (_state.scores[k].onsetStatus === 'no_speech') {
        _state.scores[k].onsetStatus = 'no_speech_true';
        migrated++;
      }
    }
    if (migrated > 0) {
      console.log(`Migrated ${migrated} scores: no_speech → no_speech_true`);
      save();
    }
  }

  function get() { return _state; }

  function save() {
    if (!_state) return;
    _state.lastSaved = new Date().toISOString();
    try {
      localStorage.setItem(key(_state.raterId, _state.datasetId), JSON.stringify(_state));
    } catch (e) {
      console.error('Failed to save state:', e);
    }
  }

  function debouncedSave() {
    if (_saveTimeout) clearTimeout(_saveTimeout);
    _saveTimeout = setTimeout(save, 500);
  }

  function flushPendingSave() {
    if (_saveTimeout) {
      clearTimeout(_saveTimeout);
      _saveTimeout = null;
      save();
    }
  }

  // Flush pending saves on page unload / tab switch
  window.addEventListener('beforeunload', flushPendingSave);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPendingSave();
  });

  function setPosition(pIndex, tIndex) {
    if (!_state) return;
    _state.currentParticipantIndex = pIndex;
    _state.currentTrialIndex = tIndex;
    debouncedSave();
  }

  function getScore(participantId, trialNum) {
    if (!_state) return null;
    return _state.scores[`${participantId}_${trialNum}`] || null;
  }

  function setScore(participantId, trialNum, data) {
    if (!_state) return;
    const scoreKey = `${participantId}_${trialNum}`;
    _state.scores[scoreKey] = {
      ...(_state.scores[scoreKey] || {}),
      ...data,
      scoredAt: new Date().toISOString()
    };
    debouncedSave();
  }

  function isScored(score) {
    if (!score) return false;
    return score.accuracy != null || (score.onsetStatus != null && score.onsetStatus !== 'auto');
  }

  function getTotalScoredCount() {
    if (!_state) return 0;
    return Object.values(_state.scores).filter(isScored).length;
  }

  function getParticipantScoredCount(participantId, trials) {
    if (!_state || !trials) return 0;
    return trials.filter(t => {
      const s = _state.scores[`${participantId}_${t.trial}`];
      return isScored(s);
    }).length;
  }

  function isParticipantComplete(participantId, trials) {
    if (!trials || trials.length === 0) return false;
    return getParticipantScoredCount(participantId, trials) === trials.length;
  }

  // ── Session listing ──

  function listSessions() {
    const sessions = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith(STORAGE_PREFIX)) {
        try {
          const data = JSON.parse(localStorage.getItem(k));
          sessions.push(data);
        } catch (e) { /* skip */ }
      }
    }
    return sessions;
  }

  return {
    create, load, get, save, debouncedSave, flushPendingSave, setPosition,
    getScore, setScore, getTotalScoredCount, isScored,
    getParticipantScoredCount, isParticipantComplete,
    listSessions
  };
})();

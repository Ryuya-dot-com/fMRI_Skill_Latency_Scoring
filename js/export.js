/**
 * export.js - Export for fMRI onset scorer
 * Per-participant Excel, bulk CSV, and JSON backup.
 */
const Export = (() => {

  const _exportedPopups = new Set();
  const NO_SPEECH_STATUSES = ['no_speech_true', 'no_speech_technical', 'no_speech_nonlexical', 'no_speech'];
  const MIN_REVIEW_SPEECH_DURATION_MS = 250;
  const MAX_REVIEW_SPEECH_DURATION_MS = 3000;
  const MARKER_TOLERANCE_MS = 1;
  const ERROR_QA_FLAGS = new Set([
    'unscored',
    'missing_accuracy',
    'missing_onset',
    'missing_offset',
    'offset_before_onset',
    'offset_after_recording',
    'utterance_marker_missing',
    'utterance_marker_out_of_range',
    'utterance_marker_order',
    'utterance_marker_before_onset',
    'double_answer_code_missing'
  ]);

  function isNoSpeechStatus(status) {
    return NO_SPEECH_STATUSES.includes(status);
  }

  function isNoResponseScore(score) {
    return score.accuracy === 'NR' || isNoSpeechStatus(score.onsetStatus);
  }

  function isScored(score) {
    return !!score && (score.accuracy != null || (score.onsetStatus != null && score.onsetStatus !== 'auto'));
  }

  function getFirstSpeechMs(score, isNR) {
    if (isNR) return null;
    return score.onsetMs != null ? score.onsetMs : null;
  }

  function getAdditionalMarkerCount(score) {
    const count = score.utteranceCount || (score.doubleAnswerCode ? 2 : 1);
    return Math.max(0, Math.min(4, count) - 1);
  }

  function getAdditionalUtteranceMarkers(score, isNR) {
    if (isNR) return [];
    const markerCount = getAdditionalMarkerCount(score);
    if (markerCount === 0) return [];

    let markers = Array.isArray(score.utteranceMarkersMs) ? score.utteranceMarkersMs.slice() : [];
    if (markers.length > markerCount && score.onsetMs != null && Math.abs(markers[0] - score.onsetMs) < 5) {
      markers = markers.slice(1);
    }
    if (!markers.length && score.firstSpeechMs != null && score.onsetMs != null && Math.abs(score.firstSpeechMs - score.onsetMs) >= 5) {
      markers = [score.firstSpeechMs];
    }
    return markers.slice(0, markerCount);
  }

  function getUtteranceMarkers(score, isNR) {
    const firstSpeechMs = getFirstSpeechMs(score, isNR);
    const additionalMarkers = getAdditionalUtteranceMarkers(score, isNR);
    return firstSpeechMs != null ? [firstSpeechMs, ...additionalMarkers] : additionalMarkers;
  }

  function buildQaSummary(score, trial, isNR, timingFields) {
    const flags = [];
    const productionType = inferProductionType(score);
    const timingQuality = score.timingQuality || 'clear';
    const utteranceCount = score.utteranceCount || (score.doubleAnswerCode ? 2 : 1);
    const utteranceMarkers = getAdditionalUtteranceMarkers(score, isNR);
    const recordingEndMs = trial.recordingDurationS != null ? trial.recordingDurationS * 1000 : null;

    if (!isScored(score)) {
      flags.push('unscored');
    }

    if (score.accuracy == null && !isNoSpeechStatus(score.onsetStatus)) {
      flags.push('missing_accuracy');
    }

    if (score.accuracy === 'NR' && !isNoSpeechStatus(score.onsetStatus)) {
      flags.push('no_response_reason_missing');
    }

    if (isNoSpeechStatus(score.onsetStatus) && score.accuracy != null && score.accuracy !== 'NR') {
      flags.push('accuracy_not_nr_for_no_response');
    }

    if (!isNR) {
      if (score.onsetMs == null) flags.push('missing_onset');
      if (score.offsetMs == null) flags.push('missing_offset');
      if (timingFields.timing_issue) flags.push(timingFields.timing_issue);

      if (score.onsetMs != null && (!score.onsetStatus || score.onsetStatus === 'auto')) {
        flags.push('onset_unconfirmed');
      }
      if (score.offsetMs != null && (!score.offsetStatus || score.offsetStatus === 'auto')) {
        flags.push('offset_unconfirmed');
      }
      if ((score.onsetStatus === 'auto' || score.offsetStatus === 'auto') &&
          score.autoTimingQuality && score.autoTimingQuality !== 'ok') {
        flags.push(`auto_timing_${score.autoTimingQuality}`);
      }
      if ((score.onsetStatus === 'auto' || score.offsetStatus === 'auto') && score.autoTimingIssue) {
        flags.push(`auto_${score.autoTimingIssue}`);
      }

      if (score.onsetMs != null && trial.stimDurationS != null && score.onsetMs > trial.stimDurationS * 1000) {
        flags.push('onset_after_stimulus_window');
      }

      if (timingFields.timing_valid === 1 && timingFields.speech_duration_ms_rater !== '') {
        const durationMs = Number(timingFields.speech_duration_ms_rater);
        if (durationMs < MIN_REVIEW_SPEECH_DURATION_MS) {
          flags.push('speech_duration_short');
        }
        if (durationMs > MAX_REVIEW_SPEECH_DURATION_MS) {
          flags.push('speech_duration_long');
        }
      }

      if (utteranceCount > 1) {
        const markerCount = getAdditionalMarkerCount(score);
        const markers = utteranceMarkers.slice(0, markerCount);
        if (markers.length < markerCount || markers.some(ms => ms == null || isNaN(ms))) {
          flags.push('utterance_marker_missing');
        }
        const numericMarkers = [score.onsetMs, ...markers].filter(ms => ms != null && !isNaN(ms));
        if (recordingEndMs != null && numericMarkers.some(ms => ms < 0 || ms > recordingEndMs)) {
          flags.push('utterance_marker_out_of_range');
        }
        for (let i = 1; i < numericMarkers.length; i++) {
          if (numericMarkers[i] + MARKER_TOLERANCE_MS < numericMarkers[i - 1]) {
            flags.push('utterance_marker_order');
            break;
          }
        }
        if (score.onsetMs != null && markers.some(ms => ms != null && !isNaN(ms) && ms <= score.onsetMs + MARKER_TOLERANCE_MS)) {
          flags.push('utterance_marker_before_onset');
        }
        if (productionType === 'single') {
          flags.push('multi_utterance_single_type');
        }
      }

      if (productionType === 'double_answer' && !score.doubleAnswerCode) {
        flags.push('double_answer_code_missing');
      }
      if (score.doubleAnswerCode && productionType !== 'double_answer') {
        flags.push('double_answer_code_type_mismatch');
      }
    }

    if (timingQuality !== 'clear') {
      flags.push(`timing_quality_${timingQuality}`);
    }

    const uniqueFlags = Array.from(new Set(flags));
    const qaSeverity = uniqueFlags.some(flag => ERROR_QA_FLAGS.has(flag)) ? 'error' :
      (uniqueFlags.length ? 'review' : 'ok');

    return {
      qa_severity: qaSeverity,
      qa_flag_count: uniqueFlags.length,
      qa_flags: uniqueFlags.join(';')
    };
  }

  function roundMs(ms) {
    return Math.round(ms * 1000) / 1000;
  }

  function roundMsOrBlank(ms) {
    return ms != null && !isNaN(ms) ? roundMs(ms) : '';
  }

  function deltaMsOrBlank(raterMs, autoMs) {
    return raterMs != null && !isNaN(raterMs) && autoMs != null && !isNaN(autoMs)
      ? roundMs(raterMs - autoMs)
      : '';
  }

  function roundSec(ms) {
    return Math.round((ms / 1000) * 1000000) / 1000000;
  }

  function buildTimingFields(score, trial, isNR) {
    const onsetMs = score.onsetMs;
    const offsetMs = score.offsetMs;
    const recordingEndMs = trial.recordingDurationS != null ? trial.recordingDurationS * 1000 : null;
    const blank = {
      pre_speech_onset_s: '',
      pre_speech_duration_s: '',
      speech_onset_s_rater: '',
      speech_duration_s_rater: '',
      post_speech_onset_s: '',
      post_speech_duration_s: '',
      speech_duration_ms_rater: '',
      timing_valid: '',
      timing_issue: ''
    };

    if (isNR) {
      return { ...blank, timing_valid: 0, timing_issue: 'no_response' };
    }
    if (onsetMs == null && offsetMs == null) {
      return blank;
    }
    if (onsetMs == null) {
      return { ...blank, timing_valid: 0, timing_issue: 'missing_onset' };
    }
    if (offsetMs == null) {
      return { ...blank, timing_valid: 0, timing_issue: 'missing_offset' };
    }

    const speechDurationMs = offsetMs - onsetMs;
    if (speechDurationMs < 0) {
      return { ...blank, timing_valid: 0, timing_issue: 'offset_before_onset' };
    }
    if (recordingEndMs != null && offsetMs > recordingEndMs) {
      return { ...blank, timing_valid: 0, timing_issue: 'offset_after_recording' };
    }

    const postDurationMs = recordingEndMs != null ? Math.max(0, recordingEndMs - offsetMs) : null;
    return {
      pre_speech_onset_s: 0,
      pre_speech_duration_s: roundSec(onsetMs),
      speech_onset_s_rater: roundSec(onsetMs),
      speech_duration_s_rater: roundSec(speechDurationMs),
      post_speech_onset_s: roundSec(offsetMs),
      post_speech_duration_s: postDurationMs != null ? roundSec(postDurationMs) : '',
      speech_duration_ms_rater: roundMs(speechDurationMs),
      timing_valid: 1,
      timing_issue: ''
    };
  }

  function inferProductionType(score) {
    if (!score) return 'single';
    if (score.productionType) return score.productionType;
    if (score.doubleAnswerCode) return 'double_answer';
    if (score.utteranceCount && score.utteranceCount > 1) return 'other';
    return 'single';
  }

  function generateParticipantRows(participant, dataset, state) {
    return participant.trials.map(trial => {
      const scoreKey = `${participant.id}_${trial.trial}`;
      const score = state.scores[scoreKey] || {};
      const isNR = isNoResponseScore(score);
      const timingFields = buildTimingFields(score, trial, isNR);
      const qaSummary = buildQaSummary(score, trial, isNR, timingFields);
      const firstSpeechMs = getFirstSpeechMs(score, isNR);
      const utteranceMarkers = getUtteranceMarkers(score, isNR);
      const roundedUtteranceMarkers = utteranceMarkers
        .map(ms => ms != null ? Math.round(ms * 1000) / 1000 : '')
        .filter(ms => ms !== '');

      return {
        rater_id: state.raterId,
        participant_id: participant.id,
        trial: trial.trial,
        session: trial.session,
        session_trial: trial.sessionTrial != null ? trial.sessionTrial : '',
        trial_index: trial.trialIndex != null ? trial.trialIndex : '',
        trial_type: trial.trialType || '',
        picture_type: trial.pictureType,
        picture_label: trial.pictureLabel,
        sprang_form: trial.sprangForm,
        suffix: trial.suffix || '',
        suffix_label: trial.suffixLabel || '',
        rule_type: trial.ruleType || '',
        rule_id: trial.ruleId != null ? trial.ruleId : '',
        stim_onset_s: trial.stimOnsetS != null ? trial.stimOnsetS : '',
        stim_duration_s: trial.stimDurationS != null ? trial.stimDurationS : '',
        repetition: trial.repetition,
        total_repetition: trial.totalRepetition,
        item_repetition: trial.itemRepetition != null ? trial.itemRepetition : '',
        rule_repetition: trial.ruleRepetition != null ? trial.ruleRepetition : '',
        accuracy_score: score.accuracy != null ? score.accuracy : '',
        production_type: inferProductionType(score),
        timing_quality: score.timingQuality || 'clear',
        utterance_count: score.utteranceCount != null ? score.utteranceCount : '',
        utterance_onsets_ms: (!isNR && roundedUtteranceMarkers.length) ? roundedUtteranceMarkers.join(';') : '',
        onset_ms_rater: (!isNR && score.onsetMs != null) ? Math.round(score.onsetMs * 1000) / 1000 : '',
        first_speech_ms_rater: firstSpeechMs != null ? Math.round(firstSpeechMs * 1000) / 1000 : '',
        onset_status: score.onsetStatus || '',
        offset_ms_rater: (!isNR && score.offsetMs != null) ? Math.round(score.offsetMs * 1000) / 1000 : '',
        offset_status: (!isNR && score.offsetStatus) ? score.offsetStatus : '',
        auto_onset_ms: roundMsOrBlank(score.autoOnsetMs),
        auto_offset_ms: roundMsOrBlank(score.autoOffsetMs),
        onset_auto_delta_ms: (!isNR) ? deltaMsOrBlank(score.onsetMs, score.autoOnsetMs) : '',
        offset_auto_delta_ms: (!isNR) ? deltaMsOrBlank(score.offsetMs, score.autoOffsetMs) : '',
        auto_timing_quality: score.autoTimingQuality || '',
        auto_timing_issue: score.autoTimingIssue || '',
        ...timingFields,
        ...qaSummary,
        double_answer_code: score.doubleAnswerCode || '',
        audio_file: trial.audioFile || '',
        recording_duration_s: trial.recordingDurationS != null ? trial.recordingDurationS : '',
        duration_for_fmri_s: trial.durationForFmriS != null ? trial.durationForFmriS : '',
        log_file: trial.logFile || '',
        jitter_ms: trial.jitterMs != null ? trial.jitterMs : '',
        notes: score.notes || '',
        scored_at: score.scoredAt || ''
      };
    }).sort((a, b) => a.trial - b.trial);
  }

  function downloadParticipantExcel(participant, dataset) {
    const state = State.get();
    if (!state) return;

    const rows = generateParticipantRows(participant, dataset, state);
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'Scoring');

    const filename = `onset_scoring_${state.raterId}_${participant.id}.xlsx`;
    XLSX.writeFile(wb, filename);
  }

  function showParticipantExportPopup(participant, dataset) {
    const popupKey = `${participant.id}`;
    if (_exportedPopups.has(popupKey)) return;
    _exportedPopups.add(popupKey);

    const overlay = document.createElement('div');
    overlay.className = 'export-popup-overlay';
    overlay.innerHTML = `
      <div class="export-popup">
        <h3>Participant ${participant.id} Complete</h3>
        <p>All ${participant.trials.length} trials scored. Download results?</p>
        <div class="export-popup-buttons">
          <button class="btn btn-primary export-popup-download">Download .xlsx</button>
          <button class="btn export-popup-skip">Skip</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('.export-popup-download').addEventListener('click', () => {
      downloadParticipantExcel(participant, dataset);
      overlay.remove();
    });
    overlay.querySelector('.export-popup-skip').addEventListener('click', () => {
      overlay.remove();
    });
  }

  // ── Bulk export (all participants, CSV) ──

  async function exportAllCSV(dataset) {
    const state = State.get();
    if (!state) return;

    const headers = [
      'rater_id', 'participant_id', 'trial', 'session', 'session_trial',
      'trial_index', 'trial_type', 'picture_type', 'picture_label', 'sprang_form',
      'suffix', 'suffix_label', 'rule_type', 'rule_id',
      'stim_onset_s', 'stim_duration_s',
      'repetition', 'total_repetition', 'item_repetition', 'rule_repetition',
      'accuracy_score', 'production_type', 'timing_quality',
      'utterance_count', 'utterance_onsets_ms',
      'onset_ms_rater', 'first_speech_ms_rater', 'onset_status',
      'offset_ms_rater', 'offset_status',
      'auto_onset_ms', 'auto_offset_ms', 'onset_auto_delta_ms', 'offset_auto_delta_ms',
      'auto_timing_quality', 'auto_timing_issue',
      'pre_speech_onset_s', 'pre_speech_duration_s',
      'speech_onset_s_rater', 'speech_duration_s_rater',
      'post_speech_onset_s', 'post_speech_duration_s',
      'speech_duration_ms_rater', 'timing_valid', 'timing_issue',
      'qa_severity', 'qa_flag_count', 'qa_flags',
      'double_answer_code',
      'audio_file', 'recording_duration_s', 'duration_for_fmri_s', 'log_file',
      'jitter_ms', 'notes', 'scored_at'
    ];

    const csvRows = [headers.join(',')];

    for (const pid of state.assignedParticipants) {
      // Load participant data to get trial details
      let participant;
      try {
        participant = await CsvLoader.loadParticipant(dataset.id, pid);
      } catch (e) {
        console.warn(`Failed to load participant ${pid} for export`);
        continue;
      }

      const rows = generateParticipantRows(participant, dataset, state);
      for (const row of rows) {
        csvRows.push(headers.map(h => {
          const val = row[h];
          if (val === '' || val == null) return '';
          return escapeCSV(String(val));
        }).join(','));
      }
    }

    const csv = csvRows.join('\n');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadBlob(csv, `onset_scoring_${state.raterId}_${ts}.csv`, 'text/csv');
  }

  function generateEventRows(participant, dataset, state) {
    const rows = [];
    for (const trial of participant.trials) {
      const scoreKey = `${participant.id}_${trial.trial}`;
      const score = state.scores[scoreKey] || {};
      const isNR = isNoResponseScore(score);
      const timing = buildTimingFields(score, trial, isNR);
      const qaSummary = buildQaSummary(score, trial, isNR, timing);
      const productionType = inferProductionType(score);
      const timingQuality = score.timingQuality || 'clear';
      const base = {
        rater_id: state.raterId,
        participant_id: participant.id,
        trial: trial.trial,
        session: trial.session,
        session_trial: trial.sessionTrial != null ? trial.sessionTrial : '',
        picture_label: trial.pictureLabel,
        sprang_form: trial.sprangForm,
        accuracy_score: score.accuracy != null ? score.accuracy : '',
        production_type: productionType,
        timing_quality: timingQuality,
        double_answer_code: score.doubleAnswerCode || '',
        onset_status: (!isNR && score.onsetStatus) ? score.onsetStatus : '',
        offset_status: (!isNR && score.offsetStatus) ? score.offsetStatus : '',
        auto_onset_ms: roundMsOrBlank(score.autoOnsetMs),
        auto_offset_ms: roundMsOrBlank(score.autoOffsetMs),
        timing_valid: timing.timing_valid,
        timing_issue: timing.timing_issue,
        qa_severity: qaSummary.qa_severity,
        qa_flags: qaSummary.qa_flags,
        audio_file: trial.audioFile || '',
        notes: score.notes || ''
      };

      const addEvent = (eventType, eventIndex, onsetS, durationS, source) => {
        rows.push({
          ...base,
          event_type: eventType,
          event_index: eventIndex,
          onset_s: onsetS,
          duration_s: durationS,
          source
        });
      };

      const utteranceMarkers = getUtteranceMarkers(score, isNR);
      if (!isNR) {
        utteranceMarkers.forEach((ms, index) => {
          if (ms != null && !isNaN(ms)) {
            addEvent('utterance_start', index + 1, roundSec(ms), 0, `U${index + 1}`);
          }
        });
      }

      if (timing.timing_valid === 1) {
        addEvent('pre_speech', 1, timing.pre_speech_onset_s, timing.pre_speech_duration_s, 'onset_ms_rater');
        addEvent('speech', 1, timing.speech_onset_s_rater, timing.speech_duration_s_rater, 'onset_offset_rater');
        if (timing.post_speech_duration_s !== '') {
          addEvent('post_speech', 1, timing.post_speech_onset_s, timing.post_speech_duration_s, 'offset_recording_duration');
        }
      } else if (isNR && trial.recordingDurationS != null) {
        addEvent('no_response', 1, 0, trial.recordingDurationS, 'recording_duration');
      } else if (timing.timing_issue) {
        addEvent('timing_issue', 1, '', '', timing.timing_issue);
      }
    }
    return rows;
  }

  async function exportEventsCSV(dataset) {
    const state = State.get();
    if (!state) return;

    const headers = [
      'rater_id', 'participant_id', 'trial', 'session', 'session_trial',
      'picture_label', 'sprang_form', 'accuracy_score', 'production_type',
      'timing_quality', 'double_answer_code', 'onset_status', 'offset_status',
      'auto_onset_ms', 'auto_offset_ms', 'event_type', 'event_index',
      'onset_s', 'duration_s', 'source', 'timing_valid', 'timing_issue',
      'qa_severity', 'qa_flags', 'audio_file', 'notes'
    ];

    const csvRows = [headers.join(',')];
    for (const pid of state.assignedParticipants) {
      let participant;
      try {
        participant = await CsvLoader.loadParticipant(dataset.id, pid);
      } catch (e) {
        console.warn(`Failed to load participant ${pid} for events export`);
        continue;
      }

      const rows = generateEventRows(participant, dataset, state);
      for (const row of rows) {
        csvRows.push(headers.map(h => {
          const val = row[h];
          if (val === '' || val == null) return '';
          return escapeCSV(String(val));
        }).join(','));
      }
    }

    const csv = csvRows.join('\n');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadBlob(csv, `onset_events_${state.raterId}_${ts}.csv`, 'text/csv');
  }

  async function exportQACSV(dataset) {
    const state = State.get();
    if (!state) return;

    const headers = [
      'rater_id', 'participant_id', 'trial', 'session', 'session_trial',
      'picture_label', 'sprang_form', 'accuracy_score', 'production_type',
      'timing_quality', 'double_answer_code', 'onset_status', 'offset_status',
      'utterance_count', 'utterance_onsets_ms',
      'onset_ms_rater', 'first_speech_ms_rater', 'offset_ms_rater',
      'auto_onset_ms', 'auto_offset_ms', 'onset_auto_delta_ms', 'offset_auto_delta_ms',
      'auto_timing_quality', 'auto_timing_issue',
      'speech_duration_ms_rater', 'timing_valid', 'timing_issue',
      'qa_severity', 'qa_flag_count', 'qa_flags',
      'audio_file', 'notes', 'scored_at'
    ];

    const csvRows = [headers.join(',')];
    for (const pid of state.assignedParticipants) {
      let participant;
      try {
        participant = await CsvLoader.loadParticipant(dataset.id, pid);
      } catch (e) {
        console.warn(`Failed to load participant ${pid} for QA export`);
        continue;
      }

      const rows = generateParticipantRows(participant, dataset, state)
        .filter(row => row.qa_flags);
      for (const row of rows) {
        csvRows.push(headers.map(h => {
          const val = row[h];
          if (val === '' || val == null) return '';
          return escapeCSV(String(val));
        }).join(','));
      }
    }

    const csv = csvRows.join('\n');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadBlob(csv, `onset_qa_${state.raterId}_${ts}.csv`, 'text/csv');
  }

  function exportJSON() {
    const state = State.get();
    if (!state) return;
    const json = JSON.stringify({
      exportVersion: '2.3.0',
      exportedAt: new Date().toISOString(),
      raterId: state.raterId,
      datasetId: state.datasetId,
      totalScored: Object.keys(state.scores).length,
      assignedParticipants: state.assignedParticipants,
      scores: state.scores
    }, null, 2);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadBlob(json, `onset_scoring_${state.raterId}_${ts}.json`, 'application/json');
  }

  function escapeCSV(val) {
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  function downloadBlob(content, filename, mimeType) {
    // Add UTF-8 BOM for CSV/text files to prevent mojibake in Excel
    const bom = (mimeType === 'text/csv') ? '\uFEFF' : '';
    const blob = new Blob([bom + content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function exportCurrentParticipant(dataset) {
    const participant = Navigation.getCurrentParticipant();
    if (participant) {
      downloadParticipantExcel(participant, dataset);
    }
  }

  return {
    showParticipantExportPopup, downloadParticipantExcel,
    exportCurrentParticipant, exportAllCSV, exportEventsCSV, exportQACSV, exportJSON
  };
})();

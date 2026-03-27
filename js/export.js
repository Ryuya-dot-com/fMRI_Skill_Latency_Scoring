/**
 * export.js - Export for fMRI onset scorer
 * Per-participant Excel, bulk CSV, and JSON backup.
 */
const Export = (() => {

  const _exportedPopups = new Set();

  function generateParticipantRows(participant, dataset, state) {
    return participant.trials.map(trial => {
      const scoreKey = `${participant.id}_${trial.trial}`;
      const score = state.scores[scoreKey] || {};
      const isNR = score.accuracy === 'NR';

      return {
        rater_id: state.raterId,
        participant_id: participant.id,
        trial: trial.trial,
        session: trial.session,
        picture_type: trial.pictureType,
        picture_label: trial.pictureLabel,
        sprang_form: trial.sprangForm,
        repetition: trial.repetition,
        total_repetition: trial.totalRepetition,
        accuracy_score: score.accuracy != null ? score.accuracy : '',
        onset_ms_rater: (!isNR && score.onsetMs != null) ? Math.round(score.onsetMs * 1000) / 1000 : '',
        onset_status: score.onsetStatus || '',
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
        <h3>Participant ${participant.id} 採点完了</h3>
        <p>全${participant.trials.length}試行の採点が完了しました。結果をダウンロードしますか？</p>
        <div class="export-popup-buttons">
          <button class="btn btn-primary export-popup-download">Download .xlsx</button>
          <button class="btn export-popup-skip">スキップ</button>
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
      'rater_id', 'participant_id', 'trial', 'session',
      'picture_type', 'picture_label', 'sprang_form',
      'repetition', 'total_repetition',
      'accuracy_score', 'onset_ms_rater', 'onset_status',
      'jitter_ms',
      'notes', 'scored_at'
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
        csvRows.push([
          escapeCSV(row.rater_id),
          escapeCSV(row.participant_id),
          row.trial,
          row.session,
          row.picture_type,
          escapeCSV(row.picture_label),
          escapeCSV(row.sprang_form),
          row.repetition,
          row.total_repetition,
          row.accuracy_score !== '' ? row.accuracy_score : '',
          row.onset_ms_rater !== '' ? row.onset_ms_rater : '',
          escapeCSV(row.onset_status),
          row.jitter_ms !== '' ? row.jitter_ms : '',
          escapeCSV(row.notes),
          escapeCSV(row.scored_at)
        ].join(','));
      }
    }

    const csv = csvRows.join('\n');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadBlob(csv, `onset_scoring_${state.raterId}_${ts}.csv`, 'text/csv');
  }

  function exportJSON() {
    const state = State.get();
    if (!state) return;
    const json = JSON.stringify({
      exportVersion: '2.0.0',
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
    const blob = new Blob([content], { type: mimeType });
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
    exportCurrentParticipant, exportAllCSV, exportJSON
  };
})();

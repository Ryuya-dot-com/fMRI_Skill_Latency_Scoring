/**
 * csv-loader.js - Browser-side CSV loading for fMRI naming task
 */
const CsvLoader = (() => {
  let _index = null;
  const _cache = new Map();

  async function loadIndex() {
    const resp = await fetch('data/participants.json');
    if (!resp.ok) throw new Error('Failed to load participants.json');
    _index = await resp.json();
    return _index;
  }

  function getIndex() { return _index; }

  function getDataset(datasetId) {
    if (!_index) return null;
    return _index.datasets.find(d => d.id === datasetId);
  }

  function getVerbs() {
    return _index ? _index.verbs : {};
  }

  /**
   * Load and parse a single participant's CSV.
   * Returns { id, trials, trialCount }.
   */
  async function loadParticipant(datasetId, participantId) {
    const cacheKey = `${datasetId}/${participantId}`;
    if (_cache.has(cacheKey)) return _cache.get(cacheKey);

    const ds = getDataset(datasetId);
    if (!ds) throw new Error(`Dataset not found: ${datasetId}`);

    const csvUrl = `data/${ds.csvPath}/${participantId}/results_${participantId}.csv`;
    const resp = await fetch(csvUrl);
    if (!resp.ok) throw new Error(`Failed to load CSV: ${csvUrl}`);
    const text = await resp.text();

    const rows = parseCSV(text);
    const trials = rows.map(row => buildFmriNamingTrial(row, participantId, ds))
      .sort((a, b) => a.trial - b.trial);

    const participant = { id: participantId, trials, trialCount: trials.length };
    _cache.set(cacheKey, participant);
    return participant;
  }

  function evict(datasetId, participantId) {
    _cache.delete(`${datasetId}/${participantId}`);
  }

  function clearCache() {
    _cache.clear();
  }

  // ── CSV Parsing ──

  function parseCSV(text) {
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length < 2) return [];
    const headers = lines[0].split(',').map(h => h.trim());
    return lines.slice(1).map(line => {
      const values = line.split(',');
      const row = {};
      headers.forEach((h, i) => { row[h] = (values[i] || '').trim(); });
      return row;
    });
  }

  function safeFloat(val) {
    if (val === '' || val === undefined || val === null) return null;
    const n = parseFloat(val);
    return isNaN(n) ? null : n;
  }

  function safeInt(val) {
    if (val === '' || val === undefined || val === null) return null;
    const n = parseInt(val);
    return isNaN(n) ? null : n;
  }

  function buildFmriNamingTrial(row, participantId, dataset) {
    const audioFile = row.audio_file || '';
    return {
      trial: safeInt(row.trial),
      session: safeInt(row.session),
      pictureType: safeInt(row.picture_type),
      pictureLabel: row.picture_label || '',
      sprangForm: row.sprang_form || '',
      repetition: safeInt(row.repetition),
      totalRepetition: safeInt(row.total_repetition),
      audioFile: audioFile,
      audioFileNormalized: audioFile.replace(/\.wav$/i, '.mp3'),
      jitterMs: safeFloat(row.jitter_ms),
      onset_ms_from_recording_start: null,
      _audioPath: dataset.audioPath
    };
  }

  return { loadIndex, getIndex, getDataset, getVerbs, loadParticipant, evict, clearCache };
})();

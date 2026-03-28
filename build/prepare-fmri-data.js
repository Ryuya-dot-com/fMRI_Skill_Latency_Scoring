#!/usr/bin/env node
/**
 * prepare-fmri-data.js
 * Prepares fMRI naming task data for the Voice Onset Scorer.
 *
 * Data source: Data_Audio/Results_XXXX/ containing:
 *   - SubXXXX_stimulus_plan.tsv (300 trials: picture type + jitter)
 *   - SubXXXX_results.csv (partial — typically only last session)
 *   - SubXXXX_001_verb.wav ... SubXXXX_300_verb.wav (audio recordings)
 *
 * Since the CSV only has the last session's data, we reconstruct all 300 trials
 * from the stimulus plan TSV + audio file names on disk.
 *
 * Usage:
 *   node build/prepare-fmri-data.js                # index + CSV + images only
 *   node build/prepare-fmri-data.js --with-audio   # also convert WAV→MP3
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJ_ROOT = path.resolve(__dirname, '../../');
const DATA_AUDIO = path.join(PROJ_ROOT, 'Data_Audio');
const STIMULI_SRC = path.join(PROJ_ROOT, '../Presentation/Stimuli');
const ANALYSIS_EVENTS = path.join(__dirname, '..', 'Analysis_Latency', 'analysis_events_table.csv');
const SITE_ROOT = path.resolve(__dirname, '..');
const DATA_OUT = path.join(SITE_ROOT, 'data');

const WITH_AUDIO = process.argv.includes('--with-audio');
const TRIALS_PER_SESSION = 60;

// ── Verb definitions (from Presentation scenario) ──
const VERBS = {
  avanzar:  { japanese: '電話する', sprang: 'avanziando',  pictureType: 1 },
  comenzas: { japanese: '笑う',     sprang: 'camenziando', pictureType: 2 },
  definis:  { japanese: '泣く',     sprang: 'dofiniondo',  pictureType: 3 },
  deprimir: { japanese: '走る',     sprang: 'deprimiondo', pictureType: 4 },
  dominas:  { japanese: '食べる',   sprang: 'damitiando',  pictureType: 5 },
  gustar:   { japanese: '跳ねる',   sprang: 'gustiando',   pictureType: 6 },
  impedir:  { japanese: '歌う',     sprang: 'impediondo',  pictureType: 7 },
  lavar:    { japanese: '寝る',     sprang: 'laviando',    pictureType: 8 },
  montas:   { japanese: '咳をする', sprang: 'mantiando',   pictureType: 9 },
  partir:   { japanese: '掃除をする', sprang: 'partiondo', pictureType: 10 },
  recibis:  { japanese: '踊る',     sprang: 'rocibiondo',  pictureType: 11 },
  sentis:   { japanese: '読む',     sprang: 'sontiondo',   pictureType: 12 }
};

// Reverse lookup: pictureType → verb label
const PICTURE_TYPE_TO_LABEL = {};
for (const [label, info] of Object.entries(VERBS)) {
  PICTURE_TYPE_TO_LABEL[info.pictureType] = label;
}

// ── Analysis events table ──

function parseCSVFile(text) {
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

/**
 * Load analysis_events_table.csv and index by subject_id + global_trial.
 * Returns a Map: "pid_trial" → row object with all columns.
 */
function loadAnalysisEvents() {
  if (!fs.existsSync(ANALYSIS_EVENTS)) {
    console.warn(`  WARNING: analysis_events_table.csv not found at ${ANALYSIS_EVENTS}`);
    return null;
  }
  const text = fs.readFileSync(ANALYSIS_EVENTS, 'utf-8');
  const rows = parseCSVFile(text);
  const map = new Map();
  for (const row of rows) {
    const key = `${row.subject_id}_${row.global_trial}`;
    map.set(key, row);
  }
  console.log(`Loaded ${rows.length} rows from analysis_events_table.csv`);
  return map;
}

// ── Utility functions ──

function parseTSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split('\t').map(h => h.trim());
  return lines.slice(1).map(line => {
    const values = line.split('\t');
    const row = {};
    headers.forEach((h, i) => { row[h] = (values[i] || '').trim(); });
    return row;
  });
}

function getParticipantDirs(srcDir) {
  if (!fs.existsSync(srcDir)) {
    console.warn(`  WARNING: Directory not found: ${srcDir}`);
    return [];
  }
  return fs.readdirSync(srcDir)
    .filter(d => d.startsWith('Results_') && fs.statSync(path.join(srcDir, d)).isDirectory())
    .sort((a, b) => {
      const numA = parseInt(a.replace('Results_', ''));
      const numB = parseInt(b.replace('Results_', ''));
      return numA - numB;
    });
}

function convertWavToMp3(srcWav, destMp3) {
  const destDir = path.dirname(destMp3);
  fs.mkdirSync(destDir, { recursive: true });
  try {
    execSync(
      `ffmpeg -i "${srcWav}" -af "pan=mono|c0=c0" -codec:a libmp3lame -b:a 64k -ar 22050 -y "${destMp3}" 2>/dev/null`
    );
    return true;
  } catch (e) {
    console.warn(`  WARNING: Failed to convert ${srcWav}`);
    return false;
  }
}

/**
 * Detect the file prefix used in a participant directory.
 * Could be "Sub6001" or "P6014" etc.
 */
function detectFilePrefix(srcDirPath, pid) {
  const files = fs.readdirSync(srcDirPath);
  // Look for WAV files to detect prefix
  const wavFile = files.find(f => f.endsWith('.wav') && f.includes('_001_'));
  if (wavFile) {
    const match = wavFile.match(/^(.+?)_001_/);
    if (match) return match[1];
  }
  // Fallback: try common patterns
  if (files.some(f => f.startsWith(`Sub${pid}`))) return `Sub${pid}`;
  if (files.some(f => f.startsWith(`P${pid}`))) return `P${pid}`;
  return `Sub${pid}`;
}

/**
 * Find the stimulus plan TSV file in a participant directory.
 */
function findStimulusPlan(srcDirPath) {
  const files = fs.readdirSync(srcDirPath);
  return files.find(f => f.endsWith('_stimulus_plan.tsv'));
}

/**
 * Build a lookup from trial number to actual WAV filename on disk.
 */
function buildAudioFileMap(srcDirPath) {
  const files = fs.readdirSync(srcDirPath).filter(f => f.endsWith('.wav'));
  const map = {};
  for (const f of files) {
    // Extract trial number from filename like Sub6001_241_impedir.wav or P6014_001_comenzas.wav
    const match = f.match(/_(\d{3})_/);
    if (match) {
      const trialNum = parseInt(match[1]);
      map[trialNum] = f;
    }
  }
  return map;
}

// ── Main processing ──

function processParticipant(dirName, analysisEvents) {
  const pid = dirName.replace('Results_', '');
  const srcDirPath = path.join(DATA_AUDIO, dirName);
  const prefix = detectFilePrefix(srcDirPath, pid);

  // Find and parse stimulus plan (has all 300 trials)
  const planFile = findStimulusPlan(srcDirPath);
  if (!planFile) {
    console.warn(`  WARNING: No stimulus plan TSV in ${srcDirPath}`);
    return null;
  }

  const planText = fs.readFileSync(path.join(srcDirPath, planFile), 'utf-8');
  const planRows = parseTSV(planText);

  if (planRows.length === 0) {
    console.warn(`  WARNING: Empty stimulus plan in ${srcDirPath}`);
    return null;
  }

  // Build audio file map from disk
  const audioFileMap = buildAudioFileMap(srcDirPath);

  // Track repetition counts per picture type
  const repCounters = {};

  // Build trial rows from stimulus plan
  const trials = planRows.map(row => {
    const trialNum = parseInt(row.trial_number);
    const pictureType = parseInt(row.picture_type_number);
    const jitterSeconds = parseFloat(row.jitter_seconds);
    const jitterMs = Math.round(jitterSeconds * 1000);
    const session = Math.ceil(trialNum / TRIALS_PER_SESSION);
    const pictureLabel = PICTURE_TYPE_TO_LABEL[pictureType] || `unknown_${pictureType}`;
    const sprangForm = VERBS[pictureLabel] ? VERBS[pictureLabel].sprang : '';

    // Track repetitions
    if (!repCounters[pictureType]) repCounters[pictureType] = 0;
    repCounters[pictureType]++;
    const totalRep = repCounters[pictureType];

    // Session-local repetition count
    const sessionRepCounters = {};
    // (we'll compute this in a second pass)

    // Get actual audio filename from disk
    const audioFile = audioFileMap[trialNum] || `${prefix}_${String(trialNum).padStart(3, '0')}_${pictureLabel}.wav`;

    // Enrich with analysis events data if available
    const evKey = `${pid}_${trialNum}`;
    const ev = analysisEvents ? analysisEvents.get(evKey) : null;

    return {
      trial: trialNum,
      session,
      session_trial: ev ? parseInt(ev.session_trial) : ((trialNum - 1) % TRIALS_PER_SESSION) + 1,
      trial_index: ev ? ev.trial_index : '',
      trial_type: ev ? ev.trial_type : '',
      picture_type: pictureType,
      picture_label: pictureLabel,
      sprang_form: sprangForm,
      suffix: ev ? ev.suffix : '',
      suffix_label: ev ? ev.suffix_label : '',
      rule_type: ev ? ev.rule_type : '',
      rule_id: ev ? ev.rule_id : '',
      stim_onset_s: ev ? ev.stim_onset_s : '',
      stim_duration_s: ev ? ev.stim_duration_s : '',
      repetition: 0, // computed below
      total_repetition: totalRep,
      item_repetition: ev ? ev.item_repetition : '',
      rule_repetition: ev ? ev.rule_repetition : '',
      audio_file: audioFile,
      recording_duration_s: ev ? ev.recording_duration_s : '',
      duration_for_fmri_s: ev ? ev.duration_for_fmri_s : '',
      log_file: ev ? ev.log_file : '',
      jitter_ms: jitterMs
    };
  });

  // Compute session-local repetition counts
  const sessionRepCounters = {};
  for (const t of trials) {
    const key = `${t.session}_${t.picture_type}`;
    if (!sessionRepCounters[key]) sessionRepCounters[key] = 0;
    sessionRepCounters[key]++;
    t.repetition = sessionRepCounters[key];
  }

  // Write adapted CSV
  const csvOutDir = path.join(DATA_OUT, 'csv', pid);
  fs.mkdirSync(csvOutDir, { recursive: true });
  const csvOutPath = path.join(csvOutDir, `results_${pid}.csv`);

  const headers = 'trial,session,session_trial,trial_index,trial_type,picture_type,picture_label,sprang_form,suffix,suffix_label,rule_type,rule_id,stim_onset_s,stim_duration_s,repetition,total_repetition,item_repetition,rule_repetition,audio_file,recording_duration_s,duration_for_fmri_s,log_file,jitter_ms';
  const csvLines = [headers];
  for (const t of trials) {
    csvLines.push([
      t.trial, t.session, t.session_trial, t.trial_index, t.trial_type,
      t.picture_type, t.picture_label, t.sprang_form,
      t.suffix, t.suffix_label, t.rule_type, t.rule_id,
      t.stim_onset_s, t.stim_duration_s,
      t.repetition, t.total_repetition, t.item_repetition, t.rule_repetition,
      t.audio_file, t.recording_duration_s, t.duration_for_fmri_s,
      t.log_file, t.jitter_ms
    ].join(','));
  }
  fs.writeFileSync(csvOutPath, csvLines.join('\n') + '\n');

  // Convert audio files
  let audioCount = 0;
  if (WITH_AUDIO) {
    const audioOutDir = path.join(DATA_OUT, 'audio', pid);
    for (const t of trials) {
      if (!t.audio_file) continue;
      const srcWav = path.join(srcDirPath, t.audio_file);
      const mp3Name = t.audio_file.replace(/\.wav$/i, '.mp3');
      const destMp3 = path.join(audioOutDir, mp3Name);

      if (fs.existsSync(srcWav)) {
        if (!fs.existsSync(destMp3)) {
          if (convertWavToMp3(srcWav, destMp3)) {
            audioCount++;
          }
        } else {
          audioCount++;
        }
      } else {
        console.warn(`  WARNING: Audio not found: ${srcWav}`);
      }
    }
  }

  return { pid, trialCount: trials.length, audioCount };
}

function main() {
  console.log('Preparing fMRI naming task data for Voice Onset Scorer...');
  console.log(`Source: ${DATA_AUDIO}`);
  console.log(`Output: ${DATA_OUT}`);
  console.log(`Audio conversion: ${WITH_AUDIO ? 'YES' : 'NO'}`);
  console.log('');

  // Check ffmpeg if audio conversion requested
  if (WITH_AUDIO) {
    try {
      execSync('which ffmpeg', { stdio: 'pipe' });
    } catch (e) {
      console.error('ERROR: ffmpeg not found. Install ffmpeg for audio conversion.');
      process.exit(1);
    }
  }

  // Load analysis events table for enrichment
  const analysisEvents = loadAnalysisEvents();

  const participantDirs = getParticipantDirs(DATA_AUDIO);
  console.log(`Found ${participantDirs.length} participant directories\n`);

  const participantIds = [];
  let totalTrials = 0;
  let totalAudio = 0;

  for (const dirName of participantDirs) {
    console.log(`Processing: ${dirName}`);
    const result = processParticipant(dirName, analysisEvents);
    if (result) {
      participantIds.push(result.pid);
      totalTrials += result.trialCount;
      totalAudio += result.audioCount;
      console.log(`  ${result.trialCount} trials, ${result.audioCount} audio files`);
    }
  }

  // Copy stimulus images
  console.log('\nCopying stimulus images...');
  const imagesDestDir = path.join(DATA_OUT, 'images');
  fs.mkdirSync(imagesDestDir, { recursive: true });
  if (fs.existsSync(STIMULI_SRC)) {
    const imageFiles = fs.readdirSync(STIMULI_SRC).filter(f => f.endsWith('.jpg'));
    for (const img of imageFiles) {
      fs.copyFileSync(path.join(STIMULI_SRC, img), path.join(imagesDestDir, img));
    }
    console.log(`  Copied ${imageFiles.length} images`);
  } else {
    console.warn(`  WARNING: Stimuli directory not found: ${STIMULI_SRC}`);
  }

  // Write participants.json
  const index = {
    version: '2.0.0',
    verbs: VERBS,
    datasets: [{
      id: 'fmri_naming',
      label: 'fMRI Naming Task',
      testType: 'fmri_naming',
      audioPath: 'audio',
      csvPath: 'csv',
      participants: participantIds
    }]
  };

  const indexPath = path.join(DATA_OUT, 'participants.json');
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));

  console.log(`\nparticipants.json written to: ${indexPath}`);
  console.log(`Total: ${participantIds.length} participants, ${totalTrials} trials, ${totalAudio} audio files`);
}

main();

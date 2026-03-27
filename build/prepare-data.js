#!/usr/bin/env node
/**
 * prepare-data.js
 * Prepares data for the Variability_Scoring GitHub Pages site.
 *
 * 1. Generates participants.json (minimal index)
 * 2. Copies CSV files to data/csv/
 * 3. Converts WAV→MP3 (64kbps) to data/audio/
 * 4. Copies stimulus images to data/images/
 *
 * Usage:
 *   node build/prepare-data.js                # index + CSV + images only
 *   node build/prepare-data.js --with-audio   # also convert WAV→MP3
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJ_ROOT = path.resolve(__dirname, '../../');
const DATA_ROOT = path.join(PROJ_ROOT, 'Analysis/BehavioralData');
const IMAGES_SRC = path.join(PROJ_ROOT, 'Experiment/production_task/images');
const SITE_ROOT = path.resolve(__dirname, '..');
const DATA_OUT = path.join(SITE_ROOT, 'data');

const WITH_AUDIO = process.argv.includes('--with-audio');

// ── Word-to-English translation map ──
const WORD_TRANSLATIONS = {
  hongos: 'mushrooms', reloj: 'clock', tijeras: 'scissors', sandia: 'watermelon',
  cuaderno: 'notebook', ardilla: 'squirrel', cinta: 'tape', fresas: 'strawberries',
  tiza: 'chalk', caballo: 'horse', elote: 'corn', manzana: 'apple',
  oso: 'bear', pato: 'duck', grapadora: 'stapler', loro: 'parrot',
  cebolla: 'onion', lechuga: 'lettuce', lapiz: 'pencil', conejo: 'rabbit',
  gato: 'cat', naranja: 'orange', basurero: 'trash can', pez: 'fish'
};

// ── Dataset definitions ──
const DATASETS = [
  {
    id: 'immediate_l2_to_l1',
    label: 'Immediate / L2-to-L1',
    testType: 'l2_to_l1',
    timing: 'immediate',
    srcDir: path.join(DATA_ROOT, 'ImmediateData', 'L2_to_L1'),
    audioPath: 'audio/immediate/l2_to_l1',
    csvPath: 'csv/immediate/l2_to_l1',
    dirPrefix: 'l2_to_l1_'
  },
  {
    id: 'immediate_picture_naming',
    label: 'Immediate / Picture Naming',
    testType: 'picture_naming',
    timing: 'immediate',
    srcDir: path.join(DATA_ROOT, 'ImmediateData', 'PictureNaming'),
    audioPath: 'audio/immediate/picture_naming',
    csvPath: 'csv/immediate/picture_naming',
    dirPrefix: 'production_'
  },
  {
    id: 'delayed_l2_to_l1',
    label: 'Delayed / L2-to-L1',
    testType: 'l2_to_l1',
    timing: 'delayed',
    srcDir: path.join(DATA_ROOT, 'DelayedData', 'L2_to_L1'),
    audioPath: 'audio/delayed/l2_to_l1',
    csvPath: 'csv/delayed/l2_to_l1',
    dirPrefix: 'l2_to_l1_'
  },
  {
    id: 'delayed_picture_naming',
    label: 'Delayed / Picture Naming',
    testType: 'picture_naming',
    timing: 'delayed',
    srcDir: path.join(DATA_ROOT, 'DelayedData', 'PictureNaming'),
    audioPath: 'audio/delayed/picture_naming',
    csvPath: 'csv/delayed/picture_naming',
    dirPrefix: 'production_'
  }
];

// ── Utility functions ──

function stripAccents(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function extractParticipantId(dirName, prefix) {
  return dirName.replace(prefix, '');
}

function getParticipantDirs(srcDir, dirPrefix) {
  if (!fs.existsSync(srcDir)) {
    console.warn(`  WARNING: Directory not found: ${srcDir}`);
    return [];
  }
  return fs.readdirSync(srcDir)
    .filter(d => d.startsWith(dirPrefix) && fs.statSync(path.join(srcDir, d)).isDirectory())
    .sort((a, b) => {
      const numA = parseInt(extractParticipantId(a, dirPrefix));
      const numB = parseInt(extractParticipantId(b, dirPrefix));
      return numA - numB;
    });
}

// Build a map of NFC-normalized → actual disk filenames for a directory
function buildDiskFileMap(dirPath, ext) {
  const files = fs.readdirSync(dirPath).filter(f => f.endsWith(ext));
  const map = new Map();
  for (const f of files) {
    map.set(f.normalize('NFC'), f);
  }
  return map;
}

// Resolve audio filename mismatches (CSV participant_id != directory participant_id)
function resolveAudioFilename(csvRecordingFile, pid, diskFileMap) {
  const csvNfc = csvRecordingFile.normalize('NFC');
  if (diskFileMap.has(csvNfc)) {
    return diskFileMap.get(csvNfc);
  }
  // Try replacing the participant ID prefix
  const fixedFile = csvRecordingFile.replace(/^\d+/, pid).normalize('NFC');
  if (diskFileMap.has(fixedFile)) {
    return diskFileMap.get(fixedFile);
  }
  return csvRecordingFile; // fallback
}

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

function convertWavToMp3(srcWav, destMp3) {
  const destDir = path.dirname(destMp3);
  fs.mkdirSync(destDir, { recursive: true });
  try {
    execSync(`ffmpeg -i "${srcWav}" -codec:a libmp3lame -b:a 64k -ar 22050 -y "${destMp3}" 2>/dev/null`);
    return true;
  } catch (e) {
    console.warn(`  WARNING: Failed to convert ${srcWav}`);
    return false;
  }
}

// ── Main processing ──

function processDataset(dataset) {
  const { srcDir, dirPrefix, csvPath, audioPath } = dataset;
  const participantDirs = getParticipantDirs(srcDir, dirPrefix);
  const participantIds = [];
  let audioCount = 0;

  for (const dirName of participantDirs) {
    const pid = extractParticipantId(dirName, dirPrefix);
    participantIds.push(pid);

    const srcDirPath = path.join(srcDir, dirName);

    // Copy CSV
    const csvFiles = fs.readdirSync(srcDirPath).filter(f => f.startsWith('results_') && f.endsWith('.csv'));
    if (csvFiles.length === 0) {
      console.warn(`  WARNING: No results CSV in ${srcDirPath}`);
      continue;
    }
    const csvSrc = path.join(srcDirPath, csvFiles[0]);
    const csvDest = path.join(DATA_OUT, csvPath, pid, `results_${pid}.csv`);
    fs.mkdirSync(path.dirname(csvDest), { recursive: true });
    fs.copyFileSync(csvSrc, csvDest);

    // Convert audio files (WAV→MP3)
    if (WITH_AUDIO) {
      const diskFileMap = buildDiskFileMap(srcDirPath, '.wav');
      const csvText = fs.readFileSync(csvSrc, 'utf-8');
      const rows = parseCSV(csvText);

      for (const row of rows) {
        const recordingFile = row.recording_file;
        if (!recordingFile) continue;

        const resolvedFile = resolveAudioFilename(recordingFile, pid, diskFileMap);
        const srcWav = path.join(srcDirPath, resolvedFile);

        // Output MP3 with accent-stripped name
        const mp3Name = stripAccents(resolvedFile)
          .normalize('NFC')
          .replace(/\.wav$/i, '.mp3');
        // Also fix participant ID in output filename
        const mp3NameFixed = mp3Name.replace(/^\d+/, pid);
        const destMp3 = path.join(DATA_OUT, audioPath, pid, mp3NameFixed);

        if (fs.existsSync(srcWav)) {
          if (!fs.existsSync(destMp3)) {
            convertWavToMp3(srcWav, destMp3);
          }
          audioCount++;
        } else {
          console.warn(`  WARNING: Audio not found: ${srcWav}`);
        }
      }
    }
  }

  return { participantIds, audioCount };
}

function main() {
  console.log('Preparing data for Variability_Scoring...');
  console.log(`Source: ${DATA_ROOT}`);
  console.log(`Output: ${DATA_OUT}`);
  console.log(`Audio conversion: ${WITH_AUDIO ? 'YES' : 'NO'}`);
  console.log('');

  const index = {
    version: '2.0.0',
    words: WORD_TRANSLATIONS,
    datasets: []
  };

  let totalParticipants = 0;
  let totalAudio = 0;

  for (const ds of DATASETS) {
    console.log(`Processing: ${ds.label}`);
    const { participantIds, audioCount } = processDataset(ds);

    totalParticipants += participantIds.length;
    totalAudio += audioCount;
    console.log(`  ${participantIds.length} participants, ${audioCount} audio files`);

    index.datasets.push({
      id: ds.id,
      label: ds.label,
      testType: ds.testType,
      timing: ds.timing,
      audioPath: ds.audioPath,
      csvPath: ds.csvPath,
      participants: participantIds
    });
  }

  // Copy images
  console.log('\nCopying stimulus images...');
  const imagesDestDir = path.join(DATA_OUT, 'images');
  fs.mkdirSync(imagesDestDir, { recursive: true });
  const imageFiles = fs.readdirSync(IMAGES_SRC).filter(f => f.endsWith('.jpg'));
  for (const img of imageFiles) {
    fs.copyFileSync(path.join(IMAGES_SRC, img), path.join(imagesDestDir, img));
  }
  console.log(`  Copied ${imageFiles.length} images`);

  // Copy reference pronunciation audio (female speaker)
  console.log('\nCopying reference pronunciation audio...');
  const REF_AUDIO_SRC = path.join(PROJ_ROOT, 'Experiment/Audio_LDT/LDT_audio/target/female');
  const refAudioDest = path.join(DATA_OUT, 'reference_audio');
  if (fs.existsSync(REF_AUDIO_SRC)) {
    fs.mkdirSync(refAudioDest, { recursive: true });
    const refFiles = fs.readdirSync(REF_AUDIO_SRC).filter(f => f.endsWith('.mp3'));
    for (const f of refFiles) {
      fs.copyFileSync(path.join(REF_AUDIO_SRC, f), path.join(refAudioDest, f));
    }
    console.log(`  Copied ${refFiles.length} reference audio files`);
  } else {
    console.warn(`  WARNING: Reference audio directory not found: ${REF_AUDIO_SRC}`);
  }

  // Write participants.json
  const indexPath = path.join(DATA_OUT, 'participants.json');
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));

  console.log(`\nparticipants.json written to: ${indexPath}`);
  console.log(`Total: ${totalParticipants} participants, ${totalAudio} audio files`);
}

main();

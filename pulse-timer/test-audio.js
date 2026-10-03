const fs = require('fs');

const html = fs.readFileSync('pulse-timer/index.html','utf8');
const scriptMatch = html.match(/<script>\s*([\s\S]*?)\s*<\/script>\s*<\/body>/);
if(!scriptMatch) throw new Error('Inline app script not found');
new Function(scriptMatch[1]);

const sounds = {
  countdown: fs.readFileSync('pulse-timer/sounds/countdown.b64','utf8').trim(),
  workStart: fs.readFileSync('pulse-timer/sounds/start_whistle.b64','utf8').trim(),
  workEnd: fs.readFileSync('pulse-timer/sounds/end_bell.b64','utf8').trim(),
};

const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const signalReport = {};
for (const [name,b64] of Object.entries(sounds)) {
  if (b64.length < 1000) throw new Error(name+' sound is unexpectedly small');
  const head = b64.slice(0,96);
  if (!html.includes(head)) throw new Error(name+' is not embedded in index.html');

  const bytes = Buffer.from(b64,'base64');
  if (bytes.length < 700) throw new Error(name+' decoded audio is unexpectedly small');
  const tmp = path.join(os.tmpdir(),'pulse-'+name+'.mp3');
  fs.writeFileSync(tmp,bytes);

  const duration = Number(execFileSync('ffprobe',[
    '-v','error',
    '-show_entries','format=duration',
    '-of','default=noprint_wrappers=1:nokey=1',
    tmp
  ],{encoding:'utf8'}).trim());
  if (!(duration > 0.05 && duration < 15)) {
    throw new Error(name+' has invalid duration: '+duration);
  }

  const ff = spawnSync('ffmpeg',[
    '-hide_banner','-nostats','-i',tmp,
    '-af','volumedetect','-f','null','-'
  ],{encoding:'utf8'});
  if (ff.error) throw ff.error;
  const analysis = String(ff.stderr || '') + String(ff.stdout || '');
  const maxMatch = analysis.match(/max_volume:\s*(-?[0-9.]+) dB/);
  const meanMatch = analysis.match(/mean_volume:\s*(-?[0-9.]+) dB/);
  const maxDb = maxMatch ? Number(maxMatch[1]) : NaN;
  const meanDb = meanMatch ? Number(meanMatch[1]) : NaN;
  if (!Number.isFinite(maxDb) || maxDb < -55) {
    throw new Error(name+' appears silent or undecodable; max_volume='+maxDb);
  }
  signalReport[name] = {
    base64: b64.length,
    bytes: bytes.length,
    duration: Number(duration.toFixed(3)),
    maxDb,
    meanDb
  };
}

const required = [
  "audioSession.type='transient'",
  'function playFinishSequence()',
  "playSignal('workEnd')",
  "playSignal('workStart')",
  "playRecorded('countdown'",
  'window.__pulseAudioDiagnostics',
];
for (const token of required) {
  if(!html.includes(token)) throw new Error('Missing required audio token: '+token);
}

if (html.includes("audioSession.type='playback'")) {
  throw new Error('playback audio session would be allowed to interrupt external music');
}
if (html.includes('navigator.mediaSession.metadata=')) {
  throw new Error('MediaSession metadata should stay disabled to avoid taking over media controls');
}
if (/fetch\(path\s*,/.test(html)) {
  throw new Error('Timer sounds must not depend on runtime /sounds network fetches');
}

console.log('Pulse Timer static audio tests: PASS');
console.log(JSON.stringify({
  embeddedSounds: signalReport,
  transientSession: true,
  finishSequence: true,
  mediaSessionTakeover: false,
}, null, 2));

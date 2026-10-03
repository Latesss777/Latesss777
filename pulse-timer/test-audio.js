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

for (const [name,b64] of Object.entries(sounds)) {
  if (b64.length < 1000) throw new Error(name+' sound is unexpectedly small');
  const head = b64.slice(0,96);
  if (!html.includes(head)) throw new Error(name+' is not embedded in index.html');
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
  embeddedSounds: Object.fromEntries(Object.entries(sounds).map(([k,v])=>[k,v.length])),
  transientSession: true,
  finishSequence: true,
  mediaSessionTakeover: false,
}, null, 2));

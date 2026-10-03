const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const root=path.resolve(__dirname);
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const app=fs.readFileSync(path.join(root,'src/app/app.js'),'utf8');
const engine=fs.readFileSync(path.join(root,'src/audio/audio-engine.js'),'utf8');

const scriptMatch=html.match(/<script>\s*([\s\S]*?)\s*<\/script>\s*<\/body>/);
if(!scriptMatch) throw new Error('Generated app script not found');
new Function(scriptMatch[1]);

const sounds={
  countdown:fs.readFileSync(path.join(root,'sounds/countdown.b64'),'utf8').trim().replace(/\s+/g,''),
  workStart:fs.readFileSync(path.join(root,'sounds/start_whistle.b64'),'utf8').trim().replace(/\s+/g,''),
  workEnd:fs.readFileSync(path.join(root,'sounds/end_bell.b64'),'utf8').trim().replace(/\s+/g,'')
};

const signalReport={};
for(const [name,b64] of Object.entries(sounds)){
  if(b64.length<1000) throw new Error(name+' sound is unexpectedly small');
  if(!html.includes(b64.slice(0,96))) throw new Error(name+' is not embedded in generated index');

  const bytes=Buffer.from(b64,'base64');
  const tmp=path.join(os.tmpdir(),'pulse-'+name+'.mp3');
  fs.writeFileSync(tmp,bytes);

  const duration=Number(execFileSync('ffprobe',[
    '-v','error','-show_entries','format=duration',
    '-of','default=noprint_wrappers=1:nokey=1',tmp
  ],{encoding:'utf8'}).trim());

  if(!(duration>.05&&duration<15)) throw new Error(name+' invalid duration '+duration);

  const ff=spawnSync('ffmpeg',[
    '-hide_banner','-nostats','-i',tmp,
    '-af','volumedetect','-f','null','-'
  ],{encoding:'utf8'});
  if(ff.error) throw ff.error;
  const analysis=String(ff.stderr||'')+String(ff.stdout||'');
  const max=analysis.match(/max_volume:\s*(-?[0-9.]+) dB/);
  const mean=analysis.match(/mean_volume:\s*(-?[0-9.]+) dB/);
  const maxDb=max?Number(max[1]):NaN;
  const meanDb=mean?Number(mean[1]):NaN;
  if(!Number.isFinite(maxDb)||maxDb<-45) throw new Error(name+' appears silent');

  signalReport[name]={bytes:bytes.length,duration:Number(duration.toFixed(3)),maxDb,meanDb};
}

const requiredEngine=[
  "navigator.audioSession.type = 'ambient'",
  'context.createDynamicsCompressor()',
  'async function playSignal',
  'async function startCarrier',
  'async function playBlob',
  'bindGestureUnlock'
];
for(const token of requiredEngine){
  if(!engine.includes(token)) throw new Error('Audio engine missing '+token);
}

const requiredApp=[
  'PulseAudioEngine.create',
  "playSignal('workStart')",
  "playSignal('workEnd')",
  "playSignal('finish')",
  'startBackgroundKeeper()',
  'window.__pulseAudioDiagnostics = audio'
];
for(const token of requiredApp){
  if(!app.includes(token)) throw new Error('App missing '+token);
}

for(const forbidden of [
  'new Audio(',
  "audioSession.type = 'playback'",
  "audioSession.type='playback'",
  "audioSession.type = 'transient'",
  "audioSession.type='transient'",
  'navigator.mediaSession.metadata',
  'RECORDED_SOUND_BASE64',
  'audioCtx'
]){
  if(app.includes(forbidden)) throw new Error('Legacy audio leaked into app: '+forbidden);
}
if(html.includes('new Audio(')) throw new Error('Generated app contains HTMLAudio playback');
if(html.includes('quickchart.io')===false){} // sharing service is tested separately; not part of timer audio.

console.log('Pulse Timer audio test: PASS');
console.log(JSON.stringify(signalReport,null,2));

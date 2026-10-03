import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'..');
const read=rel=>fs.readFileSync(path.join(root,rel),'utf8');

const template=read('src/template.html');
const css=[
  read('src/styles/base.css'),
  read('src/styles/liquid-glass.css')
].join('\n\n');

let audio=read('src/audio/audio-engine.js');
const soundMap={
  '__COUNTDOWN_B64__':read('sounds/countdown.b64').trim().replace(/\s+/g,''),
  '__WORK_START_B64__':read('sounds/start_whistle.b64').trim().replace(/\s+/g,''),
  '__WORK_END_B64__':read('sounds/end_bell.b64').trim().replace(/\s+/g,'')
};
for(const [token,value] of Object.entries(soundMap)) audio=audio.replace(token,value);

const js=[
  audio,
  read('src/app/app.js')
].join('\n\n');

const banner='<!-- GENERATED FILE. Edit pulse-timer/src/* and run scripts/build.mjs. -->\n';
const output=banner+
  template
    .replace('<!-- PULSE_STYLES -->','<style>\n'+css+'\n</style>')
    .replace('<!-- PULSE_SCRIPTS -->','<script>\n'+js+'\n</script>');

fs.writeFileSync(path.join(root,'index.html'),output);
console.log('Built pulse-timer/index.html',output.length,'bytes');

const fs=require('fs');
const path=require('path');
const cp=require('child_process');

const root=path.resolve(__dirname,'..');
const indexPath=path.join(root,'index.html');
const before=fs.readFileSync(indexPath,'utf8');

cp.execFileSync(process.execPath,[path.join(root,'scripts/build.mjs')],{stdio:'inherit'});
const after=fs.readFileSync(indexPath,'utf8');

if(before!==after){
  throw new Error('Generated index.html is stale. Run node pulse-timer/scripts/build.mjs and commit the result.');
}

const required=[
  'src/template.html',
  'src/styles/base.css',
  'src/styles/liquid-glass.css',
  'src/audio/audio-engine.js',
  'src/app/app.js'
];
for(const rel of required){
  if(!fs.existsSync(path.join(root,rel))) throw new Error('Missing source module: '+rel);
}

if(!after.startsWith('<!-- GENERATED FILE.')) throw new Error('index.html must be generated');
console.log('Pulse Timer structure test: PASS');

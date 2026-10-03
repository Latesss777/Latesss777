const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const template=fs.readFileSync(path.join(root,'src/template.html'),'utf8');
const base=fs.readFileSync(path.join(root,'src/styles/base.css'),'utf8');
const glass=fs.readFileSync(path.join(root,'src/styles/liquid-glass.css'),'utf8');
const app=fs.readFileSync(path.join(root,'src/app/app.js'),'utf8');

if(/style="/.test(template)) throw new Error('Static template still contains inline CSS');
if(base.includes('fonts.googleapis.com')) throw new Error('External Google Fonts dependency remains');
if(app.includes('images.unsplash.com')) throw new Error('Remote workout photos remain');
if(!glass.includes('-webkit-backdrop-filter')||!glass.includes('backdrop-filter')) throw new Error('Liquid Glass blur layer missing');
if(!glass.includes('@supports not ((backdrop-filter')) throw new Error('Glass fallback missing');
if(!glass.includes('prefers-reduced-motion')) throw new Error('Reduced motion support missing');
if(!glass.includes('prefers-contrast:more')) throw new Error('Increased contrast support missing');
if(!glass.includes('.phase-bg.work{--phase:#0a5d87')) throw new Error('Blue work phase token missing');
if(!glass.includes('animation:none!important')) throw new Error('Timer pulse animation is not disabled');
if(!glass.includes('.card-visual')) throw new Error('Local vector card artwork missing');
if((glass.match(/backdrop-filter:/g)||[]).length<12) throw new Error('Glass material coverage unexpectedly low');

console.log('Pulse Timer design/static test: PASS');

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit } from 'playwright';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'..');
const html=fs.readFileSync(path.join(root,'index.html'));

const server=http.createServer((req,res)=>{
  if(req.url==='/'||req.url.startsWith('/?')){
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    res.end(html);
    return;
  }
  res.writeHead(404);res.end('not found');
});
await new Promise(resolve=>server.listen(4173,'127.0.0.1',resolve));

const browser=await webkit.launch({headless:true});
const context=await browser.newContext({
  viewport:{width:393,height:852},
  deviceScaleFactor:2,
  isMobile:true,
  hasTouch:true
});

await context.addInitScript(()=>{
  localStorage.setItem('pulse-timer-clean-v1-workouts',JSON.stringify([{
    id:'e2e',name:'ТЕСТ',prep:1,work:1,rest:0,cycles:1,sets:1,setRest:0,coolDown:0,color:'blue',finishVoiceId:''
  }]));
  localStorage.setItem('pulse-timer-clean-v2-prefs',JSON.stringify({sound:true,vibrate:false}));
});

const page=await context.newPage();
const consoleErrors=[];
page.on('console',msg=>{if(msg.type()==='error')consoleErrors.push(msg.text())});
page.on('pageerror',err=>consoleErrors.push(String(err)));

const assert=(value,message)=>{if(!value)throw new Error(message)};
const overflow=()=>page.evaluate(()=>({
  width:window.innerWidth,
  html:document.documentElement.scrollWidth,
  body:document.body.scrollWidth
}));

await page.goto('http://127.0.0.1:4173/',{waitUntil:'load'});
await page.waitForTimeout(1300);

assert(await page.locator('#screen').isVisible(),'Home screen is not visible');
assert(await page.locator('.card-row').count()===1,'Workout card did not render');
assert(await page.locator('.card-visual-icon svg').count()===1,'Local sport artwork did not render');
assert(await page.locator('.card-photo').count()===0,'Old photo card still rendered');

let dims=await overflow();
assert(dims.html<=dims.width+1&&dims.body<=dims.width+1,'Home has horizontal overflow');

const cardBox=await page.locator('.card.exact-art').boundingBox();
assert(cardBox&&cardBox.height>=140,'Workout card scale is too small');

await page.locator('#settingsBtn').click();
assert(await page.locator('#settings').isVisible(),'Settings did not open');

const glassStyle=await page.locator('#settingsBtn').evaluate(el=>{
  const c=getComputedStyle(el);
  return c.backdropFilter||c.webkitBackdropFilter||'';
});
assert(glassStyle&&glassStyle!=='none','Settings icon is missing backdrop-filter');

await page.locator('#testSoundBtn').click();
await page.waitForFunction(()=>((window.__pulseAudioDiagnostics?.status?.cueCount||0)>=2),null,{timeout:7000});
const audioStatus=await page.evaluate(()=>window.__pulseAudioDiagnostics?.status);
console.log('AUDIO_STATUS_AFTER_TEST',JSON.stringify(audioStatus));
assert(audioStatus,'Audio diagnostics missing');
assert(Object.keys(audioStatus.decoded||{}).length===3,'Not all timer cues decoded after user gesture: '+JSON.stringify(audioStatus));
assert(audioStatus.lastCue==='workEnd','Sound test did not reach end cue');
assert((audioStatus.cueCount||0)>=2,'Repeated sound test did not complete two cues: '+JSON.stringify(audioStatus));
if(audioStatus.sessionType!=='unsupported'){
  assert((audioStatus.sessionTransitionCount||0)>=4,'Audio session did not cycle between repeated cues: '+JSON.stringify(audioStatus));
}
assert(await page.locator('audio').count()===0,'HTMLAudio element exists and may take over music');

await page.locator('#settingsBtn').click();
await page.locator('#addBtn').click();
assert(await page.locator('#editor').isVisible(),'Editor did not open');
assert(await page.locator('.color-dot').count()===6,'Color picker is incomplete');
assert(await page.locator('#voicePicker').isVisible(),'Voice picker missing');
dims=await overflow();
assert(dims.html<=dims.width+1&&dims.body<=dims.width+1,'Editor has horizontal overflow');

const addBox=await page.locator('#editorBack').boundingBox();
assert(addBox&&addBox.width>=44&&addBox.height>=44,'Editor back target is below 44px');
await page.locator('#editorBack').click();

await page.locator('.card-primary.play-btn').click();
await page.locator('#timer').waitFor({state:'visible'});
assert(await page.locator('.int-row').count()===2,'Short workout phases are incorrect');

const pauseBox=await page.locator('#pauseBtn').boundingBox();
assert(pauseBox&&pauseBox.width>=44&&pauseBox.height>=44,'Pause target is below 44px');
const pauseGlass=await page.locator('#pauseBtn').evaluate(el=>{
  const c=getComputedStyle(el);
  return c.backdropFilter||c.webkitBackdropFilter||'';
});
assert(pauseGlass&&pauseGlass!=='none','Timer controls are not glass');

dims=await overflow();
assert(dims.html<=dims.width+1&&dims.body<=dims.width+1,'Timer has horizontal overflow');

await page.waitForTimeout(8000);
const finished=await page.evaluate(()=>({
  audio:window.__pulseAudioDiagnostics?.status,
  timerVisible:!document.getElementById('timer')?.classList.contains('hidden'),
  timerNumber:document.getElementById('timerNumber')?.textContent,
  phaseTitle:document.getElementById('phaseTitle')?.textContent,
  intervalCounter:document.getElementById('intervalCounter')?.textContent
}));
console.log('WORKOUT_FINAL_STATE',JSON.stringify(finished));
assert(finished.audio?.lastCue==='workEnd','Final workout sound was not requested: '+JSON.stringify(finished));
assert((finished.audio?.cueCount||0)>(audioStatus.cueCount||0),'Workout did not complete any additional timer cue: '+JSON.stringify(finished));
assert(!finished.audio?.lastError,'Audio engine ended with an error: '+String(finished.audio?.lastError||''));

fs.mkdirSync(path.join(root,'test-artifacts'),{recursive:true});
await page.screenshot({path:path.join(root,'test-artifacts','timer-iphone.png'),fullPage:true});

assert(consoleErrors.length===0,'Browser errors: '+consoleErrors.join(' | '));

await browser.close();
await new Promise(resolve=>server.close(resolve));
console.log('Pulse Timer browser e2e: PASS');
console.log(JSON.stringify({audioStatus,finished},null,2));

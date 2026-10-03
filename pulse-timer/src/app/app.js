(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'w-' + Date.now() + '-' + Math.random().toString(16).slice(2));
  const fmt = s => {
    s = Math.max(0, Math.round(s));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2,'0');
  };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  const DEFAULTS = [
    {id:'press',name:'ПРЕСС',prep:10,work:30,rest:80,cycles:9,sets:1,setRest:150,coolDown:0,color:'berry'},
    {id:'training',name:'ТРЕНИРОВКА',prep:30,work:30,rest:150,cycles:12,sets:3,setRest:180,coolDown:0,color:'blue'}
  ];

  // Fresh state: deliberately does not import previously broken localStorage.
  const STORAGE = 'pulse-timer-clean-v1-workouts';
  const PREFS = 'pulse-timer-clean-v2-prefs';

  const normalize = w => ({
    id:String(w?.id || uid()),
    name:String(w?.name || 'ТРЕНИРОВКА').toUpperCase(),
    prep:Math.max(0,Number(w?.prep ?? 10) || 0),
    work:Math.max(1,Number(w?.work ?? 30) || 30),
    rest:Math.max(0,Number(w?.rest ?? 60) || 0),
    cycles:Math.max(1,Number(w?.cycles ?? 8) || 8),
    sets:Math.max(1,Number(w?.sets ?? 1) || 1),
    setRest:Math.max(0,Number(w?.setRest ?? 120) || 0),
    coolDown:Math.max(0,Number(w?.coolDown ?? 0) || 0),
    color:['graphite','berry','orange','blue','green','violet'].includes(w?.color)?w.color:'graphite',
    finishVoiceId:String(w?.finishVoiceId || '')
  });

  function loadWorkouts(){
    try{
      const saved = JSON.parse(localStorage.getItem(STORAGE) || 'null');
      if(Array.isArray(saved) && saved.length) return saved.map(normalize);
    }catch{}
    const fresh = DEFAULTS.map(x=>({...x}));
    localStorage.setItem(STORAGE, JSON.stringify(fresh));
    return fresh;
  }

  let workouts = loadWorkouts();
  let prefs = {sound:true,vibrate:true};
  try{prefs={...prefs,...JSON.parse(localStorage.getItem(PREFS)||'{}')}}catch{}
  let sound = !!prefs.sound;
  let vibrate = !!prefs.vibrate;

  let editing = null;
  let active = null;
  let phases = [];
  let phaseIndex = 0;
  let remainingMs = 0;
  let deadline = 0;
  let running = false;
  let tickId = null;
  let resumeAfterModal = false;
  let lastCountdownSec = null;
  let padField = null;
  let padDraft = '0';
  let audioCtx = null;
  let timerMasterGain = null;
  let timerLimiter = null;
  const recordedDataUrls = {};
  let audioGeneration = 0;
  let lastAudioError = '';
  let lastAudioCue = '';
  let lastAudioCueAt = 0;
  let shareWorkout = null;
  let currentShareUrl = '';
  let toastTimer = null;
  let cardMenuWorkoutId = null;
  let backgroundKeeper = null;
  let wakeLock = null;
  let lastMediaSecond = null;
  let lastMediaKey = '';
  let finishSequencePlayed = false;
  let pendingFinishCue = false;
  let voiceLibrary = [];
  const voiceBufferCache = new Map();
  let voiceDbPromise = null;

  const COLOR_OPTIONS = [
    ['graphite','Графит'],['berry','Ягодный'],['orange','Оранжевый'],
    ['blue','Синий'],['green','Зелёный'],['violet','Фиолетовый']
  ];

  function openVoiceDb(){
    if(voiceDbPromise)return voiceDbPromise;
    voiceDbPromise=new Promise((resolve,reject)=>{
      const req=indexedDB.open('pulse-timer-voice-library',1);
      req.onupgradeneeded=()=>{
        const db=req.result;
        if(!db.objectStoreNames.contains('clips'))db.createObjectStore('clips',{keyPath:'id'});
      };
      req.onsuccess=()=>resolve(req.result);
      req.onerror=()=>reject(req.error);
    });
    return voiceDbPromise;
  }

  async function refreshVoiceLibrary(){
    try{
      const db=await openVoiceDb();
      voiceLibrary=await new Promise((resolve,reject)=>{
        const tx=db.transaction('clips','readonly');
        const req=tx.objectStore('clips').getAll();
        req.onsuccess=()=>resolve((req.result||[]).sort((a,b)=>a.created-b.created));
        req.onerror=()=>reject(req.error);
      });
    }catch{
      voiceLibrary=[];
    }
    renderVoiceLibrary();
    renderVoicePicker();
  }

  async function addVoiceClip(file){
    if(!file)return;
    await refreshVoiceLibrary();
    if(voiceLibrary.length>=10){
      showToast('Максимум 10 голосов');
      return;
    }
    const id='voice-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,7);
    const name=(file.name||'Финальный голос').replace(/\.[^.]+$/,'').slice(0,42);
    try{
      const db=await openVoiceDb();
      await new Promise((resolve,reject)=>{
        const tx=db.transaction('clips','readwrite');
        tx.objectStore('clips').put({id,name,mime:file.type||'audio/mpeg',blob:file,created:Date.now()});
        tx.oncomplete=resolve;
        tx.onerror=()=>reject(tx.error);
      });
      await refreshVoiceLibrary();
      showToast('Голос добавлен');
    }catch{
      showToast('Не удалось сохранить аудио');
    }
  }

  async function removeVoiceClip(id){
    if(!id)return;
    try{
      const db=await openVoiceDb();
      await new Promise((resolve,reject)=>{
        const tx=db.transaction('clips','readwrite');
        tx.objectStore('clips').delete(id);
        tx.oncomplete=resolve;
        tx.onerror=()=>reject(tx.error);
      });
      voiceBufferCache.delete(id);
      workouts=workouts.map(w=>w.finishVoiceId===id?{...w,finishVoiceId:''}:w);
      if(editing?.finishVoiceId===id)editing.finishVoiceId='';
      saveWorkouts();
      await refreshVoiceLibrary();
      renderCards();
    }catch{}
  }

  function renderVoiceLibrary(){
    const box=$('voiceLibrary');
    const count=$('voiceCount');
    if(count)count.textContent=voiceLibrary.length+' / 10';
    if(!box)return;
    box.innerHTML=voiceLibrary.map(v=>`
      <div class="voice-library-row">
        <span>${esc(v.name)}</span>
        <button class="voice-remove" data-voice-remove="${v.id}" aria-label="Удалить">×</button>
      </div>
    `).join('');
  }

  function renderVoicePicker(){
    const box=$('voicePicker');
    if(!box||!editing)return;
    box.innerHTML=[
      `<button class="voice-chip ${!editing.finishVoiceId?'active':''}" data-voice-id="">Без голоса</button>`,
      ...voiceLibrary.map(v=>`<button class="voice-chip ${editing.finishVoiceId===v.id?'active':''}" data-voice-id="${v.id}">${esc(v.name)}</button>`)
    ].join('');
  }

  async function getVoiceAudioBuffer(id){
    if(!id)return null;
    if(voiceBufferCache.has(id))return voiceBufferCache.get(id);
    try{
      const db=await openVoiceDb();
      const record=await new Promise((resolve,reject)=>{
        const tx=db.transaction('clips','readonly');
        const req=tx.objectStore('clips').get(id);
        req.onsuccess=()=>resolve(req.result||null);
        req.onerror=()=>reject(req.error);
      });
      if(!record?.blob)return null;
      ensureAudio();
      const buffer=await decodeTimerAudio(await record.blob.arrayBuffer());
      voiceBufferCache.set(id,buffer);
      return buffer;
    }catch{return null}
  }

  async function playFinishVoice(id){
    if(!sound||!id)return false;
    const buffer=await getVoiceAudioBuffer(id);
    if(!buffer||!audioCtx)return false;
    try{
      if(audioCtx.state==='suspended')await audioCtx.resume();
      const src=audioCtx.createBufferSource();
      const gain=audioCtx.createGain();
      src.buffer=buffer;
      gain.gain.value=.95;
      src.connect(gain);
      gain.connect(audioCtx.destination);
      src.start();
      return true;
    }catch{return false}
  }

  const fieldMeta = [
    ['prep','Подготовка','сек',0,5],
    ['work','Работа','сек',1,5],
    ['rest','Отдых','сек',0,5],
    ['cycles','Циклы','',1,1],
    ['sets','Подходы','',1,1],
    ['setRest','Отдых между подходами','сек',0,5],
    ['coolDown','Заминка','сек',0,5]
  ];

  function saveWorkouts(){localStorage.setItem(STORAGE,JSON.stringify(workouts))}
  function savePrefs(){localStorage.setItem(PREFS,JSON.stringify({sound,vibrate}))}
  function configureTimerAudioSession(){
    if('audioSession' in navigator){
      try{navigator.audioSession.type='transient'}catch{
        try{navigator.audioSession.type='ambient'}catch{}
      }
    }
    try{
      window.webkit?.messageHandlers?.PulseAudio?.postMessage?.({
        action:'mixWithOthers',
        duck:false,
        notifyOthers:true
      });
    }catch{}
  }

  function releaseTimerAudioSession(){
    try{
      window.webkit?.messageHandlers?.PulseAudio?.postMessage?.({
        action:'deactivate',
        notifyOthers:true
      });
    }catch{}
  }

  async function rebuildAudioContext(){
    const old=audioCtx;
    audioCtx=null;
    timerMasterGain=null;
    timerLimiter=null;
    audioGeneration++;
    try{
      if(old && old.state!=='closed')await Promise.race([
        old.close(),
        new Promise(r=>setTimeout(r,180))
      ]);
    }catch{}
    ensureAudio();
    return audioCtx;
  }

  async function resumeAudioSafely(){
    ensureAudio();
    if(!audioCtx)return false;
    if(audioCtx.state==='running')return true;
    try{
      await Promise.race([
        audioCtx.resume(),
        new Promise((_,reject)=>setTimeout(()=>reject(new Error('resume timeout')),350))
      ]);
    }catch(err){
      lastAudioError=String(err?.message||err||'resume failed');
      await rebuildAudioContext();
      try{
        await Promise.race([
          audioCtx?.resume?.(),
          new Promise((_,reject)=>setTimeout(()=>reject(new Error('resume retry timeout')),350))
        ]);
      }catch(err2){
        lastAudioError=String(err2?.message||err2||'resume retry failed');
      }
    }
    return !!audioCtx && audioCtx.state==='running';
  }

  function ensureAudio(){
    configureTimerAudioSession();
    if(!audioCtx){
      try{
        const Ctx=window.AudioContext||window.webkitAudioContext;
        audioCtx=new Ctx({latencyHint:'interactive'});
      }catch{
        try{audioCtx=new (window.AudioContext||window.webkitAudioContext)()}catch{}
      }
    }
    if(audioCtx && !timerMasterGain){
      try{
        timerMasterGain=audioCtx.createGain();
        timerLimiter=audioCtx.createDynamicsCompressor();
        timerMasterGain.gain.value=4.25;
        timerLimiter.threshold.value=-10;
        timerLimiter.knee.value=2;
        timerLimiter.ratio.value=20;
        timerLimiter.attack.value=.001;
        timerLimiter.release.value=.12;
        timerMasterGain.connect(timerLimiter);
        timerLimiter.connect(audioCtx.destination);
      }catch{
        timerMasterGain=null;
        timerLimiter=null;
      }
    }
    if(audioCtx?.state==='suspended')audioCtx.resume().catch(()=>{});
  }

  const RECORDED_SOUND_BASE64={
    countdown:'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',
    workStart:'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',
    workEnd:'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/9SL+hN///8fbV/36AakHvH/WS3qJo4SyP///rJ9vUv6H/zdlRGAIEAIAQeuv/okatm1upTwUS+hXZmMAVrUHXkEXVb6S//zYsQhH3wKlmYWauQ2SLIugSBYBM3AwAExXCbLiDs7f/7sVSmIoBhszAMB4tkuThobmn//dSZgShuxiLQBjMrBcwT5OHbP//+oy+ql///kw9X/41hkEfLBMpdQ+S6Zm3///yr9R/6//mIOjDoBBEAIPTI/Uv0QbZ0/lqWRcviD5RQiOyWPVN8y3r+d3/63reM+8iD5sFmDztEh55b/82LEMx6MDpJWFujwUmeG////1uRMyFpAezEmPIkoPaJr//UX0HmDk6RYZoMIgESwcVNj3///zPretv//8tof/1isCw/Mit9kyTf///5e/P///OPVEowggAgCCGPVcN6/scLZChMa0fhpqpJKNJFWgy+XUT30a2QtZXWkakyQIY0LJgMhP4DPYMDGJFmUikj//ZaCJQLIpwGMDkGW//NixEgfE6qSdhaq5A1OkYWXb//6BVJFkiRIeKeLGYJt///5Ufvr/v/+RX//WKcO9/MCt6yaKQz1///+amPEn+XVFwAggAQAMGK/Nh//yH1N3ljIoZAoABydC9/MY7K8nf/7HTApgUAQGG20BjAEDLkUMzdB2//3pmqYuQDHIKBxIIuQMbhGP+tepSr1IEMFmkDIASwygWNgQA4b2f/zYMRbHyPCmn4W6uSiab///6i91Pqf//+ZP//lIen9P6zVIZFv6v/9A59Zr/lVCgAqAKBjAv2qKv/1OQNZWKfXbkrgARznLBAcImLchvWX/qWZGxERzgupA15cFWI2i0brUtX/+pc3LAdcATuHVHRK588v61sy6kLLjlijDrFJEsGyghEAEKCMMUm///W7nSdMDdZyiiz2/Zf/O//zYsRtHtvCnlYuaOb//Ul//WW////3+cNf8soRjjsBBEV/n0+X0qR0MUV3GamX6Bgmc4EJqs3j8epMWTUv/RSMiZHKDOQKu8DDQFGOKaCDs//16LF1EiorYDGA4BYjEEQHyQFL//86Tg6DMvIkFAw6BQcAUzFJn////6kG///lx1qW3/lgkf7e5wijaXqb/r81+YE+FU+KV30Nijn/82LEgR9rwpZOFurkAQBAu3smfyv9ygDXO3O5VFDxS0f6igo+ecYe6TooVqv6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oNZqVP/zYsT0JHq6HAAvZPBRQW1FqStdS/QW7qUtEsFt1OtcxGCI0GmOsVHbVDsK4iQOuyQNOVCYb+w1TEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVAjJCAhWzCuE2aNdzvHXcaaNQzqKIPmnVp72ObYBiQFE0tmLwKkikv69akmH8IBwHF0AeNsDc8T4SZ9BbL0VXRZ/Wy0UhnQxSNGv/82LE8iM6uhSiLuLySf5kXW//aCvln/5bg0gRclJaCrusNcl8sr54sDXZkiKGZqvhjTRGAnpeGDJuaiL7NxZ8wlZKji81bEwyIUBHAgkYGLoEy486HXHMSfORmy+Y++GAQphECCHIxVbMqPDvhOgwBdgqADDo9rCOvAjZ0rQKAFiRwZDBHNUC404QgYxCzBYCj4UhHHAamYQgQWNA//NgxNoaeZYF9g7oyCebHHnl96mq3Jmakskj03UzuVZqblFjuVWtduXblyuGTILC4qzb///ULC4riotVTEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//NixP8niZU8AM7zAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zYsRvAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU='
  };
  const recordedSounds={};
  let recordedSoundsPromise=null;
  let signalsUnlocked=false;

  function base64ToArrayBuffer(base64){
    const raw=atob(String(base64||'').replace(/\s+/g,''));
    const bytes=new Uint8Array(raw.length);
    for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
    return bytes.buffer;
  }

  function decodeTimerAudio(arrayBuffer){
    return new Promise((resolve,reject)=>{
      let settled=false;
      const ok=value=>{if(!settled){settled=true;resolve(value)}};
      const fail=err=>{if(!settled){settled=true;reject(err)}};
      try{
        const result=audioCtx.decodeAudioData(arrayBuffer.slice(0),ok,fail);
        if(result?.then)result.then(ok).catch(fail);
      }catch(err){fail(err)}
    });
  }

  function loadRecordedSounds(){
    if(recordedSoundsPromise)return recordedSoundsPromise;
    ensureAudio();
    recordedSoundsPromise=Promise.all(
      Object.entries(RECORDED_SOUND_BASE64).map(async([name,b64])=>{
        try{
          const clean=String(b64||'').replace(/\s+/g,'');
          if(clean.length<1000)throw new Error('embedded sound too small');
          recordedDataUrls[name]='data:audio/mpeg;base64,'+clean;
          recordedSounds[name]=await decodeTimerAudio(base64ToArrayBuffer(clean));
        }catch(err){
          lastAudioError=name+': '+String(err?.message||err);
          console.warn('Timer sound failed:',name,err);
        }
      })
    );
    return recordedSoundsPromise;
  }

  async function unlockSignals(){
    configureTimerAudioSession();
    const runningNow=await resumeAudioSafely();
    await loadRecordedSounds();
    signalsUnlocked=runningNow || Object.keys(recordedDataUrls).length===3;
    return signalsUnlocked;
  }

  function fallbackTimerTone(name,volume=.22){
    ensureAudio();
    if(!audioCtx)return;
    try{
      const now=audioCtx.currentTime;
      const gain=audioCtx.createGain();
      const osc=audioCtx.createOscillator();
      osc.type='sine';
      let dur=.10;

      if(name==='countdown'){
        osc.frequency.setValueAtTime(880,now);
        dur=.10;
      }else if(name==='workStart'){
        osc.frequency.setValueAtTime(760,now);
        osc.frequency.exponentialRampToValueAtTime(1320,now+.42);
        dur=.48;
      }else{
        osc.frequency.setValueAtTime(920,now);
        osc.frequency.exponentialRampToValueAtTime(620,now+.38);
        dur=.52;
      }

      gain.gain.setValueAtTime(.0001,now);
      gain.gain.exponentialRampToValueAtTime(Math.max(.02,volume),now+.008);
      gain.gain.exponentialRampToValueAtTime(.0001,now+dur);
      osc.connect(gain);
      if(timerMasterGain)gain.connect(timerMasterGain);
      else gain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now+dur+.02);
    }catch{}
  }

  function playHtmlRecorded(name){
    if(!sound)return false;
    const url=recordedDataUrls[name];
    if(!url)return false;
    try{
      configureTimerAudioSession();
      const audio=new Audio(url);
      audio.preload='auto';
      audio.playsInline=true;
      audio.volume=1;
      audio.addEventListener('ended',()=>releaseTimerAudioSession(),{once:true});
      audio.addEventListener('error',()=>{lastAudioError='HTMLAudio '+name+' failed'},{once:true});
      const p=audio.play();
      if(p?.catch)p.catch(err=>{lastAudioError='HTMLAudio '+name+': '+String(err?.message||err)});
      return true;
    }catch(err){
      lastAudioError='HTMLAudio '+name+': '+String(err?.message||err);
      return false;
    }
  }

  function playRecorded(name,volume=1){
    if(!sound)return false;
    configureTimerAudioSession();
    lastAudioCue=name;
    lastAudioCueAt=Date.now();

    if(document.hidden && playHtmlRecorded(name))return true;

    ensureAudio();
    const buffer=recordedSounds[name];
    if(!buffer){
      loadRecordedSounds();
      if(playHtmlRecorded(name))return true;
      fallbackTimerTone(name,.34);
      return !!audioCtx;
    }

    try{
      const src=audioCtx.createBufferSource();
      const gain=audioCtx.createGain();
      src.buffer=buffer;
      gain.gain.value=Math.max(1.05,Math.min(1.35,volume*1.15));
      src.connect(gain);
      if(timerMasterGain)gain.connect(timerMasterGain);
      else gain.connect(audioCtx.destination);
      src.onended=()=>releaseTimerAudioSession();
      src.start();
      return true;
    }catch(err){
      lastAudioError='WebAudio '+name+': '+String(err?.message||err);
      if(playHtmlRecorded(name))return true;
      fallbackTimerTone(name,.34);
      return !!audioCtx;
    }
  }

  function pulseTimerBackground(){ /* disabled by design */ }

  function softTick(){
    playRecorded('countdown',1);
  }

  async function playSignal(kind){
    if(!sound)return false;
    configureTimerAudioSession();
    await resumeAudioSafely();
    if(kind==='preStart')return playRecorded('countdown',1)!==false;
    if(kind==='workStart')return playRecorded('workStart',1)!==false;
    if(kind==='workEnd'||kind==='finish')return playRecorded('workEnd',1)!==false;
    return false;
  }

  function makeBackgroundKeeperWav(){
    const sr=8000,dur=2,frames=sr*dur;
    const bytes=new ArrayBuffer(44+frames*2),view=new DataView(bytes);
    const wr=(o,str)=>{for(let i=0;i<str.length;i++)view.setUint8(o+i,str.charCodeAt(i))};
    wr(0,'RIFF');view.setUint32(4,36+frames*2,true);wr(8,'WAVE');
    wr(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);
    view.setUint16(22,1,true);view.setUint32(24,sr,true);view.setUint32(28,sr*2,true);
    view.setUint16(32,2,true);view.setUint16(34,16,true);wr(36,'data');view.setUint32(40,frames*2,true);
    for(let i=0;i<frames;i++){
      const sample=Math.sin(2*Math.PI*55*(i/sr))*.00008;
      view.setInt16(44+i*2,Math.round(sample*32767),true);
    }
    return URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));
  }

  function setupMediaActions(){ /* intentionally disabled */ }

  function updateMediaCenter(){ /* intentionally disabled */ }

  async function startBackgroundKeeper(){
    configureTimerAudioSession();
  }

  function pauseBackgroundKeeper(){}

  function stopBackgroundKeeper(){
    lastMediaSecond=null;
    lastMediaKey='';
  }

  async function holdWakeLock(){
    try{
      if('wakeLock' in navigator && !wakeLock) wakeLock=await navigator.wakeLock.request('screen');
    }catch{}
  }
  function releaseWakeLock(){
    try{wakeLock?.release?.()}catch{}
    wakeLock=null;
  }

  const HAPTIC_PATTERNS={
    tap:[18],
    toggle:[30],
    workoutStart:[55,35,95],
    preWork3:[125,48,165],
    workStart:[90,45,135],
    workEnd:[130,55,90],
    countdown3:[28],
    countdown2:[42],
    countdown1:[75,30,110],
    finish:[120,55,170,60,220]
  };

  function pulseNativeSwitch(pattern){
    const sw=$('hapticSwitch');
    if(!sw) return false;
    const pulses=Array.isArray(pattern)?pattern:[pattern];
    let t=0;
    for(let i=0;i<pulses.length;i+=2){
      setTimeout(()=>{
        try{sw.click()}catch{}
      },t);
      t+=Number(pulses[i]||20)+Number(pulses[i+1]||0);
    }
    return true;
  }

  async function haptic(kind='tap'){
    if(!vibrate) return false;
    const pattern=Array.isArray(kind)||typeof kind==='number'
      ? kind
      : (HAPTIC_PATTERNS[kind]??HAPTIC_PATTERNS.tap);

    let fired=false;

    try{
      const cap=window.Capacitor?.Plugins?.Haptics;
      if(cap){
        const strong=['workStart','workEnd','finish','countdown1','workoutStart','preWork3'].includes(kind);
        if(cap.impact){
          await cap.impact({style:strong?'HEAVY':'MEDIUM'});
          fired=true;
        }
        if(Array.isArray(pattern)&&cap.vibrate){
          setTimeout(()=>cap.vibrate({duration:Math.max(...pattern)}).catch?.(()=>{}),40);
        }
      }
    }catch{}

    try{
      const bridge=window.webkit?.messageHandlers?.PulseHaptics
        || window.webkit?.messageHandlers?.haptics
        || window.webkit?.messageHandlers?.Haptics;
      if(bridge?.postMessage){
        bridge.postMessage({kind,pattern});
        fired=true;
      }
    }catch{}

    try{
      if(typeof navigator.vibrate==='function'){
        const ok=navigator.vibrate(pattern);
        fired=ok||fired;
      }
    }catch{}

    pulseNativeSwitch(pattern);
    return fired;
  }

  function buildPhases(w){
    const out=[];
    if(w.prep>0) out.push({label:'ПОДГОТОВКА',duration:w.prep,type:'prep',set:1,cycle:0});
    for(let s=1;s<=w.sets;s++){
      for(let c=1;c<=w.cycles;c++){
        out.push({label:'РАБОТА',duration:w.work,type:'work',set:s,cycle:c});
        if(c<w.cycles && w.rest>0) out.push({label:'ОТДЫХ',duration:w.rest,type:'rest',set:s,cycle:c});
      }
      if(s<w.sets && w.setRest>0) out.push({label:'ОТДЫХ МЕЖДУ ПОДХОДАМИ',duration:w.setRest,type:'rest',set:s,cycle:w.cycles});
    }
    if(w.coolDown>0) out.push({label:'ЗАМИНКА',duration:w.coolDown,type:'rest',set:w.sets,cycle:w.cycles});
    return out;
  }
  function totalSeconds(w){return buildPhases(w).reduce((a,p)=>a+p.duration,0)}

  function show(id){
    ['screen','editor','timer'].forEach(x=>$(x).classList.add('hidden'));
    $(id).classList.remove('hidden');
  }

  const CARD_PHOTOS={
    press:'https://images.unsplash.com/photo-1547919307-1ecb10702e6f?auto=format&fit=crop&fm=jpg&q=88&w=1800',
    training:'https://images.unsplash.com/photo-1734630341082-0fec0e10126c?auto=format&fit=crop&fm=jpg&q=88&w=1800',
    hiit:'https://images.unsplash.com/photo-1734630341082-0fec0e10126c?auto=format&fit=crop&fm=jpg&q=88&w=1800',
    cardio:'https://images.unsplash.com/photo-1734630341082-0fec0e10126c?auto=format&fit=crop&fm=jpg&q=88&w=1800',
    stretch:'https://images.unsplash.com/photo-1547919307-1ecb10702e6f?auto=format&fit=crop&fm=jpg&q=88&w=1800'
  };

  function workoutKind(w){
    const n=String(w?.name||'').toUpperCase();
    if(n.includes('ПРЕСС')) return 'press';
    if(n.includes('HIIT')||n.includes('ХИИТ')) return 'hiit';
    if(n.includes('КАРДИО')) return 'cardio';
    if(n.includes('РАСТЯЖ')) return 'stretch';
    return 'training';
  }

  function workoutIconSvg(kind){
    if(kind==='cardio') return '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="14" cy="4.5" r="1.7"/><path d="m9.5 9 3-2 2.5 2.2 3.2 1.1M12.4 8.2l-2 4.1-3.7 2.1M10.4 12.3l3 2.2 1.2 4M8.2 14.9 5 18.3"/></svg>';
    if(kind==='stretch') return '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="4.2" r="1.7"/><path d="M12 6.5v5.1m0-2.5-4.2 2.3M12 9.1l4.4 2.2M12 11.6l-2.6 4.2-3.7 2.4M12 11.6l2.7 4.1 3.8 2.4"/></svg>';
    if(kind==='hiit') return '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M8.2 9.2a4.2 4.2 0 1 1 7.6 0"/><path d="M7.2 9.2h9.6l1.4 9.3H5.8z"/><path d="M10.2 9.2V7.8a1.8 1.8 0 0 1 3.6 0v1.4"/></svg>';
    return '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8v8M3.5 9.5v5M18 8v8M20.5 9.5v5M6 12h12"/></svg>';
  }

  function renderCards(){
    $('cards').innerHTML=workouts.map(w=>{
      const kind=workoutKind(w);
      const photo=CARD_PHOTOS[kind]||CARD_PHOTOS.training;
      return `
        <div class="card-row" data-id="${w.id}">
          <div class="card-delete-underlay" aria-hidden="true">
            <span>Удалить</span>
            <svg viewBox="0 0 24 24" fill="none" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>
          </div>
          <article class="card exact-art" data-theme="${w.color||'graphite'}" data-id="${w.id}">
            <div class="card-photo" style="--photo:url('${photo}')"></div>
            <div class="card-live">
              <button class="card-primary play-btn" data-id="${w.id}" aria-label="Запустить ${esc(w.name)}">
                <span class="card-sport-icon">${workoutIconSvg(kind)}</span>
                <strong class="card-live-title">${esc(w.name)}</strong>
                <span class="card-live-stats" aria-hidden="true">
                  <span class="card-live-stat"><b>${w.work}</b><span>Работа</span></span>
                  <span class="card-live-stat"><b>${w.rest}</b><span>Отдых</span></span>
                  <span class="card-live-stat"><b>${w.cycles}</b><span>Циклы</span></span>
                  <span class="card-live-stat"><b>${w.sets}</b><span>Подходы</span></span>
                </span>
              </button>
              <div class="card-live-actions">
                <button class="card-live-action menu menu-btn" data-id="${w.id}" aria-label="Действия">
                  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>
                </button>
                <button class="card-live-action play-btn" data-id="${w.id}" aria-label="Запустить">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linejoin="round"><path d="M8 5.5v13l10-6.5-10-6.5Z"/></svg>
                </button>
              </div>
            </div>
          </article>
        </div>
      `;
    }).join('');
  }

  function openCardMenu(id){
    const w=workouts.find(x=>x.id===id);
    if(!w)return;
    cardMenuWorkoutId=id;
    $('cardMenuTitle').textContent=w.name;
    $('cardMenuModal').classList.remove('hidden');
    haptic(10);
  }
  function closeCardMenu(){
    $('cardMenuModal').classList.add('hidden');
    cardMenuWorkoutId=null;
  }

  function openEditor(id){
    const existing=id?workouts.find(w=>w.id===id):null;
    editing=existing?{...existing}:{id:uid(),name:'НОВАЯ ТРЕНИРОВКА',prep:10,work:30,rest:60,cycles:8,sets:1,setRest:120,coolDown:0,color:'graphite',finishVoiceId:''};
    $('nameInput').value=editing.name;
    $('deleteBtn').classList.toggle('hidden',!existing);
    renderEditor();
    show('editor');
  }

  function renderEditor(){
    $('editorList').innerHTML=fieldMeta.map(([key,label,unit,min,step])=>`
      <div class="edit-row">
        <span>${label}</span>
        <div class="stepper">
          <button class="adjust-btn" data-key="${key}" data-delta="-${step}" data-min="${min}">−</button>
          <button class="value-btn pad-btn" data-key="${key}">${editing[key]}${unit?`<small>${unit}</small>`:''}</button>
          <button class="adjust-btn" data-key="${key}" data-delta="${step}" data-min="${min}">＋</button>
        </div>
      </div>
    `).join('');
    $('colorPicker').innerHTML=COLOR_OPTIONS.map(([key,label])=>`
      <button class="color-dot ${editing.color===key?'active':''}" data-color="${key}" aria-label="${label}" title="${label}"></button>
    `).join('');
    renderVoicePicker();
  }

  function showToast(message){
    const el=$('toast');
    clearTimeout(toastTimer);
    el.textContent=message;
    el.classList.add('show');
    toastTimer=setTimeout(()=>el.classList.remove('show'),1800);
  }

  function base64UrlEncode(text){
    const bytes=new TextEncoder().encode(text);
    let binary='';
    bytes.forEach(b=>binary+=String.fromCharCode(b));
    return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }

  function base64UrlDecode(token){
    let b64=String(token||'').replace(/-/g,'+').replace(/_/g,'/');
    while(b64.length%4)b64+='=';
    const binary=atob(b64);
    const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  function encodeWorkout(w){
    const n=normalize(w);
    return base64UrlEncode(JSON.stringify({
      v:1,name:n.name,prep:n.prep,work:n.work,rest:n.rest,cycles:n.cycles,
      sets:n.sets,setRest:n.setRest,coolDown:n.coolDown,color:n.color,finishVoiceId:n.finishVoiceId
    }));
  }

  function decodeWorkout(token){
    const data=JSON.parse(base64UrlDecode(token));
    if(!data||data.v!==1) throw new Error('Unsupported workout');
    return normalize({...data,id:uid()});
  }

  function workoutSignature(w){
    return [w.name,w.prep,w.work,w.rest,w.cycles,w.sets,w.setRest,w.coolDown,w.color,w.finishVoiceId].join('|');
  }

  function workoutShareUrl(w){
    const u=new URL('https://pulse-timer-matvey-v2.onrender.com/');
    u.searchParams.set('v','1215');
    u.searchParams.set('workout',encodeWorkout(w));
    return u.toString();
  }

  function closeShare(){
    $('shareOverlay').classList.add('hidden');
    shareWorkout=null;
  }

  function openShare(w){
    shareWorkout=normalize(w);
    currentShareUrl=workoutShareUrl(shareWorkout);
    $('sharePreview').innerHTML=`
      <h3>${esc(shareWorkout.name)}</h3>
      <div class="share-preview-stats">
        <div><span>Работа</span><b>${shareWorkout.work}</b></div>
        <div><span>Отдых</span><b>${shareWorkout.rest}</b></div>
        <div><span>Циклы</span><b>${shareWorkout.cycles}</b></div>
        <div><span>Подходы</span><b>${shareWorkout.sets}</b></div>
      </div>`;
    $('shareUrlText').textContent=currentShareUrl;
    $('shareQr').src='https://quickchart.io/qr?size=420&margin=1&ecLevel=M&dark=000000&light=ffffff&text='+encodeURIComponent(currentShareUrl);
    $('shareOverlay').classList.remove('hidden');
    haptic(12);
  }

  async function copyShare(){
    if(!currentShareUrl)return;
    try{await navigator.clipboard.writeText(currentShareUrl)}
    catch{
      const ta=document.createElement('textarea');
      ta.value=currentShareUrl;ta.style.position='fixed';ta.style.opacity='0';
      document.body.appendChild(ta);ta.select();
      try{document.execCommand('copy')}catch{}
      ta.remove();
    }
    showToast('Ссылка скопирована');
    haptic(10);
  }

  async function nativeShare(){
    if(!shareWorkout||!currentShareUrl)return;
    if(navigator.share){
      try{
        await navigator.share({title:'Pulse Timer — '+shareWorkout.name,text:'Тренировка '+shareWorkout.name+' в Pulse Timer',url:currentShareUrl});
        return;
      }catch(err){if(err?.name==='AbortError')return}
    }
    await copyShare();
  }

  function importSharedWorkout(){
    const u=new URL(location.href);
    const token=u.searchParams.get('workout');
    if(!token)return;
    try{
      const imported=decodeWorkout(token);
      const sig=workoutSignature(imported);
      const exists=workouts.some(w=>workoutSignature(w)===sig);
      if(!exists){
        workouts.unshift(imported);
        saveWorkouts();
        setTimeout(()=>showToast('Тренировка добавлена'),900);
      }else setTimeout(()=>showToast('Тренировка уже сохранена'),900);
    }catch{
      setTimeout(()=>showToast('Не удалось открыть тренировку'),900);
    }
    u.searchParams.delete('workout');
    try{history.replaceState({},'',u.pathname+(u.search||'')+u.hash)}catch{}
  }

  function commitEditor(){
    editing.name=($('nameInput').value.trim()||'ТРЕНИРОВКА').toUpperCase();
    const clean=normalize(editing);
    const idx=workouts.findIndex(w=>w.id===clean.id);
    if(idx>=0) workouts[idx]=clean; else workouts.unshift(clean);
    editing=clean;
    saveWorkouts();
    document.addEventListener('pointerdown',()=>{unlockSignals()},{once:true,capture:true});
  document.addEventListener('touchstart',()=>{unlockSignals()},{once:true,capture:true,passive:true});
  renderCards();
  }

  function openPad(key){
    padField=key;
    padDraft=String(editing[key]??0);
    $('numpadValue').textContent=padDraft;
    $('numpad').classList.remove('hidden');
  }

  const keys=['1','2','3','4','5','6','7','8','9','⌫','0','✓'];
  $('keys').innerHTML=keys.map(k=>`<button data-key="${k}">${k}</button>`).join('');

  async function playFinishSequence(){
    if(finishSequencePlayed)return;
    pendingFinishCue=false;
    await unlockSignals();
    const bellPlayed=await playSignal('finish');
    if(!bellPlayed && document.hidden){
      pendingFinishCue=true;
      return;
    }
    finishSequencePlayed=true;
    haptic('finish');
    const voiceId=active?.finishVoiceId||'';
    if(voiceId)setTimeout(()=>playFinishVoice(voiceId),700);
  }

  async function startWorkout(w){
    await unlockSignals();
    active=normalize(w);
    phases=buildPhases(active);
    if(!phases.length) return;
    phaseIndex=0;
    remainingMs=phases[0].duration*1000;
    deadline=Date.now()+remainingMs;
    running=true;
    lastCountdownSec=null;
    finishSequencePlayed=false;
    pendingFinishCue=false;
    show('timer');
    renderTimer(true);
    updatePauseIcon();
    startTicker();
    startBackgroundKeeper();
    holdWakeLock();
    haptic('workoutStart');
    playSignal('ready');
  }

  function startTicker(){
    clearInterval(tickId);
    tickId=setInterval(()=>{
      if(!running||!active) return;
      remainingMs=Math.max(0,deadline-Date.now());
      if(remainingMs<=0){
        catchUpFromBackground(-remainingMs);
        return;
      }
      const sec=Math.ceil(remainingMs/1000);
      if(sec<=3&&sec>=1&&sec!==lastCountdownSec){
        lastCountdownSec=sec;
        const next=phases[phaseIndex+1];
        const workStartsNext=!!next && next.type==='work';

        if(sec===3 && workStartsNext){
          haptic('preWork3');
          playSignal('preStart');
        }else{
          haptic(sec===3?'countdown3':sec===2?'countdown2':'countdown1');
          softTick(sec);
        }
      }
      renderTimer(false);
    },200);
  }

  function catchUpFromBackground(overrunMs){
    const now=Date.now();
    let over=Math.max(0,overrunMs);
    let previous=phases[phaseIndex];

    while(true){
      if(phaseIndex>=phases.length-1){
        running=false;
        remainingMs=0;
        renderTimer(false);
        updatePauseIcon();
        stopBackgroundKeeper();
        releaseWakeLock();
        playFinishSequence();
        return;
      }

      phaseIndex++;
      const current=phases[phaseIndex];
      const durationMs=current.duration*1000;

      if(over<durationMs){
        remainingMs=durationMs-over;
        deadline=now+remainingMs;
        lastCountdownSec=null;

        if(over<1500){
          if(previous?.type==='work' && current.type!=='work'){
            playSignal('workEnd');haptic('workEnd');
          }
          if(current.type==='work'){
            playSignal('workStart');haptic('workStart');
          }
        }
        renderTimer(true);
        return;
      }

      over-=durationMs;
      previous=current;
    }
  }

  function nextPhase(auto){
    const prev=phases[phaseIndex];
    const next=phaseIndex+1;

    if(next>=phases.length){
      running=false;
      remainingMs=0;
      renderTimer(false);
      updatePauseIcon();
      stopBackgroundKeeper();
      releaseWakeLock();
      if(auto)playFinishSequence();
      return;
    }

    phaseIndex=next;
    remainingMs=phases[phaseIndex].duration*1000;
    deadline=Date.now()+remainingMs;
    lastCountdownSec=null;
    const p=phases[phaseIndex];

    if(auto){
      if(prev?.type==='work' && p.type!=='work'){
        playSignal('workEnd');
        haptic('workEnd');
      }
      if(p.type==='work'){
        playSignal('workStart');
        haptic('workStart');
      }
    }
    renderTimer(true);
  }

  function previousPhase(){
    phaseIndex=Math.max(0,phaseIndex-1);
    remainingMs=phases[phaseIndex].duration*1000;
    deadline=Date.now()+remainingMs;
    lastCountdownSec=null;
    renderTimer(true);
    haptic(12);
  }

  function selectPhase(index){
    if(index<0||index>=phases.length) return;
    phaseIndex=index;
    remainingMs=phases[index].duration*1000;
    deadline=Date.now()+remainingMs;
    lastCountdownSec=null;
    renderTimer(true);
    haptic(12);
  }

  function renderTimer(scroll){
    if(!active||!phases.length) return;
    const p=phases[phaseIndex];
    const chrome=p.type==='prep'?'#10361a':p.type==='work'?'#168fc5':'#0b1631';
    document.documentElement.style.setProperty('--phase',chrome);
    document.documentElement.style.setProperty('--page',chrome);
    $('phaseBg').className='phase-bg '+p.type;
    $('themeColor').setAttribute('content',chrome);

    const total=phases.reduce((s,x)=>s+x.duration,0);
    const before=phases.slice(0,phaseIndex).reduce((s,x)=>s+x.duration,0);
    const currentElapsed=Math.max(0,p.duration-remainingMs/1000);
    const elapsed=before+currentElapsed;

    $('timerSub').textContent='Подход '+p.set+'/'+active.sets+' · Цикл '+Math.max(1,p.cycle)+'/'+active.cycles;
    $('phaseTitle').textContent=p.label;
    $('timerNumber').textContent=Math.max(0,Math.ceil(remainingMs/1000));
    $('timerTotal').textContent='/ '+p.duration+' сек';
    $('remainTotal').textContent=fmt(Math.max(0,total-elapsed));
    $('allTotal').textContent=fmt(total);
    $('progressBar').style.width=(total?Math.min(100,elapsed/total*100):0)+'%';
    $('intervalCounter').textContent=(phaseIndex+1)+'/'+phases.length;
    updateMediaCenter(false);

    $('intervals').innerHTML=phases.map((x,i)=>`
      <button class="int-row ${i===phaseIndex?'current':''}" data-index="${i}">
        <span class="int-index">${i+1}</span>
        <b class="int-label">${esc(x.label)}</b>
        <span class="int-duration">${x.duration} сек</span>
      </button>
    `).join('');

    if(scroll) requestAnimationFrame(()=>document.querySelector('.int-row.current')?.scrollIntoView({block:'nearest',behavior:'smooth'}));
  }

  function updatePauseIcon(){
    $('pauseBtn').innerHTML=running
      ? '<svg class="icon timer-icon" viewBox="0 0 24 24"><path d="M9 6v12M15 6v12"/></svg>'
      : '<svg class="icon timer-icon" viewBox="0 0 24 24"><path d="M8 5.5v13l10-6.5-10-6.5Z"/></svg>';
  }

  let swipeState=null;
  let suppressCardClickUntil=0;

  function deleteWorkoutBySwipe(id,row){
    if(!id)return;
    row?.classList.add('deleting');
    haptic(18);
    setTimeout(()=>{
      workouts=workouts.filter(w=>w.id!==id);
      saveWorkouts();
      renderCards();
      showToast('Тренировка удалена');
    },170);
  }

  $('cards').addEventListener('pointerdown',e=>{
    if(e.pointerType==='mouse' && e.button!==0)return;
    if(e.target.closest('.card-live-action'))return;
    const row=e.target.closest('.card-row');
    const card=row?.querySelector('.card.exact-art');
    if(!row||!card)return;
    swipeState={
      pointerId:e.pointerId,
      row,card,
      id:row.dataset.id,
      startX:e.clientX,
      startY:e.clientY,
      dx:0,
      horizontal:false,
      cancelled:false
    };
    try{row.setPointerCapture(e.pointerId)}catch{}
  });

  $('cards').addEventListener('pointermove',e=>{
    const st=swipeState;
    if(!st||st.pointerId!==e.pointerId||st.cancelled)return;
    const rawX=e.clientX-st.startX;
    const rawY=e.clientY-st.startY;

    if(!st.horizontal){
      if(Math.abs(rawY)>10 && Math.abs(rawY)>Math.abs(rawX)){
        st.cancelled=true;
        st.row.classList.remove('is-dragging');
        st.card.style.transform='';
        return;
      }
      if(Math.abs(rawX)>8 && Math.abs(rawX)>Math.abs(rawY)*1.15){
        st.horizontal=true;
        st.row.classList.add('is-dragging');
      }else return;
    }

    e.preventDefault();
    const width=st.row.getBoundingClientRect().width||1;
    const dx=Math.max(-width,Math.min(0,rawX));
    st.dx=dx;
    const resistance=dx<-width*.58 ? -width*.58+(dx+width*.58)*.38 : dx;
    st.card.style.transform=`translateX(${resistance}px)`;
  },{passive:false});

  function finishCardSwipe(e){
    const st=swipeState;
    if(!st||st.pointerId!==e.pointerId)return;
    swipeState=null;
    st.row.classList.remove('is-dragging');
    try{st.row.releasePointerCapture(e.pointerId)}catch{}

    if(st.cancelled){
      st.card.style.transform='';
      return;
    }

    const width=st.row.getBoundingClientRect().width||1;
    const shouldDelete=st.horizontal && st.dx<-Math.max(88,width*.28);
    if(shouldDelete){
      suppressCardClickUntil=Date.now()+450;
      deleteWorkoutBySwipe(st.id,st.row);
    }else{
      st.card.style.transform='';
      if(st.horizontal)suppressCardClickUntil=Date.now()+220;
    }
  }

  $('cards').addEventListener('pointerup',finishCardSwipe);
  $('cards').addEventListener('pointercancel',finishCardSwipe);

  $('cards').addEventListener('click',e=>{
    if(Date.now()<suppressCardClickUntil){
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const menu=e.target.closest('.menu-btn');
    const play=e.target.closest('.play-btn');
    if(menu){openCardMenu(menu.dataset.id);return}
    if(play){const w=workouts.find(x=>x.id===play.dataset.id);if(w)startWorkout(w)}
  });

  $('cardMenuEdit').addEventListener('click',()=>{
    const id=cardMenuWorkoutId;closeCardMenu();if(id)openEditor(id);
  });
  $('cardMenuShare').addEventListener('click',()=>{
    const w=workouts.find(x=>x.id===cardMenuWorkoutId);closeCardMenu();if(w)openShare(w);
  });
  $('cardMenuCancel').addEventListener('click',closeCardMenu);
  $('cardMenuModal').addEventListener('click',e=>{if(e.target===$('cardMenuModal'))closeCardMenu()});

  $('addBtn').addEventListener('click',()=>{openEditor(null);haptic(10)});
  $('settingsBtn').addEventListener('click',()=>{
    $('settings').classList.toggle('hidden');
    refreshVoiceLibrary();
  });

  $('addVoiceBtn').addEventListener('click',()=>$('voiceFileInput').click());
  $('voiceFileInput').addEventListener('change',async e=>{
    const file=e.target.files?.[0];
    e.target.value='';
    if(file)await addVoiceClip(file);
  });
  $('voiceLibrary').addEventListener('click',e=>{
    const btn=e.target.closest('[data-voice-remove]');
    if(btn)removeVoiceClip(btn.dataset.voiceRemove);
  });
  $('voicePicker').addEventListener('click',e=>{
    const btn=e.target.closest('[data-voice-id]');
    if(!btn||!editing)return;
    editing.finishVoiceId=btn.dataset.voiceId||'';
    renderVoicePicker();
    haptic(8);
  });

  $('colorPicker').addEventListener('click',e=>{
    const btn=e.target.closest('.color-dot');
    if(!btn||!editing)return;
    editing.color=btn.dataset.color;
    renderEditor();
    haptic(8);
  });

  $('shareBack').addEventListener('click',closeShare);
  $('shareOverlay').addEventListener('click',e=>{if(e.target===$('shareOverlay'))closeShare()});
  $('copyShareInline').addEventListener('click',copyShare);
  $('copyShareBtn').addEventListener('click',copyShare);
  $('nativeShareBtn').addEventListener('click',nativeShare);

  $('editorList').addEventListener('click',e=>{
    const adj=e.target.closest('.adjust-btn');
    const pad=e.target.closest('.pad-btn');
    if(adj){
      const key=adj.dataset.key,min=Number(adj.dataset.min),delta=Number(adj.dataset.delta);
      editing[key]=Math.max(min,Number(editing[key])+delta);
      renderEditor();haptic(8);
    }else if(pad) openPad(pad.dataset.key);
  });

  $('keys').addEventListener('click',e=>{
    const k=e.target.dataset.key;
    if(!k)return;
    haptic(8);
    if(k==='⌫') padDraft=padDraft.slice(0,-1);
    else if(k==='✓'){
      const meta=fieldMeta.find(x=>x[0]===padField);
      editing[padField]=Math.max(meta?meta[3]:0,Number(padDraft||0));
      $('numpad').classList.add('hidden');
      renderEditor();
      return;
    }else padDraft=(padDraft==='0'?k:padDraft+k).slice(0,5);
    $('numpadValue').textContent=padDraft||'0';
  });

  $('numpad').addEventListener('click',e=>{if(e.target===$('numpad'))$('numpad').classList.add('hidden')});

  $('editorBack').addEventListener('click',()=>show('screen'));
  $('saveBtn').addEventListener('click',()=>{commitEditor();show('screen');haptic(12)});
  $('editorStart').addEventListener('click',()=>{commitEditor();startWorkout(editing)});
  $('deleteBtn').addEventListener('click',()=>{
    if(!editing)return;
    if(confirm('Удалить тренировку?')){
      workouts=workouts.filter(w=>w.id!==editing.id);
      saveWorkouts();renderCards();show('screen');
    }
  });

  $('pauseBtn').addEventListener('click',()=>{
    if(!active)return;
    if(running){
      remainingMs=Math.max(0,deadline-Date.now());
      running=false;
      pauseBackgroundKeeper();
      releaseWakeLock();
    }else{
      if(remainingMs<=0) remainingMs=phases[phaseIndex].duration*1000;
      deadline=Date.now()+remainingMs;
      running=true;
      ensureAudio();
      startBackgroundKeeper();
      holdWakeLock();
    }
    updatePauseIcon();
    updateMediaCenter(true);
    haptic(12);
  });

  $('prevBtn').addEventListener('click',previousPhase);
  $('nextBtn').addEventListener('click',()=>{if(phaseIndex<phases.length-1)nextPhase(false)});
  $('intervals').addEventListener('click',e=>{
    const row=e.target.closest('.int-row');
    if(row)selectPhase(Number(row.dataset.index));
  });

  $('exitBtn').addEventListener('click',()=>{
    if(!active)return;
    resumeAfterModal=running;
    if(running){
      remainingMs=Math.max(0,deadline-Date.now());
      running=false;
      updatePauseIcon();
    }
    $('exitModal').classList.remove('hidden');
  });

  $('continueBtn').addEventListener('click',()=>{
    $('exitModal').classList.add('hidden');
    if(active&&resumeAfterModal&&remainingMs>0){
      deadline=Date.now()+remainingMs;
      running=true;
      updatePauseIcon();
      startBackgroundKeeper();
      holdWakeLock();
    }
  });

  $('confirmExitBtn').addEventListener('click',()=>{
    $('exitModal').classList.add('hidden');
    running=false;active=null;phases=[];clearInterval(tickId);stopBackgroundKeeper();releaseWakeLock();
    document.documentElement.style.setProperty('--phase','#10361a');
    document.documentElement.style.setProperty('--page','#050505');
    $('themeColor').setAttribute('content','#050505');
    show('screen');renderCards();
  });

  $('testSoundBtn').addEventListener('click',async()=>{
    sound=true;
    $('soundToggle').checked=true;
    savePrefs();
    await unlockSignals();
    playSignal('workStart');
    setTimeout(()=>playSignal('workEnd'),1100);
  });

  $('soundToggle').checked=sound;
  $('vibrateToggle').checked=vibrate;
  $('soundToggle').addEventListener('change',async e=>{sound=e.target.checked;savePrefs();if(sound){await unlockSignals();playSignal('ready')}});
  $('vibrateToggle').addEventListener('change',e=>{vibrate=e.target.checked;savePrefs();if(vibrate)haptic('toggle')});

  const primeAudioFromGesture=()=>{
    configureTimerAudioSession();
    resumeAudioSafely();
    loadRecordedSounds();
  };
  document.addEventListener('pointerdown',primeAudioFromGesture,{capture:true});
  document.addEventListener('touchstart',primeAudioFromGesture,{capture:true,passive:true});

  ['gesturestart','gesturechange'].forEach(type=>document.addEventListener(type,e=>e.preventDefault(),{passive:false}));
  document.addEventListener('touchmove',e=>{if(e.touches?.length>1)e.preventDefault()},{passive:false});
  document.addEventListener('dblclick',e=>e.preventDefault(),{passive:false});
  document.addEventListener('contextmenu',e=>e.preventDefault());
  document.addEventListener('selectstart',e=>e.preventDefault());

  function syncViewportHeight(){
    const portrait=window.matchMedia('(orientation: portrait)').matches;
    const sw=Number(window.screen?.width)||0;
    const sh=Number(window.screen?.height)||0;
    const physicalH=sw&&sh?(portrait?Math.max(sw,sh):Math.min(sw,sh)):0;
    const visualH=Number(window.visualViewport?.height)||0;
    const innerH=Number(window.innerHeight)||0;
    const h=Math.max(physicalH,visualH,innerH);
    if(h>0) document.documentElement.style.setProperty('--app-h',Math.round(h)+'px');
  }
  syncViewportHeight();
  window.addEventListener('resize',syncViewportHeight);
  window.addEventListener('orientationchange',()=>setTimeout(syncViewportHeight,120));
  window.visualViewport?.addEventListener('resize',syncViewportHeight);

  document.addEventListener('visibilitychange',async()=>{
    if(!document.hidden){
      configureTimerAudioSession();
      const badState=!audioCtx || audioCtx.state==='interrupted' || audioCtx.state==='closed';
      if(badState)await rebuildAudioContext();
      else await resumeAudioSafely();
    }
    if(!document.hidden && pendingFinishCue && active)playFinishSequence();
    if(!document.hidden && active){
      if(running){
        remainingMs=deadline-Date.now();
        if(remainingMs<=0)catchUpFromBackground(-remainingMs);
        else renderTimer(false);
        startBackgroundKeeper();
        holdWakeLock();
      }
    }
  });
  window.addEventListener('pageshow',()=>{
    if(active&&running){
      remainingMs=deadline-Date.now();
      if(remainingMs<=0)catchUpFromBackground(-remainingMs);
      else renderTimer(false);
    }
  });

  window.__pulseAudioDiagnostics={
    get status(){
      return {
        soundEnabled:sound,
        sessionType:('audioSession' in navigator)?navigator.audioSession.type:'unsupported',
        contextState:audioCtx?.state||'none',
        generation:audioGeneration,
        embedded:{
          countdown:RECORDED_SOUND_BASE64.countdown.length,
          workStart:RECORDED_SOUND_BASE64.workStart.length,
          workEnd:RECORDED_SOUND_BASE64.workEnd.length
        },
        decoded:Object.fromEntries(Object.entries(recordedSounds).map(([k,v])=>[k,{
          duration:Number(v?.duration||0),
          sampleRate:Number(v?.sampleRate||0)
        }])),
        lastCue:lastAudioCue,
        lastCueAt:lastAudioCueAt,
        lastError:lastAudioError
      };
    },
    async selfTest(){await unlockSignals();return this.status},
    async testStart(){await unlockSignals();return playSignal('workStart')},
    async testEnd(){await unlockSignals();return playSignal('workEnd')}
  };

  configureTimerAudioSession();
  loadRecordedSounds();
  refreshVoiceLibrary();
  importSharedWorkout();
  renderCards();

  const started=performance.now();
  const waitLoad=document.readyState==='complete'?Promise.resolve():new Promise(r=>window.addEventListener('load',r,{once:true}));
  const waitFonts=document.fonts?.ready?document.fonts.ready.catch(()=>{}):Promise.resolve();
  Promise.race([Promise.all([waitLoad,waitFonts]),new Promise(r=>setTimeout(r,1500))]).then(()=>{
    const delay=Math.max(0,650-(performance.now()-started));
    setTimeout(()=>{
      $('splash').classList.add('fade');
      setTimeout(()=>$('splash').classList.add('hidden'),430);
    },delay);
  });
})();
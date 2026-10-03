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

  const audio = window.PulseAudioEngine.create({ isEnabled: () => sound });
  const unlockSignals = () => audio.unlock();
  const playSignal = kind => audio.playSignal(kind);
  const softTick = () => audio.playSignal('countdown');
  const startBackgroundKeeper = () => audio.startCarrier();
  const pauseBackgroundKeeper = () => audio.stopCarrier();
  const stopBackgroundKeeper = () => audio.stopCarrier();
  const updateMediaCenter = () => {};
  audio.bindGestureUnlock(document);
  window.__pulseAudioDiagnostics = audio;

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
  let shareWorkout = null;
  let currentShareUrl = '';
  let toastTimer = null;
  let cardMenuWorkoutId = null;
  let wakeLock = null;
  let finishSequencePlayed = false;
  let pendingFinishCue = false;
  let voiceLibrary = [];
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

  async function getVoiceBlob(id){
    if(!id)return null;
    try{
      const db=await openVoiceDb();
      return await new Promise((resolve,reject)=>{
        const tx=db.transaction('clips','readonly');
        const req=tx.objectStore('clips').get(id);
        req.onsuccess=()=>resolve(req.result?.blob||null);
        req.onerror=()=>reject(req.error);
      });
    }catch{
      return null;
    }
  }

  async function playFinishVoice(id){
    if(!sound||!id)return false;
    const blob=await getVoiceBlob(id);
    return blob ? audio.playBlob(blob,.95) : false;
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
      unlockSignals();
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
  $('soundToggle').addEventListener('change',async e=>{
    sound=e.target.checked;
    savePrefs();
    if(sound){
      await unlockSignals();
      playSignal('countdown');
    }else{
      stopBackgroundKeeper();
    }
  });
  $('vibrateToggle').addEventListener('change',e=>{vibrate=e.target.checked;savePrefs();if(vibrate)haptic('toggle')});

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
    await audio.onVisibilityChange(document.hidden);
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
    audio.onVisibilityChange(false);
    if(active&&running){
      remainingMs=deadline-Date.now();
      if(remainingMs<=0)catchUpFromBackground(-remainingMs);
      else renderTimer(false);
    }
  });

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
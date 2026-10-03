(() => {
  'use strict';

  const CUE_DATA = Object.freeze({
    countdown: '__COUNTDOWN_B64__',
    workStart: '__WORK_START_B64__',
    workEnd: '__WORK_END_B64__'
  });

  const CUE_GAIN = Object.freeze({
    countdown: 0.98,
    workStart: 1.05,
    workEnd: 1.12
  });

  const RESUME_TIMEOUT_MS = 500;
  const MASTER_GAIN = 3.25;
  const CARRIER_FREQUENCY_HZ = 18;
  const CARRIER_GAIN = 0.000008;

  function decodeBase64(base64) {
    const raw = atob(String(base64 || '').replace(/\s+/g, ''));
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return bytes.buffer;
  }

  function create({ isEnabled = () => true } = {}) {
    let context = null;
    let master = null;
    let limiter = null;
    let carrier = null;
    let carrierGain = null;
    let generation = 0;
    let decodePromise = null;
    let lastError = '';
    let lastCue = '';
    let lastCueAt = 0;
    let cueCount = 0;
    let sessionTransitionCount = 0;
    let cueChain = Promise.resolve();
    const buffers = new Map();
    const voiceCache = new WeakMap();

    function recordError(error, prefix = '') {
      const message = String(error?.message || error || 'unknown audio error');
      lastError = prefix ? prefix + ': ' + message : message;
      console.warn('[PulseAudio]', lastError);
    }

    function configureMixingSession() {
      if (!('audioSession' in navigator)) return;
      try {
        navigator.audioSession.type = 'ambient';
        sessionTransitionCount += 1;
      } catch (error) {
        recordError(error, 'audioSession idle');
      }
    }

    async function activateAudibleCueSession() {
      if (!('audioSession' in navigator)) return;
      try {
        // iOS mutes ambient/transient sessions when the Ring/Silent switch is on.
        // Force a real category transition for every cue. Cycling through ambient
        // also works around WebKit sessions whose cached playback category went stale.
        if (navigator.audioSession.type === 'playback') {
          navigator.audioSession.type = 'ambient';
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        navigator.audioSession.type = 'playback';
        sessionTransitionCount += 1;
      } catch (error) {
        recordError(error, 'audioSession cue');
      }
    }

    async function releaseAudibleCueSession() {
      try {
        if (context?.state === 'running') {
          await Promise.race([
            context.suspend(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('suspend timeout')), RESUME_TIMEOUT_MS))
          ]);
        }
      } catch (error) {
        recordError(error, 'suspend after cue');
      }

      if (!('audioSession' in navigator)) return;
      try {
        // Change category only after WebAudio has stopped rendering. This avoids
        // the iOS state where AudioContext says "running" but later cues are silent.
        navigator.audioSession.type = 'ambient';
        sessionTransitionCount += 1;
      } catch (error) {
        recordError(error, 'audioSession release');
      }
    }

    function buildGraph() {
      if (!context || master) return;
      master = context.createGain();
      limiter = context.createDynamicsCompressor();

      master.gain.value = MASTER_GAIN;
      limiter.threshold.value = -10;
      limiter.knee.value = 8;
      limiter.ratio.value = 8;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.16;

      master.connect(limiter);
      limiter.connect(context.destination);
    }

    function ensureContext() {
      if (!context || context.state === 'closed') {
        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextCtor) {
          recordError('Web Audio API unavailable');
          return null;
        }
        try {
          context = new AudioContextCtor({ latencyHint: 'interactive' });
        } catch {
          context = new AudioContextCtor();
        }
        generation += 1;
        master = null;
        limiter = null;
        buildGraph();

        if ('audioSession' in navigator && navigator.audioSession?.addEventListener) {
          navigator.audioSession.addEventListener('statechange', () => {
            if (navigator.audioSession.state === 'interrupted') {
              lastError = 'audio session interrupted';
            }
          }, { passive: true });
        }
      }
      buildGraph();
      return context;
    }

    async function resumeContext() {
      const ctx = ensureContext();
      if (!ctx) return false;
      if (ctx.state === 'running') {
        lastError = '';
        return true;
      }

      try {
        await Promise.race([
          ctx.resume(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('resume timeout')), RESUME_TIMEOUT_MS))
        ]);
      } catch (error) {
        recordError(error, 'resume');
      }

      if (ctx.state === 'running') return true;

      // WebKit occasionally leaves a context permanently suspended/interrupted.
      try {
        await ctx.close();
      } catch {}
      context = null;
      master = null;
      limiter = null;
      carrier = null;
      carrierGain = null;

      const rebuilt = ensureContext();
      if (!rebuilt) return false;
      try {
        await Promise.race([
          rebuilt.resume(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('resume retry timeout')), RESUME_TIMEOUT_MS))
        ]);
      } catch (error) {
        recordError(error, 'resume retry');
      }
      const recovered = rebuilt.state === 'running';
      if (recovered) lastError = '';
      return recovered;
    }

    function decodeAudioData(arrayBuffer) {
      const ctx = ensureContext();
      if (!ctx) return Promise.reject(new Error('AudioContext unavailable'));
      return new Promise((resolve, reject) => {
        let settled = false;
        const done = value => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        const fail = error => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        try {
          const result = ctx.decodeAudioData(arrayBuffer.slice(0), done, fail);
          if (result?.then) result.then(done).catch(fail);
        } catch (error) {
          fail(error);
        }
      });
    }

    async function decodeCues() {
      if (decodePromise) return decodePromise;
      decodePromise = Promise.all(Object.entries(CUE_DATA).map(async ([name, base64]) => {
        try {
          const audioBuffer = await decodeAudioData(decodeBase64(base64));
          buffers.set(name, audioBuffer);
        } catch (error) {
          recordError(error, 'decode ' + name);
        }
      }));
      await decodePromise;
      return buffers.size === Object.keys(CUE_DATA).length;
    }

    async function unlock() {
      if (!isEnabled()) return false;
      configureMixingSession();
      const running = await resumeContext();
      if (!running) return false;
      await decodeCues();
      return buffers.size > 0;
    }

    function connectSource(source, volume = 1) {
      if (!context || !master) return false;
      const gain = context.createGain();
      gain.gain.value = Math.max(0, Math.min(1.35, Number(volume) || 1));
      source.connect(gain);
      gain.connect(master);
      return true;
    }

    async function playBuffer(buffer, volume = 1) {
      if (!isEnabled() || !buffer) return false;

      // A cue owns the audio session from category activation until the source
      // ends. Between cues the context stays suspended.
      try {
        if (context?.state === 'running') {
          await context.suspend();
        }
      } catch (error) {
        recordError(error, 'pre-cue suspend');
      }

      await activateAudibleCueSession();
      if (!(await resumeContext())) {
        await releaseAudibleCueSession();
        return false;
      }

      return new Promise(resolve => {
        try {
          const source = context.createBufferSource();
          source.buffer = buffer;
          if (!connectSource(source, volume)) {
            releaseAudibleCueSession().finally(() => resolve(false));
            return;
          }

          source.addEventListener('ended', () => {
            cueCount += 1;
            releaseAudibleCueSession().finally(() => resolve(true));
          }, { once: true });

          source.start();
        } catch (error) {
          recordError(error, 'play buffer');
          releaseAudibleCueSession().finally(() => resolve(false));
        }
      });
    }

    async function playSignal(kind) {
      if (!isEnabled()) return false;

      const cue =
        kind === 'preStart' || kind === 'countdown' ? 'countdown' :
        kind === 'workStart' ? 'workStart' :
        kind === 'workEnd' || kind === 'finish' ? 'workEnd' :
        null;

      if (!cue) return false;

      // Serialize the ENTIRE audio-session lifecycle. A later cue must never
      // call unlock()/ambient while the current cue is still playing.
      const run = async () => {
        if (!(await unlock())) return false;
        lastCue = cue;
        lastCueAt = Date.now();
        return playBuffer(buffers.get(cue), CUE_GAIN[cue] || 1);
      };

      cueChain = cueChain.then(run, run);
      return cueChain;
    }

    async function playBlob(blob, volume = 0.92) {
      if (!isEnabled() || !blob) return false;

      const run = async () => {
        if (!(await unlock())) return false;
        try {
          let buffer = voiceCache.get(blob);
          if (!buffer) {
            buffer = await decodeAudioData(await blob.arrayBuffer());
            voiceCache.set(blob, buffer);
          }
          return playBuffer(buffer, volume);
        } catch (error) {
          recordError(error, 'voice');
          return false;
        }
      };

      cueChain = cueChain.then(run, run);
      return cueChain;
    }

    async function startCarrier() {
      // Deliberately disabled. A continuous carrier keeps the WebAudio session
      // active and prevents Music/Spotify from recovering between timer cues.
      return true;
    }

    function stopCarrier() {}

    async function onVisibilityChange(hidden) {
      if (hidden) return;
      configureMixingSession();
      await resumeContext();
      try { if (context?.state === 'running') await context.suspend(); } catch {}
    }

    function bindGestureUnlock(target = document) {
      let armed = true;
      const prime = async () => {
        if (!armed || !isEnabled()) return;
        armed = false;
        await unlock();
      };
      target.addEventListener('pointerdown', prime, { capture: true, passive: true });
      target.addEventListener('touchstart', prime, { capture: true, passive: true });
    }

    const api = {
      unlock,
      playSignal,
      playBlob,
      startCarrier,
      stopCarrier,
      onVisibilityChange,
      bindGestureUnlock,
      get status() {
        return {
          enabled: !!isEnabled(),
          contextState: context?.state || 'none',
          sessionType: ('audioSession' in navigator) ? navigator.audioSession.type : 'unsupported',
          sessionState: ('audioSession' in navigator) ? navigator.audioSession.state : 'unsupported',
          generation,
          carrierActive: !!carrier,
          decoded: Object.fromEntries([...buffers].map(([name, buffer]) => [name, {
            duration: Number(buffer.duration || 0),
            sampleRate: Number(buffer.sampleRate || 0)
          }])),
          embedded: Object.fromEntries(Object.entries(CUE_DATA).map(([name, value]) => [name, value.length])),
          lastCue,
          lastCueAt,
          cueCount,
          sessionTransitionCount,
          lastError
        };
      },
      async selfTest() {
        await unlock();
        return api.status;
      }
    };

    return api;
  }

  window.PulseAudioEngine = Object.freeze({ create });
})();

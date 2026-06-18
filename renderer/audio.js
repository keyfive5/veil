// Live audio capture for "Listen" mode. Captures system/loopback audio (so Veil
// hears the OTHER person on the call) mixed with the mic, and ships short cycles
// to the main process for transcription.
//
// Speed: instead of fixed 7s chunks, it watches the audio level (voice-activity
// detection) and flushes a cycle the moment the speaker PAUSES — so the transcript
// catches up right when they stop talking, which is exactly when the user reaches
// for "Suggest reply". Paid plans flush faster (shorter min cycle + silence hold)
// than free. The same level read drives the "Veil can hear you" indicator.
//
// Exposed as window.AudioListener. No keys here — main does the transcription.
(function () {
  const MIN_BYTES = 1400;     // skip near-silent/empty cycles
  const SPEAK_RMS = 0.02;     // audio level above this = someone is talking

  // Per-tier pacing. Free is deliberately a touch slower (longer chunks) — that's
  // part of the upgrade pitch; paid is snappy. All times in ms.
  const PACE = {
    free: { minCycle: 2200, silenceHold: 850, maxCycle: 6500 },
    fast: { minCycle: 1100, silenceHold: 480, maxCycle: 4500 },
  };

  function pickMime() {
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
    for (const t of types) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
    }
    return 'audio/webm';
  }

  class AudioListener {
    constructor({ onTranscript, onState, onLevel, onPending, fast } = {}) {
      this.onTranscript = onTranscript || (() => {});
      this.onState = onState || (() => {});
      this.onLevel = onLevel || (() => {});     // (level0to1, speaking) — drives the indicator
      this.onPending = onPending || (() => {}); // (bool) — a transcription is in flight
      this.pace = fast ? PACE.fast : PACE.free;
      this.active = false;
      this.streams = [];
      this.ctx = null;
      this.analyser = null;
      this.mime = pickMime();
      this._pending = 0;
      this._lastSpeechAt = 0;
    }

    async start() {
      if (this.active) return;
      this.active = true;

      let systemStream = null;
      let micStream = null;

      // System / loopback audio — main grants this via setDisplayMediaRequestHandler.
      try {
        systemStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        systemStream.getVideoTracks().forEach((t) => t.stop()); // we only want audio
        if (!systemStream.getAudioTracks().length) systemStream = null;
      } catch (_) { /* unsupported (e.g. macOS) or denied — fall back to mic */ }

      // Microphone (the user's own voice).
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (_) { /* mic denied */ }

      if (!systemStream && !micStream) {
        this.active = false;
        this.onState('error', 'Could not access audio. Allow microphone / screen audio.');
        return;
      }

      // Mix whatever we got into one stream, and tap the same audio with an analyser
      // for the live level meter / VAD.
      this.ctx = new AudioContext();
      const dest = this.ctx.createMediaStreamDestination();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      for (const s of [systemStream, micStream]) {
        if (s && s.getAudioTracks().length) {
          this.streams.push(s);
          const node = this.ctx.createMediaStreamSource(s);
          node.connect(dest);
          node.connect(this.analyser);
        }
      }
      this.dest = dest;
      this.onState('listening', systemStream ? 'system+mic' : 'mic');
      this._meter();
      this._cycle();
    }

    // Root-mean-square of the current audio frame, ~0 (silence) … ~0.3+ (loud speech).
    _rms() {
      const a = this.analyser;
      if (!a) return 0;
      const buf = this._buf || (this._buf = new Uint8Array(a.fftSize));
      a.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      return Math.sqrt(sum / buf.length);
    }

    // Real-time level meter → drives the "Veil can hear you" indicator + tracks the
    // last moment speech was heard (used to detect a pause).
    _meter() {
      const loop = () => {
        if (!this.active) return;
        const level = this._rms();
        const speaking = level > SPEAK_RMS;
        if (speaking) this._lastSpeechAt = Date.now();
        this.onLevel(Math.min(1, level / 0.25), speaking);
        this._meterTimer = setTimeout(loop, 60);
      };
      loop();
    }

    _cycle() {
      if (!this.active) return;
      let rec;
      try {
        rec = new MediaRecorder(this.dest.stream, { mimeType: this.mime });
      } catch (e) {
        this.onState('error', 'Recorder failed: ' + e.message);
        return;
      }
      const chunks = [];
      const startedAt = Date.now();
      let sawSpeech = false;
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = async () => {
        // Immediately start the next cycle to minimise the audio gap.
        if (this.active) this._cycle();
        const blob = new Blob(chunks, { type: this.mime });
        if (blob.size < MIN_BYTES || !sawSpeech) return; // nothing worth sending
        this._pending++; this.onPending(true);
        try {
          const buf = await blob.arrayBuffer();
          const res = await window.veil.transcribe(buf, this.mime);
          if (res && res.text) this.onTranscript(res.text);
          else if (res && res.error) this.onState('error', res.error);
        } catch (e) {
          this.onState('error', e.message || String(e));
        } finally {
          this._pending = Math.max(0, this._pending - 1);
          this.onPending(this._pending > 0);
        }
      };
      rec.start();
      this._rec = rec;

      // Flush this cycle as soon as the speaker pauses (snappy), or at maxCycle for a
      // long uninterrupted monologue. A pause = silenceHold ms with no speech, but
      // only after at least minCycle ms so we don't ship tiny scraps.
      const watch = () => {
        if (!this.active || this._rec !== rec) return;
        const elapsed = Date.now() - startedAt;
        if (this._rms() > SPEAK_RMS) sawSpeech = true;
        const silenceFor = Date.now() - this._lastSpeechAt;
        const pausedAfterSpeech = sawSpeech && silenceFor > this.pace.silenceHold && elapsed > this.pace.minCycle;
        if (pausedAfterSpeech || elapsed > this.pace.maxCycle) {
          try { rec.stop(); } catch (_) {}
          return;
        }
        this._watchTimer = setTimeout(watch, 80);
      };
      watch();
    }

    // Force the current cycle to transcribe NOW — used when the user clicks
    // "Suggest reply" so the reply is based on what was just said.
    flush() {
      try { if (this._rec && this._rec.state !== 'inactive') this._rec.stop(); } catch (_) {}
    }

    stop() {
      this.active = false;
      clearTimeout(this._meterTimer);
      clearTimeout(this._watchTimer);
      try { this._rec && this._rec.state !== 'inactive' && this._rec.stop(); } catch (_) {}
      this.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
      this.streams = [];
      if (this.ctx) { try { this.ctx.close(); } catch (_) {} this.ctx = null; }
      this.onLevel(0, false);
      this.onState('stopped');
    }
  }

  window.AudioListener = AudioListener;
})();

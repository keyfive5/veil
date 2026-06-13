// Live audio capture for "Listen" mode. Captures system/loopback audio (so Veil
// hears the OTHER person on the call) mixed with the mic, records it in short
// cycles, and ships each cycle to the main process for transcription.
//
// Exposed as window.AudioListener. No keys here — main does the transcription.
(function () {
  const CYCLE_MS = 7000;        // length of each transcription cycle
  const MIN_BYTES = 1400;       // skip near-silent/empty cycles

  function pickMime() {
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
    for (const t of types) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
    }
    return 'audio/webm';
  }

  class AudioListener {
    constructor({ onTranscript, onState }) {
      this.onTranscript = onTranscript || (() => {});
      this.onState = onState || (() => {});
      this.active = false;
      this.streams = [];
      this.ctx = null;
      this.mime = pickMime();
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

      // Mix whatever we got into one stream.
      this.ctx = new AudioContext();
      const dest = this.ctx.createMediaStreamDestination();
      for (const s of [systemStream, micStream]) {
        if (s && s.getAudioTracks().length) {
          this.streams.push(s);
          this.ctx.createMediaStreamSource(s).connect(dest);
        }
      }
      this.dest = dest;
      this.onState('listening', systemStream ? 'system+mic' : 'mic');
      this._cycle();
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
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = async () => {
        // Immediately start the next cycle to minimise the audio gap.
        if (this.active) this._cycle();
        const blob = new Blob(chunks, { type: this.mime });
        if (blob.size < MIN_BYTES) return;
        try {
          const buf = await blob.arrayBuffer();
          const res = await window.veil.transcribe(buf, this.mime);
          if (res && res.text) this.onTranscript(res.text);
          else if (res && res.error) this.onState('error', res.error);
        } catch (e) {
          this.onState('error', e.message || String(e));
        }
      };
      rec.start();
      this._rec = rec;
      this._timer = setTimeout(() => { try { rec.stop(); } catch (_) {} }, CYCLE_MS);
    }

    stop() {
      this.active = false;
      clearTimeout(this._timer);
      try { this._rec && this._rec.state !== 'inactive' && this._rec.stop(); } catch (_) {}
      this.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
      this.streams = [];
      if (this.ctx) { try { this.ctx.close(); } catch (_) {} this.ctx = null; }
      this.onState('stopped');
    }
  }

  window.AudioListener = AudioListener;
})();

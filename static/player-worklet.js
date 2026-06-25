// Agent-audio playback worklet (24 kHz PCM16 → speaker).
//
// The TTS server emits PCM in BURSTS (~6 frames every 240 ms), not a smooth
// stream. Playing the first chunk immediately and filling silence on every gap
// produces clicks/crackle ("added noise"). So we PREBUFFER a cushion of audio
// before starting, then drain it — exactly what the production widget does.
//
// Also posts 'playing' / 'idle' on real playback transitions (used to arm
// barge-in and to re-cushion at the next turn).
const IDLE_HANGOVER = 24;   // ~128 ms of underrun before declaring the turn idle

class PlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];          // Float32Array chunks
    this.offset = 0;          // read offset into queue[0]
    this.queued = 0;          // total samples buffered
    this.prebuffer = 0;       // samples to accumulate before (re)starting
    this.playing = false;
    this.silentBlocks = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d === 'flush') {     // barge-in / interrupt → drop everything, re-cushion next turn
        this.queue = []; this.offset = 0; this.queued = 0;
        if (this.playing) { this.playing = false; this.port.postMessage('idle'); }
        return;
      }
      if (d && d.prebuffer !== undefined) { this.prebuffer = d.prebuffer; return; }
      this.queue.push(d); this.queued += d.length;   // d is a Float32Array chunk
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!this.playing) {
      // Wait for the cushion to fill before emitting the first sample.
      if (this.queued > 0 && this.queued >= this.prebuffer) {
        this.playing = true; this.silentBlocks = 0; this.port.postMessage('playing');
      } else {
        out.fill(0); return true;
      }
    }
    let i = 0;
    while (i < out.length && this.queue.length) {
      const chunk = this.queue[0];
      const avail = chunk.length - this.offset;
      const take = Math.min(avail, out.length - i);
      out.set(chunk.subarray(this.offset, this.offset + take), i);
      i += take; this.offset += take; this.queued -= take;
      if (this.offset >= chunk.length) { this.queue.shift(); this.offset = 0; }
    }
    if (i < out.length) {
      out.fill(0, i);                                // brief gap → silence (rare, cushion absorbs most)
      if (++this.silentBlocks >= IDLE_HANGOVER) {    // sustained silence → turn ended; re-cushion next turn
        this.playing = false; this.silentBlocks = 0; this.port.postMessage('idle');
      }
    } else {
      this.silentBlocks = 0;
    }
    return true;
  }
}
registerProcessor('player', PlayerProcessor);

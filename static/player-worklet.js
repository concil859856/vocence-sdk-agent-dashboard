// Agent-audio playback worklet. The AudioContext is created at 24 kHz (the
// VocenceTTS output rate), so we just queue the incoming Float32 samples and
// feed them to the speaker, emitting silence on underrun. `flush` drops the
// queue instantly (used on barge-in / interrupt).
class PlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];          // array of Float32Array chunks
    this.offset = 0;          // read offset into queue[0]
    this.port.onmessage = (e) => {
      if (e.data === 'flush') { this.queue = []; this.offset = 0; return; }
      this.queue.push(e.data);
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    let i = 0;
    while (i < out.length && this.queue.length) {
      const chunk = this.queue[0];
      const avail = chunk.length - this.offset;
      const need = out.length - i;
      const take = Math.min(avail, need);
      out.set(chunk.subarray(this.offset, this.offset + take), i);
      i += take;
      this.offset += take;
      if (this.offset >= chunk.length) { this.queue.shift(); this.offset = 0; }
    }
    if (i < out.length) out.fill(0, i);   // underrun → silence
    return true;
  }
}
registerProcessor('player', PlayerProcessor);

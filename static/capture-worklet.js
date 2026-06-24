// Mic capture worklet. The AudioContext is created at 16 kHz, so the input
// frames are already at the rate VocenceSTT expects — we just convert the
// Float32 samples to little-endian PCM16 and post them to the main thread,
// which relays them over the WebSocket.
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || ch.length === 0) return true;
    const pcm = new Int16Array(ch.length);
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
    return true;
  }
}
registerProcessor('capture', CaptureProcessor);

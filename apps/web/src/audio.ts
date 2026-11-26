/**
 * Microphone audio for the web app: the browser records at its own rate (usually 44.1 or
 * 48 kHz, float); Scribe takes 16 kHz mono PCM16 little-endian (research R1). Pure helpers,
 * unit-tested; app.ts wires them to an AudioWorklet.
 */
export const TARGET_RATE = 16_000;

/** Streaming linear-interpolation resampler; keeps its position across chunks. */
export class Resampler {
  private readonly step: number;
  private pos = 0; // read position in the current chunk, in input samples
  private last = 0; // last input sample of the previous chunk

  constructor(inputRate: number) {
    if (!(inputRate > 0)) throw new Error("bad input rate");
    this.step = inputRate / TARGET_RATE;
  }

  push(input: Float32Array): Float32Array {
    const out: number[] = [];
    // Index -1 is the previous chunk's last sample, so interpolation spans the seam.
    const at = (i: number) => (i < 0 ? this.last : (input[i] ?? 0));
    while (this.pos <= input.length - 1) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      out.push(at(i) + (at(i + 1) - at(i)) * frac);
      this.pos += this.step;
    }
    this.pos -= input.length;
    if (input.length) this.last = input[input.length - 1] ?? 0;
    return Float32Array.from(out);
  }
}

/** Float samples in [-1, 1] to 16-bit little-endian PCM. */
export function toPcm16(samples: Float32Array): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(samples.length * 2));
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return view.buffer;
}

/** AudioWorklet processor source: posts mono float chunks of ~100 ms to the page. */
export const CAPTURE_WORKLET = `
class SayvoxCapture extends AudioWorkletProcessor {
  constructor() { super(); this.parts = []; this.count = 0; this.target = Math.round(sampleRate / 10); }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      this.parts.push(new Float32Array(ch));
      this.count += ch.length;
      if (this.count >= this.target) {
        const out = new Float32Array(this.count);
        let o = 0;
        for (const p of this.parts) { out.set(p, o); o += p.length; }
        this.port.postMessage(out, [out.buffer]);
        this.parts = []; this.count = 0;
      }
    }
    return true;
  }
}
registerProcessor("sayvox-capture", SayvoxCapture);
`;

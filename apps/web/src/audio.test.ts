import { describe, expect, it } from "vitest";
import { Resampler, toPcm16 } from "./audio";

describe("Resampler", () => {
  it("turns 48 kHz into 16 kHz: one second in, one second out", () => {
    const r = new Resampler(48_000);
    let n = 0;
    for (let c = 0; c < 10; c++) n += r.push(new Float32Array(4_800).fill(0.25)).length;
    expect(Math.abs(n - 16_000)).toBeLessThanOrEqual(1);
  });

  it("handles 44.1 kHz across odd chunk sizes without drift", () => {
    const r = new Resampler(44_100);
    let n = 0;
    for (let c = 0; c < 441; c++) n += r.push(new Float32Array(100)).length;
    expect(Math.abs(n - 16_000)).toBeLessThanOrEqual(1);
  });

  it("interpolates across chunk boundaries", () => {
    const r = new Resampler(32_000); // step 2
    const a = r.push(Float32Array.from([0, 0.5, 1]));
    const b = r.push(Float32Array.from([1, 1, 1]));
    expect([...a]).toEqual([0, 1]);
    expect(b.every((v) => v === 1)).toBe(true);
  });
});

describe("toPcm16", () => {
  it("writes clamped little-endian 16-bit samples", () => {
    const buf = toPcm16(Float32Array.from([0, 1, -1, 2, -2, 0.5]));
    const v = new DataView(buf);
    expect(buf.byteLength).toBe(12);
    expect([0, 1, 2, 3, 4].map((i) => v.getInt16(i * 2, true))).toEqual([
      0, 32767, -32768, 32767, -32768,
    ]);
    expect(v.getInt16(10, true)).toBe(16383);
  });
});

/** Minimal semver compare for `major.minor.patch` (pre-release tags sort before the release). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre] = v.trim().replace(/^v/, "").split("-", 2);
    const nums = core.split(".").map((n) => Number.parseInt(n, 10) || 0);
    while (nums.length < 3) nums.push(0);
    return { nums, pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** Stable 0–99 bucket for staged rollouts (FNV-1a over the install id). */
export function rolloutBucket(installId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < installId.length; i++) {
    h ^= installId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 100;
}

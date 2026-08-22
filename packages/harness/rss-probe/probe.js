// rss-probe -- verify the measurement instrument before trusting a single
// measurement. Milestone M1.
//
//   node packages/harness/rss-probe/probe.js [--mb 512] [--write]
//
// Peak RSS is the only memory figure comparable across runtimes: heap
// statistics from Node and allocator behaviour in Rust do not describe the
// same thing. But the platform sources disagree about UNITS, not merely
// values -- getrusage reports ru_maxrss in bytes on Darwin and in kilobytes
// on Linux -- and a runtime accessor sitting on top of them may or may not
// normalise.
//
// A memory comparison built on an assumed unit is worse than no comparison,
// because it looks authoritative. So: allocate a known number of bytes, touch
// every page to force residency, read what the platform claims, and derive
// the unit from the ratio rather than from documentation.
//
// docs/MEASUREMENT-CONTRACT.md §5 is CONFIRMED OR CORRECTED by this output.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
};

const TARGET_MB = argOf('--mb', 512);
const TARGET_BYTES = TARGET_MB * 1024 * 1024;
const CHUNK_BYTES = 16 * 1024 * 1024;
const PAGE = 4096;

// Held at module scope so nothing is collected before we read the peak.
const held = [];

const before = {
  maxRSS: process.resourceUsage().maxRSS,
  rss: process.memoryUsage().rss,
};

// Buffers above a few KB are allocated outside the V8 heap, so they count
// toward RSS directly. Writing one byte per page is what actually makes them
// resident -- an untouched allocation may never be backed by physical pages.
let touched = 0;
let checksum = 0;
for (let done = 0; done < TARGET_BYTES; done += CHUNK_BYTES) {
  const size = Math.min(CHUNK_BYTES, TARGET_BYTES - done);
  const buf = Buffer.allocUnsafe(size);
  for (let off = 0; off < size; off += PAGE) {
    const v = ((done + off) >>> 12) & 0xff;
    buf[off] = v;
    checksum = (checksum + v) & 0xffff;
    touched++;
  }
  held.push(buf);
}

const after = {
  maxRSS: process.resourceUsage().maxRSS,
  rss: process.memoryUsage().rss,
};

// Read back what we wrote, so nothing above can be elided. Only written
// bytes are read: allocUnsafe leaves the rest uninitialised, and a
// nondeterministic value has no place in a committed result file.
let readback = 0;
for (const b of held) for (let off = 0; off < b.length; off += PAGE) readback = (readback + b[off]) & 0xffff;
if (readback !== checksum) { console.error(`FAIL: readback ${readback} != written ${checksum}`); process.exit(2); }

const deltaMaxRSS = after.maxRSS - before.maxRSS;
const deltaRssBytes = after.rss - before.rss;

// process.memoryUsage().rss is documented in bytes on every platform, so it
// is the cross-check: if this does not track the allocation, the allocation
// never became resident and the whole reading is meaningless.
const residencyRatio = deltaRssBytes / TARGET_BYTES;
const residencyOk = residencyRatio > 0.9 && residencyRatio < 1.35;

// Derive the unit rather than assume it.
const CANDIDATES = { bytes: 1, kilobytes: 1024 };
let unit = 'indeterminate', unitRatio = null, best = Infinity;
if (deltaMaxRSS > 0) {
  const impliedBytesPerUnit = TARGET_BYTES / deltaMaxRSS;
  for (const [name, mult] of Object.entries(CANDIDATES)) {
    const err = Math.abs(Math.log(impliedBytesPerUnit / mult));
    if (err < best) { best = err; unit = name; unitRatio = impliedBytesPerUnit; }
  }
  if (best > Math.log(1.35)) unit = 'indeterminate';
}

const maxRSSBytes = unit === 'indeterminate'
  ? null
  : deltaMaxRSS * CANDIDATES[unit];
const accuracy = maxRSSBytes === null ? null : maxRSSBytes / TARGET_BYTES;
const accurate = accuracy !== null && accuracy > 0.9 && accuracy < 1.1;

const result = {
  contract: 1,
  probe: 'rss',
  runtime: 'node',
  runtime_version: process.versions.node,
  platform: {
    os: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0]?.model ?? null,
    cores_logical: os.cpus().length,
    ram_bytes: os.totalmem(),
  },
  allocated_bytes: TARGET_BYTES,
  pages_touched: touched,
  checksum,
  raw: { before, after, delta_maxRSS: deltaMaxRSS, delta_rss_bytes: deltaRssBytes },
  residency: { ratio: Number(residencyRatio.toFixed(4)), ok: residencyOk },
  inferred: {
    source: 'process.resourceUsage().maxRSS',
    unit,
    implied_bytes_per_unit: unitRatio === null ? null : Number(unitRatio.toFixed(3)),
    peak_delta_bytes: maxRSSBytes,
    accuracy_vs_allocation: accuracy === null ? null : Number(accuracy.toFixed(4)),
  },
  verdict: !residencyOk ? 'FAIL: allocation never became resident'
         : unit === 'indeterminate' ? 'FAIL: maxRSS unit could not be determined'
         : !accurate ? `WARN: unit=${unit} but accuracy ${(accuracy * 100).toFixed(1)}% is outside 90-110%`
         : `PASS: maxRSS is in ${unit}; peak tracked allocation to ${(accuracy * 100).toFixed(1)}%`,
};

console.log(JSON.stringify(result, null, 2));
console.log(`\n${result.verdict}`);

if (argv.includes('--write')) {
  const name = `rss-probe.node.${process.platform}-${process.arch}.json`;
  const p = join(HERE, '..', '..', '..', 'results', 'instrument', name);
  writeFileSync(p, JSON.stringify(result, null, 2) + '\n');
  console.log(`wrote ${p}`);
}

process.exit(result.verdict.startsWith('PASS') ? 0 : 1);

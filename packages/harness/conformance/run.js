// Boundary conformance suite. BOUNDARY.md §5.
//
//   node packages/harness/conformance/run.js <cell.js> [--data data/tiny]
//
// Neither side's own tests exercise the contract: the oracle self-test never
// spawns a cell, and a cell run by hand never tests how the harness reacts to
// its failures. This suite tests the boundary itself.
//
// Every cell must pass before its numbers enter the matrix. That requirement
// is what makes M6's claim -- "adding a runtime costs a row, not a project" --
// testable rather than rhetorical: a new runtime is admissible when it passes
// this, without the harness being touched.

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2);
const cell = argv.find((a) => !a.startsWith('--'));
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DATA = resolve(opt('--data', 'data/tiny'));
if (!cell) { console.error('usage: run.js <cell.js> [--data data/tiny] [--algorithm <name>]'); process.exit(2); }

// Derived from the cell's filename, overridable. An earlier version hardcoded
// 'builtin' here, which meant the suite passed only for the cell it was
// written against -- exactly the property BOUNDARY.md §5 says it exists to
// test. Found by the first agent to add a second cell, which is the cheapest
// possible moment for it to be found.
const ALGORITHM = opt('--algorithm', basename(cell).replace(/\.[^.]+$/, ''));

const work = mkdtempSync(join(tmpdir(), 'orch-conformance-'));
const results = [];

function runCell(spec, { specPath = null } = {}) {
  const p = specPath ?? join(work, `job-${results.length}.json`);
  if (spec !== null) writeFileSync(p, JSON.stringify(spec, null, 2));
  const r = spawnSync(process.execPath, [cell, '--job', p], { encoding: 'utf8' });
  let manifest = null, parseError = null;
  if (r.stdout.trim()) { try { manifest = JSON.parse(r.stdout); } catch (e) { parseError = e.message; } }
  let errObj = null;
  if (r.stderr.trim()) {
    for (const line of [r.stderr.trim(), ...r.stderr.trim().split('\n')]) {
      try { const o = JSON.parse(line); if (o && o.kind === 'error') { errObj = o; break; } } catch { /* not json */ }
    }
  }
  return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, manifest, parseError, errObj };
}

function check(id, why, fn) {
  let pass = false, detail = '';
  try { const r = fn(); pass = r === true; if (r !== true) detail = String(r); }
  catch (e) { detail = `threw: ${e.message}`; }
  results.push({ id, why, pass, detail });
}

const baseSpec = (over = {}) => ({
  contract: 1,
  job_id: 'conformance-0001',
  op: 'sort',
  tier: 'tiny',
  inputs: [{ dataset: 'C', path: join(DATA, 'C.tsv') }],
  algorithm: ALGORITHM,
  threads: 1,
  load_mode: 'aos',
  output: { path: join(work, 'out.tsv'), emit: true },
  repeat: 1,
  ...over,
});

const REQUIRED = ['contract', 'job_id', 'impl', 'platform', 'tier', 'dataset',
  'records_in', 'records_out', 'startup_ns', 'peak_rss_bytes',
  'memory_measurement_valid', 'runs', 'invariants', 'notes'];

// --- C1 happy path --------------------------------------------------------
check('C1', 'valid spec -> exit 0, parseable manifest, every field present', () => {
  const r = runCell(baseSpec());
  if (r.status !== 0) return `exit ${r.status} (expected 0); stderr: ${r.stderr.slice(0, 200)}`;
  if (r.parseError) return `stdout not valid JSON: ${r.parseError}`;
  if (!r.manifest) return 'no manifest on stdout';
  const missing = REQUIRED.filter((k) => !(k in r.manifest));
  if (missing.length) return `manifest missing: ${missing.join(', ')}`;
  if (r.manifest.job_id !== 'conformance-0001') return `job_id not echoed: ${r.manifest.job_id}`;
  return true;
});

// --- C2 stdout purity -----------------------------------------------------
check('C2', 'stdout carries the manifest and nothing else', () => {
  const r = runCell(baseSpec());
  // Assert stdout is NON-EMPTY and parses. An earlier version checked only
  // that it parsed, so a cell that exited before producing anything scored a
  // clean pass on stdout purity -- a check that cannot fail for the reason it
  // is looking for.
  if (r.status !== 0) return `happy path exited ${r.status}; stdout purity untested`;
  if (!r.stdout.trim()) return 'stdout empty on the happy path';
  if (r.parseError) return `stdout has non-manifest content: ${r.parseError}`;
  return true;
});

// --- C3 unknown contract version -----------------------------------------
check('C3', 'contract: 99 -> exit 2, error object, empty stdout', () => {
  const r = runCell(baseSpec({ contract: 99 }));
  if (r.status !== 2) return `exit ${r.status} (expected 2)`;
  if (r.stdout.trim()) return 'stdout not empty';
  if (!r.errObj) return 'no error object on stderr';
  return true;
});

// --- C4 unknown algorithm -------------------------------------------------
check('C4', 'unknown algorithm -> exit 2', () => {
  const r = runCell(baseSpec({ algorithm: 'no-such-algorithm' }));
  if (r.status !== 2) return `exit ${r.status} (expected 2)`;
  return true;
});

// --- C5 missing input -----------------------------------------------------
check('C5', 'missing input -> exit 3, stage "load", code ENOENT', () => {
  const r = runCell(baseSpec({ inputs: [{ dataset: 'C', path: join(DATA, 'does-not-exist.tsv') }] }));
  if (r.status !== 3) return `exit ${r.status} (expected 3)`;
  if (!r.errObj) return 'no error object on stderr';
  if (r.errObj.stage !== 'load') return `stage '${r.errObj.stage}' (expected 'load')`;
  if (r.errObj.code !== 'ENOENT') return `code '${r.errObj.code}' (expected 'ENOENT')`;
  return true;
});

// --- C6 relative path -----------------------------------------------------
check('C6', 'relative input path -> exit 2 (spec error, not a lookup)', () => {
  const r = runCell(baseSpec({ inputs: [{ dataset: 'C', path: 'data/tiny/C.tsv' }] }));
  if (r.status !== 2) return `exit ${r.status} (expected 2)`;
  return true;
});

// --- C7 emit false --------------------------------------------------------
check('C7', 'output.emit false -> exit 0, emit phase 0, no file written', () => {
  const path = join(work, 'must-not-exist.tsv');
  const r = runCell(baseSpec({ output: { path, emit: false } }));
  if (r.status !== 0) return `exit ${r.status} (expected 0)`;
  if (existsSync(path)) return 'a file was written despite emit:false';
  const e = r.manifest?.runs?.[0]?.phases_ns?.emit;
  if (e !== 0) return `emit phase ${e} (expected 0)`;
  return true;
});

// --- C8 corrupted input ---------------------------------------------------
check('C8', 'corrupted input -> exit 1 with a failing invariant, NOT a crash', () => {
  const src = readFileSync(join(DATA, 'C.tsv'), 'utf8').split('\n');
  // Mutate column 3 on one line, leaving its datastring intact: I1 must catch it.
  const f = src[10].split('\t'); f[2] = String(Number(f[2]) + 1); src[10] = f.join('\t');
  const bad = join(work, 'corrupt.tsv');
  writeFileSync(bad, src.join('\n'));
  const r = runCell(baseSpec({ inputs: [{ dataset: 'C', path: bad }] }));
  if (r.signal) return `killed by ${r.signal} (expected exit 1)`;
  if (r.status !== 1) return `exit ${r.status} (expected 1)`;
  if (!r.manifest) return 'exit 1 must still emit a manifest -- the result is the finding';
  const failed = Object.entries(r.manifest.invariants ?? {}).filter(([, v]) => v !== 'pass');
  if (!failed.length) return 'exit 1 but every invariant reported pass';
  return true;
});

// --- C9 repeat invalidates memory ----------------------------------------
check('C9', 'repeat: 2 -> memory_measurement_valid false', () => {
  const r = runCell(baseSpec({ repeat: 2 }));
  if (r.status !== 0) return `exit ${r.status} (expected 0)`;
  if (r.manifest?.memory_measurement_valid !== false) return `memory_measurement_valid ${r.manifest?.memory_measurement_valid} (expected false)`;
  return true;
});

// --- C10 output matches the declared total order -------------------------
check('C10', 'sorted output matches the committed reference hash', () => {
  const refPath = resolve('results/determinism/sorted-tiny.json');
  if (!existsSync(refPath)) return 'no committed reference (results/determinism/sorted-tiny.json)';
  const ref = JSON.parse(readFileSync(refPath, 'utf8'));
  const out = join(work, 'c10.tsv');
  const r = runCell(baseSpec({ output: { path: out, emit: true } }));
  if (r.status !== 0) return `exit ${r.status} (expected 0)`;
  const got = createHash('sha256').update(readFileSync(out)).digest('hex');
  const want = ref.files?.['C.sorted.tsv']?.sha256;
  if (got !== want) return `sha256 ${got.slice(0, 16)} != reference ${String(want).slice(0, 16)}`;
  return true;
});

// --- report ---------------------------------------------------------------
console.log(`conformance: ${basename(cell)}   data: ${DATA}\n`);
for (const r of results) {
  console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(4)} ${r.why}`);
  if (!r.pass) console.log(`              ${r.detail}`);
}
const failed = results.filter((r) => !r.pass);
console.log(failed.length ? `\n${failed.length}/${results.length} FAILED` : `\nall ${results.length} conformance cases passed`);
rmSync(work, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);

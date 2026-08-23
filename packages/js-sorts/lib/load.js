// The canonical JS loader. Every JS variation in the matrix uses this one, so
// the benchmark measures twenty algorithms rather than twenty TSV parsers.
//
// It is NOT normalised against Rust or C++. Zero-copy &str slicing versus a
// JS string allocation per field is a real language difference and a finding
// in its own right, which is why `load` is a separately reported phase.
//
// Two representations, and choosing between them is itself one of the
// tradeoffs under measurement, so both are canonical:
//
//   aos  array of objects. What you would write first. One object header per
//        record, every field a separate slot.
//   soa  struct of arrays. Numeric columns in typed arrays, strings in plain
//        arrays. Denser and cache-friendlier for a sort that only touches
//        one key column; more awkward to permute.
//
// Reading is chunked rather than readFileSync: at the large tier the file is
// ~1.6 GB and a single string would exceed V8's maximum string length. A
// streaming reader is also what the Rust and C++ loaders will do, so the
// comparison stays honest.

import { openSync, readSync, closeSync, fstatSync } from 'node:fs';

const LF = 0x0a;
const CHUNK = 1 << 22; // 4 MiB

// Per-dataset column types. A parser that guesses these from the data would
// be inferring schema at runtime, which is both slower and a place for the
// int/string distinction in I7 to quietly disappear.
export const SCHEMA = Object.freeze({
  A: { l1: 'number', l2: 'string' },
  B: { l1: 'number', l2: 'number' },
  C: { l1: 'string', l2: 'number' },
});

/**
 * Call `onLine(text)` for every line in the file. Constant memory: the only
 * buffer held is one chunk plus any partial trailing line.
 */
export function forEachLine(path, onLine) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const buf = Buffer.allocUnsafe(CHUNK);
    let carry = null;
    let pos = 0;
    while (pos < size) {
      const got = readSync(fd, buf, 0, CHUNK, pos);
      if (got <= 0) break;
      pos += got;
      let start = 0;
      for (let i = 0; i < got; i++) {
        if (buf[i] !== LF) continue;
        const text = carry === null
          ? buf.toString('utf8', start, i)
          : carry + buf.toString('utf8', start, i);
        carry = null;
        onLine(text);
        start = i + 1;
      }
      if (start < got) {
        const tail = buf.toString('utf8', start, got);
        carry = carry === null ? tail : carry + tail;
      }
    }
    // A final line without a trailing newline. The generator always emits one,
    // so reaching here means the file was truncated -- surface it rather than
    // silently accepting a short record.
    if (carry !== null && carry.length) onLine(carry);
  } finally {
    closeSync(fd);
  }
}

function parseFields(text, lineNo, path) {
  const t1 = text.indexOf('\t');
  const t2 = text.indexOf('\t', t1 + 1);
  const t3 = text.indexOf('\t', t2 + 1);
  const t4 = text.indexOf('\t', t3 + 1);
  if (t1 < 0 || t2 < 0 || t3 < 0 || t4 < 0 || text.indexOf('\t', t4 + 1) >= 0) {
    throw new Error(`${path}:${lineNo}: expected exactly 5 tab-separated fields`);
  }
  return [
    text.slice(0, t1),
    text.slice(t1 + 1, t2),
    text.slice(t2 + 1, t3),
    text.slice(t3 + 1, t4),
    text.slice(t4 + 1),
  ];
}

/**
 * @param {string} path
 * @param {{mode?: 'aos'|'soa', dataset?: 'A'|'B'|'C'}} opts
 */
export function load(path, { mode = 'aos', dataset = null } = {}) {
  let ds = dataset;
  let schema = ds ? SCHEMA[ds] : null;
  let lineNo = 0;

  if (mode === 'aos') {
    const out = [];
    forEachLine(path, (text) => {
      lineNo++;
      const f = parseFields(text, lineNo, path);
      if (schema === null) { ds = f[0]; schema = SCHEMA[ds]; if (!schema) throw new Error(`${path}:${lineNo}: unknown dataset '${ds}'`); }
      out.push({
        ds: f[0],
        l1: schema.l1 === 'number' ? Number(f[1]) : f[1],
        l2: schema.l2 === 'number' ? Number(f[2]) : f[2],
        l3ord: Number(f[3]),
        d: f[4],
      });
    });
    return { mode, dataset: ds, n: out.length, rows: out };
  }

  if (mode === 'soa') {
    const dsCol = [], l1n = [], l1s = [], l2n = [], l2s = [], ordArr = [], dArr = [];
    forEachLine(path, (text) => {
      lineNo++;
      const f = parseFields(text, lineNo, path);
      if (schema === null) { ds = f[0]; schema = SCHEMA[ds]; if (!schema) throw new Error(`${path}:${lineNo}: unknown dataset '${ds}'`); }
      dsCol.push(f[0]);
      if (schema.l1 === 'number') l1n.push(Number(f[1])); else l1s.push(f[1]);
      if (schema.l2 === 'number') l2n.push(Number(f[2])); else l2s.push(f[2]);
      ordArr.push(Number(f[3]));
      dArr.push(f[4]);
    });
    const n = dArr.length;
    return {
      mode, dataset: ds, n,
      ds: dsCol[0],
      l1: schema.l1 === 'number' ? Float64Array.from(l1n) : l1s,
      l2: schema.l2 === 'number' ? Float64Array.from(l2n) : l2s,
      l3ord: Int32Array.from(ordArr),
      d: dArr,
    };
  }

  throw new Error(`unknown load mode '${mode}'`);
}

/** Uniform accessor so invariant checks work against either representation. */
export function reader(loaded) {
  if (loaded.mode === 'aos') {
    const r = loaded.rows;
    return {
      n: loaded.n,
      ds: (i) => r[i].ds, l1: (i) => r[i].l1, l2: (i) => r[i].l2,
      l3ord: (i) => r[i].l3ord, d: (i) => r[i].d,
    };
  }
  return {
    n: loaded.n,
    ds: () => loaded.ds, l1: (i) => loaded.l1[i], l2: (i) => loaded.l2[i],
    l3ord: (i) => loaded.l3ord[i], d: (i) => loaded.d[i],
  };
}

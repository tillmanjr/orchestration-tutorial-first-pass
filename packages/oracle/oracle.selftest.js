// Adversarial self-test for the oracle.
//
//   node packages/oracle/oracle.selftest.js [data-dir]
//
// Every invariant is shown FAILING on data corrupted in the specific way it
// exists to catch, and PASSING on data that is correct. A verification gate
// that has only ever been seen to pass is not evidence of anything -- it is
// as likely to be a function that returns true.
//
// Each case below corresponds to a real failure mode of a sort or merge
// implementation, not to a hypothetical one.

import { load } from '../js-sorts/lib/load.js';
import { checkI1, checkI2, checkI3, digest, COMPARATORS } from './invariants.js';
import { reader } from '../js-sorts/lib/load.js';

const DATA = process.argv[2] ?? '/tmp/m3/tiny';
let failures = 0;

function expect(label, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(56)} ${got ? 'pass' : 'fail'} (expected ${want ? 'pass' : 'fail'})`);
}

/** Reorder an aos load without touching its contents. */
const permute = (L, order) => ({ ...L, rows: order.map((i) => L.rows[i]), n: order.length });

const sortedIndex = (L, cmp) => {
  const R = reader(L);
  return Array.from({ length: R.n }, (_, i) => i).sort((a, b) => cmp(R, a, b));
};

const base = load(`${DATA}/C.tsv`, { mode: 'aos' });
const baseDigest = digest(base);
console.log(`C.tsv  ${base.n} records\n`);

// --- correct sort ---------------------------------------------------------
console.log('correct behaviour (all must pass):');
const good = permute(base, sortedIndex(base, COMPARATORS.C));
expect('I1 on a correctly sorted file', checkI1(good).pass, true);
expect('I2 sorted output vs original input', checkI2(baseDigest, digest(good)).pass, true);
expect('I3 on a correctly sorted file', checkI3(good, 'C').pass, true);

// --- the collation trap ---------------------------------------------------
console.log('\nlocale collation instead of byte order (the trap C exists for):');
{
  const R = reader(base);
  const order = Array.from({ length: R.n }, (_, i) => i).sort((a, b) =>
    (R.l2(a) - R.l2(b)) || R.l1(a).localeCompare(R.l1(b)) || (R.l3ord(a) - R.l3ord(b)));
  const locale = permute(base, order);
  const r = checkI3(locale, 'C');
  expect('I3 rejects a localeCompare-ordered file', r.pass, false);
  expect('I2 still passes -- no record was lost, only misordered', checkI2(baseDigest, digest(locale)).pass, true);
  console.log(`        ${r.inversions} inversions; every record present, ordering plausible and wrong`);
}

// --- dropped, duplicated, substituted -------------------------------------
console.log('\nrecord-set corruption (I3 alone cannot see any of these):');
{
  const order = sortedIndex(base, COMPARATORS.C);

  const dropped = permute(base, order.slice(0, order.length - 1));
  expect('I3 passes on output missing one record', checkI3(dropped, 'C').pass, true);
  expect('I2 catches the dropped record', checkI2(baseDigest, digest(dropped)).pass, false);

  const dup = permute(base, [order[0], ...order]);
  expect('I2 catches a duplicated record', checkI2(baseDigest, digest(dup)).pass, false);

  // Same count, same ordering, one record's payload replaced by another's.
  const swapped = permute(base, order);
  swapped.rows = swapped.rows.slice();
  swapped.rows[100] = swapped.rows[101];
  expect('I2 catches substitution at constant count', checkI2(baseDigest, digest(swapped)).pass, false);
}

// --- field mutation -------------------------------------------------------
console.log('\nfield mutation (the loader-bug shape):');
{
  const mutated = { ...base, rows: base.rows.slice() };
  mutated.rows[42] = { ...mutated.rows[42], l2: mutated.rows[42].l2 + 1 };
  expect('I1 catches a column diverging from its datastring', checkI1(mutated).pass, false);
  expect('I2 still passes -- datastrings are untouched', checkI2(baseDigest, digest(mutated)).pass, true);
  console.log('        this is why I1 runs against loaded records, not against the file');
}

// --- representation independence ------------------------------------------
console.log('\nboth load modes must agree:');
{
  const soa = load(`${DATA}/C.tsv`, { mode: 'soa' });
  expect('I1 passes in soa mode', checkI1(soa).pass, true);
  const d = digest(soa);
  expect('digest identical across aos and soa', d.sum === baseDigest.sum && d.xor === baseDigest.xor && d.count === baseDigest.count, true);
}

console.log(failures ? `\n${failures} FAILURE(S) -- the oracle is not trustworthy` : '\nall oracle self-tests passed');
process.exit(failures ? 1 : 0);

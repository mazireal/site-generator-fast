// The harness runs `node /bot/main.ts` (node22). It reads every case from
// /input/cases.json (a JSON array of {id, input}), answers each one alone
// with run() from solve.js, and writes /output/answers.json: a JSON array of
// the answers, one per case and in the cases' order. Outside a container
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.
//
// The driver is tuned for the timed heat, where every run is a fresh
// process: V8 flags are set before solve.js is imported (the rules allow an
// entry to tune V8's flags this way), and each case is stringified and
// written as soon as it is answered, so the heap never holds every case's
// answer and its JSON text at once — a case's answer becomes garbage before
// the next case runs, which also keeps the next run's heap small. The bytes
// written are exactly JSON.stringify's of the answers array: '[' + the
// cases' JSON joined by ',' + ']'.

import { readFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its
// work runs under it. --no-opt skips the optimizing compiler: on a single
// cold pass its compile cost and deopts cost more than its code saves.
// --no-lazy compiles every function eagerly, so the first call runs compiled
// code. --max-semi-space-size=8 keeps the young generation small, so the
// garbage a case leaves is collected in cheap scavenges.
setFlagsFromString('--no-incremental-marking');
setFlagsFromString('--no-opt');
setFlagsFromString('--no-lazy');
setFlagsFromString('--max-semi-space-size=8');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const fd = openSync(join(OUTPUT_DIR, 'answers.json'), 'w');
writeSync(fd, '[');
for (let i = 0; i < cases.length; i++) {
  if (i !== 0) writeSync(fd, ',');
  writeSync(fd, JSON.stringify(run(cases[i].input)));
}
writeSync(fd, ']');
closeSync(fd);

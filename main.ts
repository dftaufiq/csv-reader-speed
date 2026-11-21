// The program the harness runs: `node /bot/main.ts` (node22). It reads every case from
// /input/cases.json (a JSON array of {id, input}), answers each one alone with run() from
// solve.js, and writes /output/answers.json: a JSON array of the answers, one per case and
// in the cases' order. Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand
// in for /input and /output.
//
// Note: this driver deliberately does NOT turn V8's incremental marking off (the house
// baseline does, and it suits the reference, which builds every field a character at a
// time and leaves a trail of short-lived strings). This solver builds its fields with
// native slices and splits and leaves little garbage behind, and measured on the
// practice set the default flags are the faster ones for it.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));
writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));

// Benchmarking hook: with MAKEFUN_BENCH=1, report this process's CPU time on stderr.
// The harness never sets it, so a graded run prints nothing.
if (process.env.MAKEFUN_BENCH === '1') {
  const cpu = process.cpuUsage();
  console.error(JSON.stringify({ cpu_user_us: cpu.user, cpu_system_us: cpu.system }));
}

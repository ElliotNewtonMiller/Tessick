import os from 'node:os';
import { configDefaults, defineConfig } from 'vitest/config';

// A worker running server tests settles around 1.5 GB: every test starts a server on its own
// in-memory Postgres (PGlite). Vitest's default of one worker per core but one ran an 8-core
// laptop out of memory (7 workers, about 10.5 GB): it swapped and the run looked stalled. So run
// only as many workers as free memory allows at 2.5 GB each, and never more than the default.
// `--maxWorkers` on the command line still overrides this.
const WORKER_MEMORY_BYTES = 2.5 * 1024 ** 3;
const maxWorkers = Math.max(1, Math.min(os.availableParallelism() - 1, Math.floor(os.freemem() / WORKER_MEMORY_BYTES)));

export default defineConfig({
  test: {
    // Claude Code keeps git worktrees (other checkouts of this repo) under .claude/worktrees;
    // their copies of the tests must not run here -- they test old code against this checkout.
    exclude: [...configDefaults.exclude, '.claude/**'],
    maxWorkers,
    // Most server tests start a whole server on a fresh in-memory database. Alone each takes
    // a second or two, but with every test file running in parallel some go past vitest's 5s
    // default and fail at random, so allow more.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

// Master switch for the hand-encoded / plan-cached write paths.
//
// Production always runs with these on. The differential tests flip it off to
// re-encode the very same world through the generic schema writer and compare
// byte for byte, and the benchmark flips it per iteration to get an
// interleaved A/B measurement. Not re-exported from src/brdb/index.ts; it
// is a test seam, not API.
let enabled = true;

export const fastPathsEnabled = (): boolean => enabled;

/** @internal test/bench seam. */
export const setFastPaths = (on: boolean): void => {
  enabled = on;
};

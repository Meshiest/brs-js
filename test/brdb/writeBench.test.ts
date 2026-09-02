// Opt-in write benchmark: `just bench` (or BRS_BENCH=1 npx vitest run).
//
// The two builds are alternated INSIDE each iteration and reported as
// min-of-N. Run-to-run drift on a laptop is easily several percent, so
// sequential "before, then after" measurements can invent a regression that
// is not there; interleaving keeps both sides under the same conditions.
import { describe, expect, test } from 'vitest';
import {
  COMPONENT_STRUCT_DEFAULTS,
  COMPONENT_TYPE_STRUCTS,
  COMPONENTS,
} from '../../src/brdb/componentDb';
import { setFastPaths } from '../../src/brdb/fastPaths';
import { embeddedSchema } from '../../src/brdb/schema';
import { World } from '../../src/brdb/world';

const enabled = process.env.BRS_BENCH === '1';
const ITERATIONS = Number(process.env.BRS_BENCH_ITERATIONS ?? 7);
const BRICKS = Number(process.env.BRS_BENCH_BRICKS ?? 40_000);

/** Component types whose generated defaults encode cleanly (a few carry an
 * incomplete nested struct default and throw in both writers). */
const componentTypes = (() => {
  const schema = embeddedSchema('BRSavedComponentChunkSoA_max');
  return [...COMPONENT_TYPE_STRUCTS]
    .filter(([, struct]) => {
      if (struct === 'None') return true;
      try {
        schema.encode(
          struct,
          schema.fillStruct(struct, {}, COMPONENT_STRUCT_DEFAULTS.get(struct))
        );
        return true;
      } catch {
        return false;
      }
    })
    .map(([type]) => type);
})();

/** A world shaped like a big logic build: every brick carries a component,
 * most with nothing set (the all-default path) and some partially set, plus
 * a wire per pair. */
function benchWorld(bricks: number): World {
  const w = new World();
  const light = COMPONENTS.PointLight.NAME;
  const handles = [];
  for (let i = 0; i < bricks; i++) {
    const type =
      i % 9 === 0 ? light : componentTypes[i % componentTypes.length];
    handles.push(
      w.addBrick({
        asset: 'PB_DefaultBrick',
        size: [5, 5, 6],
        position: [(i % 200) * 10 - 1000, Math.floor(i / 200) * 10 - 1000, 6],
        color: [i & 0xff, (i * 7) & 0xff, (i * 31) & 0xff],
        direction: i % 6,
        rotation: i % 4,
        components: [
          type === light ? { type, data: { Brightness: i % 500 } } : { type },
        ],
      })
    );
  }
  for (let i = 1; i < handles.length; i += 2)
    w.addWire(
      { brick: handles[i], component_type: light, port: 'Out' },
      { brick: handles[i - 1], component_type: light, port: 'In' }
    );
  return w;
}

const ms = (n: number) => `${n.toFixed(1)}ms`;

describe.skipIf(!enabled)('write benchmark (interleaved A/B, min-of-N)', () => {
  test(
    `${BRICKS} bricks, ${ITERATIONS} iterations`,
    { timeout: 600_000 },
    () => {
      const world = benchWorld(BRICKS);
      // toPendingFs is serialization alone; toBrz additionally carries BLAKE3
      // hashing and the container walk.
      const phases: [string, () => unknown][] = [
        ['serialize (toPendingFs)', () => world.toPendingFs()],
        ['whole archive (toBrz)', () => world.toBrz()],
      ];

      const results: string[] = [];
      for (const [label, run] of phases) {
        // Warm up both paths so neither pays for JIT tiering while timed.
        for (const on of [true, false, true, false]) {
          setFastPaths(on);
          run();
        }

        let fast = Infinity;
        let generic = Infinity;
        try {
          for (let i = 0; i < ITERATIONS; i++) {
            setFastPaths(true);
            let t = performance.now();
            run();
            fast = Math.min(fast, performance.now() - t);

            setFastPaths(false);
            t = performance.now();
            run();
            generic = Math.min(generic, performance.now() - t);
          }
        } finally {
          setFastPaths(true);
        }

        results.push(
          `  ${label.padEnd(24)} generic ${ms(generic).padStart(8)}` +
            ` -> fast ${ms(fast).padStart(8)}` +
            `  (${(generic / fast).toFixed(2)}x)`
        );
        expect(fast).toBeLessThan(generic);
      }

      // A speed comparison means nothing unless both sides agree on output.
      setFastPaths(true);
      const a = world.toBrz();
      setFastPaths(false);
      const b = world.toBrz();
      setFastPaths(true);
      expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);

      console.log(['', ...results, ''].join('\n'));
    }
  );
});

// Build a clipboard-style interact brick from scratch: one 5x5x2 default
// brick carrying a Component_Interact that prints "test" to chat/console
// and plays the OBA_UI_Goal_Tune_Cue one-shot audio on interact. The sound
// is an external asset reference: the component's InteractSound field
// stores an index into the externalAssets table passed at write time.
// Writes example_interact.brz, reads it back, and — when given a .brz to
// compare against (e.g. the game clipboard export this recreates) —
// verifies both archives carry the same brick content, ignoring who owns
// the brick and where it sits.
// Usage: node examples/writeInteractBrick.mjs [compare.brz]
import assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import { lib, openWorld } from './openWorld.mjs';
import { canonicalWorld, summarize } from './worldContent.mjs';

const { WorldReader, writeBrzLegacy, brdb } = lib;

const INTERACT = brdb.COMPONENTS.Interact;

const save = {
  // id omitted -> DEFAULT_UUID; the comparison below ignores ownership
  brick_owners: [{ name: 'Example' }],
  bricks: [
    {
      size: [5, 5, 2],
      position: [0, 0, 0],
      direction: 4, // ZPositive
      rotation: 1, // Deg90
      color: [104, 104, 104],
      material_intensity: 5,
      owner_index: 1, // 0 is PUBLIC; owners start at 1
      components: [
        {
          type: INTERACT.NAME,
          data: {
            InteractSound: 0, // externalAssets[0]; omit (null) for no sound
            Message: 'test',
            ConsoleTag: 'test',
            // bAllowNearbyInteraction / bHiddenInteraction /
            // PromptCustomLabel keep their defaults (true / false / '')
          },
        },
      ],
    },
  ],
};

const bytes = writeBrzLegacy(save, {
  externalAssets: [
    { type: 'BrickOneShotAudioDescriptor', name: 'OBA_UI_Goal_Tune_Cue' },
  ],
  bundle: { description: 'Interact brick example' },
});
writeFileSync('example_interact.brz', bytes);
console.log(`example_interact.brz written (${bytes.length} bytes)`);

const reader = WorldReader.from(bytes);
const [brick] = [...reader.bricks()];
console.log('brick:', brick.position, brick.size, brick.color);
for (const ref of reader.brickChunkIndex()) {
  for (const c of reader.componentChunk(1, ref.index).components) {
    console.log(`component ${c.typeName}:`, c.data);
    const sound = reader.externalAssets()[c.data.InteractSound];
    console.log('InteractSound resolves to:', sound);
  }
}

// Optional: verify brick content parity with an existing archive (asset,
// size, orientation, color, components, external assets). Ownership and
// placement are stripped from both sides first — this file uses the
// placeholder owner above and sits near the origin rather than wherever
// the compared archive was clipped from.
const compareFile = process.argv[2];
if (compareFile) {
  const withoutOwnership = canon => {
    delete canon.prefab; // paste pivots/offset are placement metadata too
    for (const grid of Object.values(canon.grids))
      for (const brick of grid) {
        delete brick.owner;
        delete brick.position;
      }
    return canon;
  };
  const { reader: other } = await openWorld(compareFile, 'unreachable');
  const built = withoutOwnership(canonicalWorld(reader));
  const target = withoutOwnership(canonicalWorld(other));
  console.log(`built:  ${summarize(built)}`);
  console.log(`target: ${summarize(target)}`);
  assert.deepStrictEqual(built, target); // throws with a diff on mismatch
  console.log(`content matches ${compareFile} (ignoring ownership/placement)`);
}

// Build a world where pressing a button spawns a prefab: an interactive
// button's `bHeld` output is wired into a prefab-spawner gate's `Exec`
// input, so each press spawns a copy of an embedded single-brick prefab.
// Demonstrates World.addPrefab (content-addressed embedding) with the wire
// API. Build the library first: just build
import { writeFileSync } from 'node:fs';
import { lib } from './openWorld.mjs';

const { World, WorldReader, brdb } = lib;

// COMPONENTS carries each component's type name (NAME), host brick asset
// (BRICK), and wire port names (PORTS).
const BUTTON = brdb.COMPONENTS.Button;
const SPAWNER = brdb.COMPONENTS.Exec_PrefabSpawner;

// 1. Build the prefab that gets spawned: a single red brick.
const prefab = new World();
prefab.addBrick({ position: [0, 0, 6], color: [255, 0, 0] });
prefab.makePrefab();
const prefabBytes = prefab.toBrz({ bundle: { name: 'Spawned Brick' } });

// 2. Build the outer world holding the button + spawner.
const w = new World();

// Embed the prefab; the returned path is what the spawner references.
const prefabPath = w.addPrefab(prefabBytes);

// A pressable button (Component_Button on a 1x1 flat round brick).
const button = w.addBrick({
  asset: BUTTON.BRICK,
  position: [0, 0, 2],
  color: [0, 255, 0],
  components: [{ type: BUTTON.NAME, data: { PromptCustomLabel: 'Spawn Brick' } }],
});

// The prefab-spawner gate, pointed at the embedded prefab.
const spawner = w.addBrick({
  asset: SPAWNER.BRICK,
  position: [15, 0, 1],
  color: [0, 0, 255],
  components: [{ type: SPAWNER.NAME, data: { Prefab: prefabPath } }],
});

// Wire the button's held signal into the spawner's Exec input, so a press
// fires the spawn.
w.addWire(
  { brick: button, component_type: BUTTON.NAME, port: BUTTON.PORTS.bHeld },
  { brick: spawner, component_type: SPAWNER.NAME, port: SPAWNER.PORTS.Exec }
);

const bytes = w.toBrz({
  bundle: { description: 'Button-triggered prefab spawner' },
});
writeFileSync('example_prefab_spawner.brz', bytes);
console.log(`example_prefab_spawner.brz written (${bytes.length} bytes)`);

// Read it back to confirm the embedded prefab, components, and wire survived.
const reader = WorldReader.from(bytes);
console.log('embedded prefab:', prefabPath);
console.log('prefab paths in archive:', reader.prefabPaths());
for (const ref of reader.brickChunkIndex()) {
  for (const c of reader.componentChunk(1, ref.index).components)
    console.log(`  brick ${c.brickIndex} has ${c.typeName}`);
  if (ref.numWires === 0) continue;
  for (const wire of reader.wireChunk(1, ref.index).local)
    console.log(
      `  wire: ${wire.source.componentType}.${wire.source.port}`,
      `feeds ${wire.target.componentType}.${wire.target.port}`
    );
}

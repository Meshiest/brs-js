// Read a .brz or .brdb world and print a summary of its contents.
// Usage: node examples/readWorld.mjs <world.brz|world.brdb>
// Build the library first: just build
import { existsSync, readFileSync } from 'node:fs';

const dist = new URL('../dist/dist.mjs', import.meta.url);
if (!existsSync(dist)) {
  console.error('dist/dist.mjs not found; run `just build` first');
  process.exit(1);
}
const { Brdb, WorldReader } = await import(dist.href);

const file = process.argv[2];
if (!file) {
  console.error('usage: node examples/readWorld.mjs <world.brz|world.brdb>');
  process.exit(1);
}
if (!existsSync(file)) {
  console.error(`file does not exist: ${file}`);
  process.exit(1);
}

const db = file.endsWith('.brdb') ? await Brdb.open(file) : null;
const reader = db
  ? db.worldReader()
  : WorldReader.from(new Uint8Array(readFileSync(file)));

console.log('bundle:', reader.bundle());
console.log('environment:', reader.environment().environment);
console.log('brick assets:', reader.brickAssets());
console.log('materials:', reader.materials());
console.log('owners:', reader.brickOwners());
const globalData = reader.globalData();
console.log('component types:', globalData.ComponentTypeNames);
console.log('wire ports:', globalData.ComponentWirePortNames);

for (const gridId of reader.gridIds()) {
  console.log(`grid ${gridId}:`);
  for (const ref of reader.brickChunkIndex(gridId)) {
    const { index } = ref;
    console.log(
      `  chunk ${index.x},${index.y},${index.z}: ` +
        `${ref.numBricks} bricks, ${ref.numComponents} components, ${ref.numWires} wires`
    );
    if (ref.numComponents > 0)
      for (const c of reader.componentChunk(gridId, index).components)
        console.log(
          `    component on brick ${c.brickIndex}: ${c.typeName}`,
          c.data ?? ''
        );
    if (ref.numWires > 0) {
      const wires = reader.wireChunk(gridId, index);
      for (const w of wires.local)
        console.log(
          `    wire ${w.source.componentType}.${w.source.port} to ${w.target.componentType}.${w.target.port}`
        );
      for (const w of wires.remote)
        console.log(
          `    wire (from grid ${w.source.gridId}) ${w.source.componentType}.${w.source.port} to ${w.target.componentType}.${w.target.port}`
        );
    }
  }
  const bricks = [...reader.bricks(gridId)];
  for (const b of bricks.slice(0, 5))
    console.log(
      `  brick at [${b.position}] size [${b.size}] color [${b.color}]`
    );
  if (bricks.length > 5) console.log(`  (${bricks.length - 5} more bricks)`);
}

const entities = [...reader.entities()];
console.log(`entities: ${entities.length}`);
for (const e of entities)
  console.log(
    `  ${e.typeName} at ${e.location.X},${e.location.Y},${e.location.Z}` +
      (e.frozen ? ' (frozen)' : '')
  );

if (db) {
  console.log('revisions:');
  for (const r of db.revisions())
    console.log(
      `  ${r.revisionId}: ${r.description} (${new Date(
        r.createdAt * 1000
      ).toISOString()})`
    );
  db.close();
}

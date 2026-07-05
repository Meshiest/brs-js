// Extract the component/brick inventory from a "zoo" world — a save with
// every component placed and every wire port wired (built in-game by the
// ue4ss mod's inventory tool) — into data/componentInventory.json.
//
// The inventory feeds scripts/syncBrdbData.mjs (COMPONENTS, catalog, wire
// ports). Regenerate when the game adds components:
//   1. build the zoo world in-game (ue4ss-mcp `inventory` tool), save it
//   2. npm run build   (this script reads the world with the built library)
//   3. node scripts/extractInventory.mjs <path/to/zoo.brdb>
// Usage: node scripts/extractInventory.mjs <world.brdb|world.brz>
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const dist = new URL('../dist/dist.mjs', import.meta.url);
if (!existsSync(dist)) {
  console.error('dist/dist.mjs not found; run `npm run build` first');
  process.exit(1);
}
const { Brdb, WorldReader } = await import(dist.href);

const file = process.argv[2];
if (!file || !existsSync(file)) {
  console.error('usage: node scripts/extractInventory.mjs <world.brdb|.brz>');
  process.exit(1);
}

const db = file.endsWith('.brdb') ? await Brdb.open(file) : null;
const reader = db
  ? db.worldReader()
  : WorldReader.from(new Uint8Array(readFileSync(file)));

const globalData = reader.globalData();
const assets = reader.brickAssets();

// class -> { bricks:Set, inputs:Set, outputs:Set }
const components = new Map();
const entry = cls => {
  let e = components.get(cls);
  if (!e)
    components.set(
      cls,
      (e = { bricks: new Set(), inputs: new Set(), outputs: new Set() })
    );
  return e;
};

for (const gridId of reader.gridIds()) {
  const refs = reader.brickChunkIndex(gridId);
  // bricks(gridId) streams chunks in brickChunkIndex order; partition the
  // stream by each chunk's brick count to resolve chunk-local indices.
  const stream = reader.bricks(gridId);
  const chunkBricks = refs.map(ref =>
    Array.from({ length: ref.numBricks }, () => stream.next().value)
  );
  refs.forEach((ref, i) => {
    if (ref.numComponents > 0)
      for (const c of reader.componentChunk(gridId, ref.index).components) {
        const asset = assets[chunkBricks[i][c.brickIndex]?.asset_name_index];
        if (asset) entry(c.typeName).bricks.add(asset);
      }
    if (ref.numWires > 0) {
      const wires = reader.wireChunk(gridId, ref.index);
      for (const w of [...wires.local, ...wires.remote]) {
        entry(w.source.componentType).outputs.add(w.source.port);
        entry(w.target.componentType).inputs.add(w.target.port);
      }
    }
  });
}
db?.close();

const out = {
  allBrickAssets: globalData.BasicBrickAssetNames,
  proceduralBrickAssets: globalData.ProceduralBrickAssetNames,
  components: [...components.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cls, e]) => ({
      class: cls,
      bricks: [...e.bricks].sort(),
      inputs: [...e.inputs].sort(),
      outputs: [...e.outputs].sort(),
    })),
};

const target = new URL('../data/componentInventory.json', import.meta.url);
writeFileSync(target, JSON.stringify(out, null, 2) + '\n');
console.log(
  `wrote data/componentInventory.json: ${out.allBrickAssets.length} basic assets, ` +
    `${out.proceduralBrickAssets.length} procedural, ${out.components.length} components`
);

// Print per-owner brick and component counts, including the synthetic
// PUBLIC owner stored at row 0 of the owner table.
// Usage: node examples/worldOwnerCounts.mjs <world.brz|world.brdb>
import { openWorld } from './openWorld.mjs';

const { reader, db } = await openWorld(
  process.argv[2],
  'node examples/worldOwnerCounts.mjs <world.brz|world.brdb>'
);

const owners = reader.owners();
let bricks = 0;
for (let i = 0; i < owners.UserNames.length; i++) {
  const name = i === 0 ? 'PUBLIC' : owners.DisplayNames[i];
  console.log(
    `${name}: ${owners.BrickCounts[i]} bricks, ${owners.ComponentCounts[i]} components`
  );
  bricks += owners.BrickCounts[i];
}
console.log(`total: ${bricks} bricks`);
db?.close();

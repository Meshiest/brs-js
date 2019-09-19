const { read, write } = require('../dist/dist.node.js');
const _ = require('lodash');

const uuid0 = '00000000-0000-0000-0000-000000000000';

test('creating a brs from thin air', () => {
  const save = {
    version: 4,
    map: 'Unknown',
    description: '',
    author: {id: uuid0, name: 'Test'},
    save_time: [0, 0, 0, 0, 0, 0, 0, 0],
    brick_count: 1,
    mods: [],
    brick_assets: [],
    colors: [],
    materials: ['BMC_Hologram', 'BMC_Plastic', 'BMC_Glow', 'BMC_Metallic'],
    brick_owners: [{id: uuid0, name: 'Test'}],
    bricks: [{
      asset_name_index: 1,
      size: [10, 10, 10],
      position: [0, 0, 0],
      direction: 4,
      owner_index: 0,
      rotation: 0,
      collision: true,
      visibility: true,
      material_index: 1,
      color: [0, 0, 0, 255],
    }],
  };

  expect(read(write(save))).toEqual(save);
});
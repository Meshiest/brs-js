/*
  This is an example read for Node.js
 */

const fs = require('fs');
const path = require('path');
const brs = require('brs-js');

// Save path
const file = path.resolve(__dirname, 'ATCFort.brs');

// Read the save as bytes into a buffer
const buffer = fs.readFileSync(file);

// Read the buffer into JSON
const save = brs.read(buffer);

// Print some info
console.log('Description:', save.description);
console.log('Brick Count:', save.brick_count);
console.log('Random Brick: ', save.bricks[Math.round(Math.random() * save.brick_count)]);

/*
  This is an example write for Node.js
 */

const fs = require('fs');
const path = require('path');
const brs = require('brs-js');
const _ = require('lodash');

// Save path
const file = path.resolve(__dirname, 'ATCFort.brs');

// Read the save as bytes into a buffer
const buffer = fs.readFileSync(file);

// Read the buffer into JSON
const save = brs.read(buffer);
const same = brs.read(brs.write(save));

console.log('read(write(save)) == read(buff) :', _.isEqual(save, same));

// Write the save to a file
const outfile = path.resolve(__dirname, 'ATCFort-test.brs');
// Print some info
fs.writeFileSync(outfile, brs.write(save));

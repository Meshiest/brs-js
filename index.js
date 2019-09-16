// Detect if we're on node
const isNode = require('detect-node');

if (isNode) {
  // require the node built target
  module.exports = require('./dist/dist.node.js');
} else {
  // require the web built target
  module.exports = require('./dist/dist.js');
}

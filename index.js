// Detect if we're on node
const isNode = require('detect-node');

module.exports = require(isNode
  // require the node built target
  ? './dist/dist.node.js'
  // require the web built target
  : './dist/dist.web.js');


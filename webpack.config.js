const path = require('path');

const config = {
  mode: 'development',
  entry: path.resolve(__dirname, 'src/index.js'),
  module: {
    rules: [{
      test: /\.js$/,
      use: 'babel-loader',
      exclude: /node_modules/,
    }],
  }
};

module.exports = [{
  ...config,
  target: 'node',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'dist.node.js',
    library: 'brs-js',
    libraryTarget: 'commonjs2'
  }
}, {
  ...config,
  target: 'web',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'dist.js',
  }
}];

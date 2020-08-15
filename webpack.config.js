const path = require('path');

const mode = process.env.NODE_ENV || 'development';

const config = {
  mode,
  entry: path.resolve(__dirname, 'src/index.js'),
  devtool: 'source-map',
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
    libraryTarget: 'commonjs2',
  },
}, {
  ...config,
  target: 'web',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'dist.js',
  },
}, {
  ...config,
  target: 'web',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'dist.web.js',
    library: 'brs-js',
    libraryTarget: 'commonjs2',
  },
}];

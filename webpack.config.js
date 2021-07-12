const path = require('path');

const mode = process.env.NODE_ENV || 'development';

const config = {
  mode,
  entry: path.resolve(__dirname, 'src/index.ts'),
  devtool: 'source-map',
  module: {
    rules: [{
      test: /\.ts$/,
      use: {
        loader: 'ts-loader',
        options: {
          experimentalFileCaching: true,
        },
      },
      exclude: /node_modules/,
    }],
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
};

module.exports = [{
  ...config,
  target: 'node',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'dist.node.js',
    library: {
      type: 'commonjs2',
    },
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
    library: {
      type: 'commonjs2',
    },
  },
}];

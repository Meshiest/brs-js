import read from './read';
import write from './write';
import * as utils from './utils';
import * as constants from './constants';

export { read, write, utils, constants };

if (typeof window !== 'undefined')
  window.BRS = { read, write, utils, constants };

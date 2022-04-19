import read from './read';
import write from './write';
import * as utils from './utils';
import * as constants from './constants';
export * from './types';

// https://i.imgur.com/cv1fDWs.png
const brs = { read, write, utils, constants };
export { read, write, utils, constants };
export default brs;

if (typeof window !== 'undefined') {
  (window as any).BRS = brs;
}

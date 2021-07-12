import read from './read';
import write from './write';
import * as utils from './utils';
import * as constants from './constants';

// https://i.imgur.com/cv1fDWs.png
const brs = { read, write, utils, constants };
export { read, write, utils, constants };
export default brs;

declare global {
  interface Window {
    BRS: {
      read: typeof read;
      write: typeof write;
      utils: typeof utils;
      constants: typeof constants;
    };
  }
}

if (typeof window !== 'undefined') {
  window.BRS = brs;
}

import read from './brs/read';
import write from './brs/write';
import * as utils from './brs/utils';
import * as constants from './brs/constants';
import * as types from './brs/types';
export * from './brs/types';

// https://i.imgur.com/cv1fDWs.png
const brs = { read, write, utils, constants, types };
export { read, write, utils, constants, types };
export default brs;

if (typeof window !== 'undefined') {
  (window as any).BRS = brs;
}

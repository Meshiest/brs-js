import read from './brs/read';
import write from './brs/write';
import * as utils from './brs/utils';
import * as constants from './brs/constants';
import * as types from './brs/types';
import * as brdb from './brdb';
export * from './brs/types';

// https://i.imgur.com/cv1fDWs.png
const brs = { read, write, utils, constants, types, brdb };
export { read, write, utils, constants, types, brdb };
export { Brdb, World, WorldReader, writeBrzLegacy } from './brdb';
export default brs;

if (typeof window !== 'undefined') {
  (window as any).BRS = brs;
}

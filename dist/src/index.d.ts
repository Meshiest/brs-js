import read from './read';
import write from './write';
import * as utils from './utils';
import * as constants from './constants';
declare const brs: {
    read: typeof read;
    write: typeof write;
    utils: typeof utils;
    constants: typeof constants;
};
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

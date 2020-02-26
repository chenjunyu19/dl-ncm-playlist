'use strict';

const worker_threads = require('worker_threads');

const util = require('./util');

worker_threads.parentPort.on('message', (file) => {
    util.md5sum(file).then((md5) => {
        worker_threads.parentPort.postMessage({ file, md5 });
    });
});

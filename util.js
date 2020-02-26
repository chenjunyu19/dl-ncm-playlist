'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');

module.exports = {
    readFileSyncSafe(path) {
        if (fs.existsSync(path)) {
            return fs.readFileSync(path, { encoding: 'utf-8' });
        }
    },

    readDirFileSync(path) {
        const files = [];
        for (const file of fs.readdirSync(path, { withFileTypes: true })) {
            if (file.isFile()) {
                files.push(file.name);
            }
        }
        return files;
    },

    md5sum(path) {
        return new Promise((resolve) => {
            const hash = crypto.createHash('md5');
            hash.on('readable', () => {
                const data = hash.read();
                if (data) {
                    resolve(data.toString('hex'));
                }
            });
            fs.createReadStream(path).pipe(hash);
        });
    },

    getCookie(url) {
        return new Promise((resolve) => {
            http.get(url, (res) => {
                resolve(res.headers['set-cookie']);
            });
        });
    },

    getJSON(url, cookie) {
        return new Promise((resolve) => {
            http.get(url, { headers: { cookie: cookie || '' } }, (res) => {
                let data = Buffer.alloc(0);
                res.on('data', (chunk) => {
                    data = Buffer.concat([data, chunk]);
                });
                res.on('end', () => {
                    resolve(JSON.parse(data));
                });
            });
        });
    },

    donwloadFile(url, path) {
        return new Promise((resolve) => {
            http.get(url, (res) => {
                const writeStream = fs.createWriteStream(path);
                writeStream.on('close', resolve);
                res.pipe(writeStream);
            });
        });
    },

    removeExtName(fileName) {
        return fileName.substring(0, fileName.lastIndexOf('.'));
    },

    getSongName(track, maxByteLength) {
        const artist = [];
        for (const ar of track.ar) {
            artist.push(ar.name);
        }
        let name = this.replaceSpecialChar(artist.join(',') + ' - ' + track.name);
        while (maxByteLength && Buffer.from(name).byteLength > maxByteLength) {
            artist.pop();
            name = this.replaceSpecialChar(artist.concat(`...(${track.ar.length})`).join(',') + ' - ' + track.name);
        }
        return name;
    },

    replaceSpecialChar(string) {
        for (const char of [[/\\/g, '＼'], [/\//g, '／'], [/\?/g, '？'], [/:/g, '：'], [/\*/g, '＊'], [/"/g, '＂'], [/</g, '＜'], [/>/g, '＞'], [/\|/g, '｜']]) {
            string = string.replace(char[0], char[1]);
        }
        return string;
    },

    logStep(message) {
        console.log('\u001b[1m\u001b[34m::\u001b[0m\u001b[1m %s\u001b[0m', message);
    },

    logError(message) {
        console.log(`\u001b[1m\u001b[31m错误：\u001b[0m${message}`);
    },
};
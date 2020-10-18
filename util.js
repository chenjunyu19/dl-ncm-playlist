'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');

module.exports = {
    async readFileSafe(path) {
        try {
            return await fs.promises.readFile(path, { encoding: 'utf-8' });
        } catch (err) {
            return;
        }
    },

    async readDirFile(path) {
        const files = [];
        for (const file of await fs.promises.readdir(path, { withFileTypes: true })) {
            if (file.isFile()) {
                files.push(file.name);
            }
        }
        return files;
    },

    async writeFileIfNecessary(path, data) {
        if (await this.readFileSafe(path) !== data) {
            await fs.promises.writeFile(path, data);
            return true;
        } else {
            return false;
        }
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

    getSongName(track, maxByteLength, separator) {
        const artist = [];
        for (const ar of track.ar) {
            artist.push(ar.name);
        }
        let name = this.replaceSpecialChar(artist.join(separator) + ' - ' + track.name);
        while (maxByteLength && Buffer.from(name).byteLength > maxByteLength) {
            artist.pop();
            name = this.replaceSpecialChar(artist.concat(`...(${track.ar.length})`).join(separator) + ' - ' + track.name);
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

    logWarn(message) {
        console.log(`\u001b[1m\u001b[33m警告：\u001b[0m${message}`);
    },

    logError(message) {
        console.log(`\u001b[1m\u001b[31m错误：\u001b[0m${message}`);
    },
};

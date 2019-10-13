'use strict';

const cluster = require('cluster');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const configFilePath = path.join(__dirname, 'config.json');

function readFileSyncSafe(path) {
    if (fs.existsSync(path)) {
        return fs.readFileSync(path, { encoding: 'utf-8' });
    }
}

function readDirFileSync(path) {
    const files = [];
    for (const file of fs.readdirSync(path, { withFileTypes: true })) {
        if (file.isFile()) {
            files.push(file.name);
        }
    }
    return files;
}

function md5sum(path) {
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
}

function getCookie(url) {
    return new Promise((resolve) => {
        http.get(url, (res) => {
            resolve(res.headers["set-cookie"]);
        });
    });
}

function getJSON(url, cookie) {
    return new Promise((resolve) => {
        http.get(url, { headers: { cookie: cookie ? cookie : '' } }, (res) => {
            let data = Buffer.alloc(0);
            res.on('data', (chunk) => {
                data = Buffer.concat([data, chunk]);
            });
            res.on('end', () => {
                resolve(JSON.parse(data));
            });
        });
    });
}

function donwloadFile(url, path) {
    return new Promise((resolve) => {
        http.get(url, (res) => {
            res.on('close', resolve);
            res.pipe(fs.createWriteStream(path));
        });
    });
}

function removeExtName(fileName) {
    return fileName.substring(0, fileName.lastIndexOf('.'));
}

function getSongName(track) {
    const artist = [];
    for (const ar of track.ar) {
        artist.push(ar.name);
    }
    return replaceSpecialChar(artist.join(',') + ' - ' + track.name);
}

function replaceSpecialChar(string) {
    for (const char of [['\\', '＼'], ['/', '／'], ['?', '？'], [':', '：'], ['*', '＊'], ['"', '＂'], ['<', '＜'], ['>', '＞'], ['|', '｜']]) {
        string = string.replace(char[0], char[1]);
    }
    return string;
}

function logStep(message) {
    console.log('\u001b[1m\u001b[34m::\u001b[0m\u001b[1m %s\u001b[0m', message);
}

async function main() {
    logStep('正在读取配置...');
    const config = JSON.parse(readFileSyncSafe(configFilePath)) || {};

    logStep('正在启动 NeteaseCloudMusicApi...');
    const ncmApi = await require(config.ncmApiPath + '/app.js');
    const ncmApiHost = 'http://localhost:' + ncmApi.server.address().port;

    let needSave;
    if (config.mainLogin) {
        logStep('正在登录主帐号...');
        config.mainCookie = await getCookie(ncmApiHost + `/login/cellphone?phone=${config.mainLogin.phone}&password=${config.mainLogin.password}`);
        config.mainLogin = undefined;
        needSave = true;
    }
    if (config.downloadLogin) {
        logStep('正在登录辅助下载帐号...');
        config.downloadCookie = await getCookie(ncmApiHost + `/login/cellphone?phone=${config.downloadLogin.phone}&password=${config.downloadLogin.password}`);
        config.downloadLogin = undefined;
        needSave = true;
    }
    if (config.mainCookie && !config.downloadCookie) {
        config.downloadCookie = config.mainCookie;
        needSave = true;
    }
    if (config.downloadCookie && !config.mainCookie) {
        config.mainCookie = config.downloadCookie;
        needSave = true;
    }
    if (needSave) {
        logStep('正在保存配置...');
        fs.writeFileSync(configFilePath, JSON.stringify(config, undefined, 4));
    }

    logStep('正在获取歌单数据...');
    const songs = new Map();
    for (const track of (await getJSON(ncmApiHost + '/playlist/detail?id=' + config.playlistId, config.mainCookie)).playlist.tracks) {
        songs.set(track.id, { songName: getSongName(track) });
    }
    for (const track of (await getJSON(ncmApiHost + '/user/cloud', config.mainCookie)).data) {
        const id = track.songId;
        if (songs.has(id)) {
            const song = songs.get(id);
            song.inCloud = true;
            song.fileName = track.fileName;
            song.songName = removeExtName(track.fileName);
        }
    }

    logStep('正在对比本地文件...');
    const files = readDirFileSync(config.downloadDir);
    for (const song of songs.values()) {
        let fileName = songs.fileName;
        song.needDownload = true;
        if (fileName) {
            song.needDownload = files.includes(fileName);
        } else {
            for (const extname of config.extnames) {
                fileName = song.songName + extname;
                if (files.includes(fileName)) {
                    song.needDownload = false;
                    break;
                }
            }
        }
        if (!song.needDownload) {
            files.splice(files.indexOf(fileName), 1);
        }
    }

    const md5s = new Map();
    if (config.useMd5 && config.downloadSong) {
        const filesToSumMd5 = [];
        for (const file of files) {
            if (config.extnames.includes(path.extname(file))) {
                filesToSumMd5.push(file);
            }
        }
        if (filesToSumMd5.length) {
            logStep('正在计算未知歌曲 md5...');
            await new Promise((resolve) => {
                const iterator = filesToSumMd5[Symbol.iterator]();
                function sendNextFileToWorker(worker) {
                    const obj = iterator.next();
                    if (obj.done) {
                        worker.kill();
                    } else {
                        const file = obj.value;
                        console.log('(%i/%i) 正在计算 %s', filesToSumMd5.indexOf(file) + 1, filesToSumMd5.length, file);
                        worker.send(path.join(config.downloadDir, file));
                    }
                }
                cluster.on('online', sendNextFileToWorker);
                cluster.on('message', (worker, message) => {
                    md5s.set(message.md5, message.file);
                    if (md5s.size < filesToSumMd5.length) {
                        sendNextFileToWorker(worker);
                    } else {
                        resolve();
                    }
                });
                for (let i = 0; i < Math.min(filesToSumMd5.length, os.cpus().length); ++i) {
                    cluster.fork();
                }
            });
        }
    }

    if (config.downloadSong) {
        const byMain = [];
        const byDl = [];
        for (const array of songs) {
            if (array[1].needDownload) {
                if (array[1].inCloud) {
                    byMain.push(array[0]);
                } else {
                    byDl.push(array[0]);
                }
            }
        }
        if (byMain.length && byDl.length) {
            logStep('正在获取下载地址...');
            const urls = [];
            for (const array of [[byMain, config.mainCookie], [byDl, config.downloadCookie]]) {
                if (array[0].length) {
                    urls.push(...(await getJSON(ncmApiHost + '/song/url?id=' + array[0].join(','), array[1])).data);
                }
            }

            logStep('正在下载缺少歌曲...');
            for (const url of urls) {
                const song = songs.get(url.id);
                const fileName = song.inCloud ? song.fileName : song.songName + '.' + url.type;
                const file = path.join(config.downloadDir, fileName);
                const tmpFile = file + '.part';
                if (md5s.has(url.md5)) {
                    function rename(oldPath, newPath) {
                        console.log('(%i/%i) 正在重命名 %s 为 %s', urls.indexOf(url) + 1, urls.length, path.basename(oldPath), path.basename(newPath));
                        fs.renameSync(oldPath, newPath);
                    }
                    const oldFile = md5s.get(url.md5);
                    rename(oldFile, file);
                    const oldLrc = removeExtName(oldFile) + '.lrc';
                    if (fs.existsSync(oldLrc)) {
                        const lrc = removeExtName(file) + '.lrc';
                        rename(oldLrc, lrc);
                    }
                    md5s.delete(url.md5);
                } else {
                    let successful;
                    do {
                        console.log('(%i/%i) 正在下载 [%i bit/s] %s', urls.indexOf(url) + 1, urls.length, url.br, path.basename(file));
                        await donwloadFile(url.url, tmpFile);
                        if (await md5sum(tmpFile) === url.md5) {
                            fs.renameSync(tmpFile, file);
                            successful = true;
                        } else {
                            console.error('\u001b[1m\u001b[31m错误：\u001b[0mmd5 不符');
                        }
                    } while (!successful)
                }
            }
        }

    } else {
        logStep('正在显示缺少歌曲...');
        for (const song of songs.values()) {
            if (song.needDownload) {
                console.log(song.songName);
            }
        }
    }

    if (config.downloadLyric) {
        logStep('正在更新歌词...');
        const maps = new Map();
        if (config.maps) {
            for (const map of config.maps) {
                maps.set(map[0], map[1]);
            }
        }
        for (const array of songs) {
            const id = array[0];
            const song = array[1];
            const file = path.join(config.downloadDir, song.songName + '.lrc');
            console.log('(%i/%i) 正在检查 %s', Array.from(songs.keys()).indexOf(id) + 1, songs.size, path.basename(file));
            const lyric = await getJSON(ncmApiHost + '/lyric?id=' + (maps.has(id) ? maps.get(id) : id));
            if (!lyric.nolyric && !lyric.uncollected && lyric.lrc) {
                const lrc = lyric.lrc.lyric;
                if (readFileSyncSafe(file) !== lrc) {
                    fs.writeFileSync(file, lrc);
                    console.log('已更新');
                }
            }
        }
    }

    if (md5s.size) {
        logStep('正在输出遗留歌曲文件...');
        for (const file of md5s.values()) {
            console.log(path.basename(file));
        }
    }

    logStep('正在退出...');
    ncmApi.server.close();
    process.exit();
}

if (cluster.isMaster) {
    main();
} else if (cluster.isWorker) {
    cluster.worker.on('message', (message) => {
        md5sum(message).then((md5) => {
            cluster.worker.send({ file: message, md5: md5 });
        });
    });
}

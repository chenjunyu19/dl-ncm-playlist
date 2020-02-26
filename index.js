'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const worker_threads = require('worker_threads');

const util = require('./util');

const configFilePath = path.join(__dirname, 'config.json');

async function main() {
    util.logStep('正在读取配置...');
    const config = JSON.parse(util.readFileSyncSafe(configFilePath)) || {};

    util.logStep('正在启动 NeteaseCloudMusicApi...');
    const ncmApi = await require(config.ncmApiPath + '/app.js');
    const ncmApiHost = 'http://localhost:' + ncmApi.server.address().port;

    let needSave;
    if (config.mainLogin) {
        util.logStep('正在登录主帐号...');
        config.mainCookie = await util.getCookie(ncmApiHost + `/login/cellphone?phone=${config.mainLogin.phone}&password=${config.mainLogin.password}`);
        delete config.mainLogin;
        needSave = true;
    }
    if (config.downloadLogin) {
        util.logStep('正在登录辅助下载帐号...');
        config.downloadCookie = await util.getCookie(ncmApiHost + `/login/cellphone?phone=${config.downloadLogin.phone}&password=${config.downloadLogin.password}`);
        delete config.downloadLogin;
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
        util.logStep('正在保存配置...');
        fs.writeFileSync(configFilePath, JSON.stringify(config, undefined, 4));
    }

    util.logStep('正在获取歌单数据...');
    const songs = new Map();
    for (const track of (await util.getJSON(ncmApiHost + '/playlist/detail?id=' + config.playlistId, config.mainCookie)).playlist.tracks) {
        songs.set(track.id, { id: track.id, songName: util.getSongName(track, config.maxByteLength) });
    }
    if (config.mainCookie) {
        for (const track of (await util.getJSON(ncmApiHost + '/user/cloud', config.mainCookie)).data) {
            const id = track.songId;
            if (songs.has(id)) {
                const song = songs.get(id);
                song.inCloud = true;
                song.fileName = track.fileName;
                song.songName = util.removeExtName(track.fileName);
            }
        }
    }

    util.logStep('正在对比本地文件...');
    const unkownFiles = util.readDirFileSync(config.downloadDir);
    for (const song of songs.values()) {
        let fileName = songs.fileName;
        song.needDownload = true;
        if (fileName) {
            song.needDownload = unkownFiles.includes(fileName);
        } else {
            for (const extname of config.extnames) {
                fileName = song.songName + extname;
                if (unkownFiles.includes(fileName)) {
                    song.needDownload = false;
                    break;
                }
            }
        }
        if (!song.needDownload) {
            unkownFiles.splice(unkownFiles.indexOf(fileName), 1);
        }
    }

    const md5s = new Map();
    if (config.useMd5 && config.downloadSong) {
        const filesToSumMd5 = [];
        for (const file of unkownFiles) {
            if (config.extnames.includes(path.extname(file))) {
                filesToSumMd5.push(file);
            }
        }
        if (filesToSumMd5.length) {
            util.logStep('正在计算未知歌曲 md5...');
            await new Promise((resolve) => {
                const iterator = filesToSumMd5[Symbol.iterator]();
                const sendNextFileToWorker = (worker) => {
                    const obj = iterator.next();
                    if (obj.done) {
                        worker.terminate();
                    } else {
                        const file = obj.value;
                        console.log('(%i/%i) 正在计算 %s', filesToSumMd5.indexOf(file) + 1, filesToSumMd5.length, file);
                        worker.postMessage(path.join(config.downloadDir, file));
                    }
                };
                for (let i = 0; i < Math.min(filesToSumMd5.length, os.cpus().length); ++i) {
                    const worker = new worker_threads.Worker(path.join(__dirname, 'md5sum_worker.js'));
                    worker.once('online', () => { sendNextFileToWorker(worker); });
                    worker.on('message', (value) => {
                        md5s.set(value.md5, value.file);
                        if (md5s.size < filesToSumMd5.length) {
                            sendNextFileToWorker(worker);
                        } else {
                            resolve();
                        }
                    });
                }
            });
        }
    }

    if (config.downloadSong) {
        const byMain = [];
        const byDl = [];
        for (const song of songs.values()) {
            if (song.needDownload) {
                if (song.inCloud) {
                    byMain.push(song.id);
                } else {
                    byDl.push(song.id);
                }
            }
        }
        if (byMain.length || byDl.length) {
            util.logStep('正在获取下载地址...');
            const urls = [];
            for (const array of [[byMain, config.mainCookie], [byDl, config.downloadCookie]]) {
                if (array[0].length) {
                    urls.push(...(await util.getJSON(ncmApiHost + '/song/url?id=' + array[0].join(','), array[1])).data);
                }
            }

            util.logStep('正在下载缺少歌曲...');
            const countTotal = urls.length;
            for (const url of urls) {
                const countThis = urls.indexOf(url) + 1;
                const song = songs.get(url.id);
                const fileName = song.inCloud ? song.fileName : song.songName + '.' + url.type;
                const file = path.join(config.downloadDir, fileName);
                const tmpFile = file + '.part';
                if (url.code === 200) {
                    if (md5s.has(url.md5)) {
                        const rename = (oldPath, newPath) => {
                            console.log('(%i/%i) 正在重命名 %s 为 %s', countThis, countTotal, path.basename(oldPath), path.basename(newPath));
                            fs.renameSync(oldPath, newPath);
                        };
                        const oldFile = md5s.get(url.md5);
                        rename(oldFile, file);
                        const oldLrc = util.removeExtName(oldFile) + '.lrc';
                        if (fs.existsSync(oldLrc)) {
                            const lrc = util.removeExtName(file) + '.lrc';
                            rename(oldLrc, lrc);
                        }
                        md5s.delete(url.md5);
                    } else {
                        let successful;
                        while (!successful) {
                            console.log('(%i/%i) 正在下载 [%i bit/s] %s', countThis, countTotal, url.br, path.basename(file));
                            await util.donwloadFile(url.url, tmpFile);
                            if (await util.md5sum(tmpFile) === url.md5) {
                                fs.renameSync(tmpFile, file);
                                successful = true;
                            } else {
                                util.logError('md5 不符');
                            }
                        }
                    }
                } else {
                    util.logError(`无法获取 ${song.songName} 的地址，请检查当前登录帐号是否有权限试听该歌曲。`);
                }
            }
        }

    } else {
        util.logStep('正在显示缺少歌曲...');
        for (const song of songs.values()) {
            if (song.needDownload) {
                console.log(song.songName);
            }
        }
    }

    if (config.downloadLyric) {
        util.logStep('正在更新歌词...');
        const maps = new Map(config.maps);
        for (const song of songs.values()) {
            const file = path.join(config.downloadDir, song.songName + '.lrc');
            console.log('(%i/%i) 正在检查 %s', Array.from(songs.keys()).indexOf(song.id) + 1, songs.size, path.basename(file));
            const lyric = await util.getJSON(ncmApiHost + '/lyric?id=' + (maps.get(song.id) || song.id));
            if (!lyric.nolyric && !lyric.uncollected && lyric.lrc) {
                const lrc = lyric.lrc.lyric;
                if (util.readFileSyncSafe(file) !== lrc) {
                    fs.writeFileSync(file, lrc);
                    console.log('已更新');
                }
            }
        }
    }

    if (md5s.size) {
        util.logStep('正在输出遗留歌曲文件...');
        for (const file of md5s.values()) {
            console.log(path.basename(file));
        }
    }

    util.logStep('正在退出...');
    ncmApi.server.close();
    process.exit();
}

main();

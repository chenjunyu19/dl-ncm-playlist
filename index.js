'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const worker_threads = require('worker_threads');

const util = require('./util');

const configFilePath = path.join(__dirname, 'config.json');

async function main() {
    util.logStep('正在读取配置...');
    const config = JSON.parse(await util.readFileSafe(configFilePath)) || {};

    util.logStep('正在加载 NeteaseCloudMusicApi...');
    const { login_cellphone, playlist_detail, user_cloud, song_url, lyric } = require(path.join(config.ncmApiPath, 'main.js'));

    let needSave;
    for (const type of [{ name: 'main', description: '主' }, { name: 'download', description: '辅助下载' }]) {
        if (config[type.name + 'Login']) {
            util.logStep(`正在登录${type.description}帐号...`);
            const result = await login_cellphone({ phone: config[type.name + 'Login'].phone, password: config[type.name + 'Login'].password });
            config[type.name + 'Cookie'] = result.body.cookie;
            delete config[type.name + 'Login'];
            needSave = true;
        }
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
        await fs.writeFile(configFilePath, JSON.stringify(config, undefined, 4));
    }

    util.logStep('正在获取歌单数据...');
    const songs = new Map();
    const playlistDetail = await playlist_detail({ id: config.playlistId, cookie: config.mainCookie });
    for (const track of playlistDetail.body.playlist.tracks) {
        songs.set(track.id, { id: track.id, songName: util.getSongName(track, config.maxByteLength) });
    }
    if (config.mainCookie) {
        for (const track of (await user_cloud({ cookie: config.mainCookie })).body.data) {
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
    const unkownFiles = await util.readDirFile(config.downloadDir);
    for (const song of songs.values()) {
        let fileName = song.fileName;
        song.needDownload = true;
        if (fileName) {
            song.needDownload = !unkownFiles.includes(fileName);
        } else {
            for (const extname of config.extnames) {
                fileName = song.songName + extname;
                if (unkownFiles.includes(fileName)) {
                    song.fileName = fileName;
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
                    urls.push(...(await song_url({ id: array[0].join(','), cookie: array[1] })).body.data);
                }
            }

            util.logStep('正在下载缺少歌曲...');
            const countTotal = urls.length;
            for (const url of urls) {
                const countThis = urls.indexOf(url) + 1;
                const song = songs.get(url.id);
                if (!song.inCloud) {
                    song.fileName = song.songName + '.' + url.type;
                }
                const file = path.join(config.downloadDir, song.fileName);
                const tmpFile = file + '.part';
                if (url.code === 200) {
                    if (md5s.has(url.md5)) {
                        const rename = async (oldPath, newPath) => {
                            console.log('(%i/%i) 正在重命名 %s 为 %s', countThis, countTotal, path.basename(oldPath), path.basename(newPath));
                            await fs.rename(oldPath, newPath);
                        };
                        const oldFile = md5s.get(url.md5);
                        await rename(oldFile, file);
                        try {
                            await rename(util.removeExtName(oldFile) + '.lrc', util.removeExtName(file) + '.lrc');
                        } catch (error) {
                            util.logWarn('重命名时发生了错误');
                        }
                        md5s.delete(url.md5);
                    } else {
                        let successful;
                        while (!successful) {
                            console.log('(%i/%i) 正在下载 [%i bit/s] %s', countThis, countTotal, url.br, path.basename(file));
                            await util.donwloadFile(url.url, tmpFile);
                            if (await util.md5sum(tmpFile) === url.md5) {
                                await fs.rename(tmpFile, file);
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
            const lyricResult = (await lyric({ id: maps.get(song.id) || song.id })).body;
            if (!lyricResult.nolyric && !lyricResult.uncollected && lyricResult.lrc) {
                if (await util.writeFileIfNecessary(file, lyricResult.lrc.lyric)) {
                    console.log('已更新');
                }
            }
        }
    }

    if (config.saveM3U) {
        util.logStep('正在更新 M3U 播放列表...');
        const fileNames = [];
        for (const song of songs.values()) {
            fileNames.push(song.fileName);
        }
        if (await util.writeFileIfNecessary(path.join(config.downloadDir, `! ${playlistDetail.body.playlist.name}.m3u`), fileNames.join('\n'))) {
            console.log('已更新');
        }
    }

    if (md5s.size) {
        util.logStep('正在输出遗留歌曲文件...');
        for (const file of md5s.values()) {
            console.log(path.basename(file));
        }
    }

    util.logStep('正在退出...');
    process.exit();
}

main();

# dl-ncm-playlist

将网易云音乐播放列表同步到磁盘，支持主辅双帐号和云盘歌曲。特别感谢 [NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi)。

## 特性

- **没有**歌曲文件元数据
- 支持下载歌词
- 支持登录帐号
- 自动差异处理
- 云端歌曲更名后本地文件自动更名
- 支持歌曲 ID 映射（将没正确匹配的云盘歌曲映射到正确但无版权的歌曲，用于获取歌词）

## 安装

1. 克隆/下载本仓库。
2. 安装 [Binaryify/NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi)。
3. 复制 `config.example.json` 为 `config.json`。
4. 编辑 `config.json`，将 `ncmApiPath` 修改为实际位置。

## 运行

```bash
node index.js
```

## 配置文件说明

- `playlistId`：数值/字符串。网易云音乐播放列表 ID。
- `downloadDir`：字符串。同步目录。
- `downloadSong`：布尔值。控制是否下载音乐。
- `downloadLyric`：布尔值。控制是否下载歌词。
- `useMd5`：布尔值。控制是否使用 md5 识别未知歌曲。
- `extnames`：字符串数组。指定歌曲文件扩展名。
- `ncmApiPath`：字符串。NeteaseCloudMusicApi 路径。
- `mainLogin`：主帐号登录信息（可选）。
- `downloadLogin`：辅助下载帐号登录信息（可选）。

**注：配置不具有默认值。**

**注：登录信息将在登录成功后自动删除。**

## 主辅双帐号功能说明

主帐号用于获取歌单和云盘数据，辅助下载帐号用于获取云盘外歌曲。~~将主辅帐号分别设为自己的帐号和别人的会员帐号即可同时下载云盘歌曲和高品质歌曲。~~

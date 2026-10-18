# 粽子音源 · MusicFree 插件

九源聚合的音乐源插件，支持单曲 / 专辑 / 歌手 / 歌单四类搜索。

## 安装

MusicFree → 设置 → 插件 → 从网络安装，粘贴：

```
https://raw.githubusercontent.com/ZONGZI-000/zongzi-musicfree-plugin/master/zongzimusic.js
```

国内直连 GitHub raw 慢的话，用 jsDelivr 镜像（有 12 小时缓存，新版不一定立刻生效）：

```
https://cdn.jsdelivr.net/gh/ZONGZI-000/zongzi-musicfree-plugin@master/zongzimusic.js
```

## 更新

插件里写了 `srcUrl` 指向上面那个固定地址，所以 MusicFree 里点「检查更新」就会拉最新版。

> 必须版本号变大才会更新（App 用 `compare(oldVersion, newVersion, ">")` 判断）。

## 历史版本

所有旧版都放在 `versions/` 文件夹里，文件名是 `zongzi-<版本号>.js`，要装特定版本直接换地址：

```
https://raw.githubusercontent.com/ZONGZI-000/zongzi-musicfree-plugin/master/versions/zongzi-4.9.18.js
```

主目录只留一个固定名 `zongzimusic.js`（永远是最新版，也是 `srcUrl` 指向的地址），避免根目录越堆越乱。

`zongzi.js` 仍会同步一份最新内容，只为兼容还没更新到 v4.9.20 的旧安装——等大家都迁过去就会停掉。

## 包含的平台

| 平台 | 说明 |
|---|---|
| 网易云 / QQ / 酷狗 / 咪咕 / 酷我 | COCO 后端 + 官方直连，多通道路由 |
| Bilibili | 免费，音质最高（实测 319kbps m4a） |
| YouTube | ANDROID innertube |
| JOOX | 需要自己填 Cookie |
| 咪咕直出 | 官方接口直接返回 MP3 |

## 插件设置项

| 键 | 默认 | 作用 |
|---|---|---|
| `filterAudiobook` | 开 | 听书/有声书归到专辑页 |
| `filterVip` | 开 | 过滤会员曲 |
| `filterCover` | 开 | 过滤翻唱标记 |
| `useBilibili` | 开 | Bilibili 参与搜索 |
| `useYoutube` | 开 | YouTube 参与搜索 |
| `useMiguApi` | 开 | 咪咕直出参与搜索 |
| `biliMusicOnly` | 开 | Bilibili 只搜音乐区 |
| `biliGuichu` | 开 | Bilibili 鬼畜区（搜索 + 榜单页，不进推荐） |
| `inlineYoutube` | 开 | YouTube 整首预载（超 6MB 退流式） |
| `inlineBili` | 开 | Bilibili 整首预下载（超 8MB 退流式） |
| `jooxCookie` | 空 | JOOX 登录 Cookie（不填则不参与） |
| `feishuWebhook` | 空 | 拿到播放地址后推送到飞书 |

## 发版

```bash
./publish.sh "更新说明"
```

脚本会读源码里的 version、复制成 `zongzimusic.js`、兼容用的 `zongzi.js`，以及 `versions/zongzi-<version>.js`、推送 GitHub，然后回读远程比对版本号和内容。

## 历史

2026-10-18 起弃用 Gitee：它会静默风控含特定字样的 js 文件，上传返回 200 而下载返回 451，整个仓库连带不可用。现在只走 GitHub。

## 免责

仅供个人学习和研究使用。所有音频版权归原平台及版权方所有。
本插件不托管任何音频文件，只做接口聚合。

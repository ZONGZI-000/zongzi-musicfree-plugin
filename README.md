# 粽子音源 · MusicFree 插件

![粽子音源](assets/poster.jpg)

八平台聚合的音乐源插件，支持单曲 / 专辑 / 歌手 / 歌单四类搜索，取流自动跨平台兜底。

## 关于 MusicFree

[MusicFree](https://github.com/maotoumao/MusicFree) 是一个开源、免费、无广告的音乐播放器，本身不内置任何音源——搜索和播放能力全靠插件提供。播放器只负责界面、播放队列、歌词、音效和下载，插件负责「歌从哪来」。这个仓库就是给它写的一个音源插件。

| 项 | 说明 |
|---|---|
| 主页 | https://musicfree.catcat.work |
| 源码 | [Android 版](https://github.com/maotoumao/MusicFree) · [桌面版](https://github.com/maotoumao/MusicFreeDesktop)（Electron） |
| 开源协议 | AGPL-3.0 |
| 运行平台 | Android（arm64 / armv7 / x86 / universal APK）· Windows / macOS / Linux |
| 官方插件库 | [maotoumao/MusicFreePlugins](https://github.com/maotoumao/MusicFreePlugins)（本插件不在其中，需手动安装） |

插件需要实现的接口只有几个：搜索（单曲 / 专辑 / 歌手 / 歌单）、`getMediaSource` 取播放地址、`getLyric` 取歌词，另外可选实现推荐页 `getRecommendSheetTags` / `getRecommendSheetsByTag` 和榜单页。只要能把某个平台的歌曲信息映射成 MusicFree 的数据结构，它就能出现在搜索和播放里——这也是这类插件能同时接好几个平台的原因。

本插件用的是 CommonJS 写法（`module.exports = { platform, version, srcUrl, getMediaSource, ... }`），文件由播放器直接拉取执行，不经应用商店；`srcUrl` 指向本仓库固定地址，所以播放器里能「检查更新」。

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

## 在 MusicFree 里能用到什么

装上之后，播放器里会出现一个叫「粽子音源」的插件，四个页面都能用上：

| 位置 | 效果 |
|---|---|
| 搜索 | 单曲 / 专辑 / 歌手 / 歌单四类都能搜，同一平台多个结果自动去重合并 |
| 推荐页 | 每天一张《拼好歌》，按分类（华语 / 古风 / 爵士 / 深夜 / 治愈 / 钢琴 / 说唱 / R&B）轮换 |
| 榜单页 | 各平台热歌榜、新歌榜 |
| 播放 | 取流时按你选的音质跨平台兜底：128k / 320k / 无损，取不到就往下退 |
| 歌词 | 优先用原平台歌词，缺的从公开歌词库补，带时间轴 |
| 下载 | 用播放器自带的下载功能，插件只提供地址不落盘 |

音效、倍速、淡入淡出、悬浮歌词这些是播放器自己的功能，跟插件无关。

## 每日推荐 · 拼好歌

推荐页每天自动拼一张《拼好歌》歌单：从各平台公开歌单里按分类取材，重排成 30 首，每天换新，按分类配封面。

卡片标题是「分类 · 拼好歌」，点进详情才会看到完整曲风介绍和当天拼出来的歌手名单。

## 包含的平台

| 平台 | 说明 |
|---|---|
| 网易云 / QQ / 酷狗 / 咪咕 / 酷我 | 主力五家，多家独立上游互备 |
| YouTube | 海外补充，冷门和现场版资源多 |
| JOOX | 需要自己填 Cookie |
| 咪咕直出 | 作为咪咕的补充线路 |

Bilibili 已于 v4.10.62 默认下线：它的取流链路不在插件控制范围内，播放成功率撑不住。代码保留，设置里把「Bilibili 参与」填 1 可重新启用。

## 插件设置项

| 键 | 默认 | 作用 |
|---|---|---|
| `filterAudiobook` | 开 | 听书/有声书归到专辑页 |
| `filterVip` | 开 | 过滤会员曲 |
| `filterCover` | 开 | 过滤翻唱标记 |
| `useBilibili` | 关 | Bilibili 参与搜索（v4.10.62 起默认关） |
| `useYoutube` | 开 | YouTube 参与搜索 |
| `useMiguApi` | 开 | 咪咕直出参与搜索 |
| `biliMusicOnly` | 开 | Bilibili 只搜音乐区 |
| `biliGuichu` | 关 | Bilibili 鬼畜区（搜索 + 榜单页，不进推荐） |
| `inlineYoutube` | 开 | YouTube 整首预载（超 6MB 退流式） |
| `inlineBili` | 开 | Bilibili 整首预下载（超 8MB 退流式） |
| `jooxCookie` | 空 | JOOX 登录 Cookie（不填则不参与） |
| `feishuWebhook` | 空 | 拿到播放地址后推送到飞书 |
| `tasteSeeds` | 空 | 口味种子：填常听的歌手名（逗号分隔，最多 8 个），推荐页会出现「为你推荐」 |
| `tasteSkip` | 空 | 不想听到的歌手，不会出现在画像推荐里 |

## 为你推荐（口味画像）

填了 `tasteSeeds` 之后，推荐页顶部会多出「为你推荐」：一张每日精选 + 每位种子歌手一张分支单。

**它不是平台算法。** MusicFree 的插件沙箱是无状态的 —— 没有文件、没有 AsyncStorage、读不到 App 的播放历史和收藏（`core/pluginManager/plugin.ts` 里 env 只有 `getUserVariables` 一个只读方法）。所以「自动记录你听了什么」这条路在插件里根本走不通。

能做的是：拿你手填的种子歌手，顺着**歌单共现关系**往外扩。具体做法是搜这位歌手的歌单，统计同一张歌单里还出现了谁 —— 榜单和推荐类歌单是运营拼的，同档歌手会被拼在一起。实测周杰伦能扩出蔡依林、李玟、温岚，Taylor Swift 能扩出 Lana Del Rey、Post Malone，米津玄師能扩出 King Gnu、菅田将暉。

几个必须说的限制：

- **种子要填歌手，不要填歌名。** 按歌名反查原唱这条路在网易上不可靠 —— 匿名搜「晴天」前 30 条全是翻唱版，没有一条是周杰伦原唱。填歌名大概率解析不出来，那一项会被跳过。
- **小众音乐人可能断链。** 草东没有派对在公开的相似歌手图谱里查无此人，只能靠歌单共现；如果连共现都没有，就只剩种子本人。
- **有一道搬运号过滤。** 歌单共现会带进一些短视频搬运号（热门曲里大量 90 秒以下的碎片）。判据是碎片率 > 15% 或原创占比 < 50% 就整位剔除。

冷启动约 2 秒（本机直连，手机慢一些），结果缓存 30 分钟，翻页不重复算。

## 发版

```bash
./publish.sh "更新说明"
```

脚本会读源码里的 version、复制成 `zongzimusic.js`、兼容用的 `zongzi.js`，以及 `versions/zongzi-<version>.js`、推送 GitHub，然后回读远程比对版本号和内容。

## 历史

2026-10-18 起弃用 Gitee：它对这类 js 文件有静默拦截，上传正常但下载不可用，整个仓库连带失效。现在只走 GitHub。

## 免责

仅供个人学习和研究使用。所有音频版权归原平台及版权方所有。
本插件不托管任何音频文件，只做接口聚合。

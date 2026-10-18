# 粽子音源 · MusicFree 插件

九源聚合的音乐源插件，支持单曲 / 专辑 / 歌手 / 歌单四类搜索。

## 安装

MusicFree → 设置 → 插件 → 从网络安装，粘贴：

```
https://gitee.com/zongziiiiiiiiiiiiiiiiiiiiiiiiiiii/zongzi-musicfree-plugin/raw/master/zongzi.js
```

## 更新

插件里写了 `srcUrl` 指向这个地址，所以 MusicFree 里点「检查更新」就会拉最新版。

> 必须版本号变大才会更新（App 用 `compare(oldVersion, newVersion, ">")` 判断）。

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
| `jooxCookie` | 空 | JOOX 登录 Cookie（不填则不参与） |
| `feishuWebhook` | 空 | 拿到播放地址后推送到飞书 |

## 发版

```bash
./publish.sh "更新说明"
```

## 免责

仅供个人学习和研究使用。所有音频版权归原平台及版权方所有。
本插件不托管任何音频文件，只做接口聚合。

"use strict";
/**
 * 粽子音源 · MusicFree 插件 v3.1
 *
 * v2 相比 v1 的增强：每个平台有多条独立通道，互不依赖同一个第三方。
 *
 *   网易云  netease(id直取) → hi.cn(id直取) → outer官方302 → 搜索
 *   QQ     qq(id直取, xcvts解析器) → 搜索
 *   酷狗    kugou(id直取) → hi.cn(搜索) → 搜索
 *   咪咕    migu(搜索, 后端对部分 contentId 有 bug) → 搜索
 *   酷我    官方直连(搜索→convert_url) → 溯音 → 长青 → hi.cn(搜索)
 *
 * 关键修复（别删）：
 *   1. 酷狗 CDN 证书覆盖不到两级子域 → 必须走 http
 *   2. 所有第三方直链都要验活（会过期，实测遇到过 410）
 *   3. 手机端没有 Buffer，只能用 Uint8Array
 */
const axios_1 = require("axios");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const UA_MOBILE = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";

const COCO = "https://cocodownloader.markqq.com";
const HI = "https://flac.music.hi.cn/ajax.php";
const HI_HEADERS = { Referer: "https://flac.music.hi.cn/", Origin: "https://flac.music.hi.cn" };
const SUYIN_KUWO = "https://oiapi.net/api/Kuwo";
const CHANGQING_KUWO = "https://musicapi.haitangw.net/music/kw.php?type=mp3&id={id}&level={level}";
const NETEASE_OUTER = "https://music.163.com/song/media/outer/url?id={id}.mp3";
const KUWO_SEARCH = "http://search.kuwo.cn/r.s";

/* 网易云歌单（只用来搜歌单，取流仍走 COCO/outer） */
const NETEASE_SEARCH_WEB = "https://music.163.com/api/search/get/web";
const NETEASE_PLAYLIST_DETAIL = "https://music.163.com/api/v6/playlist/detail";
const NETEASE_SONG_DETAIL = "https://music.163.com/api/song/detail";
const NETEASE_HEADERS = { "User-Agent": UA, Referer: "https://music.163.com/" };
const KUWO_CONVERT = "http://antiserver.kuwo.cn/anti.s?type=convert_url&format={fmt}&response=url&rid=MUSIC_{rid}";

const FALLBACK_ORDER = ["netease", "qq", "migu", "kugou", "kuwo", "joox", "youtube", "bilibili", "miguapi"];

/* ============================================================
 * Bilibili —— 免费、音质最高（可到 319kbps m4a）
 * 关键：
 *   1. 必须先访问首页拿 buvid3 cookie，否则搜索 -352 风控
 *   2. 取流要走 /x/player/playurl 的 dash，字段名是 baseUrl（不是 url）
 *   3. 音频流要带 Referer: https://www.bilibili.com/ 才能下
 * ============================================================ */
const BILI_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
let biliCookie = "";
let biliCookieAt = 0;

/* ============================================================
 * 咪咕官方直出（旧接口）—— 直接返回 MP3 字节流，不经第三方
 * 实测：4.97MB 完整 MP3，fffb 帧头，1.5 秒下完
 * toneFlag 不生效（SQ/HQ/PQ/LQ 拿到的是同一个文件）
 * ============================================================ */
const MIGU_UA_MOBILE = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
const MIGU_SEARCH = "https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/search_all.do";
const MIGU_LISTEN = "https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/sub/listenSong.do";

/* ============================================================
 * YouTube —— 逆向 innertube
 * 关键：WEB / WEB_REMIX / MWEB / TVHTML5 在 2026 年已全部被 anti-bot 打死，
 *      只有 ANDROID / IOS / ANDROID_VR 还能拿到 streamingData，
 *      而且这三个直接返回 url（不需要解 signatureCipher）。
 *      key 和 clientVersion 必须是新的，用旧的会 400。
 * ============================================================ */
const YT_ANDROID = {
  version: "20.10.38",
  ua: "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip",
  sdk: 34,
  nameId: 3,
};
/* ============================================================
 * VISIONOS client —— 关键发现（2026-10-17）
 *
 * 这是 Telelgram 那些 YouTube 下载机器人能拿完整文件的原因：
 *   ANDROID / IOS 签发的 URL 有约 1MB 配额（超了 403）；
 *   VISIONOS 签发的 URL **没有配额限制**（首/中/尾都能取）。
 *
 * ⚠️ 两个必须同时满足，少一个就 LOGIN_REQUIRED：
 *   1. clientName = "VISIONOS"，nameId = 101
 *   2. 必须带 visitorData（从 watch 页面 HTML 里抓 VISITOR_DATA）
 *
 * 实测（hRmHh4h_-Nc）：
 *   itag=140 2352KB  0=200 中段=200 尾部=200  ✅
 *   itag=251 2259KB  0=200 中段=200 尾部=200  ✅
 * ============================================================ */
const YT_VISIONOS = {
  name: "VISIONOS",
  ver: "1.02",
  nameId: 101,
  ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  deviceMake: "Apple",
  deviceModel: "RealityDevice17,1",
  osName: "visionOS",
  osVersion: "26.5.23O471",
};

/** visitorData 缓存（10 分钟） */
let ytVisitorData = "";
let ytVisitorAt = 0;
let ytApiKey = "";

/** 从 watch 页抓 INNERTUBE_API_KEY + VISITOR_DATA */
async function ytBootstrap(videoId) {
  if (ytVisitorData && ytApiKey && Date.now() - ytVisitorAt < 10 * 60 * 1000) {
    return { key: ytApiKey, visitor: ytVisitorData };
  }
  const r = await axios_1.get("https://www.youtube.com/watch?v=" + encodeURIComponent(videoId), {
    timeout: 20000,
    headers: { "User-Agent": YT_VISIONOS.ua },
    validateStatus: () => true,
    responseType: "text",
    transformResponse: [(x) => x],
  });
  const html = String(r.data || "");
  const km = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  const vm = html.match(/"VISITOR_DATA":"([^"]+)"/);
  if (!km || !vm) throw new Error("yt: 无法从网页获取 API key / visitorData");
  ytApiKey = km[1];
  ytVisitorData = vm[1];
  ytVisitorAt = Date.now();
  return { key: ytApiKey, visitor: ytVisitorData };
}

/** 用 VISIONOS client 取 player 响应 */
async function ytPlayerVisionos(videoId) {
  const boot = await ytBootstrap(videoId);
  const body = {
    context: {
      client: {
        clientName: YT_VISIONOS.name,
        clientVersion: YT_VISIONOS.ver,
        deviceMake: YT_VISIONOS.deviceMake,
        deviceModel: YT_VISIONOS.deviceModel,
        userAgent: YT_VISIONOS.ua,
        osName: YT_VISIONOS.osName,
        osVersion: YT_VISIONOS.osVersion,
        hl: "zh-CN",
        gl: "CN",
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true },
    },
    visitorData: boot.visitor,
    videoId: videoId,
    contentCheckOk: true,
    racyCheckOk: true,
  };
  const r = await axios_1.post(
    "https://www.youtube.com/youtubei/v1/player?key=" + boot.key + "&prettyPrint=false",
    JSON.stringify(body),
    {
      timeout: 20000,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": YT_VISIONOS.ua,
        "X-YouTube-Client-Name": String(YT_VISIONOS.nameId),
        "X-YouTube-Client-Version": YT_VISIONOS.ver,
        "X-Goog-Visitor-Id": boot.visitor,
      },
      validateStatus: () => true,
    }
  );
  const d = r.data || {};
  const ps = d.playabilityStatus || {};
  if (ps.status !== "OK") throw new Error("yt visionos: " + (ps.status || "?") + " " + String(ps.reason || "").slice(0, 40));
  const sd = d.streamingData || {};
  const all = (sd.formats || []).concat(sd.adaptiveFormats || []);
  const audios = all
    .filter((f) => f.url && /audio/.test(f.mimeType || ""))
    .map((f) => ({
      itag: f.itag,
      mime: (f.mimeType || "").split(";")[0],
      bitrate: Number(f.bitrate || 0),
      url: f.url,
      size: Number(f.contentLength || 0),
    }))
    .sort((a, b) => b.bitrate - a.bitrate);
  if (!audios.length) throw new Error("yt visionos: 无音频流");
  const vd = d.videoDetails || {};
  return {
    audios: audios,
    title: vd.title || "",
    lengthSeconds: Number(vd.lengthSeconds || 0),
    author: vd.author || "",
  };
}

const YT_IOS = {
  version: "20.10.4",
  ua: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
  nameId: 5,
};

/* ============================================================
 * innertube API key —— 运行时抓取，绝不硬编码
 * 硬编码会在 GitHub 触发 "Google API Key" 密钥扫描告警。
 * 这个 key 本身就是 YouTube 首页 HTML 里的公开值，抓一次缓存 1 小时。
 * ============================================================ */
let ytPubKeyCache = "";
let ytPubKeyAt = 0;
async function ytPubKey() {
  if (ytPubKeyCache && Date.now() - ytPubKeyAt < 60 * 60 * 1000) return ytPubKeyCache;
  const urls = [
    "https://www.youtube.com/",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  ];
  for (const u of urls) {
    try {
      const r = await axios_1.get(u, {
        timeout: 15000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        },
        validateStatus: () => true,
        responseType: "text",
        transformResponse: [(x) => x],
      });
      const m = String(r.data || "").match(/"INNERTUBE_API_KEY":"([^"]+)"/);
      if (m && m[1]) {
        ytPubKeyCache = m[1];
        ytPubKeyAt = Date.now();
        return ytPubKeyCache;
      }
    } catch (e) {}
  }
  throw new Error("yt: 无法从网页获取 innertube API key");
}

/* ============================================================
 * JOOX —— 需要登录 Cookie
 * 签名算法从 player-d.*.js 逆向：secret = MD5("Jo0x@t3Nc3nT" + qs)
 * ⚠️ 三个 HttpOnly cookie（session_key / user_type / wmid）必须一起带上，
 *    只带 document.cookie 能读到的那些，服务端一律降级成 30 秒试听。
 * ============================================================ */
const JOOX_API = "https://cache.api.joox.com";
const JOOX_SALT = "Jo0x@t3Nc3nT";

const QUALITY_MAP = { low: "128k", standard: "128k", high: "320k", super: "flac" };

const PLATFORM_LABEL = {
  netease: "网易云", qq: "QQ音乐", kugou: "酷狗", migu: "咪咕", kuwo: "酷我",
  joox: "JOOX",
  youtube: "YouTube",
  bilibili: "Bilibili",
  miguapi: "咪咕直出",
};
const LABEL_TO_PROVIDER = {
  "网易云": "netease", "QQ音乐": "qq", "酷狗": "kugou", "咪咕": "migu", "酷我": "kuwo",
  "JOOX": "joox",
  "YouTube": "youtube",
  "Bilibili": "bilibili",
  "咪咕直出": "miguapi",
  // Apple 目录条目没有平台 id —— 标成 "apple" 让它跳过「本平台直取」，
  // 直接进跨平台兜底（按歌名+歌手搜 YouTube / 各家）
  "Apple Music": "apple",
};

/* ============================================================
 * 飞书推送
 * ============================================================ */
/** Bilibili 是否参与搜索（默认开：免费且音质最高） */
function shouldUseBilibili() {
  try {
    const vars = (typeof env !== "undefined" && env && env.userVariables) || {};
    const v = vars.useBilibili;
    if (v === undefined || v === null || v === "") return true;
    return !(v === "0" || v === "false" || v === "off");
  } catch (e) { return true; }
}

/** Bilibili 是否只搜音乐区（默认开） */
function shouldBiliMusicOnly() {
  try {
    const vars = (typeof env !== 'undefined' && env && env.userVariables) || {};
    const v = vars.biliMusicOnly;
    if (v === undefined || v === null || v === '') return true;
    return !(v === '0' || v === 'false' || v === 'off');
  } catch (e) { return true; }
}

/** Bilibili 鬼畜区是否一起搜（默认开）
 *  音乐区（tids=3）里没有鬼畜区和动画区，搜「改革春风吹满地」这种梗
 *  在音乐区是空手 —— 它本来就长在鬼畜区。所以单开一路去问 119。
 *  ⚠️ 鬼畜结果不参与推荐，排序也压在所有音乐条目之后。 */
function shouldBiliGuichu() {
  try {
    const vars = (typeof env !== 'undefined' && env && env.userVariables) || {};
    const v = vars.biliGuichu;
    if (v === undefined || v === null || v === '') return true;
    return !(v === '0' || v === 'false' || v === 'off');
  } catch (e) { return true; }
}

/** 咪咕官方直出是否参与（默认开） */
function shouldUseMiguApi() {
  try {
    const vars = (typeof env !== "undefined" && env && env.userVariables) || {};
    const v = vars.useMiguApi;
    if (v === undefined || v === null || v === "") return true;
    return !(v === "0" || v === "false" || v === "off");
  } catch (e) { return true; }
}

/** 是否做 YouTube 1MB 配额预检（默认开） */
function shouldProbeYtQuota() {
  try {
    const vars = (typeof env !== "undefined" && env && env.userVariables) || {};
    const v = vars.probeYoutubeQuota;
    if (v === undefined || v === null || v === "") return true;
    return !(v === "0" || v === "false" || v === "off");
  } catch (e) { return true; }
}

/** YouTube 是否参与搜索（默认开；内容拉美/欧美的版权差异较大，可关） */
function shouldUseYoutube() {
  try {
    const vars = (typeof env !== "undefined" && env && env.userVariables) || {};
    const v = vars.useYoutube;
    if (v === undefined || v === null || v === "") return true;
    return !(v === "0" || v === "false" || v === "off");
  } catch (e) { return true; }
}

/** 是否过滤各平台的会员/无版权曲目（默认开） */
function shouldFilterVip() {
  try {
    const vars = (typeof env !== "undefined" && env && env.userVariables) || {};
    const v = vars.filterVip;
    // 未设置 / 空串 / "1" / "true" 都算开启；只有明确写 0 或 false 才关
    if (v === undefined || v === null || v === "") return true;
    return !(v === "0" || v === "false" || v === "off");
  } catch (e) { return true; }
}

/** 是否隐藏「明显的试听片段」（默认开）
 *  判据是时长：<90 秒基本只能是试听/切片，正常单曲最短也在 100 秒以上。
 *  想要全量结果（哪怕是 30 秒试听）就把 filterTrial 设成 0。 */
function shouldFilterTrial() {
  try {
    const vars = (typeof env !== "undefined" && env && env.userVariables) || {};
    const v = vars.filterTrial;
    if (v === undefined || v === null || v === "") return true;
    return !(v === "0" || v === "false" || v === "off");
  } catch (e) { return true; }
}

/** 是否过滤翻唱（默认开）
 *  判据是标题里带翻唱标记：翻唱 / cover / 翻自 / 改编自 / 原唱：xxx 等。
 *  只认「标题里明说了」的，不猜 —— 有大量翻唱标题和原唱一模一样，
 *  那种靠标题根本分不出来，硬猜就会误杀原唱。 */
function shouldFilterCover() {
  try {
    const vars = (typeof env !== "undefined" && env && env.userVariables) || {};
    const v = vars.filterCover;
    if (v === undefined || v === null || v === "") return true;
    return !(v === "0" || v === "false" || v === "off");
  } catch (e) { return true; }
}

/** 标题里的翻唱标记。和 VARIANT_RE 分开：那个还兼管伴奏/DJ/加速等，
 *  用户可能只想滤翻唱、留着伴奏。 */
const COVER_RE = /翻唱|翻自|改编自|改編自|重唱|cover|カバー|커버|原唱\s*[：:]/i;


/* ============================================================
 * 听书 / 有声书 / 广播剧 过滤
 *
 * 实测污染源（2026-10-17，逐平台量化）：
 *   酷我官方   三体 20%  盗墓笔记 15%  明朝那些事 75%  夜的命名术 95%
 *   Bilibili   三体 35%  红楼梦 35%    盗墓笔记 40%    明朝那些事 45%
 *   COCO三平台 0~15%
 *   咪咕直出   0%
 *
 * 所以必须过滤的是酷我和 B 站。识别靠两个信号：
 *   1. 标题特征词（第01集 / 第393章 / 有声书 / 广播剧 / 演播 …）
 *   2. 时长（有声书单集常在 20 分钟以上）
 * ============================================================ */
const AUDIOBOOK_RE = /有声书|有聲書|广播剧|广播劇|评书|評書|有声小说|有聲小說|睡前故事|儿童故事|兒童故事|演播|播讲|播講|讲书|講書|朗讀者|朗读版|朗讀版|诵读版|誦讀版|夜听|夜聽|完本|全集|连载中|連載中|多人小说剧|小说剧|小說劇|听书|聽書/i;

/** 「第01集」「第 393 章」「EP12」「Vol.5」这类分集编号 */
const EPISODE_RE = /第\s*[\d一二三四五六七八九十百千零〇]+\s*[集章回期节節話话]/;
const EPISODE_LOOSE_RE = /(?:^|[\s\-_【\[(])(?:EP|Ep|ep)\s*\d{1,4}(?![\d])|(?:^|[\s\-_【\[(])Vol\.?\s*\d{1,3}/;

/** 标题像不像听书内容 */

/* ============================================================
 * 听书 → 专辑 聚合
 *
 * 形态实测（「明朝那些事」）：
 *   酷我      「明朝那些事儿 第01集」×N，歌手=喜马拉雅
 *   Bilibili  「有声书《明朝那些事儿》历史/权谋」
 *   YouTube   「明朝那些事儿 [有声书] 第一部 洪武大帝…」
 *
 * 做法：从标题里剥掉「第01集」「有声书」「全集」这些壳，取出书名，
 * 同名的一律并成一个专辑条目，集数当曲目数。
 * 这样搜「明朝那些事」时，单曲列表是干净的歌，
 * 想听书就去「专辑」页，会看到一个叫《明朝那些事儿》的专辑。
 * ============================================================ */

/** 抽取书名（尽量干净），抽不出来返回空串 */
function audiobookBookName(raw) {
  let t = String(raw || "").trim();
  if (!t) return "";

  // 1. 优先取「《》」里的内容 —— 最可靠
  const m = t.match(/[《【]([^》】]{2,40})[》】]/);
  if (m) {
    const inside = m[1].replace(/有声书|有聲書|广播剧|廣播劇|评书|評書|小说|小說|全集|完本/g, "").trim();
    if (inside.length >= 2) return inside;
  }

  // 2. 剥掉常见壳子和集号
  t = t
    .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, " ")     // 括号段
    .replace(/有声书|有聲書|广播剧|廣播劇|评书|評書|有声小说|有聲小說|睡前故事|儿童故事|兒童故事|演播|播讲|播講|听书|聽書|多人小说剧|小说剧|小說劇/g, " ")
    .replace(/第\s*[\d一二三四五六七八九十百千零〇]+\s*[集章回期节節話话]/g, " ")
    .replace(/\b(?:EP|Ep|ep)\s*\d{1,4}/g, " ")
    .replace(/\bVol\.?\s*\d{1,3}/g, " ")
    .replace(/全集|完本|连载中|連載中|更新至.*$/g, " ")
    .replace(/[\-_|｜~～·]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // 3. 去掉首尾残留的标点
  t = t.replace(/^[\s:：,，.。、]+|[\s:：,，.。、]+$/g, "");
  return t.length >= 2 ? t : "";
}

/** 这一条是不是「听书里有意义的一条」（有书名、有集号或明显听书标记） */
function audiobookInfo(raw) {
  const t = String(raw || "");
  if (!isAudiobookTitle(t)) return null;
  const book = audiobookBookName(t);
  if (!book) return null;
  // 集号：有就更能确定这是连载
  const em = t.match(/第\s*([\d一二三四五六七八九十百千零〇]+)\s*[集章回期节節話话]/) ||
             t.match(/\b(?:EP|Ep|ep|Vol\.?)\s*(\d{1,4})/);
  return { book: book, episode: em ? em[1] : "" };
}

/** 书名归一化，用来合并 */
function bookKey(name) {
  return normText(toSimplified(name));
}

function isAudiobookTitle(raw) {
  const t = String(raw || "");
  if (!t) return false;
  if (AUDIOBOOK_RE.test(t)) return true;
  if (EPISODE_RE.test(t)) return true;
  if (EPISODE_LOOSE_RE.test(t)) return true;
  // 「xxx 第1集」这种编号 + 书名号的组合也算
  if (/[《][^》]{2,}[》]/.test(t) && /[\d]{1,3}\s*[集章回]/.test(t)) return true;
  return false;
}

/** 时长像不像听书（> 20 分钟且不像演唱会/合辑） */
function isAudiobookDuration(ms) {
  const sec = Number(ms || 0) / 1000;
  return sec > 1200;
}

/** 是否开启听书过滤（默认开） */
function shouldFilterAudiobook() {
  try {
    const vars = (typeof env !== "undefined" && env && env.userVariables) || {};
    const v = vars.filterAudiobook;
    if (v === undefined || v === null || v === "") return true;
    return !(v === "0" || v === "false" || v === "off");
  } catch (e) { return true; }
}

function isCoverTitle(raw) {
  const s = String(raw || "");
  if (!s) return false;
  return COVER_RE.test(s);
}

/** 是否按「完整度」排序（默认开）：完整的在前，试听/时长未知的沉底 */
function shouldSortByCompleteness() {
  try {
    const vars = (typeof env !== "undefined" && env && env.userVariables) || {};
    const v = vars.sortByCompleteness;
    if (v === undefined || v === null || v === "") return true;
    return !(v === "0" || v === "false" || v === "off");
  } catch (e) { return true; }
}

/** 试听判定阈值：短于这个秒数的单曲视为「试听/片段」 */
const TRIAL_SECONDS = 90;

/** 超长曲目阈值：超过这个秒数的多半是合辑/现场/直播回放，
 *  排序时不该因为「时长长」被顶到前面 */
const LONG_TRACK_SECONDS = 900;

function getFeishuHook() {
  try {
    const vars = (typeof env !== "undefined" && env && env.userVariables) || {};
    return vars.feishuWebhook || "";
  } catch (e) { return ""; }
}

async function pushToFeishu(text) {
  const hook = getFeishuHook();
  if (!hook) return;
  try {
    await axios_1.post(hook, { msg_type: "text", content: { text: text } },
      { timeout: 8000, headers: { "Content-Type": "application/json" } });
  } catch (e) { console.log("[粽子] 飞书推送失败: " + e.message); }
}

/* ============================================================
 * 基础工具
 * ============================================================ */
function httpGet(url, params, headers) {
  let full = url;
  if (params) {
    const qs = Object.keys(params)
      .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== "")
      .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(params[k]))
      .join("&");
    if (qs) full += (url.indexOf("?") >= 0 ? "&" : "?") + qs;
  }
  return axios_1.get(full, { timeout: 20000, headers: Object.assign({ "User-Agent": UA }, headers || {}) })
    .then((r) => r.data);
}

function httpPost(url, body, headers) {
  const qs = Object.keys(body)
    .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(body[k] === undefined ? "" : body[k]))
    .join("&");
  return axios_1.post(url, qs, {
    timeout: 20000,
    responseType: "text",
    transformResponse: [(d) => d],
    headers: Object.assign({
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      "User-Agent": UA,
    }, headers || {}),
  }).then((r) => {
    try { return JSON.parse(r.data); } catch (e) { return r.data; }
  });
}

/**
 * 真取 2KB 验魔数 —— 第三方直链会过期，不验活会拿到死链
 * ⚠️ 不能用 Buffer：MusicFree 跑在 React Native（Hermes）上，没有 Node 的 Buffer
 */
/**
 * 验活。extraHeaders 用于需要特定 Referer 的 CDN（B站要求 Referer: bilibili.com）
 */
/* 探活结果缓存：同一个 URL 只探一次。
   之所以要缓存，是因为「验活」和「验完整度」要的是同一个响应 ——
   Range 请求已经带回了 Content-Range，总字节数就躺在响应头里，
   再为完整性多发一次请求纯属浪费。5 分钟过期，跟直链签名寿命同步。 */
const _audioProbeCache = {};

/** 探一次音频地址：{ ok, total }
 *  ok    = 魔数是真音频（ID3/MP3/Ogg/FLAC/ftyp/WebM）
 *  total = 音频总字节数；拿不到（服务端不给 Content-Range）= 0 */
async function probeAudio(url, extraHeaders) {
  /* data: URI 直接判活，绝不发请求。
     整首内联（YouTube / B站）返回的就是几 MB 的 base64 字符串，
     交给 axios 会被当成 URL 去解析，既慢又可能卡死整个取流。 */
  if (String(url).indexOf("data:") === 0) return { ok: true, total: 0 };
  /* B 站 CDN 必须带 Referer，否则 403。这里统一补，省得每个调用点都记着传。 */
  if (!extraHeaders && /bilivideo/.test(String(url))) extraHeaders = { Referer: "https://www.bilibili.com/" };
  const hit = _audioProbeCache[url];
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.v;
  const out = { ok: false, total: 0 };
  try {
    const r = await axios_1.get(url, {
      timeout: 12000,
      responseType: "arraybuffer",
      headers: Object.assign({ "User-Agent": UA, Range: "bytes=0-2047" }, extraHeaders || {}),
      validateStatus: () => true,
    });
    if (r.data) {
      const b = new Uint8Array(r.data);
      const x = (i) => b[i] || 0;
      if (b.length >= 8) {
        if (x(0) === 0x49 && x(1) === 0x44 && x(2) === 0x33) out.ok = true;           // ID3
        if (x(0) === 0xff && (x(1) === 0xfb || x(1) === 0xf3 || x(1) === 0xf2)) out.ok = true; // MP3
        if (x(0) === 0x4f && x(1) === 0x67 && x(2) === 0x67) out.ok = true;           // OggS
        if (x(0) === 0x66 && x(1) === 0x4c && x(2) === 0x61) out.ok = true;           // fLaC
        if (x(4) === 0x66 && x(5) === 0x74 && x(6) === 0x79 && x(7) === 0x70) out.ok = true; // ftyp
        // ⚠️ WebM: EBML 头 1A 45 DF A3。
        //    YouTube 的 opus 音频全是 webm，漏了这个判断会把它们全判成「不可播」，
        //    然后错误地退回 m4a —— 这是 Topic 曲目播放失败的直接原因。
        if (x(0) === 0x1a && x(1) === 0x45 && x(2) === 0xdf && x(3) === 0xa3) out.ok = true;
      }
      // 206 响应头里的 Content-Range 形如 "bytes 0-2047/960887"
      const cr = String((r.headers && r.headers["content-range"]) || "");
      const m = cr.match(/\/\s*(\d+)\s*$/);
      if (m) out.total = parseInt(m[1], 10) || 0;
    }
  } catch (e) { /* 探不到就当不可播 */ }
  _audioProbeCache[url] = { at: Date.now(), v: out };
  return out;
}

async function verifyPlayable(url, extraHeaders) {
  return (await probeAudio(url, extraHeaders)).ok;
}

/** 「只给了试听片段」判据
 *
 *  实测（2026-10-18）：QQ 音乐对部分会员曲目会返回 200 正常、魔数是 MP3 的地址，
 *  但整段只有 60 秒。《晴天》时长 269s，拿到的文件只有 960887 字节，
 *  折合 3.5 KB/s（≈28kbps）—— 连 48kbps 都装不下，只能是片段。
 *  旧代码只验「能不能播」，于是把它当成功返回，跨平台兜底根本没机会上场。
 *
 *  判据用「每秒钟多少字节」而不是「够不够某个码率」：
 *  码率是服务端自己标称的，会撒谎；字节总数 ÷ 时长是硬算出来的。
 *  低于 48kbps（6KB/s）在音乐里不存在，低于这个必然是片段/截断。
 *  时长未知的条目不再一律放行 —— 那是 4.9.24 之前最大的漏网口子：
 *  咪咕直出、酷我搜索给的 duration 大量是 0，等于全部免检。
 *  现在改成「拿不到总字节数就放行，拿得到就按 400KB 绝对下限判」。 */
/* 阈值取 36kbps（4.5KB/s）。原来的 48kbps 会把 B 站 48kbps 档的鬼畜流
   误判成"试听片段"（实测 85 秒 857KB = 82kbps 能过，但 48kbps 档正好压线），
   于是一路去走跨平台兜底，光等待就 15~20 秒，表现就是"点了半天不播"。 */
const MIN_BYTES_PER_SEC = 4.5 * 1024; // ≈36kbps
/* 时长未知时的绝对下限：整首歌不可能小于 400KB（就算 64kbps 也有 1.5MB）。
   拿它兜住「平台不给时长 → 免检通行」这个洞。 */
const MIN_FULL_BYTES = 400 * 1024;

async function isPreviewOnly(url, durationMs, fallbackMs) {
  const ms = Number(durationMs) || 0;
  const fb = Number(fallbackMs) || 0;
  const p = await probeAudio(url);
  /* 时长未知时，能拿到实际字节数就按「一首歌至少该有多少字节」判：
     完整版 mp3 128k 也至少 1.5MB，低于 400KB 的绝不可能是整首。
     之前这里直接 return false 放行，等于把「时长 0」变成了免检通行证 ——
     而咪咕直出、酷我搜索一堆条目时长都是 0。 */
  const useMs = ms > 0 ? ms : fb;
  if (useMs <= 0) {
    if (!p.total) return false;
    return p.total < MIN_FULL_BYTES;
  }
  if (!p.total) return false;
  return p.total / (useMs / 1000) < MIN_BYTES_PER_SEC;
}

/** 把各平台五花八门的时长写法统一成毫秒。
 *  实测见过的形态：
 *    COCO  netease/qq/kugou → "05:25"（字符串）
 *    COCO  kugou.extra      → 312（秒，数字）
 *    酷我  DURATION         → "223"（秒，字符串）
 *    咪咕  rateFormats.size → 只能按码率反推（见 miguApiSearch）
 *    其它  已经是毫秒
 *  返回 0 表示「不知道」—— 不要瞎猜，未知就是未知。 */
function parseDuration(raw) {
  if (raw === undefined || raw === null || raw === "") return 0;
  if (typeof raw === "number") {
    if (!isFinite(raw) || raw <= 0) return 0;
    // 小于 10000 当秒，否则当毫秒（单曲不会超过 9999 秒 = 2:46:39）
    return raw < 10000 ? Math.round(raw * 1000) : Math.round(raw);
  }
  const s = String(raw).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return parseDuration(Number(s));
  const m = s.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const c = m[3] === undefined ? null : Number(m[3]);
    const sec = c === null ? a * 60 + b : a * 3600 + b * 60 + c;
    return sec > 0 && sec < 36000 ? sec * 1000 : 0;
  }
  return 0;
}

/** 一条搜索结果的「完整度」分档（越大越好）：
 *    3 = 时长正常，基本能完整播放
 *    2 = 时长未知（不能断定是试听，也不冤枉它）
 *    0 = 时长明显过短 —— 试听片段/切片，实际听两下就断
 */
function completenessOf(item) {
  const ms = Number(item && item.duration) || 0;
  if (ms > 0 && ms < TRIAL_SECONDS * 1000) return 0;
  if (ms > 0) return 3;
  return 2;
}
/* 为什么不用「会员标记」来降权：实测咪咕 vipType=1 的歌照样能直出完整 MP3
 * （《稻香》4.97MB 整首）。拿会员标记当「只能试听」会把好好的原唱踩下去 ——
 * 之前就是这么把周杰伦的《晴天》排到第 25 条的。时长才是硬指标。 */

/** 平台本身的「出完整版」稳定度，用来在同一完整度档内排序。
 *  免费/官方直连的排前面，聚合第三方排后面。 */
const PLATFORM_TRUST = {
  netease: 5, qq: 5, kuwo: 5, bilibili: 5,   // 主流 + 能出无损
  miguapi: 4, kugou: 4, youtube: 4,          // 稳定但多为 MP3/M4A
  migu: 3, joox: 2,
};

/** 相关性档位（越大越像用户真正要找的那首）。
 *  排序是「先档位、后其它」——完全匹配的关键词永远在最上面那一块，
 *  档位相同了才轮到时长短、平台、热度这些。
 *  3 = 完全匹配：标题字数跟查询词（的标题部分）一模一样，一个字不多一个字不少
 *  2 = 沾边：标题包含它，但字数对不上（挂括号尾巴、多出年份/版本号等），
 *      或者歌名对上了但歌手不是要的那位
 *  1 = 变体 / 伴奏 / 翻唱标记 / 勉强沾边
 *
 *  ⚠️ 判定用的是「字数」而不是「去掉括号后是否相等」：
 *  「起风了（2019版）」剥掉括号就是「起风了」，但字数多出来，它就不是完全匹配，
 *  按超出字数往后沉。
 *
 *  ⚠️ 查询词里的歌名和歌手要分开算：用户写「起风了 买辣椒也用券」时，
 *  整串拿去比字数永远对不上，得先把歌手那一截拆出来。 */
const VARIANT_RE = /翻唱|伴奏|ktv|dj|remix|童声|女声|男声|钢琴|吉他|纯音乐|铃声|片段|cover|instrumental|深情版|伤感版|抖音|加速|降调|慢速|咚鼓|氛围版|纯享|现场|live|演唱会|合辑|串烧|精选|连播|循环/i;

/** 去掉括号里的整段内容：「起风了（2019版）」→「起风了」 */
function coreTitle(s) {
  // ⚠️ 必须先把繁体摊成简体，否则繁中原唱会被当成「不匹配」
  return toSimplified(String(s || ""))
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[《》「」【】\[\]]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}
/** 只去掉括号符号、保留里面的字：「起风了（2019版）」→「起风了2019版」 */
function flatTitle(s) {
  return toSimplified(String(s || ""))
    .replace(/[（）()《》「」【】\[\]]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}
/* ---------------- 查询词拆分：歌名 + 歌手 ---------------- */

/** 查询词里的分隔符：空格、竖线、逗号、顿号。
 *  实测用户习惯就是这几种 ——「起风了 买辣椒也用券」「起风了|买辣椒也用券」
 *  「起风了，买辣椒也用券」都得认成同一个意思。
 *  加号和连字符单独由 sepToSpace 处理（「1+1」「A-Lin」不能被拆）。
 *  不加 & 和 /：Simon & Garfunkel、AC/DC 这种真名里带这些符号。 */
const QUERY_SEP_RE = /[\s|｜,，、]+/;

/** 各种写法的连字符，统一成半角再判断 */
const DASH_RE = /[－—–−﹣﹘]/g;

/** 分隔符号分情况处理，因为有些符号是艺名的一部分：
 *  - 加号「+」：「起风了+买辣椒」当分隔符，但「1+1」「A+B」是歌名本身 —— 两边都单字就不拆。
 *  - 连字符「-」：「周杰伦-稻香」要拆，但「A-Lin」「Jay-Z」是艺名 —— 两边都得 ≥2 个字才拆。
 *  - 减号在歌名里很常见（「十年-陈奕迅」），拆错了顶多搜得更宽，粘错了就搜不到。
 *  所以连字符的判据比加号更保守：必须两边都是「实词」。 */
function sepToSpace(s) {
  let out = String(s || "").replace(/＋/g, "+").replace(DASH_RE, "-");

  // 加号
  let parts = out.split("+");
  if (parts.length > 1) {
    out = parts[0];
    for (let i = 1; i < parts.length; i++) {
      const prev = parts[i - 1].replace(/\s+/g, "");
      const cur = parts[i].replace(/\s+/g, "");
      out += ((prev.length >= 2 || cur.length >= 2) ? " " : "+") + parts[i];
    }
  }

  // 连字符：两边都 ≥2 字才当分隔符
  // 「Jay-Z 99 Problems」这种，连字符右边第一个词是单个字母，说明是艺名里的缩写，不能拆
  parts = out.split("-");
  if (parts.length > 1) {
    out = parts[0];
    for (let i = 1; i < parts.length; i++) {
      const prevTok = lastWord(parts[i - 1]);
      const curTok = firstWord(parts[i]);
      const sep = (prevTok.length >= 2 && curTok.length >= 2) ? " " : "-";
      out += sep + parts[i];
    }
  }
  return out;
}

/** 最后一个词的长度依据（去掉分隔符后按空白切） */
function lastWord(s) {
  const w = String(s || "").trim().split(/\s+/);
  return (w[w.length - 1] || "").replace(/[\s|｜,，、]/g, "");
}

/** 第一个词 */
function firstWord(s) {
  const w = String(s || "").trim().split(/\s+/);
  return (w[0] || "").replace(/[\s|｜,，、]/g, "");
}

/** 发请求前把各种分隔符统一成空格：「起风了+买辣椒」→「起风了 买辣椒」 */
function normalizeQuery(query) {
  const raw = String(query || "").trim();
  const out = sepToSpace(raw).replace(QUERY_SEP_RE, " ").replace(/\s+/g, " ").trim();
  return out || raw;
}

/** 把查询词切成 token，并去重
 *  ⚠️ 必须 toSimplified：这些 token 后面要拿去跟**歌手名**比对，
 *     而歌手名那边是转成简体再比的（singerNorm）。
 *     不转的话，搜「Lemon 米津玄師」（繁体），token 是「米津玄師」，
 *     而酷狗返回的歌手是「米津玄师」（简体），indexOf 对不上，
 *     原唱被判成「歌手不符」降到 2 档、还罚 40 分，
 *     结果被一堆 YouTube 字幕视频压住。 */
function queryTokens(query) {
  return sepToSpace(query)
    .split(QUERY_SEP_RE)
    .map((t) => normText(toSimplified(t)))
    .filter(Boolean)
    .filter(function (t, i, a) { return a.indexOf(t) === i; });
}

/** 生成「这一段是歌名、剩下的是歌手」的所有拆法。
 *  整串原样也算一种候选 —— 「1+1」「A+B」这类标题本身带加号，
 *  一上来就拆会把它们拆坏，所以整串永远排在候选第一位。 */
function queryTitleCandidates(query) {
  const out = [{ text: normText(toSimplified(query)), others: [] }];
  const toks = queryTokens(query);
  const n = toks.length;
  if (n <= 1) return out;
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      out.push({
        text: toks.slice(i, j + 1).join(""),
        others: toks.slice(0, i).concat(toks.slice(j + 1)),
      });
    }
  }
  return out;
}

/** 歌手名的归一化：只去空格和符号，**保留括号里的字**。
 *  不能用 normText —— 它会把括号整段剥掉，
 *  「冯沁苑(买辣椒也用券)」会变成「冯沁苑」，搜歌手名就对不上了。 */
function singerNorm(s) {
  return toSimplified(String(s || "")).replace(/\s+/g, "").toLowerCase();
}

/** 这一截查询词是否出现在歌手名里。歌手名未知时按「没冲突」处理 ——
 *  拿不到歌手不算罪证，不能因此把它从完全匹配里踢出去。 */
function artistHit(tok, artistRaw) {
  if (!tok) return true;
  const at = singerNorm(artistRaw);
  if (!at) return true;
  if (at.indexOf(tok) >= 0) return true;
  // 歌手名里带斜杠/顿号多个人的，摊平成纯字母数字再比一次
  const a = at.replace(/[^0-9a-z\u4e00-\u9fff]/g, "");
  return !!a && a.indexOf(tok) >= 0;
}

/** 剩下那截查询词里，有没有任何一个对得上歌手。
 *  用「有」不用「全」：用户常顺手多打一个版本词（起风了 周杰伦 live），
 *  要求全中会把它判成歌手不符。 */
function artistConsistent(others, artistNorm) {
  if (!others || !others.length) return true;
  for (let i = 0; i < others.length; i++) {
    if (artistHit(others[i], artistNorm)) return true;
  }
  return false;
}

/** 标题里写了歌手名，算不算「歌手对得上」。
 *
 *  ⚠️ 为什么需要这条（实测 2026-10-21 搜「赵薇 左耳」）：
 *     赵薇那首《左耳》在内地四平台**没有版权**，返回的 60 多条全是别人的翻唱
 *     （井上苑子 / 蔡易欢 / 张小花…）。真正有她声音的只有 YouTube 和 B 站
 *     那几条搬运：标题写着「《左耳》-赵薇」「赵薇 - 左耳」，
 *     而 artist 字段是频道名（VOLVO劲浪乌托邦声浪舱 / BELLA PING MUSIC CHANNEL 2）。
 *
 *     原来的判据只看 artist 字段 → 这些条目跟「井上苑子」那批**判成同一档、
 *     同样罚 40 分**，然后靠数组顺序随机排列，用户翻半天找不到原唱。
 *
 *  ⚠️ 但必须防两类误伤：
 *     ① 版本词当歌手：搜「起风了 live」，others 里是 live，
 *        任何标题带 Live 的都会被判成「歌手对得上」→ 挡住变体词。
 *     ② 翻唱照抄原唱名：已经在 isCoverTitle 那一层判成 1 档，
 *        轮不到这里（「左耳（cover 赵薇）」不会因为标题有赵薇就升档）。
 */
function titleMentionsArtist(others, titleRaw) {
  if (!others || !others.length) return false;
  const t = singerNorm(titleRaw);
  if (!t) return false;
  for (let i = 0; i < others.length; i++) {
    const tok = String(others[i] || "");
    if (!tok || tok.length < 2) continue;
    if (VARIANT_RE.test(tok) || isCoverTitle(tok)) continue;   // ①
    if (t.indexOf(singerNorm(tok)) >= 0) return true;
  }
  return false;
}

/** 歌手没对上的罚分，只在 2 档内部生效：歌名一样但换了人的排后面 */
const ARTIST_MISS_PENALTY = 40;

/** 标题里的「这是资讯/视频，不是歌」字样。
 *  搜歌手名时全靠它把八卦新闻从歌曲堆里挑出来压下去。 */
const NEWS_TITLE_RE = /苹果日报|蘋果日報|联合报|聯合報|自由时报|自由時報|中国时报|中國時報|星岛|星島|明报|明報|东森新闻|東森新聞|三立新闻|三立新聞|娱乐新闻|娛樂新聞|新浪娱乐|新浪娛樂|网易娱乐|網易娛樂|腾讯娱乐|騰訊娛樂|日报|日報|晚报|晚報|周刊|週刊|专访|專訪|破防|亮立场|立场|出征|集体|网友|网友笑|笑死|翻车|卖台|表态|回應|回应|新聞|新闻|大白話|大白话|譴責|谴责|統一|统一|門票|门票|演唱會門票|票價|票价|爆料|怒斥|崩潰|崩溃|打臉|打脸|專輯發|专辑发|新歌|首發|首发|破億|破亿|霸榜|熱搜|热搜|網亮|网亮|主播|直播回放|太惨|太慘|卖不出去|賣不出去|降价|降價|綠媒|绿媒|中天|三立|民視|民视|TVBS|東森|央視|央视|新華社|新华社|網紅|网红|洗版|吵翻|吵翻天|炸鍋|炸锅|政治|選情|选情|罷免|罢免|立委|議員|议员|部長|部长|總統|总统|中共|解放軍|解放军|軍演|军演|外交|國防|国防|關稅|关税/i;

/* ============================================================
 * 「这条根本不是歌」的识别（不分搜歌名还是搜歌手）
 *
 * 实测搜「晴天」，YouTube 混进来一条：
 *   【🔮透視水晶球】光的頻率解析🌟你的防護罩有多強大？｜ Sunnyday Energy 晴天。光
 * 它标题里确实有「晴天」，但那是**频道名**的一部分，
 * 跟周杰伦的歌半点关系没有。
 *
 * 只在**视频平台**（YouTube / Bilibili）上判，并且要求
 * 「标题长度是查询词的 2.5 倍以上」—— 正常的歌名不会这么长，
 * 长到这种程度的多半是标题党视频。
 * ============================================================ */
const NON_MUSIC_VIDEO_RE = /水晶球|占卜|塔罗|塔羅|星座|冥想|催眠|助眠|白噪音|白噪音|ASMR|解压|解壓|开箱|開箱|教学|教學|教程|测评|測評|reaction|vlog|紀錄片|纪录片|访谈|訪談|演讲|演講|搞笑|恶搞|惡搞|整活|鬼畜|合集|盘点|盤點|排行榜|解说|解說|直播回放|直播间|直播間|粉丝群|粉絲群|頻道|频道/i;

/* 「音乐相关，但不是一首歌」的素材类字样。
 * 实测搜「Taylor Swift」，B站第一条是
 *   【Taylor Swift】Patient Zero幕后花絮混剪版MV首播！
 * 它的 artist 字段写着 TaylorSwiftChina（含歌手名），
 * 所以 NON_MUSIC_VIDEO_RE 那条「artist 里没有歌手名」的前提挡不住它。
 * 这一条**不看 artist**，只看标题，要求去掉查询词后还剩 ≥6 字：
 * 《幕后玩家》《首播》这种歌名本身带这些字时不会被误杀。 */
const MEDIA_VIDEO_RE = /幕后|幕後|花絮|混剪|首播|预告|預告|抢先看|搶先看|彩蛋|彩排|探班|采访|採訪|专访|專訪|片段|剪辑|剪輯|未公开|未公開|reaction|instrumental|纯音乐|純音樂|发布会|發布會|记者会|記者會|首映|见面会|見面會/i;

/* 新闻媒体署名。
 * 实测搜「赵薇 左耳」，第 9 条是
 *   蘇有朋處女導《左耳》操瘦6公斤　不敢與趙薇比較 -- 蘋果日報 20141119
 * 它标题里既有歌名又有歌手名，上面所有针对性规则都放它过去，
 * 于是稳稳排进「能听的原唱」那一段。但它是一条娱乐新闻。
 *
 * 只在**视频平台**上、且去掉歌名歌手后还剩 ≥6 字时才判 ——
 * 《新闻》这种真歌名（长度短、没有媒体署名）不会被误杀。 */
const NEWS_SOURCE_RE = /蘋果日報|苹果日报|聯合報|联合报|自由時報|自由时报|中國時報|中国时报|星島|星岛|明報|明报|東森新聞|东森新闻|三立新聞|三立新闻|蘋果新聞|苹果新闻|新浪娱乐|新浪娛樂|網易娛樂|网易娱乐|騰訊娛樂|腾讯娱乐|娱乐新闻|娛樂新聞|新聞網|新闻网|新聞台|新闻台|电视台|電視台|[日週周]报|晚报|晚報|周刊|週刊/i;

/** 查询词整串是否就是这位歌手的名字（搜「周杰伦」而不是搜某首歌）。
 *  ⚠️ 只认整串、且长度 ≥2，避免「起风了 买辣椒也用券」这种组合串误判。 */
/* 反查确认过的「查询词 → 同一身份的其它名字」。
 * 有了它，「IGU Band」这种**一个字都不重合**的英文名才认得出是歌手：
 * 结果里 artist 写着「那我懂你意思了」，光靠字符串包含永远判不出来。 */
const ARTIST_ALIAS = {};

/** 整串是不是纯中文（汉字）。用来判断「这是换了文字体系的译名」还是「另一个人」。 */
function isPureCJK(s) {
  const t = String(s || "").replace(/\s+/g, "");
  if (!t) return false;
  return /^[\u4e00-\u9fff]+$/.test(t);
}

/** ⚠️ 单个名字跟查询词是不是同一个人（不含多人分隔符那一步）。
 *
 *  这里曾经是 `an.indexOf(qn) >= 0` —— 包含即通过。后果（实测 2026-10-21
 *  搜「李志」）：李志辉(264 首) / 李志强 / 李志成 / 李志洲 / 大勇（李志勇）
 *  / 李志轩 / 李志斌 全部被认成「李志」，一起拿了 3 档，把李志本人的歌
 *  整片挤出前排 —— 用户看到的第一屏是「天涯 - 李志辉」这种别人的歌。
 *  同一类问题搜「赵薇」时已经踩过一次（赵薇薇 / 赵薇风），当时只在
 *  歌手库里加了闸门，**排序这一层漏掉了**。
 *
 *  真能算同一个人的写法只有三种：
 *    A. 完全相等                   周杰伦 / 李志
 *    B. 拉丁前缀 + 中文名           G.E.M.邓紫棋 / 李志 Li Zhi
 *       （前缀里不能有中文：「东北周杰伦」「李志轩」是另一个人）
 *    C. 中文名 + 拉丁后缀           蘇打綠 sodagreen
 *  中文名多一个字一律不是同一个人。
 */
function oneNameEq(name, qn) {
  let nn = singerNorm(toSimplified(name));
  // YouTube 自动生成的官方频道叫「李志 - Topic」
  nn = nn.replace(/\s*[-–—]\s*topic$/, "").replace(/\s+/g, "");
  if (!nn || !qn) return false;
  if (nn === qn) return true;
  if (nn.length > qn.length) {
    if (nn.slice(-qn.length) === qn) {
      const prefix = nn.slice(0, nn.length - qn.length);
      // 前缀必须是拉丁字母/数字/标点，「李志轩」这种中文前缀不算
      if (prefix && !/[\u4e00-\u9fff]/.test(prefix)) return true;
    }
    if (nn.slice(0, qn.length) === qn) {
      const suffix = nn.slice(qn.length);
      // 后缀同理：「李志辉」「李志强」全是另一个人
      if (suffix && !/[\u4e00-\u9fff]/.test(suffix)) return true;
    }
  }
  return false;
}

function isArtistQuery(query, artist) {
  const qn = normTextZ(query);
  if (!qn || qn.length < 2) return false;
  const an = singerNorm(toSimplified(artist));
  if (!an) return false;
  /* 多人合作署名先拆开逐个认：「周杰伦&杨瑞代」「李志、江砚深」
     「G.E.M.邓紫棋&陈奕迅」都得让其中一位对上就算。
     拆完仍要整串再比一次 —— AC/DC 这种名字里自带斜杠的会被拆坏。 */
  const parts = an.split(/[\/&、,，]/);
  for (let i = 0; i < parts.length; i++) {
    if (oneNameEq(parts[i], qn)) return true;
  }
  if (oneNameEq(an, qn)) return true;
  const als = ARTIST_ALIAS[qn];
  if (als && als.length) {
    for (let i = 0; i < als.length; i++) {
      const k = normTextZ(als[i]);
      if (k && oneNameEq(an, k)) return true;
    }
  }
  return false;
}

/* ============================================================
 * 「这次搜的是一个歌手名」的整轮判定
 *
 * ⚠️ 为什么不能逐条判断：
 *    搜「周杰伦」时，八卦视频的 artist 是频道名（坤姐闯江湖），
 *    isArtistQuery(title.artist, "周杰伦") = false，
 *    于是它按普通「标题沾边」逻辑拿 2 档，反而压过 artist 字段
 *    真是周杰伦、但标题不含他名字的歌。
 *
 * 判断依据：结果里有一定比例的条目，artist 字段包含了整串查询词。
 *
 * ⚠️ 不能用「有多条标题正好等于查询词」来判断 ——
 *    搜《起风了》也有一堆标题就叫「起风了」的条目，
 *    那条规则会把普通歌名搜索误判成歌手名搜索，
 *    结果所有条目掉到 2 档，排序全乱。
 * ============================================================ */
function detectArtistQuery(query, items) {
  const qn = normTextZ(query);
  if (!qn || qn.length < 2) return "";
  const list = items || [];
  if (!list.length) return "";

  let hit = 0;
  for (let i = 0; i < list.length; i++) {
    if (isArtistQuery(query, list[i].artist)) hit++;
  }
  /* ⚠️ 踩过的大坑（实测 2026-10-18 搜「IGU Band」）：
     原先写死 hit/list.length >= 0.15。实测每次搜索总条数在 41~44 之间浮动、
     命中 YouTube「xxx - Topic」官方频道的条目在 3~7 条之间浮动，
     命中率正好卡在 14%~16% 反复横跳 —— 同一个词连搜两次，
     一次判成歌手名（走 Apple 目录白名单，剩 12 条干净的官方曲），
     一次判不出来（42 条里混进 DJ IGU BEATS 的《Puta Bandida》、
     B站那些 Flag Band / 数字方块 band）。
     用户看到的症状就是「有时干净、有时一锅粥」。
     改成绝对条数门槛：至少 3 条，比例放宽到 6%。
     搜歌名时几乎不可能有 3 条结果的**歌手字段**包含整串查询词。
     ⚠️ 分母取 min(总数, 50)：结果池大到一百多条时（百度级大歌手），
        3 条永远不会到 6%，所以用 50 封顶，别让大结果池把判定稀释掉。 */
  const base = Math.min(list.length, 50);
  if (hit >= 3 && hit / base >= 0.06) return qn;
  return "";
}

/** 「这一轮其实是在搜歌名」的否决判据。
 *
 *  ⚠️ 踩过的大坑（2026-10-19 实测搜「印第安老斑鸠」）：
 *     周杰伦那首《印第安老斑鸠》是歌名，但酷我/咪咕上有一批网络歌手
 *     直接把这个歌名当**艺名**用（artist 字段就写着「印第安老斑鸠」），
 *     于是 detectArtistQuery 命中 → 整轮按「搜歌手」排序 →
 *     这批人的《马》《偏爱》《过火》《童年的纸飞机》全拿了 3 档，
 *     把周杰伦原曲挤到第 8 位之后，用户看到的就是满屏不相干的歌。
 *
 *  判据：「标题正好等于查询词、但歌手不是查询词」的条目 ≥3 条，
 *  说明这串字本身是个歌名，别人在翻唱它，而不是一个歌手名。
 *  ⚠️ 必须排除「歌手就是查询词」的条目：搜「周杰伦」时那条《周杰伦》
 *     (标题恰好等于歌手名) 不能算反证，否则真歌手搜索会被自己否决掉。
 */
function isTitleQuery(query, items) {
  const qf = flatTitle(query), qc = coreTitle(query);
  if (!qf) return false;
  const list = items || [];
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (isArtistQuery(query, it.artist)) continue;
    const tf = flatTitle(it.title), tc = coreTitle(it.title);
    if ((tf && tf === qf) || (tc && tc === qc)) {
      n++;
      if (n >= 3) return true;
    }
  }
  return false;
}

/** 只数命中条数，不做判定。给「要不要去问 Apple」当门槛用 ——
 *  命中 ≥2 说明这串词大概率是个人名，值得花 100ms 查一次权威曲库。 */
function countArtistHits(query, items) {
  const qn = normTextZ(query);
  if (!qn || qn.length < 2) return 0;
  const list = items || [];
  let hit = 0;
  for (let i = 0; i < list.length; i++) {
    if (isArtistQuery(query, list[i].artist)) hit++;
  }
  return hit;
}

function relevanceTier(title, query, artist, artistQuery, titleQuery) {
  const raw = String(title || "").trim();
  const q = String(query || "").trim();
  if (!raw || !q) return 1;
  const core = coreTitle(raw);
  const flat = flatTitle(raw);
  if (!core) return 1;
  // 变体词直接压到最低档，不管标题多"准"
  // （翻唱那一套标记复用 isCoverTitle，别在两处各维护一份正则）
  if (VARIANT_RE.test(raw) || isCoverTitle(raw)) return 1;

  /* ---- 搜歌手名：歌手对得上的就是「这首是他的歌」 ----
     修的问题：搜「周杰伦」，YouTube 上《周杰伦外网亮立场，青鸟破防》
     这种资讯视频，标题里正好有这三个字，被判成 2 档；
     而真正的《晴天》(artist=周杰伦) 标题不含「周杰伦」，只能算 1 档，
     结果八卦新闻把歌全压下去了。
     歌手的名字出现在 artist 字段里，才是「这是他的歌」的正经证据。
     ⚠️ artistQuery 是整轮判定结果（detectArtistQuery），逐条判断会漏掉
        「artist 是频道名、但确实是八卦视频」那一类。 */
  /* ⚠️ titleQuery 为真时（这串字其实是歌名，只是有人拿它当艺名），
     整条「搜歌手」逻辑都要跳过 —— 否则那个冒名歌手名下的
     《马》《偏爱》《过火》照样靠 isArtistQuery 拿 3 档，
     否决整轮判定等于白否决。 */
  const isAQ = !titleQuery && (artistQuery || isArtistQuery(q, artist));
  if (isAQ) {
    /* 资讯视频直接踢到 0 档 —— 比「变体/伴奏/DJ」还低。
       搜歌手名时，标题里既没有歌名、又满是「热搜/破防/出征」的，
       就是一条视频，不该夹在任何歌前面。 */
    if (NEWS_TITLE_RE.test(raw)) return 0;
    // 歌手就是他的名字 → 这是他的歌
    if (isArtistQuery(q, artist)) return 3;
    // artist 是频道名但标题里带着他的名字（演唱会切片、翻唱等）
    return 2;
  }

  const at = artist;
  const cands = queryTitleCandidates(q);
  let best = 1;
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    if (!c.text) continue;
    /* 这一截是歌名，剩下那截得在歌手名里对得上，才算完全匹配。
       ⚠️ 除了 artist 字段，标题里写着歌手名的也算 ——
         版权缺失只有搬运版时（赵薇《左耳》），artist 是频道名，
         只认 artist 会把唯一能听的原唱跟一堆翻唱判成同一档。 */
    const artistInTitle = titleMentionsArtist(c.others, raw);
    const artistOk = artistConsistent(c.others, at) || artistInTitle;
    if (flat === c.text) {
      // 「起风了」对「起风了」；「起风了（2019版）」多出六个字，不算
      const t = artistOk ? 3 : 2;
      if (t > best) best = t;
      if (best === 3) return 3;
    } else if (c.text.length >= 2 && core.indexOf(c.text) >= 0) {
      /* 歌名对上了、歌手名也写在标题里 → 这条就是「这首歌 + 这个人」，
         跟标题正好等于歌名的条目同级。
         ⚠️ 为什么不再压成 2 档（实测「赵薇 左耳」）：
            内地四平台没版权，能听的原唱全在 YouTube/B站搬运，
            标题必然是「《左耳》-赵薇」这种「歌名 + 歌手」写法，
            永远对不上「标题正好等于歌名」。压成 2 档后，
            它们跟「左耳 / 井上苑子」那批翻唱同档，只能靠罚分分出高下，
            用户翻了十几条才看到第一条能听的。
         歌手只在标题里（artist 是频道名）才算 —— 上面 artistInTitle
         已经挡掉了版本词和「cover 赵薇」这类翻唱标记。 */
      if (artistInTitle) { if (best < 3) best = 3; }
      else if (best < 2) best = 2;
    }
  }
  return best;
}

/** 同档内的细排分：多出的字数（越少越靠前），歌手对不上再加罚分 */

/* ============================================================
 * 官方发行版识别（打进 _bone 分，越小越靠前）
 *
 * 背景：搜「原谅我不明白你的悲伤」这种内地四平台没有原唱的歌，
 * 结果是「原唱（YouTube，繁体）vs 一堆同名翻唱（简体）」同分并列，
 * 翻唱反而因为标题正好是简体而排前面。
 *
 * 能用的信号（实测有效）：
 *   - 「xxx - Topic」频道 = YouTube 自动生成的官方发行版，最可靠
 *   - 视频时长（起风了原唱 325 秒），但 YouTube 侧常常没给，不可靠
 *   - 演唱者名和查询里的歌手名一致
 *   - 内地数字平台的同名单曲，绝大多数是翻唱（原唱没版权），所以给它降权
 * ============================================================ */

/* ============================================================
 * 播放量 → 排序权重（打进 _hot，越大越靠前，但封顶）
 *
 * 实测只有 Bilibili 拿得到播放量（COCO 四平台只有 8 个字段、酷我 55 个字段、
 * YouTube ANDROID client 都不返回，咪咕也没有）。所以这项只对 B 站生效。
 *
 * ⚠️ 权重必须封顶，否则会盖过「官方发行版」判断：
 *   搜「起风了」B站播放量前三名是
 *     1899万 原版《起风了》买辣椒也用券      ✅
 *     1765万 林俊杰《起风了》神级现场        ❌ 是 Live 翻唱
 *      859万 周深《起风了》                 ❌ 是翻唱
 *   播放量高只说明「受欢迎」，不说明「是原唱」。
 *
 * 所以用对数刻度，且最多给 12 分 —— 只是一个同分时的微调，
 * 永远不足以让 tier 更低的条目反超 tier 更高的。
 * ============================================================ */
function hotScore(playCount) {
  const p = Number(playCount || 0);
  if (!(p > 0)) return 0;
  // log10(1) = 0 → 0 分；log10(1e6) = 6 → 6 分；满 10 分封顶在 1e10
  const s = Math.log10(p + 1);
  return Math.min(12, Math.round(s * 1.2));
}

function officialBone(raw, artist, platform, query, artistQuery) {
  const t = String(raw || "");
  const a = String(artist || "");
  const q = toSimplified(String(query || ""));
  let bone = 0;

  // ⚠️ 关键：「- Topic」加分必须**同时要求标题跟查询对得上**。
  //    否则《我打工的咖啡廳》(IGU Band - Topic) 这种同艺人不同歌，
  //    会仅凭 Topic 身份被顶到第一位。
  const titleOk = flatTitle(t).indexOf(flatTitle(q)) >= 0 || coreTitle(t).indexOf(coreTitle(q)) >= 0;
  if (/[-–—]\s*Topic$/i.test(a)) {
    bone -= titleOk ? 45 : 0;   // 标题对得上才认它是官方发行版
  }

  // 标题里带演唱者署名「xxx - 歌名」结构的多半是搬运
  if (/^[^-]{2,20}\s*[-–—]\s*/.test(t) && !/[-–—]\s*Topic$/i.test(a)) bone += 8;

  /* ---- 搜歌手名时：歌手字段没对上这位歌手的，压一档 ----
     ⚠️ 实测（2026-10-21）搜「李志」：
        QQ 耿十三翻唱的《关于郑州的记忆》排在真正的原唱前面，
        B 站《KTV<关于郑州的记忆> 原唱李志》（上传者 tzzyyyyyy）也在里面。
        它们 tier 都是 3（歌名对上了），apc 都是 -20（YTM 目录没这首），
        剩下全靠 order 决定 —— 也就是「谁先被搜到谁在前」，纯随机。
     判据：artistQuery 成立时，条目自己的歌手字段是不是查询里那位。
        只对「国内平台 + YouTube」用，B 站/YouTube 的搬运条目本来就
        是频道名，硬压会把有用的音频一起压下去（后面还有 tier 兜着）。 */
  if (artistQuery && platform !== "Bilibili" && platform !== "YouTube" &&
      a && singerNorm(a) !== singerNorm(q) &&
      singerNorm(a).indexOf(singerNorm(q)) < 0 && singerNorm(q).indexOf(singerNorm(a)) < 0) {
    bone += 25;
  }

  // 内地数字平台上的同名单曲：原唱常常没版权，页面里剩的多是翻唱
  if (platform === "QQ音乐" || platform === "网易云" || platform === "酷狗" || platform === "咪咕") bone += 12;

  // 现场 / 巡演 / 合集（统一交给 isLiveVersion，标题+专辑一起看，见函数下方）
  if (/社慶|社庆|cover|翻唱/i.test(t)) bone += 20;

  /* 搜歌手名时，标题里全是「新闻/破亿/笑死/出征」这类资讯词的，
     是视频不是歌。此时没有「歌名」可对齐，只能靠这条把它压下去。 */
  if ((artistQuery || isArtistQuery(q, a)) && NEWS_TITLE_RE.test(t)) bone += 30;

  // Live 版降权（原来只看标题，漏了大量「标题干净、专辑带演唱会」的情况）
  if (isLiveVersion(raw, albumOf(raw))) bone += 20;

  return bone;
}

/* ============================================================
 * Live / 现场版的判定
 *
 * ⚠️ 必须**标题和专辑一起看**。实测「晴天」的几种 Live 版：
 *   标题「晴天 (Live)」        → 标题能看出来
 *   标题「晴天」               → 看不出来，信息全在专辑
 *      《周杰伦 2004 无与伦比 演唱会 Live》
 *   标题「晴天 (Live)」        → 专辑也是演唱会
 * 只查标题的话，第二种完全漏掉。
 * ============================================================ */
const LIVE_RE = /(?<![a-z])(live|concert)(?![a-z])|演唱[会會]|現場|现场|巡演|巡迴|巡回|音樂節|音乐节|音悦台|不插电|unplugged|acoustic\s*version|en\s*vivo/i;

/** 从条目里尽量取到专辑名（不同平台字段名不一样） */
function albumOf(item) {
  if (!item) return "";
  return String(
    (item && item.album) ||
    (item && item._raw && (item._raw.album || item._raw.ALBUM || item._raw.albumname || item._raw.album_name)) ||
    ""
  );
}

/** 标题或专辑任一命中 Live 特征即认为是现场版 */
function isLiveVersion(title, album) {
  const t = String(title || "");
  const a = String(album || "");
  if (!t && !a) return false;
  return LIVE_RE.test(t) || LIVE_RE.test(a);
}

function relevanceExtra(title, query, artist, artistQuery) {
  const raw = String(title || "").trim();
  const q = String(query || "").trim();
  if (!raw || !q) return 0;
  const core = coreTitle(raw);
  const flat = flatTitle(raw);
  if (!core) return 0;

  // 搜歌手名：是他的歌就拿 0 分，比的是后面的 bone/hot/heat
  // 资讯视频给个大罚分，直接沉底（长度跟歌名无关，别拿字数比）
  if (artistQuery || isArtistQuery(q, artist)) {
    if (NEWS_TITLE_RE.test(raw)) return 999;
    if (isArtistQuery(q, artist)) return 0;
  }

  const at = artist;
  const cands = queryTitleCandidates(q);
  let best = -1;
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    if (!c.text || c.text.length < 2) continue;
    /* 同上：标题里写着歌手名也算对得上。
       否则「《左耳》-赵薇」（频道名当 artist）跟「左耳/井上苑子」
       同样罚 40 分，只能靠数组顺序排 —— 用户就在一堆翻唱里翻不到原唱。 */
    const artistOk = artistConsistent(c.others, at) || titleMentionsArtist(c.others, raw);
    let score;
    if (flat === c.text) {
      score = artistOk ? 0 : ARTIST_MISS_PENALTY;
    } else if (core.indexOf(c.text) >= 0) {
      score = Math.max(0, flat.length - c.text.length) + (artistOk ? 0 : ARTIST_MISS_PENALTY);
    } else {
      continue;
    }
    if (best < 0 || score < best) best = score;
  }
  /* ⚠️ 一个都没命中时不能返回 0（2026-10-21）。
     extra 的语义是「比查询词多出来几个字」，越小越靠前；而 0 是**最靠前**
     的值。于是「标题里根本没有查询词」的条目反而排到了
     「起风了(伴奏)」(多 3 个字) 前面 —— 实测搜「起风了」，
     《飞机云(电影《起风了》插曲)》排在《起风了(伴奏)》上面；
     搜「后来」，《未来へ》排在《后来 (翻唱)》上面。
     没命中的给个大值沉到本档末尾（比资讯的 999 小），
     这样同档里「沾边的、字数少的」先出来，顺序就不再是随机的。 */
  return best < 0 ? NO_MATCH_EXTRA : best;
}
/** relevanceExtra 里「标题跟查询词完全没关系」的罚分（小于资讯的 999） */
const NO_MATCH_EXTRA = 700;


/* ============================================================
 * 简繁归一化（用于**排序比对**，不是用于发请求）
 *
 * 踩过的坑：查询是简体「原谅我不明白你的悲伤」，
 * YouTube 上的原唱标题是繁体「原諒我不明白你的悲傷」，两者 norm 后不相等，
 * 结果原唱被判成「变体」压到最低档（tier=1），
 * 而内地四平台的简体翻唱被判成「完全匹配」（tier=3）排在最前面。
 *
 * 修法：比对前把两边都摊成简体，谁写的简体繁体都不影响相关性判断。
 * 注意只影响排序打分，不改变发出去的查询词。
 * ============================================================ */
let _t2sMap = null;
/* 繁简之外还要处理的**异体字**。
 * ⚠️ 这不是「繁→简」，是「同一个人的两种写法」——
 *    实测（2026-10-21）搜「叶倩文」：QQ/酷我给的都是「叶蒨文」，
 *    蒨 在繁简表里没有对应字（它本来就是简体里也合法的异体），
 *    于是 singerNorm 之后一个「叶倩文」一个「叶蒨文」，永远对不上：
 *    歌手条目指向 QQ 那个 0 首的号，MusicBrainz 也查不到人（它写「葉蒨文」）。
 *    换成「叶蒨文」搜就一切正常，19 张 201 首。
 *    同类还有：峯/峰、恒/恆、姗/姍、修/脩、赞/讚、滨/濱、茜/蒨。
 * 这里只做「归一化到一个写法」，方向统一取更常见的那一侧。 */
/* ⚠️ 表里只放「确实是同一个字的两种写法」，别塞近音字：
   茜 / 珊 / 燊 都是**独立的姓名用字**（张茜、林珊、何燊），
   把它们并到倩/姗/燊上会认错人，这正是之前「赵薇 vs 赵薇薇」那类误伤的翻版。 */
const VARIANT_CHARS = {
  "蒨": "倩",   // 叶蒨文 = 叶倩文
  "峯": "峰",   // 林峯 = 林峰
  "恆": "恒",
  "姍": "姗",
  "脩": "修",
  "讚": "赞",
  "濱": "滨",
  "喆": "哲",   // 陶喆 的 喆 是 哲 的异体（只在比对时归一，不改发出去的词）
  "啟": "启",
};

function t2sMap() {
  if (_t2sMap) return _t2sMap;
  const m = {};
  const arr = T2S_PAIRS.split(",");
  for (let i = 0; i < arr.length; i++) {
    const p = arr[i].split(":");
    // T2S_PAIRS 是「繁:简」，方向就是我们要的，直接建表
    if (p.length === 2 && p[0] && p[1] && !m[p[0]]) m[p[0]] = p[1];
  }
  /* ⚠️ 异体字必须**覆盖**繁简表的结果（后写），不能只补空缺：
     蒨 在繁简表里可能被映射成别的字，覆盖才能保证统一到「倩」。 */
  const vk = Object.keys(VARIANT_CHARS);
  for (let i = 0; i < vk.length; i++) m[vk[i]] = VARIANT_CHARS[vk[i]];
  _t2sMap = m;
  return m;
}

/** 繁体 → 简体（已经是简体就原样返回） */
function toSimplified(str) {
  const m = t2sMap();
  const s = String(str || "");
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    out += m[c] || c;
  }
  return out;
}

/** 排序专用的归一化：先统一到简体，再去括号/空格/小写 */
function normTextZ(s) {
  return normText(toSimplified(String(s || "")));
}

/** 两个标题的相似度 0~1（逐字编辑距离）。
 *
 *  ⚠️ 为什么需要它：iTunes 繁体库里同一个歌名会换字 ——
 *     「印第安老斑鸠」在 Apple 里写作「印地安老斑鳩」（第/地、鸠/鳩），
 *     严格相等或 indexOf 全都对不上，于是被当成「查无此歌」，
 *     权威目录这一层就白跑了。归一化只处理繁简，处理不了这种用字差异。
 */
function titleSimZ(a, b) {
  const clean = (x) => normTextZ(x).replace(/[^0-9a-z一-鿿]/g, "");
  const x = clean(a), y = clean(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.indexOf(y) >= 0 || y.indexOf(x) >= 0) {
    return Math.min(x.length, y.length) / Math.max(x.length, y.length);
  }
  if (x.length * y.length > 400) return 0;
  const m = x.length, n = y.length;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

/* ------------------------------------------------------------
 * 「多词必须全中」校验。
 *
 * B 站搜索是**分词**匹配，不是整串匹配：搜「摇晃帝国」，它把关键词拆成
 * 「摇晃」+「帝国」两个词分别匹配，于是《时光的摇晃》《绿色的摇晃的汽水》
 * 全都进来了 —— 标题里根本没有「帝国」两个字。
 *
 * 规则：查询词去掉分隔符后如果还是一整块（「起风了」这种），不校验；
 * 一旦能被切成多个词（「摇晃帝国」无法在中文里切，但「Lemon 米津玄師」
 * 「Yura Yura Teikoku」可以），就要求标题里**每个词都出现**。
 *
 * 中文长词没法可靠切分，所以这里只处理两类：
 *   1) 空格/加号分隔的多词 —— 直接 split
 *   2) 纯中文串 —— 保守跳过（切错了会误杀正确结果）
 * ------------------------------------------------------------ */
function queryWordList(query) {
  const raw = String(query || "").trim();
  // 先按显式分隔符切（空格、+、|、逗号、顿号、斜杠）
  const parts = raw.split(/[\s+｜|,，、/]+/).filter(Boolean);
  if (parts.length >= 2) return parts;
  return [];
}

/** 标题是否覆盖了查询里的每个词（繁简不敏感） */
function titleCoversAllWords(title, query) {
  const words = queryWordList(query);
  if (words.length < 2) return true;             // 单块查询不校验
  const t = normTextZ(title);
  for (let i = 0; i < words.length; i++) {
    const w = normTextZ(words[i]);
    if (!w) continue;
    if (t.indexOf(w) < 0) return false;          // 缺一个词就否
  }
  return true;
}

/**
 * 标题是否「确实在讲这个查询」。
 *
 * anchors = 查询词本身 + 反查到的原名/别名。
 * 命中任意一个 anchor 就算过：
 *   · 带分隔符的多词 anchor → 每词都要出现（「Lemon 米津玄師」）
 *   · 单块 anchor（中文歌名/艺人名）→ 标题里要**连续出现**
 *
 * 单块用「连续包含」而不是分词，是因为 B 站会自己拆词：
 * 搜「摇晃帝国」它拆成「摇晃」「帝国」分别匹配，
 * 《时光的摇晃》只有前半个词也照样返回。连续包含能直接拦掉这类。
 * 而真正对的结果（「ゆらゆら帝国」）靠 anchors 里的原名兜住。
 */
function titleMatchesAnchors(title, anchors, query) {
  const t = normTextZ(title);
  if (!t) return false;
  // ⚠️ 查询本身是多词时（「Lemon 米津玄師」「海阔天空 beyond」），
  //    必须**原查询的每个词都出现**，不能拿别名去放行 ——
  //    否则别名「米津玄師」单块命中，就会把《LOSER》《IRIS OUT》
  //    这些不含 Lemon 的歌也放进来。
  if (query && queryWordList(query).length >= 2) {
    if (!titleCoversAllWords(title, query)) return false;
    // 词都覆盖了，再确认它确实是个跟查询相关的标题即可
    return true;
  }
  for (let i = 0; i < anchors.length; i++) {
    const a = String(anchors[i] || "").trim();
    if (!a) continue;
    if (queryWordList(a).length >= 2) {
      if (titleCoversAllWords(title, a)) return true;
    } else {
      const n = normTextZ(a);
      if (n && t.indexOf(n) >= 0) return true;
    }
  }
  return false;
}

/** 最长公共子串长度（只用于反查结果的置信度判断，输入都很短） */
function lcsLen(a, b) {
  const s = normTextZ(a), t = normTextZ(b);
  if (!s || !t) return 0;
  let best = 0;
  const prev = new Array(t.length + 1).fill(0);
  for (let i = 1; i <= s.length; i++) {
    let diag = 0;
    for (let j = 1; j <= t.length; j++) {
      const tmp = prev[j];
      if (s[i - 1] === t[j - 1]) {
        prev[j] = diag + 1;
        if (prev[j] > best) best = prev[j];
      } else prev[j] = 0;
      diag = tmp;
    }
  }
  return best;
}

/**
 * 原名反查：拿查询词去网易云歌手搜索，捞 name / alias / transNames。
 *
 * 场景：用户搜「摇晃帝国」（乐队名的中文译法），B 站根本不认这个名字，
 * 只有搜「ゆらゆら帝国」才有正确结果。
 *
 * 两路来源，互补：
 *   网易云 cloudsearch —— 别名在 artists[].alias，中文译名在曲目 ar[].tns
 *                         （实测能给出「摇摆帝国」这个中文译法）
 *   QQ 音乐歌手接口    —— 译名直接写在括号里，形如
 *                         「L'Arc〜en〜Ciel (彩虹乐队)」「Queen (皇后乐队)」
 *                         （实测「彩虹乐队」网易云只给到 Rainbow，QQ 才是对的）
 *
 * ⚠️ 必须卡置信度，否则「稻香」会被解析成歌手「周杰伦」，
 *    拿「周杰伦」去搜 B 站就变成整个歌手主页了。
 *    反查结果只用来**追加** anchor 和关键词，永远不会顶掉原查询。
 */
/* QQ 用「原名 (译名)」的写法明确声明「这两个名字是同一个人」，
   实测搜「彩虹乐队」酷我返回的「彩虹乐队」是个 128 首的山寨号，
   真正的 L'Arc〜en〜Ciel（613 首）根本不在结果里。
   这份表给 searchArtist / searchAlbum 排序用：权威原名压过译名同名条目。 */
const ALIAS_AUTH = {};

/** 只问 QQ 一家：它的「原名 (译名)」是**显式声明**，最快也最可靠。
 *
 *  耗时实测 1.1~2.1 秒（周杰伦 2.1s / 起风了 1.1s / 摇晃帝国 1.2s）。
 *
 *  返回 { names, authoritative, exact }
 *    authoritative  括号里的译名正好是查询词 → 平台明说「这俩是同一个人」
 *    exact          QQ 里有一位的名字就是查询词 → 查询词本身就是本名
 *                   （周杰伦 / 草东没有派对），不需要再问别的源
 *
 *  ⚠️ 「(xxx成员)」那些是乐队成员的歌手页，一律不要 ——
 *     拿成员名去搜会把整支乐队淹掉（实测「五月天」会冒出
 *     「五月天 阿信」「五月天 怪兽」「石头 (五月天成员)」）。
 */
async function qqArtistProbe(q) {
  const res = { names: [], authoritative: false, exact: false };
  const qn0 = normTextZ(q);
  try {
    /* ⚠️ 超时必须短。这个接口实测「稳定 5.0~5.2 秒、返回空 names」——
       对中文查询基本是死的，但每次专辑/歌手搜索都在等它，
       于是专辑页 1.9s → 6.4s，用户直接感觉「插件变慢了」。
       1.2 秒拿不到就当没有，Apple 那边 300ms 就能给出结果。 */
    const qq = await axios_1.get("https://c.y.qq.com/soso/fcgi-bin/client_search_cp", {
      params: { w: q, t: 9, p: 1, n: 5, format: "json" },
      timeout: 1200,
      headers: { "User-Agent": UA, Referer: "https://y.qq.com/" },
      validateStatus: () => true,
    });
    const sl = (qq.data && qq.data.data && qq.data.data.singer && qq.data.data.singer.list) || [];
    for (let i = 0; i < Math.min(4, sl.length); i++) {
      const raw = String(sl[i].singerName || "").trim();
      if (!raw || /成员|樂隊成員|乐队成员/.test(raw)) continue;
      // 「L'Arc〜en〜Ciel (彩虹乐队)」→ 主名 + 括号里的译名
      const inner = (raw.match(/[（(]([^）)]+)[）)]/) || [])[1] || "";
      const main = raw.replace(/[（(][^）)]*[）)]/g, "").trim();
      if (normTextZ(inner) === qn0 && main) {
        // 括号译名就是查询词 → 平台明确说「这俩是同一个」，以它为准
        res.authoritative = true;
        if (res.names.indexOf(main) < 0) res.names.push(main);
        continue;
      }
      if (!main) continue;
      if (normTextZ(main) === qn0) { res.exact = true; continue; }
      /* 别名只能是「跨文字体系的另一种写法」，不能是「名字里多一个字」。

         ⚠️ 踩过两次：搜「赵薇」，QQ 的歌手接口按分词返回
            「赵薇风」(75 首) /「赵薇琳」(0 首) /「赵雪薇」/「赵紫薇」。
            旧判据「LCS ≥ 2 字」把它们全收进别名表，
            紧接着 pickEffectiveName 拿「赵薇风」去酷狗一验 —— 真有这位，
            于是整个查询被改写成「赵薇风」，歌手页只剩她和 0 首的赵薇琳。
            用户看到的就是「搜赵薇出来两个陌生人」。

            真别名长什么样：L'Arc〜en〜Ciel ↔ 彩虹乐队（拉丁↔中文）、
            IGU Band ↔ 那我懂你意思了。都是**换了一套文字**，
            不是「原名再添一个字」。中文名多一个字就是另一个人。 */
      const mainIsCJK = /^[\u4e00-\u9fff]+$/.test(main);
      const queryIsCJK = /^[\u4e00-\u9fff]+$/.test(q);
      if (mainIsCJK && queryIsCJK) continue;   // 纯中文之间只认全等（上面已处理）
      if (lcsLen(q, main) >= 2 && res.names.indexOf(main) < 0) res.names.push(main);
    }
  } catch (e) { /* 拿不到就交出空结果 */ }
  if (res.authoritative) ALIAS_AUTH[qn0] = res.names.slice();
  return res;
}

/* ============================================================
 * 第三路：Apple Music 的**歌手身份桥**
 *
 * QQ 的括号译名只覆盖「中文译名 ↔ 原名」，而且它经常根本没有这个歌手
 * （QQ 搜「那我懂你意思了」直接返回 0 条，搜「IGU Band」返回一堆非洲乐队）。
 * Apple 侧有另一条更硬的路：**artistId 是跨语言、跨商店的唯一身份**。
 *
 *   搜艺人「IGU Band」→ 专辑结果归到 artistId=798583449
 *   → 拿这个 id 去 hk / tw / us / jp 四个商店 lookup
 *   → 四个区回来的 artistName 都是「那我懂你意思了」
 *   英文名 ↔ 中文名就这么对上了。
 *
 * 实测（2026-10-18）：
 *   IGU Band          → 那我懂你意思了
 *   彩虹乐队           → L'Arc-en-Ciel
 *   米津玄师           → 米津玄師 / Kenshi Yonezu
 *   落日飞车           → 落日飛車 / Sunset Rollercoaster
 *   Yura Yura Teikoku → ゆらゆら帝国
 *
 * ⚠️ 必须防误判，否则「搜歌名」会变成「搜歌手」，整页结果全跑偏：
 *   ① 歌曲结果里标题含查询词的比例过半 → 这词是歌名，直接放弃
 *        晴天 12/12   稻香 11/12   起风了 12/12   夜曲 8/11
 *   ② 专辑结果必须集中在同一个 artistId（≥2 张且占结果 25% 以上）
 *        搜「后来」，10 张专辑分给 7 个歌手 → 不认
 *   ③ 该 artistId 得和「艺人实体搜索」的第一名对得上，或者它的名字本身
 *      包含查询词 —— 两条都不满足就不认
 *        「草东」→ 专辑第一名是 Dear Jane，对不上 → 放弃
 * ⚠️ 全部并发、各自带超时，最慢的一步也算在「反查总预算」里，
 *    不会因为 Apple 抽风拖慢搜索。
 * ============================================================ */
const APPLE_BRIDGE_OK = {};

async function appleArtistAliases(query) {
  const q = String(query || "").trim();
  if (!q) return [];
  const ck = cacheGet("aliasApple", q, "");
  if (ck) return ck;
  const qn = normTextZ(q);
  const names = [];
  try {
    const albP = itunesGet("/search", { term: q, entity: "album", limit: 10, country: "hk" }, 3000);
    const artP = itunesGet("/search", { term: q, entity: "musicArtist", limit: 3, country: "hk" }, 3000);
    const songP = itunesGet("/search", { term: q, entity: "song", limit: 12, country: "hk" }, 3000);
    const [alb, art, sg] = await Promise.all([albP, artP, songP]);
    const albums = (alb && alb.results) || [];
    const songs = (sg && sg.results) || [];
    const arts = (art && art.results) || [];

    /* ① 歌名否决：搜索结果里标题几乎都写着查询词 → 这是首歌，不是人 */
    let titleHit = 0;
    for (let i = 0; i < songs.length; i++) {
      if (normTextZ(songs[i].trackName).indexOf(qn) >= 0) titleHit++;
    }
    if (songs.length >= 3 && titleHit * 2 >= songs.length) {
      cachePut("aliasApple", q, "", names);
      return names;
    }

    /* ② 专辑按 artistId 归并，挑出压倒性的那一位 */
    const byId = {};
    for (let i = 0; i < albums.length; i++) {
      const id = albums[i].artistId;
      if (!id) continue;
      const k = String(id);
      if (!byId[k]) byId[k] = { name: String(albums[i].artistName || ""), n: 0 };
      byId[k].n++;
    }
    const ids = Object.keys(byId);
    ids.sort((a, b) => byId[b].n - byId[a].n);
    const domId = ids[0] || "";
    const domN = domId ? byId[domId].n : 0;
    const share = albums.length ? domN / albums.length : 0;

    const artId = arts[0] && arts[0].artistId ? String(arts[0].artistId) : "";
    const artName = (arts[0] && arts[0].artistName) || "";

    /* ③ 证据分档，强到弱。**完全同名永远排第一**。

       ⚠️ 踩过的大坑（搜「赵薇」）：
         专辑结果 10 条里 8 条属于「趙薇薇」—— 一位抖音翻唱歌手，
         名字只比「赵薇」多一个字，459 首作品；赵薇本人只有 1 张
         《天使旅行箱》。旧逻辑第一条判据是「专辑数量压倒性 + 名字含查询词」，
         「趙薇薇」两条全中（含「赵薇」），于是把它当成赵薇的正式身份，
         反查结果被改写成「赵薇薇」—— 歌手页只剩那个翻唱号，
         专辑页全是《断送青春爱错人》《别让爱凋落》这种。
         可艺人实体搜索的第一条恰好就是「趙薇」，一字不差。
         名字完全一致这个证据，比「谁专辑多」硬得多 —— 名字多一个字
         就是另一个人，不是同一个人。 */
    let exactArt = null;
    for (let i = 0; i < arts.length; i++) {
      if (arts[i].artistId && normTextZ(arts[i].artistName) === qn) {
        exactArt = arts[i];
        break;
      }
    }

    /* ⚠️ 下面两处判据原来是 `name.indexOf(qn) >= 0`（包含即通过）。
       跟 isArtistQuery 同一个毛病：搜「李志」时 Apple 那边专辑最多的
       是「李志辉」（佛教音乐，264 首），名字含「李志」→ 被当成李志的
       正式身份，反查出来的名字全指向他。改成跟排序层同一套判据 ——
       要么是同一写法的变体（oneNameEq），要么是换了文字体系的译名。 */
    const samePerson = (nm) => {
      if (!nm) return false;
      if (oneNameEq(nm, qn)) return true;
      return isPureCJK(nm) !== isPureCJK(q);
    };
    let pickId = "";
    if (exactArt) {
      pickId = String(exactArt.artistId);   // 艺人实体跟查询词完全同名 → 本尊
    } else if (domId && domN >= 2 && share >= 0.25 && (domId === artId || samePerson(byId[domId].name))) {
      pickId = domId;                       // 专辑压倒性 + 艺人实体对得上
    } else if (artId && artName && samePerson(artName)) {
      pickId = artId;                       // 艺人实体自己就跟查询词是同一个人
    } else if (domId && domN >= 2 && share >= 0.8) {
      pickId = domId;                       // 专辑几乎全归一个人
    }
    if (!pickId) {
      cachePut("aliasApple", q, "", names);
      return names;
    }

    /* ④ 拿 artistId 去四个商店取本地化名字 —— 这一步才是「翻译」的来源 */
    const ccs = ["hk", "tw", "us", "jp"];
    const lookups = await Promise.all(ccs.map((cc) =>
      itunesGet("/lookup", { id: pickId, entity: "album", limit: 3, country: cc }, 3000).catch(() => null)
    ));
    for (let i = 0; i < lookups.length; i++) {
      const rs = (lookups[i] && lookups[i].results) || [];
      for (let j = 0; j < rs.length; j++) {
        if (rs[j].wrapperType !== "artist") continue;
        const n = String(rs[j].artistName || "").trim();
        if (!n) continue;
        if (normTextZ(n) === qn) continue;                    // 跟查询词同名，没信息量
        if (names.indexOf(n) >= 0) continue;
        names.push(n);
      }
    }
    /* 桥接成功 = 至少拿到一个跟查询词不同的名字，这个 id 就是权威身份。
       记到 ALIAS_AUTH 里，让 searchArtist / searchAlbum 优先用它。 */
    if (names.length && !ALIAS_AUTH[qn]) {
      ALIAS_AUTH[qn] = names.slice();
      APPLE_BRIDGE_OK[qn] = 1;
    }
  } catch (e) { /* 拿不到就当没有，主流程不受影响 */ }
  cachePut("aliasApple", q, "", names);
  return names;
}

async function neteaseArtistAliases(query, qqPre) {
  const q = String(query || "").trim();
  if (!q) return [];
  const ck = cacheGet("alias", q, "");
  if (ck) return ck;
  const out = [];    // 网易云那一路的原始产出
  /* ⚠️ 网易云那两发请求和 QQ 那一路**并发**跑。
     以前是串行的，等于白等 2 秒 —— 两边互不依赖。 */
  const qqP = qqPre ? Promise.resolve(qqPre) : qqArtistProbe(q).catch(() => ({ names: [], authoritative: false, exact: false }));
  /* Apple 那一路也一起发出去。它是唯一能覆盖「英文名 ↔ 中文名」的源
     （QQ 搜「那我懂你意思了」直接空手，「IGU Band」又给一堆无关乐队）。
     ⚠️ 一定并发、不能 await 在这里 —— 三条反查互不依赖，
        串起来就是白等 3~5 秒。 */
  const appleP = appleArtistAliases(q).catch(() => []);
  try {
    // ⚠️ 用 POST 打 /api/cloudsearch/pc，不要用 GET /api/search/get/web。
    //    实测 2026-10-18：GET 版连续请求几次就返回
    //    {"code":405,"msg":"操作频繁，请稍候再试"}，之后整段反查全废；
    //    同一时间 POST 版照常返回 200，且字段完全一样。
    /* ⚠️ 这两发（歌手 type=100 / 歌曲 type=1）原来是一前一后 await 的，
       每次都要 300~500ms，串起来就是白白多等一倍。
       它们互不依赖，现在一起发出去再一起等 —— 反查这条路实测从
       0.9~1.4s 降到 0.5~0.7s。 */
    const artsP = axios_1.post(
      "https://music.163.com/api/cloudsearch/pc",
      "s=" + encodeURIComponent(q) + "&type=100&limit=6&offset=0",
      {
        timeout: 12000,
        headers: Object.assign({}, NETEASE_HEADERS, {
          "Content-Type": "application/x-www-form-urlencoded",
        }),
        validateStatus: () => true,
      }
    ).catch(function () { return { data: null }; });
    /* 置信度不再只看「跟查询词有几个字重合」。
       ⚠️ 踩过的坑：搜「彩虹乐队」，网易云歌手搜索第一条是 Rainbow
          （跟查询词一个字都不重合，直接跳过），第二条却是「人造彩虹乐队」
          —— 它跟查询词连续重合 4 个字，按「重合 ≥2」的规则会被判成答案，
          于是拿一个野鸡乐队的名字去搜 B 站。
       真正能证明「这串词指的是这位歌手」的信号在**歌曲搜索**里：
       谁在结果里占压倒性多数。实测
         摇晃帝国 → ゆらゆら帝国 11/20（55%）  ← 是乐队译名
         晴天     → 最多 2/20（10%）          ← 是歌名
         起风了   → 最多 3/20（15%）          ← 是歌名
       所以先看歌曲结果里的占比，认出来之后再去歌手结果里取同名条目的
       name / alias / transNames（译名、假名、罗马音都在里面）。 */
    const sres = await axios_1.post(
      "https://music.163.com/api/cloudsearch/pc",
      "s=" + encodeURIComponent(q) + "&type=1&limit=20&offset=0",
      {
        timeout: 12000,
        headers: Object.assign({}, NETEASE_HEADERS, {
          "Content-Type": "application/x-www-form-urlencoded",
        }),
        validateStatus: () => true,
      }
    );
    const r = await artsP;
    const arts = (r && r.data && r.data.result && r.data.result.artists) || [];
    const songs = (sres && sres.data && sres.data.result && sres.data.result.songs) || [];
    const cnt = {};
    /* ⚠️ cloudsearch 版的字段名跟 /api/search/get 不一样：
       歌手在 `ar` 里（还有 `tns` = 译名），不是 `artists`。
       按 artists 取值会一路拿到空对象，反查永远返回空数组 ——
       表面上不报错，功能却整条失效。两个都读一遍。 */
    const songArs = {};
    for (let i = 0; i < songs.length; i++) {
      const ars = songs[i].ar || songs[i].artists || [];
      for (let j = 0; j < ars.length; j++) {
        const nm = String(ars[j].name || "");
        if (!nm) continue;
        cnt[nm] = (cnt[nm] || 0) + 1;
        if (!songArs[nm]) songArs[nm] = ars[j];
      }
    }
    const ranked = Object.keys(cnt).sort((x, y) => cnt[y] - cnt[x]);
    const topName = ranked[0] || "";
    const topCnt = topName ? cnt[topName] : 0;
    /* 再卡一道「这串词是不是本来就是歌名」。
       ⚠️ 只靠歌手占比不够：搜《海阔天空》，结果 18/20 的标题里都写着
          「海阔天空」，其中 Beyond 占的份额也可能过线 ——
          一旦解析成 Beyond，B 站就会拿歌手名去搜，
          结果变成 Beyond 全部作品，用户要的那首歌被淹掉。
       判据：**标题里含查询词的比例**。
         海阔天空 18/20（90%） 晴天 16/20（80%） 起风了 20/20
         摇晃帝国  0/20        周杰伦 0/20        米津玄师 0/20
       过一半就当歌名查询，不做反查。 */
    let titleHit = 0;
    const qn = normTextZ(q);
    for (let i = 0; i < songs.length; i++) {
      if (normTextZ(String(songs[i].name || "")).indexOf(qn) >= 0) titleHit++;
    }
    const looksLikeSong = songs.length > 0 && titleHit * 2 >= songs.length;
    /* ⚠️ 再加一道身份闸（实测 2026-10-21 搜「李志」）：
       「谁占多数」这条推断会把**别人的名字**带进来。搜李志时
       网易云曲库里有 14/20 条挂在「李志辉」名下（那是另一位佛教音乐
       制作人，264 首），而他本人的歌在内地被下架得只剩 1 条。
       于是 topName = 李志辉，被当成「李志的另一个名字」注册进 ARTIST_ALIAS
       —— 之后 isArtistQuery 认李志辉就是李志，李志辉的歌全拿 3 档，
       第一屏是「水墨兰亭 - 李志辉」「平遥古韵 - 李志辉」，
       李志自己的《天涯》《苏州河》反而挤不过他们。
       同一个坑搜「赵薇」也踩过（赵薇薇 459 首），当时的修法只加在
       歌手库里，这条**别名推断**路径漏掉了。

       判据跟 isArtistQuery 一致：要么本来就是同一个写法（oneNameEq 认的
       拉丁前缀/后缀那种），要么是**换了一套文字**（中文 ↔ 拉丁/假名）——
       真别名全是后者：彩虹乐队 ↔ L'Arc〜en〜Ciel、摇晃帝国 ↔ ゆらゆら帝国。
       中文名之间只认全等，「李志辉」「李志强」是另一个人。 */
    const sameIdentity = (() => {
      if (!topName) return false;
      const tn2 = normTextZ(topName);
      if (!tn2) return false;
      if (oneNameEq(topName, normTextZ(q))) return true;
      // 一边是纯中文、另一边不是 → 换文字体系的译名，认
      return isPureCJK(topName) !== isPureCJK(q);
    })();
    // 至少 3 条、且占结果的 40% 以上、且身份对得上，才认「这串词就是这位歌手」
    if (!looksLikeSong && topName && topCnt >= 3 && topCnt * 10 >= songs.length * 4 && sameIdentity) {
      const tn = normTextZ(topName);
      for (let i = 0; i < arts.length; i++) {
        const a = arts[i];
        if (normTextZ(a.name) !== tn) continue;
        const names = [a.name].concat(a.alias || [], a.transNames || [], a.alia || []);
        /* 译名藏在**曲目**的 ar.tns 里（歌手对象的 tns 是 null）。
           搜「摇晃帝国」时正是靠这里拿到「摇摆帝国」这个中文译法。 */
        const sa = songArs[topName];
        if (sa) names.push.apply(names, [].concat(sa.tns || [], sa.alias || [], sa.alia || []));
        for (let j = 0; j < names.length; j++) {
          const n = String(names[j] || "").trim();
          if (!n || normTextZ(n) === normTextZ(q)) continue;
          if (out.indexOf(n) < 0) out.push(n);
          if (out.length >= 4) break;
        }
        break;
      }
    }
  } catch (e) { /* 反查失败就当没有，不影响主流程 */ }

  /* 第二路：QQ 音乐歌手接口。
     它的译名格式是「原名 (译名)」，是一条**显式声明**：
       「L'Arc〜en〜Ciel (彩虹乐队)」= 平台自己写着这两个名字是同一个人。
     这比网易云那套「看谁在结果里占多数」的推断可靠得多 ——
     实测「彩虹乐队」，网易云推断出的却是 Rainbow（完全另一支乐队），
     QQ 的括号才是对的（中文语境下「彩虹乐队」= L'Arc〜en〜Ciel）。
     所以 QQ 一旦给出「括号里正好是查询词」的条目，就以它为准，
     网易云那一路直接弃用。

     ⚠️ 它同时会返回一堆「(xxx成员)」条目，那些是乐队成员的歌手页，
        名字里带「成员」的一律不要 —— 拿成员名去搜会把整支乐队淹掉。 */
  const qq = await qqP.catch(() => ({ names: [], authoritative: false, exact: false }));
  const qqNames = qq.names || [];
  const qqAuthoritative = !!qq.authoritative;
  const appleNames = (await appleP.catch(() => [])) || [];

  /* 合并：
     - QQ 权威 → 只用 QQ 的（网易云的推断可能是错的）
     - 否则 → Apple 的排最前（artistId 跨商店验证过，中文译名/英文名都在里面），
              然后 QQ 的，最后网易云那套推断
     最多 6 个，多了只会拖慢 B 站那几轮关键词尝试。 */
  const pool = qqAuthoritative ? qqNames : appleNames.concat(qqNames, out);
  const merged = [];
  const qn1 = normTextZ(q);
  for (let i = 0; i < pool.length; i++) {
    const n = String(pool[i] || "").trim();
    if (!n) continue;
    if (normTextZ(n) === qn1) continue;
    if (merged.indexOf(n) >= 0) continue;
    merged.push(n);
    if (merged.length >= 6) break;
  }
  cachePut("alias", q, "", merged);
  return merged;
}

/* ============================================================
 * 歌手/专辑也要认原名
 *
 * 单曲搜索早就接了「原名反查」，但**歌手页和专辑页没接** ——
 * 结果就是同一件事在两处表现不一致：
 *   搜「摇晃帝国」单曲 → 前 7 条是 ゆらゆら帝国（对）
 *   搜「摇晃帝国」歌手 → 0 条                （错，酷我/咪咕都不认这个译名）
 *   搜「摇晃帝国」专辑 → 51 条《摇晃的红酒杯》（错，全是分词噪声）
 *
 * 这里的几个小工具专门给 searchArtist / searchAlbum 用。
 * ============================================================ */


/** 候选名字：原查询在最前，后面是反查到的原名/别名。
 *
 *  ⚠️ 分两级，别一上来就问网易云：
 *     歌手页/专辑页是高频操作，每次都花 2 秒做反查、结果又没有别名，
 *     用户只会觉得「插件变慢了」。
 *     实测 QQ 一家就能覆盖绝大多数情况：
 *       彩虹乐队 → L'Arc〜en〜Ciel（括号译名，权威）
 *       周杰伦   → exact，名字本身就是本名，到此为止
 *       草东没有派对 → exact，同上
 *       摇晃帝国 → 空（QQ 没有，才需要网易云那一路补）
 *     所以先问 QQ；只有「QQ 给不出任何线索」时才升级去问网易云。 */
async function aliasCandidates(query) {
  const q = String(query || "").trim();
  const push = (arr, s) => {
    const n = String(s || "").trim();
    if (!n) return;
    const k = normTextZ(n);
    if (!k) return;
    for (let i = 0; i < arr.length; i++) if (normTextZ(arr[i]) === k) return;
    arr.push(n);
  };
  const names = [q];
  /* ⚠️ QQ 和 Apple 两家**并发**问，别串行 —— 串起来就是白等 2~4 秒，
     而歌手页/专辑页是高频操作，用户会直接感觉到「插件变慢了」。 */
  const qqP = qqArtistProbe(q).catch(() => ({ names: [], authoritative: false, exact: false }));
  const appleP = appleArtistAliases(q).catch(() => []);
  /* 整体预算 1.5 秒：到点就用手上已有的结果继续，不等 QQ。
     Apple 通常 300ms 内返回，QQ 实测稳定 5s 且多半返回空 ——
     专辑页/歌手页原本有 5 秒多都耗在等一个没有结果的请求上。 */
  const EMPTY_QQ = { names: [], authoritative: false, exact: false };
  let qq = EMPTY_QQ;
  try {
    qq = await Promise.race([
      qqP,
      new Promise((r) => setTimeout(() => r(EMPTY_QQ), 1500)),
    ]);
  } catch (e) { /* 空 */ }
  const appleNames = (await appleP.catch(() => [])) || [];
  /* QQ 说「查询词就是本名」→ 没有别名可找，直接用原查询。
     再问网易云只会白花 2 秒，还可能被它的推断带偏
     （实测搜「彩虹乐队」它推的是 Rainbow，完全另一支乐队）。 */
  if (qq.exact && !qq.authoritative) {
    return { q: q, names: names, auth: ALIAS_AUTH[normTextZ(q)] || [], cheap: true };
  }
  if (qq.authoritative) {
    for (let i = 0; i < qq.names.length; i++) push(names, qq.names[i]);
    for (let i = 0; i < appleNames.length; i++) push(names, appleNames[i]);
    return { q: q, names: names.slice(0, 6), auth: ALIAS_AUTH[normTextZ(q)] || [], cheap: true };
  }
  /* Apple 桥接成功 → 身份已经被 artistId 跨四个商店确认过，
     不必再花 2 秒问网易云（它给的「推断」还可能把话带偏）。
     ⚠️ 这条判断放在 QQ 之后：QQ 的括号译名是平台显式声明，优先级最高。 */
  if (appleNames.length) {
    for (let i = 0; i < appleNames.length; i++) push(names, appleNames[i]);
    for (let i = 0; i < qq.names.length; i++) push(names, qq.names[i]);
    return { q: q, names: names.slice(0, 6), auth: ALIAS_AUTH[normTextZ(q)] || [], cheap: true };
  }
  /* QQ / Apple 都没线索 → 才动用网易云那条慢路径（拿假名/罗马音/译名）。
     这条要额外花 2 秒左右，而它只在「查询词本身是个外文歌手/乐队名」时才有价值。
     实测「范特西」（专辑名）走这条路要白等 2 秒、拿到空结果。
     所以这里不再无条件走：只有整串可能是人名时才问，否则直接收工。 */
  if (!looksLikeArtistName(q)) {
    return { q: q, names: names.slice(0, 6), auth: ALIAS_AUTH[normTextZ(q)] || [], cheap: true };
  }
  const al = await neteaseArtistAliases(q, qq).catch(() => []);
  for (let i = 0; i < (al || []).length; i++) push(names, al[i]);
  return { q: q, names: names.slice(0, 6), auth: ALIAS_AUTH[normTextZ(q)] || [], cheap: false };
}

/** 粗略判断「这串像不像歌手/乐队名」。
 *  目的只是挡掉「拿专辑名去查歌手别名」这种必然落空的慢请求。
 *
 *  ⚠️ 第一版按「含 的/有/是 就当歌名」来判，直接误杀两个真乐队：
 *      「草東沒有派對」「那我懂你意思了」—— 中文乐队名本来就爱用虚词。
 *     所以这里**不再看虚词**，只看长度和字符构成：
 *      中文 2~10 字、或外文 1~3 个词，就当可能是人名。
 *     判宽一点没坏处：最坏是多花 2 秒，判窄了会漏掉真乐队的译名。 */
function looksLikeArtistName(q) {
  const s = String(q || "").trim();
  if (!s || s.length > 20) return false;
  // 太长的肯定是歌名/专辑名
  if (/^[\u4e00-\u9fff]{2,10}$/.test(s)) return true;
  // 外文：1~3 个词
  if (/^[A-Za-z][A-Za-z0-9 '\-.&]*$/.test(s)) {
    return s.split(/\s+/).filter(Boolean).length <= 3 && s.length <= 22;
  }
  return false;
}

/** 这条结果的歌手名，是不是「查询词或它的别名」之一。
 *  ⚠️ 只认「包含」，不认反向包含 —— 搜「摇晃帝国」时
 *     不能因为「たまゆら帝国」里有「帝国」就放进来。 */
function nameMatchesAny(name, names) {
  const n = flatTitle(name);
  if (!n) return false;
  for (let i = 0; i < (names || []).length; i++) {
    const t = flatTitle(names[i]);
    if (t && n.indexOf(t) >= 0) return true;
  }
  return false;
}

/** 歌手条目排序（**统一入口**，有别名和没别名都走这里）。
 *
 *  用户的要求（2026-10-21）：
 *    「按顺序排，两个字在前三个字在后都是可以理解的，参考 LX Music，
 *      他就是短的在前长的在后。」
 *
 *  所以档位分明之后，**同一档里名字短的排前面**，长名 / 带前后缀的往后站。
 *  原来那版是加减分制（完全匹配 +100、多一个字 -2、酷我再 +5），
 *  分差太小 —— 实测搜「彩虹乐队」，YouTube 的「L'Arc-en-Ciel」(13 字)
 *  排在「彩虹乐队」(4 字) 前面；搜「GEM」，5 字的「宝石Gem」排在
 *  4 字的「Gem浩」前面。加减分怎么调都会在别处翻车，
 *  干脆把「长度」提成独立的比较键。
 *
 *  档位（越大越前）：
 *    4  权威原名 —— QQ 括号译名声明过的本名（彩虹乐队 → L'Arc-en-Ciel）
 *    3  名字跟查询词完全一样
 *    2  名字跟某个别名完全一样
 *    1  名字里**包含**查询词/别名（「mc邓丽君」「165.邓丽君」这类）
 *    0  只在作品数 / 频道名上沾边（YouTube 的「Teresa Teng 老歌精選」）
 */
function sortArtistResults(list, query, names, authNames) {
  const qz = normTextZ(query);
  const alias = (names || []).map(normTextZ).filter(Boolean);
  const auth = (authNames || []).map(normTextZ).filter(Boolean);
  if (qz && alias.indexOf(qz) < 0) alias.push(qz);

  const nameOf = (x) => normTextZ(x.name);
  const cls = (x) => {
    const nz = nameOf(x);
    if (!nz) return 0;
    /* 权威原名只在「换了一套写法」时才算最高档：
       彩虹乐队 → L'Arc-en-Ciel（跟查询词毫无重叠，不顶上来用户认不出）
       ⚠️ 但「邓紫棋 → G.E.M.邓紫棋」这种只是**在原名前加了拉丁前缀**，
          它跟查询词是包含关系 —— 当成「包含」档处理，让长度说话，
          否则用户会看到长的排前面，跟「短的在前」正好相反。 */
    for (let i = 0; i < auth.length; i++) {
      if (nz === auth[i] && !(qz && (nz.indexOf(qz) >= 0 || qz.indexOf(nz) >= 0))) return 4;
    }
    if (nz === qz) return 3;
    for (let i = 0; i < alias.length; i++) if (nz === alias[i] && !qz) return 2;
    for (let i = 0; i < alias.length; i++) {
      if (alias[i] && nz.indexOf(alias[i]) >= 0) return 1;
    }
    return 0;
  };
  /* 长度用归一化后的名字：括号里的补充说明不算长度
     （「冯沁苑(买辣椒也用券)」按 3 个字算，跟「冯沁苑」一样长）。 */
  return list.map((x) => ({ x: x, c: cls(x), L: nameOf(x).length }))
    .sort((a, b) => {
      if (a.c !== b.c) return b.c - a.c;      // ① 匹配档位
      if (a.L !== b.L) return a.L - b.L;      // ② 同档里短的在前（用户要的）
      // ③ 并列时的细排：官方号 > 酷我（字段最全）> 作品多的
      const oa = a.x._official ? 1 : 0, ob = b.x._official ? 1 : 0;
      if (oa !== ob) return ob - oa;
      const pa = a.x.platform === "酷我" ? 1 : 0, pb = b.x.platform === "酷我" ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return Number(b.x.worksNum || 0) - Number(a.x.worksNum || 0);
    }).map((y) => y.x);
}

/** 决定「真正要拿去搜的名字」。
 *
 *  原查询本身就是歌手 → 用原查询（一个字都不改）。
 *  原查询平台不认（摇晃帝国 / 彩虹乐队），但某个别名认得出歌手
 *  → 换成那个别名去搜，否则歌手页/专辑页永远是空的或被山寨号占满。
 *
 *  ⚠️ 必须是「串行 + 命中即停」，不能对所有候选名 Promise.all 一起查：
 *     每个候选名的判定要打两次酷狗（歌手搜索 + 专辑总数），
 *     五个候选一起并发就是十次请求，用户要等 4 秒以上。
 *     实际上第一个能对上的就够用了，后面根本不用问。
 *     detectSingerQuery 自带缓存，searchAlbum 再问一次是免费命中。 */
async function pickEffectiveName(query, aliasP) {
  const q = String(query || "").trim();
  const cands = ((await aliasP) || {});
  const names = cands.names || [q];
  if (names.length <= 1) return { name: q, via: "", names: names, auth: cands.auth || [] };
  const auth = (cands.auth || []).map(normTextZ);
  // 原查询自己就是歌手 → 一个字都不换
  if (await detectSingerQuery(q).catch(() => null)) {
    return { name: q, via: q, names: names, auth: cands.auth || [] };
  }
  /* 权威原名（QQ 的括号译名）优先，它是平台显式声明的同一个身份，
     不必再花两次酷狗请求去验证。 */
  for (let i = 0; i < names.length; i++) {
    if (auth.indexOf(normTextZ(names[i])) < 0) continue;
    return { name: names[i], via: names[i], names: names, auth: cands.auth || [] };
  }
  // 其余别名按顺序试，命中即停
  for (let i = 1; i < names.length; i++) {
    if (await detectSingerQuery(names[i]).catch(() => null)) {
      return { name: names[i], via: names[i], names: names, auth: cands.auth || [] };
    }
  }
  return { name: q, via: "", names: names, auth: cands.auth || [] };
}

function normText(s) {
  return String(s || "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[《》「」【】\[\]]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}
function titleMatch(a, b) {
  const x = normText(a), y = normText(b);
  if (!x || !y) return false;
  return x.indexOf(y) >= 0 || y.indexOf(x) >= 0;
}

/* ============================================================
 * 权威音乐目录 —— 用 Apple Music 的曲库框定「正式发行版」
 *
 * 思路（用户提的）：先用权威库查出「这个歌手的正式作品有哪些」，
 * 再拿这个结果去校正各大平台的搜索结果，而不是反过来。
 *
 * 实测数据（2026-10-17）：
 *   周杰伦        专辑 48 张 / 43ms      歌曲 200 首 / 1638ms
 *   草东没有派对   歌曲 24 首
 *   落日飞车      以 Sunset Rollercoaster 收录，69 首
 *   那我懂你意思了 iTunes 里**没有** —— 搜歌手返回魏如萱/王力宏（完全错配）
 *
 * 所以设计上：
 *   1. **只加分，绝不过滤**。冷门歌手在权威库里查不到时静默跳过，
 *      不能因为「查不到」就删用户的歌 —— 那正是他用这个插件的原因。
 *   2. 歌手名必须做简繁归一后再比对。iTunes 返回「周杰倫」，
 *      查询词是「周杰伦」，字符码 502b vs 4f26，不转就永远匹配不上。
 *   3. 全程 1.5 秒超时。搜索本身才 1.3 秒，不能为了排序把它拖垮。
 * ============================================================ */
const ITUNES_TIMEOUT = 1500;

/** 带超时的 GET，超时或被墙都返回 null（绝不会让搜索卡住）
 *  ⚠️ 超时时间可以单独覆盖：lookup 拉整份歌手目录（limit=200）实测要 3 秒，
 *     沿用 1.5 秒会**静默返回空** —— 陈奕迅 112 张专辑 0 首就是这么来的，
 *     结果硬删把 100 多条真歌全删光。 */
function itunesGet(path, params, timeoutMs) {
  const TO = Number(timeoutMs || ITUNES_TIMEOUT);
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, TO);
    axios_1.get("https://itunes.apple.com" + path, {
      params: params,
      timeout: TO,
      validateStatus: () => true,
      headers: { "User-Agent": UA },
    }).then((r) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve(r && r.data ? r.data : null);
    }).catch(() => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve(null);
    });
  });
}

/* 缓存：同一首歌反复搜不该每次都打 iTunes */
const AUTH_CACHE = {};
const AUTH_CACHE_TTL = 30 * 60 * 1000;

/* ============================================================
 * iTunes 的**地区节点**（踩过的大坑）
 *
 * 之前固定写 country:"cn"，结果整个「权威目录」层是空转的 ——
 * cn 节点对中文查询**一律返回 0 条**，实测 2026-10-17：
 *   「晴天」  cn=0   hk=5（40ms）  tw=5  jp=5
 *   「范特西」cn=0   hk=5（35ms）  tw=5  jp=5
 *   「起风了」cn=0   hk=5           tw=5
 * 换句话说：所有 _auth 分永远是 0，原唱/翻唱根本没被区分过。
 *
 * 改用 hk 优先（华语曲库最全 + 响应最快），没结果再退 tw。
 * ============================================================ */
const ITUNES_COUNTRIES = ["hk", "tw"];

/** 依次试各地区节点，第一个有结果的就返回 */
async function itunesSearchAny(path, params) {
  for (let i = 0; i < ITUNES_COUNTRIES.length; i++) {
    const p = Object.assign({}, params, { country: ITUNES_COUNTRIES[i] });
    const r = await itunesGet(path, p);
    if (r && ((r.results || []).length)) return r;
  }
  return null;
}

/* ============================================================
 * Apple Music 的**歌手完整目录**（专辑 + 全部曲目）
 *
 * 解决的问题（实测 2026-10-18）：搜「那我懂你意思了」，
 *   酷狗的歌手搜索接口直接返回 data:null（这个乐团根本没被收进去），
 *   于是 detectSingerQuery 判定不出来 → 走通用专辑排序，
 *   结果头部全是**冒用同名艺名**的网络歌手：
 *     《那年夏天》《金秋的足迹》《凤囚凰》《梦灯笼引路》《西湖四点未眠》
 *   这跟那个独立乐团一点关系都没有。
 *
 *   而 Apple Music 里它有完整目录：
 *     《原諒我不明白你的悲傷》9 首 / 《沒有人在乎你在乎的事》13 首 / 《沒有的, 啊!?》8 首
 *   用它当权威白名单，就能把真歌认出来、把同名山寨条目压下去。
 *
 * ⚠️ 只作为加分/降权依据，**绝不硬删** —— 冷门歌在别的平台可能更多。
 * ============================================================ */
const APPLE_CAT_CACHE = {};
const APPLE_CAT_TTL = 60 * 60 * 1000;

/**
 * 用 Apple 目录给单条结果打分（歌手名查询专用）。
 *   +45 这首就在他的正式曲目表里（歌名完全一致）
 *   +30 这张专辑就是他的正式专辑
 *   -60 他在这位歌手目录里**查无此曲、也查无此专辑** → 极可能是同名冒名
 *    0 目录里没有这个人（查不到）→ 中性，不动
 */
function appleCatScore(item, cat) {
  if (!cat) return 0;
  const titleN = normTextZ(item.title);
  const albumN = normAlbumName(item.album || "");
  let trackHit = false;
  if (titleN) {
    if (cat.trackSet[titleN]) trackHit = true;
    else {
      // 标题常带 (Live) / - Topic / MV 之类，核心名对上也认
      const core = normTextZ(coreTitle(item.title));
      if (core && cat.trackSet[core]) trackHit = true;
      else if (core) {
        const keys = Object.keys(cat.trackSet);
        for (let i = 0; i < keys.length; i++) {
          if (keys[i].indexOf(core) >= 0 || core.indexOf(keys[i]) >= 0) { trackHit = true; break; }
        }
      }
    }
  }
  let albumHit = false;
  if (albumN) {
    if (cat.albumSet[albumN]) albumHit = true;
    else {
      const keys = Object.keys(cat.albumSet);
      for (let i = 0; i < keys.length; i++) {
        if (keys[i].indexOf(albumN) >= 0 || albumN.indexOf(keys[i]) >= 0) { albumHit = true; break; }
      }
    }
  }
  if (trackHit) return 45;
  if (albumHit) return 30;
  /* ⚠️ YTM 目录即使 complete 也只能轻压，绝不能 -60 ——
     实测李志：YTM 有 110 首，但《关于郑州的记忆》《他们》《广场》
     这些敏感曲目平台上根本没有官方音轨，目录里也就没有。
     拿它当「完整白名单」重罚，YouTube 上那些真歌会被一起打死。
     Apple 那边不一样：Apple 缺歌多半是真没有，罚得重才安全。 */
  if (cat._src === "ytm") return cat.albums.length >= 3 ? -20 : 0;
  /* 两边都没命中 —— 只有目录**确实完整**时才敢降权，
     否则碰上 Apple 里只有一张单曲的小众艺人、或者被截断的大歌手，
     会大面积误伤真歌。 */
  if (cat.complete) return -60;
  if (cat.albums.length >= 3) return -20;   // 目录不全，只轻压不重罚
  return 0;
}

/** 一次 lookup 拉全（limit 上限实测 200 条，超过不生效）
 *  超时给足 5 秒 —— 陈奕迅这种目录实测要 3 秒才不会空手而归。 */
async function itunesLookupAll(artistId, entity, country) {
  const r = await itunesGet("/lookup", {
    id: artistId, entity: entity, country: country, limit: 200,
  }, 5000);
  return (r && r.results) || [];
}

/**
 * 查「这个名字对应 Apple Music 里的哪位歌手，他有哪些专辑和歌」。
 * 返回 { id, name, albums: [...], tracks: [...] } 或 null。
 */
async function appleArtistCatalog(name) {
  const q = String(name || "").trim();
  if (!q || q.length > 40) return null;
  const ck = "cat:" + normTextZ(q);
  const hit = APPLE_CAT_CACHE[ck];
  if (hit && Date.now() - hit.at < APPLE_CAT_TTL) return hit.v;

  const qn = singerNorm(q);
  let result = null;
  try {
    /* 先确认这条查询词**就是一位歌手**。
       不确认的话，搜歌名《晴天》会命中某个叫「晴天」的野鸡歌手，
       然后拿他的目录去否定所有正经结果。 */
    const ares = await itunesSearchAny("/search", {
      term: q, entity: "musicArtist", limit: 5,
    });
    const artists = ((ares && ares.results) || []).filter((x) => x.wrapperType === "artist");
    let picked = null;
    for (let i = 0; i < artists.length; i++) {
      const an = singerNorm(toSimplified(artists[i].artistName || ""));
      if (!an) continue;
      /* 名字要**对得上**：
         A. 完全一致 —— 那我懂你意思了 = 那我懂你意思了
         B. 查询词是它的结尾、前缀全是拉丁字符 ——
            落日飞车 →「Sunset Rollercoaster」（这条走不通，前缀纯拉丁但整串不同）
            IGU Band →「那我懂你意思了」（反向：iTunes 给的名字是中文）
         所以 B 也允许反过来：iTunes 名字被查询词包含，或查询词被它包含。 */
      /* ⚠️ 这里也是「包含即通过」，同一类误伤：搜「李志」时 iTunes 能搜到
         「李志辉」，名字含「李志」就被当成他，整份 Apple 目录全指向别人。
         跟排序层统一用 oneNameEq（全等 / 拉丁前缀 / 拉丁后缀），
         剩下的「一个字都不重合的中英文对照」由下面的按歌搜兜底。 */
      if (oneNameEq(an, qn)) { picked = artists[i]; break; }
    }
    /* 兜底：搜歌手没匹配上，就**按歌搜**再反查。
       实测「IGU Band」——iTunes 的歌手搜索能给出「那我懂你意思了」
       但名字跟查询词一个字都不重合（这是同一个乐团的中英文名），
       上面那条名字匹配规则必然放过。可它的**歌曲**搜索里
       25 条结果全是同一个 artistName，那就是答案。 */
    if (!picked) {
      const sres = await itunesSearchAny("/search", {
        term: q, entity: "song", limit: 25,
      });
      const cnt = {};
      const byName = {};
      ((sres && sres.results) || []).forEach((x) => {
        if (x.wrapperType !== "track") return;
        const an = String(x.artistName || "");
        if (!an) return;
        cnt[an] = (cnt[an] || 0) + 1;
        byName[an] = x;
      });
      const ranked = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]);

      /* ⚠️ 反查会有假阳性：搜**专辑名**「范特西」，25 条里的歌手
         压倒性全是周杰倫（22 条），照这条规则就会认定「范特西是歌手」，
         然后把它整个 40 张专辑目录倒给用户 —— 首条变成《太陽之子》。
         可用户要的是《范特西》这张唱片。

         判据：查询词出现在 **trackName** 里 → 歌名查询；
                        出现在 **collectionName** 里 → 专辑名查询；
                        两边都不出现，歌手名全一样 → 才是歌手查询。
         实测：范特西 歌名0/专辑24；晴天 歌名24/专辑4；
               那我懂你意思了 0/0；周杰伦 0/0；IGU Band 0/0。 */
      const allRes = ((sres && sres.results) || []);
      let titleHit = 0;
      let albumHit = 0;
      for (let i = 0; i < allRes.length; i++) {
        const x = allRes[i];
        if (x.wrapperType !== "track") continue;
        if (String(x.trackName || "").indexOf(q) >= 0) titleHit++;
        if (String(x.collectionName || "").indexOf(q) >= 0) albumHit++;
      }
      const looksLikeTitleOrAlbum = (titleHit + albumHit) >= 5;

      /* 要**压倒性**才认：第一名至少 8 条，且要占结果的一半以上。
         否则「海阔天空」这种歌名会把一堆不同歌手都搜出来。 */
      if (!looksLikeTitleOrAlbum && ranked.length && cnt[ranked[0]] >= 8 && cnt[ranked[0]] * 2 >= allRes.length) {
        const an = ranked[0];
        const x = byName[an] || {};
        if (x.artistId) picked = { artistId: x.artistId, artistName: an, wrapperType: "artist" };
      }
    }

    if (picked) {
      const id = picked.artistId;
      // 专辑和曲目并发拉，省一半时间
      const [albumRes, songRes] = await Promise.all([
        itunesLookupAll(id, "album", ITUNES_COUNTRIES[0]),
        itunesLookupAll(id, "song", ITUNES_COUNTRIES[0]),
      ]);
      const albums = [];
      const albumSeen = {};
      const tracks = [];
      const trackSeen = {};
      for (let i = 0; i < albumRes.length; i++) {
        const x = albumRes[i];
        if (x.wrapperType !== "collection") continue;
        const nm = String(x.collectionName || "");
        const k = normAlbumName(nm);
        if (!k || albumSeen[k]) continue;
        albumSeen[k] = 1;
        albums.push({
          title: nm,
          artist: String(x.artistName || ""),
          worksNum: Number(x.trackCount || 0),
          date: String(x.releaseDate || "").slice(0, 10),
          artwork: String(x.artworkUrl100 || "").replace("100x100", "600x600"),
        });
      }
      for (let i = 0; i < songRes.length; i++) {
        const x = songRes[i];
        if (x.wrapperType !== "track") continue;
        const nm = String(x.trackName || "");
        const k = normTextZ(nm);
        if (!k || trackSeen[k]) continue;
        trackSeen[k] = 1;
        tracks.push({
          title: nm,
          album: String(x.collectionName || ""),
          // 时长留着给 YouTube 匹配用：秒数和官方录音室版对得上才敢认
          dur: Number(x.trackTimeMillis || 0),
          no: Number(x.trackNumber || 0),
        });
      }
      /* 一个没有任何专辑的条目不值得信任 ——
         Apple 里 0 张专辑说明那只是个 guest 挂名，拿它当权威会误伤。 */
      if (albums.length) {
        /* 目录是否**完整**：lookup 一次最多给 200 条（专辑 + 曲目各算各的），
           拿到 200 说明被截断了 —— 陈奕迅这种必然截断。
           截断的目录只能用来加分，绝不能拿来硬删（见下面的 safety 判断）。 */
        const truncated = songRes.length >= 200;
        result = {
          id: id,
          name: String(picked.artistName || ""),
          albums: albums,
          tracks: tracks,
          trackSet: trackSeen,
          albumSet: albumSeen,
          truncated: truncated,
          /* full = 这份目录**没被截断**，也就是这位歌手的全部唱片。
             拿它「照着目录补歌 / 列专辑」是安全的。
             ⚠️ 它跟 complete 不是一回事：complete 还要求 ≥15 首，
                那是给「硬删同名冒名」用的高门槛 ——
                而只有十几首的独立乐团永远过不了，偏偏它最需要
                拿 Apple 当骨架（平台库里根本没有这个团）。
             实测「脆弱少女組」Apple 只有 13 首，complete=false，
             于是专辑页继续被酷狗的同名野鸡单曲占着。 */
          full: !truncated,
          // 体积够不够当「硬删白名单」用
          complete: !truncated && tracks.length >= 15,
        };
      }
    }
  } catch (e) { /* 静默，退化成没有权威目录 */ }

  APPLE_CAT_CACHE[ck] = { at: Date.now(), v: result };
  return result;
}

/* ============================================================
 * Apple 目录歌手 → 曲目/专辑列表（getArtistWorks 用）
 *
 * 什么时候用：平台库里**根本没有这个人**，或者查到的是同名冒名者。
 *
 * 实测「那我懂你意思了」（2026-10-18）：
 *   酷狗把名字指给了 singerid=21522043 的冒名歌手 ——
 *   名下只有《凤囚凰》《夏日的风》2 首单曲，专辑各 1 首；
 *   真乐团（3 张正规专辑 31 首）在酷狗库里压根不存在。
 *   结果：歌手页只显示 2 首，用户以为源坏了。
 *
 * 而 Apple 香港节点有完整目录，拿它当骨架才是对的。
 * 曲目本身没有平台 id，取流走跨平台兜底（YouTube Topic 频道）。
 * ============================================================ */
const APPLE_WORKS_CACHE = {};
const APPLE_WORKS_TTL = 60 * 60 * 1000;

async function appleArtistWorks(artistId, page, type, rn) {
  const ps = rn || 30;
  const ck = "aw:" + artistId;
  const hit = APPLE_WORKS_CACHE[ck];
  let v = (hit && Date.now() - hit.at < APPLE_WORKS_TTL) ? hit.v : null;

  if (!v) {
    const [albumRes, songRes] = await Promise.all([
      itunesLookupAll(artistId, "album", ITUNES_COUNTRIES[0]),
      itunesLookupAll(artistId, "song", ITUNES_COUNTRIES[0]),
    ]);

    const albums = [];
    const albumSeen = {};
    for (let i = 0; i < albumRes.length; i++) {
      const x = albumRes[i];
      if (x.wrapperType !== "collection") continue;
      const k = normAlbumName(x.collectionName || "");
      if (!k || albumSeen[k]) continue;
      albumSeen[k] = 1;
      albums.push({
        title: String(x.collectionName || ""),
        artist: String(x.artistName || ""),
        worksNum: Number(x.trackCount || 0),
        date: String(x.releaseDate || "").slice(0, 10),
        artwork: String(x.artworkUrl100 || "").replace("100x100", "600x600"),
        _norm: k,
        _cid: String(x.collectionId || ""),
        _order: albums.length,
      });
    }

    /* 曲目按「专辑出版顺序 + 碟内序号」排。
       lookup 返回的顺序是 Apple 自己的相关性，不是专辑顺序，
       直接给用户看会像乱码（实测 31 首是跳着排的）。 */
    const tracks = [];
    const trackSeen = {};

    /* ⚠️ lookup?id=<艺人>&entity=song 返回的曲目**不是全的**。
       实测「脆弱少女組」：4 张专辑 trackCount 合计 19 首，
       这条 lookup 只回 14 首 ——《尋找尼歐 - Single》整张 3 首一条没给，
       于是点进那张专辑是空的（曲目 0）。
       按专辑 id 逐张 lookup 才是权威的。并发拉，失败不影响别的。 */
    const missing = albums.filter((a) => a._cid && a.worksNum > 0);
    const full = {};
    if (missing.length) {
      await Promise.all(missing.map(async (a) => {
        try {
          const r = await itunesLookupAll(a._cid, "song", ITUNES_COUNTRIES[0]);
          full[a._norm] = (r || []).filter((x) => x.wrapperType === "track");
        } catch (e) { /* 单张失败就用手上那批 */ }
      }));
    }
    for (let ai = 0; ai < albums.length; ai++) {
      const a = albums[ai];
      const list = full[a._norm];
      if (!list || !list.length) continue;
      for (let i = 0; i < list.length; i++) {
        const x = list[i];
        const nm = String(x.trackName || "");
        /* ⚠️ 去重键要带专辑：normTextZ 会把括号里的内容全剥掉，
           《脆弱少女組台呼 (Goodnight Version)》和《脆弱少女組台呼》
           会变成同一个键，《不如跳舞 (趙謬Remix & Solo)》和《不如跳舞》
           也一样 —— 纯按标题去重就会凭空少曲目（实测 19 首丢 2 首）。 */
        const k = normTextZ(nm) + "|" + a._order;
        if (!normTextZ(nm) || trackSeen[k]) continue;
        trackSeen[k] = 1;
        tracks.push({
          title: nm,
          album: a.title,
          no: Number(x.trackNumber || 0),
          dur: Number(x.trackTimeMillis || 0),
          artwork: String(x.artworkUrl100 || "").replace("100x100", "600x600"),
          _albumOrder: a._order,
        });
      }
    }
    tracks.sort((a, b) => (a._albumOrder - b._albumOrder) || (a.no - b.no));

    v = { albums: albums, tracks: tracks };
    APPLE_WORKS_CACHE[ck] = { at: Date.now(), v: v };
  }

  const artistName = (v.albums[0] && v.albums[0].artist) || "";
  const begin = (page - 1) * ps;

  if (type === "album") {
    const list = v.albums.map((a, i) => ({
      id: "apple:" + artistId + ":" + i,
      platform: "Apple Music",
      title: a.title,
      artist: a.artist || artistName,
      artwork: a.artwork,
      date: a.date,
      description: "Apple Music 目录（该平台暂无音源）",
      worksNum: a.worksNum,
      _provider: "apple",
      _kind: "album",
    }));
    return { isEnd: begin + ps >= list.length, data: list.slice(begin, begin + ps) };
  }

  const data = v.tracks.slice(begin, begin + ps).map((t, i) => ({
    id: "apt:" + artistId + ":" + (begin + i),
    platform: "Apple Music",
    title: t.title,
    artist: artistName,
    album: t.album,
    artwork: t.artwork,
    duration: t.dur,
    _provider: "apple",
  }));
  return { isEnd: begin + ps >= v.tracks.length, data: data };
}

/**
 * 查「这个查询词对应的正式发行版」。
 * 返回 { album: "魔杰座", title: "花海", live: false } 或 null（查不到）。
 */
function shouldUseAuthority() {
  try {
    const vars = (typeof env !== "undefined" && env && env.userVariables) || {};
    const v = vars.authorityCatalog;
    if (v === undefined || v === null || v === "") return true;
    return !(v === "0" || v === "false" || v === "off");
  } catch (e) { return true; }
}

/* ============================================================
 * 权威目录的「预热」
 *
 * ⚠️ 为什么要单独拆一发：
 *   authorityHint 里那发 iTunes 请求虽然只有 0.3~0.5s，
 *   但它原来是在**平台搜索结果全部回来之后**才发的 ——
 *   也就是说这 0.4s 是纯追加在总耗时尾部，用户全程在等。
 *   而它其实只依赖 query，不依赖任何搜索结果（topArtist 只用于打分）。
 *
 *   所以现在：searchMusicAll 一进来就把这发请求发出去，
 *   等真正要打分的时候再 await，那时它早就回来了 —— 尾部零耗时。
 * ============================================================ */
function authorityPrefetch(query) {
  const q = String(query || "").trim();
  if (!q || q.length > 40) return null;
  if (!shouldUseAuthority()) return null;
  /* 已经缓存过就别重复发 —— 直接给个同步返回的 promise */
  const ck = normText(q).slice(0, 40);
  const hit = AUTH_CACHE[ck];
  if (hit && Date.now() - hit.at < AUTH_CACHE_TTL) return { cached: hit.v };
  return itunesSearchAny("/search", { term: q, entity: "song", limit: 25, country: "cn" })
    .catch(function () { return null; });
}

async function authorityHint(query, topArtist, pre) {
  if (!shouldUseAuthority()) return null;
  const q = String(query || "").trim();
  if (!q || q.length > 40) return null;
  const ck = normText(q).slice(0, 40);
  const hit = AUTH_CACHE[ck];
  if (hit && Date.now() - hit.at < AUTH_CACHE_TTL) return hit.v;

  let result = null;
  try {
    /* 路线 A（新，主力）：直接按**歌曲**查。
       比「先找歌手再 lookup」稳得多 —— 后者要求查询词恰好是歌手名，
       搜「花海 周杰伦」时会被误认成歌手查询而错配。
       entity=song 一次就返回 歌名 / 歌手 / 专辑名 / 专辑曲目数，
       全都是判定「正式发行版」要用的字段。

       pre 是上面 authorityPrefetch 已经发出去的那一发：
       有就直接用它的结果（通常早回来了），没有才现发。 */
    const songRes = (pre && pre.cached !== undefined)
      ? pre.cached
      : (pre ? await pre : await itunesSearchAny("/search", {
          term: q, entity: "song", limit: 25, country: "cn",
        }));
    const tracks = ((songRes && songRes.results) || []).filter((x) => x.wrapperType === "track");

    // 查询词里可能带歌手名，拆出纯歌名再比
    const candNames = Array.isArray(topArtist) ? topArtist : (topArtist ? [topArtist] : []);
    let probeRaw = q;
    for (let i = 0; i < candNames.length; i++) {
      const nm = String(candNames[i] || "");
      if (nm.length < 2) continue;
      probeRaw = probeRaw.replace(new RegExp(escapeRe(nm), "gi"), " ");
    }
    const wantTitle = normText(toSimplified(probeRaw));
    const probe = wantTitle || ck;

    /* 候选歌手集合：搜索结果里真实出现过的艺人们。
       用途是给「歌名一样但换了人」的条目排序 —— 详情页里那一堆
       翻唱歌手不在集合里，自然排到后面。 */
    const candSet = {};
    for (let i = 0; i < candNames.length; i++) {
      const k = singerNorm(candNames[i]);
      if (k) candSet[k] = 1;
    }

    /* 歌名比对用模糊相似度（0.72 是实测分界：真同名 ≥0.83，不相干多数 <0.5）。
       Apple 繁体库里同一个歌名会换字，严格包含对不上就整条丢掉了。 */
    const SIM_MIN = 0.72;
    let best = null;
    let bestSc = -1;
    for (let i = 0; i < tracks.length; i++) {
      const tk = tracks[i];
      const tn = normText(toSimplified(tk.trackName || ""));
      if (!tn) continue;
      let sc = 0;
      const sim = titleSimZ(tk.trackName || "", q);
      if (tn === probe || sim >= 0.995) sc += 100;
      else if (tn.indexOf(probe) >= 0 || probe.indexOf(tn) >= 0) sc += 40;
      else if (sim >= SIM_MIN) sc += 30;
      else continue;                       // 歌名不对的不要
      // 排行榜越靠前越像正主（iTunes 自己的相关性排序）
      sc -= i * 2;
      // 专辑曲目数多 → 更像是正规专辑而不是随手发的 single
      sc += Math.min(20, Number(tk.trackCount || 0));
      // 歌手名字出现在搜索结果里 → 加分
      const tka = singerNorm(tk.artistName || "");
      if (tka && candSet[tka]) sc += 50;
      // Live / 伴奏 / 翻唱专辑降权，但**不排除** ——
      // 有些歌只在 Live 专辑里存在（用户搜的就是那个版本）
      /* ⚠️ 版本词要连**歌名**一起看，不能只看专辑名：
         实测搜「印第安老斑鸠」，Apple 首条是《謝謝儂 + 印第安老斑鳩 (Live)》，
         收录在《中國新歌聲第二季 第1期》—— 专辑名里没有 live，
         这版综艺合唱拿了最高分，权威目录就指向了合辑。 */
      const verRaw = String(tk.collectionName || "") + " " + String(tk.trackName || "");
      if (/live|演唱会|演唱會|remix|伴奏|karaoke/i.test(verRaw)) sc -= 60;
      if (/翻唱|cover/i.test(verRaw)) sc -= 60;
      if (/[+＋]/.test(String(tk.trackName || ""))) sc -= 30;
      if (sc > bestSc) { bestSc = sc; best = tk; }
    }

    if (best) {
      const album = String(best.collectionName || "");
      result = {
        album: album,
        title: String(best.trackName || ""),
        // 权威库里「原版」就是不带 Live / Remix / 演唱会 的那张
        live: /live|演唱会|演唱會|remix|dj|伴奏|翻唱|cover/i.test(album),
        artist: String(best.artistName || ""),
        trackCount: Number(best.trackCount || 0),
      };
    }
  } catch (e) { /* 静默 */ }

  AUTH_CACHE[ck] = { at: Date.now(), v: result };
  return result;
}

function escapeRe(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 拿单条搜索结果跟权威目录比对，给一个加分。
 * 0 = 没有信息（不惩罚）；正数 = 越像正式发行版越高。
 */
function authorityScore(item, auth) {
  if (!auth) return 0;
  const t = normText(toSimplified(item.title || ""));
  const at = normText(toSimplified(auth.title || ""));
  if (!t || !at) return 0;
  /* ⚠️ 「是不是同一首」的闸门也得模糊比：
     Apple 把「印第安老斑鸠」写作「印地安老斑鳩」，严格包含一判就返回 0，
     整条权威打分全是 0，原唱周杰伦那条（歌手完全一致，本该 +40）
     就跟翻唱混在一起，谁先返回谁在前。 */
  if (t !== at && t.indexOf(at) < 0 && at.indexOf(t) < 0 && titleSimZ(item.title, auth.title) < 0.8) return 0;

  const albumRaw = String(item.album || "");
  const album = normText(toSimplified(albumRaw));
  const authAlbum = normText(toSimplified(auth.album || ""));
  let sc = 0;
  // 歌手是不是**明确**对不上（既不是同一个人、也不是 Topic 官方频道）
  let artistMismatch = false;

  // 最关键的一条：**歌手得对**。
  // 权威库说《山海》是草东没有派对的，那「山海 / 阿错」这种翻唱就不该拿分。
  // 之前只看专辑名，而翻唱条目往往没有 album 字段，于是打分全靠 Live 判断，
  // 结果一条翻唱反而拿到 +20 排到原唱前面。
  const itemArtistRaw = String(item.artist || "");
  const isTopicChannel = /[-–—]\s*Topic$/i.test(itemArtistRaw);
  if (auth.artist) {
    const authArtist = singerNorm(auth.artist);
    const itemArtist = singerNorm(itemArtistRaw);
    if (authArtist && itemArtist) {
      if (itemArtist === authArtist) sc += 40;
      else if (itemArtist.indexOf(authArtist) >= 0 || authArtist.indexOf(itemArtist) >= 0) sc += 30;
      else if (isTopicChannel) {
        /* 「xxx - Topic」是 YouTube 给唱片公司/艺人自动生成的官方频道，
           频道名常常是**艺名的另一种写法**（国语乐队用英文团名）。
           权威库说这首歌是「那我懂你意思了」，YouTube 上原版挂在
           「IGU Band - Topic」—— 名字对不上不代表它不是原唱。

           ⚠️ 但 Topic 频道也有翻唱者自己开通的（Revina Wu - Topic）。
              只给「不是翻唱打压」这个待遇（0 分），**不给正分** ——
              给了分它就爬到真原唱前面去了。
              唯一的正分情况：标题跟权威歌名**完全一致**
              且专辑名也跟权威专辑一致，那基本可以确认是同一条录音。 */
        const tk = normText(toSimplified(item.title || ""));
        const ak = normText(toSimplified(auth.title || ""));
        const albumHit = album && authAlbum && album === authAlbum;
        sc += (tk === ak && albumHit) ? 20 : 0;
      } else { sc -= 30; artistMismatch = true; }   // 歌手对不上 → 别人唱的同一首歌
    }
  }

  /* 专辑名对上权威库的正式专辑 → 强信号（说明这条就是正版录音室版）
     ⚠️ 先看**原始**专辑名里有没有 cover 标记。
        normText 会把括号内容整段删掉，
       「原諒我不明白你的悲傷（Cover 李中凯）」归一化后就成了
       「原谅我不明白你的悲伤」—— 跟正版专辑名一模一样，
       于是翻唱拿到专辑加分，反而把原唱顶了下去。

     ⚠️ 更要命的是翻唱条目常常**直接照抄原版专辑名**。
        实测搜「原谅我不明白你的悲伤」，一堆翻唱条的 album 就写着
        「原諒我不明白你的悲傷」，专辑分 +30 正好把歌手不符的 -30 抵掉。
        所以：歌手明确不符时，专辑名不算数。 */
  const looksCoverAlbum = /cover|翻唱|伴奏|karaoke|纯音乐|instrumental|抖音|remix|dj|女声|男声|钢琴|吉他/i.test(albumRaw);
  if (looksCoverAlbum) {
    sc -= 35;
  } else if (authAlbum && album && !artistMismatch) {
    if (album === authAlbum) sc += 30;
    else if (album.indexOf(authAlbum) >= 0 || authAlbum.indexOf(album) >= 0) sc += 20;
  }

  // 权威库里那首本身就是 Live 版 → 不能靠「像 Live」加分
  const looksLive = /live|演唱会|演唱會|remix|dj版|伴奏|翻唱|cover/i.test(item.title || "");
  if (auth.live) {
    if (looksLive) sc += 12;
  } else {
    // 权威库有录音室版，那这条若是 Live/翻唱就该排后面
    if (looksLive) sc -= 25;
    else sc += 10;
  }

  /* 权威库给了曲目数：条目自带的专辑名跟权威专辑名一致、
     且权威专辑是正规专辑（≥5 首）时，说明这条确实出自那张专辑。
     单曲/Single 那种 1~3 首的，说明它只是「同名单曲」，
     不能跟正式专辑里的原版相提并论。 */
  if (auth.trackCount >= 5 && authAlbum && album === authAlbum && !looksCoverAlbum && !artistMismatch) {
    sc += 15;
  }
  return sc;
}
function splitSingers(s) {
  return String(s || "").split(/[、,，&/]/).map((x) => x.trim()).filter(Boolean);
}
function singerMatch(a, b) {
  const A = splitSingers(a).map(normText);
  const B = splitSingers(b).map(normText);
  if (!A.length || !B.length) return true;
  return A.some((x) => B.some((y) => x.indexOf(y) >= 0 || y.indexOf(x) >= 0));
}
/**
 * 构造搜索关键词。
 * ⚠️ 这里**不能**用 normText 归一化：酷狗等后端对查询很敏感，
 * "海阔天空 BEYOND" 能搜到，换成 "海阔天空beyond"（去空格）或
 * 只给 "海阔天空" 就返回 0 条。归一化只用于**匹配结果**，不用于**发起查询**。
 */
/* ============================================================
 * 简繁互搜
 *
 * 字表来源：OpenCC 官方 STCharacters.txt（Apache-2.0）
 *   https://github.com/BYVoid/OpenCC/blob/master/data/dictionary/STCharacters.txt
 * 已剔除「候选里含原字」的歧义字（云→雲 云、干→幹 乾 干 这类），
 * 所以只做加法不做减法：繁体输入原样保留，简体输入额外补一份繁体写法。
 *
 * 为什么需要：
 *   简繁在各平台之间并不互通。实测《原諒我不明白你的悲傷》只有繁体写法
 *   能在 YouTube 命中，简体写法搜不到。
 * ============================================================ */
/* 繁 → 简（OpenCC TSCharacters，2965 条）。格式 繁:简。
   ⚠️ 必须是**真正的繁→简表**。之前用的是「简→繁反向拼」的做法，
   生成时把「叶/杰/里/后/云/万/丰」这类歧义字整条丢掉了，
   结果「葉惠美」永远转不成「叶惠美」，《叶惠美》专辑只能靠猜。 */
const T2S_PAIRS = "㑯:㑔,㑳:㑇,㑶:㐹,㓨:刾,㘚:㘎,㜄:㚯,㜏:㛣,㠏:㟆,㥮:㤘,㩜:㨫,㩳:㧐,㩵:擜,䁻:䀥,䃮:鿎,䊷:䌶,䋙:䌺,䋚:䌻,䋹:䌿,䋻:䌾,䍦:䍠,䎱:䎬,䙡:䙌,䜀:䜧,䝼:䞍,䥇:䦂,䥑:鿏,䥱:䥾,䦛:䦶,䦟:䦷,䯀:䯅,䰾:鲃,䱷:䲣,䱽:䲝,䲁:鳚,䲘:鳤,䴉:鹮,丟:丢,並:并,乾:干,亂:乱,亙:亘,亞:亚,佇:伫,佈:布,佔:占,併:并,來:来,侖:仑,侶:侣,侷:局,俁:俣,係:系,俔:伣,俠:侠,俥:伡,俬:私,倀:伥,倆:俩,倈:俫,倉:仓,個:个,們:们,倖:幸,倫:伦,倲:㑈,偉:伟,偑:㐽,側:侧,偵:侦,偽:伪,傌:㐷,傑:杰,傖:伧,傘:伞,備:备,傢:家,傭:佣,傯:偬,傳:传,傴:伛,債:债,傷:伤,傾:倾,僂:偻,僅:仅,僉:佥,僑:侨,僕:仆,僞:伪,僥:侥,僨:偾,僱:雇,價:价,儀:仪,儁:俊,儂:侬,億:亿,儈:侩,儉:俭,儎:傤,儐:傧,儔:俦,儕:侪,儘:尽,償:偿,優:优,儲:储,儷:俪,儸:㑩,儺:傩,儻:傥,儼:俨,兇:凶,兌:兑,兒:儿,兗:兖,內:内,兩:两,冊:册,冑:胄,冪:幂,凈:净,凍:冻,凜:凛,凱:凯,別:别,刪:删,剄:刭,則:则,剋:克,剎:刹,剗:刬,剛:刚,剝:剥,剮:剐,剴:剀,創:创,剷:铲,劃:划,劄:札,劇:剧,劉:刘,劊:刽,劌:刿,劍:剑,劏:㓥,劑:剂,劚:㔉,勁:劲,動:动,務:务,勛:勋,勝:胜,勞:劳,勢:势,勩:勚,勱:劢,勳:勋,勵:励,勸:劝,勻:匀,匭:匦,匯:汇,匱:匮,區:区,協:协,卹:恤,卻:却,卽:即,厙:厍,厠:厕,厤:历,厭:厌,厲:厉,厴:厣,參:参,叄:叁,叢:丛,吒:咤,吳:吴,吶:呐,呂:吕,咼:呙,員:员,唄:呗,唸:念,問:问,啓:启,啞:哑,啟:启,啢:唡,喎:㖞,喚:唤,喪:丧,喫:吃,喬:乔,單:单,喲:哟,嗆:呛,嗇:啬,嗊:唝,嗎:吗,嗚:呜,嗩:唢,嗶:哔,嘆:叹,嘍:喽,嘓:啯,嘔:呕,嘖:啧,嘗:尝,嘜:唛,嘩:哗,嘮:唠,嘯:啸,嘰:叽,嘵:哓,嘸:呒,嘽:啴,噁:恶,噓:嘘,噚:㖊,噝:咝,噠:哒,噥:哝,噦:哕,噯:嗳,噲:哙,噴:喷,噸:吨,噹:当,嚀:咛,嚇:吓,嚌:哜,嚐:尝,嚕:噜,嚙:啮,嚥:咽,嚦:呖,嚨:咙,嚮:向,嚲:亸,嚳:喾,嚴:严,嚶:嘤,囀:啭,囁:嗫,囂:嚣,囅:冁,囈:呓,囉:啰,囌:苏,囑:嘱,囪:囱,圇:囵,國:国,圍:围,園:园,圓:圆,圖:图,團:团,垻:坝,埡:垭,埰:采,執:执,堅:坚,堊:垩,堖:垴,堝:埚,堯:尧,報:报,場:场,塊:块,塋:茔,塏:垲,塒:埘,塗:涂,塚:冢,塢:坞,塤:埙,塵:尘,塹:堑,墊:垫,墜:坠,墮:堕,墰:坛,墳:坟,墶:垯,墻:墙,墾:垦,壇:坛,壋:垱,壎:埙,壓:压,壘:垒,壙:圹,壚:垆,壜:坛,壞:坏,壟:垄,壠:垅,壢:坜,壩:坝,壪:塆,壯:壮,壺:壶,壼:壸,壽:寿,夠:够,夢:梦,夥:伙,夾:夹,奐:奂,奧:奥,奩:奁,奪:夺,奬:奖,奮:奋,奼:姹,妝:妆,姍:姗,姦:奸,娛:娱,婁:娄,婦:妇,婭:娅,媧:娲,媯:妫,媰:㛀,媼:媪,媽:妈,嫋:袅,嫗:妪,嫵:妩,嫺:娴,嫻:娴,嫿:婳,嬀:妫,嬃:媭,嬈:娆,嬋:婵,嬌:娇,嬙:嫱,嬡:嫒,嬤:嬷,嬪:嫔,嬰:婴,嬸:婶,孃:娘,孋:㛤,孌:娈,孫:孙,學:学,孿:孪,宮:宫,寀:采,寢:寝,實:实,寧:宁,審:审,寫:写,寬:宽,寵:宠,寶:宝,將:将,專:专,尋:寻,對:对,導:导,尷:尴,屆:届,屍:尸,屓:屃,屜:屉,屢:屡,層:层,屨:屦,屬:属,岡:冈,峯:峰,峴:岘,島:岛,峽:峡,崍:崃,崑:昆,崗:岗,崙:仑,崢:峥,崬:岽,嵐:岚,嵗:岁,嵾:㟥,嶁:嵝,嶄:崭,嶇:岖,嶔:嵚,嶗:崂,嶠:峤,嶢:峣,嶧:峄,嶨:峃,嶮:崄,嶸:嵘,嶺:岭,嶼:屿,嶽:岳,巋:岿,巒:峦,巔:巅,巖:岩,巰:巯,巹:卺,帥:帅,師:师,帳:帐,帶:带,幀:帧,幃:帏,幓:㡎,幗:帼,幘:帻,幟:帜,幣:币,幫:帮,幬:帱,幷:并,幹:干,幾:几,庫:库,廁:厕,廂:厢,廄:厩,廈:厦,廎:庼,廕:荫,廚:厨,廝:厮,廟:庙,廠:厂,廡:庑,廢:废,廣:广,廩:廪,廬:庐,廳:厅,弒:弑,弔:吊,弳:弪,張:张,強:强,彆:别,彈:弹,彌:弥,彎:弯,彔:录,彙:汇,彠:彟,彥:彦,彫:雕,彲:彨,彿:佛,後:后,徑:径,從:从,徠:徕,復:复,徵:征,徹:彻,恆:恒,恥:耻,悅:悦,悞:悮,悵:怅,悶:闷,悽:凄,惡:恶,惱:恼,惲:恽,惻:恻,愛:爱,愜:惬,愨:悫,愴:怆,愷:恺,愾:忾,慄:栗,態:态,慍:愠,慘:惨,慚:惭,慟:恸,慣:惯,慤:悫,慪:怄,慫:怂,慮:虑,慳:悭,慶:庆,慺:㥪,慼:戚,慾:欲,憂:忧,憊:惫,憐:怜,憑:凭,憒:愦,憖:慭,憚:惮,憤:愤,憫:悯,憮:怃,憲:宪,憶:忆,懇:恳,應:应,懌:怿,懍:懔,懞:蒙,懟:怼,懣:懑,懤:㤽,懨:恹,懲:惩,懶:懒,懷:怀,懸:悬,懺:忏,懼:惧,懾:慑,戀:恋,戇:戆,戔:戋,戧:戗,戩:戬,戰:战,戱:戯,戲:戏,戶:户,扞:捍,拋:抛,拚:拼,挩:捝,挱:挲,挾:挟,捨:舍,捫:扪,捱:挨,捲:卷,掃:扫,掄:抡,掆:㧏,掗:挜,掙:挣,掛:挂,採:采,揀:拣,揚:扬,換:换,揮:挥,揯:搄,損:损,搖:摇,搗:捣,搧:扇,搵:揾,搶:抢,摑:掴,摜:掼,摟:搂,摯:挚,摳:抠,摶:抟,摺:折,摻:掺,撈:捞,撏:挦,撐:撑,撓:挠,撝:㧑,撟:挢,撣:掸,撥:拨,撫:抚,撲:扑,撳:揿,撻:挞,撾:挝,撿:捡,擁:拥,擄:掳,擇:择,擊:击,擋:挡,擓:㧟,擔:担,據:据,擠:挤,擡:抬,擣:捣,擬:拟,擯:摈,擰:拧,擱:搁,擲:掷,擴:扩,擷:撷,擺:摆,擻:擞,擼:撸,擽:㧰,擾:扰,攄:摅,攆:撵,攏:拢,攔:拦,攖:撄,攙:搀,攛:撺,攜:携,攝:摄,攢:攒,攣:挛,攤:摊,攪:搅,攬:揽,敎:教,敓:敚,敗:败,敘:叙,敵:敌,數:数,斂:敛,斃:毙,斆:敩,斕:斓,斬:斩,斷:断,於:于,旂:旗,旣:既,昇:升,時:时,晉:晋,晝:昼,暈:晕,暉:晖,暘:旸,暢:畅,暫:暂,曄:晔,曆:历,曇:昙,曉:晓,曏:向,曖:暧,曠:旷,曨:昽,曬:晒,書:书,會:会,朧:胧,朮:术,東:东,枴:拐,柵:栅,柺:拐,査:查,桿:杆,梔:栀,梘:枧,條:条,梟:枭,梲:棁,棄:弃,棊:棋,棖:枨,棗:枣,棟:栋,棡:㭎,棧:栈,棲:栖,棶:梾,椏:桠,椲:㭏,楊:杨,楓:枫,楨:桢,業:业,極:极,榘:矩,榦:干,榪:杩,榮:荣,榲:榅,榿:桤,構:构,槍:枪,槓:杠,槤:梿,槧:椠,槨:椁,槮:椮,槳:桨,槶:椢,槼:椝,樁:桩,樂:乐,樅:枞,樑:梁,樓:楼,標:标,樞:枢,樢:㭤,樣:样,樧:榝,樫:㭴,樳:桪,樸:朴,樹:树,樺:桦,樿:椫,橈:桡,橋:桥,機:机,橢:椭,橫:横,檁:檩,檉:柽,檔:档,檜:桧,檟:槚,檢:检,檣:樯,檮:梼,檯:台,檳:槟,檸:柠,檻:槛,櫃:柜,櫓:橹,櫚:榈,櫛:栉,櫝:椟,櫞:橼,櫟:栎,櫥:橱,櫧:槠,櫨:栌,櫪:枥,櫫:橥,櫬:榇,櫱:蘖,櫳:栊,櫸:榉,櫻:樱,欄:栏,欅:榉,權:权,欏:椤,欒:栾,欖:榄,欞:棂,欽:钦,歎:叹,歐:欧,歟:欤,歡:欢,歲:岁,歷:历,歸:归,歿:殁,殘:残,殞:殒,殤:殇,殨:㱮,殫:殚,殭:僵,殮:殓,殯:殡,殰:㱩,殲:歼,殺:杀,殻:壳,殼:壳,毀:毁,毆:殴,毿:毵,氂:牦,氈:毡,氌:氇,氣:气,氫:氢,氬:氩,氳:氲,氾:泛,汎:泛,汙:污,決:决,沒:没,沖:冲,況:况,泝:溯,洩:泄,洶:汹,浹:浃,涇:泾,涗:涚,涼:凉,淒:凄,淚:泪,淥:渌,淨:净,淩:凌,淪:沦,淵:渊,淶:涞,淺:浅,渙:涣,減:减,渢:沨,渦:涡,測:测,渾:浑,湊:凑,湞:浈,湧:涌,湯:汤,溈:沩,準:准,溝:沟,溫:温,溮:浉,溳:涢,溼:湿,滄:沧,滅:灭,滌:涤,滎:荥,滙:汇,滬:沪,滯:滞,滲:渗,滷:卤,滸:浒,滻:浐,滾:滚,滿:满,漁:渔,漊:溇,漚:沤,漢:汉,漣:涟,漬:渍,漲:涨,漵:溆,漸:渐,漿:浆,潁:颍,潑:泼,潔:洁,潙:沩,潚:㴋,潛:潜,潤:润,潯:浔,潰:溃,潷:滗,潿:涠,澀:涩,澆:浇,澇:涝,澐:沄,澗:涧,澠:渑,澤:泽,澦:滪,澩:泶,澮:浍,澱:淀,澾:㳠,濁:浊,濃:浓,濄:㳡,濕:湿,濘:泞,濚:溁,濛:蒙,濜:浕,濟:济,濤:涛,濧:㳔,濫:滥,濰:潍,濱:滨,濺:溅,濼:泺,濾:滤,瀂:澛,瀅:滢,瀆:渎,瀇:㲿,瀉:泻,瀋:沈,瀏:浏,瀕:濒,瀘:泸,瀝:沥,瀟:潇,瀠:潆,瀦:潴,瀧:泷,瀨:濑,瀰:弥,瀲:潋,瀾:澜,灃:沣,灄:滠,灑:洒,灕:漓,灘:滩,灝:灏,灡:㳕,灣:湾,灤:滦,灧:滟,灩:滟,災:灾,為:为,烏:乌,烴:烃,無:无,煉:炼,煒:炜,煙:烟,煢:茕,煥:焕,煩:烦,煬:炀,煱:㶽,熅:煴,熒:荧,熗:炝,熱:热,熲:颎,熾:炽,燁:烨,燈:灯,燉:炖,燒:烧,燙:烫,燜:焖,營:营,燦:灿,燬:毁,燭:烛,燴:烩,燶:㶶,燻:熏,燼:烬,燾:焘,爍:烁,爐:炉,爛:烂,爭:争,爲:为,爺:爷,爾:尔,牀:床,牆:墙,牘:牍,牴:抵,牽:牵,犖:荦,犛:牦,犢:犊,犧:牺,狀:状,狹:狭,狽:狈,猙:狰,猶:犹,猻:狲,獁:犸,獃:呆,獄:狱,獅:狮,獎:奖,獨:独,獪:狯,獫:猃,獮:狝,獰:狞,獱:㺍,獲:获,獵:猎,獷:犷,獸:兽,獺:獭,獻:献,獼:猕,玀:猡,現:现,琱:雕,琺:珐,琿:珲,瑋:玮,瑒:玚,瑣:琐,瑤:瑶,瑩:莹,瑪:玛,瑲:玱,璉:琏,璡:琎,璣:玑,璦:瑷,璫:珰,璯:㻅,環:环,璵:玙,璸:瑸,璽:玺,璿:璇,瓊:琼,瓏:珑,瓔:璎,瓚:瓒,甌:瓯,甕:瓮,產:产,産:产,畝:亩,畢:毕,畫:画,異:异,畵:画,當:当,疇:畴,疊:叠,痙:痉,痠:酸,痾:疴,瘂:痖,瘋:疯,瘍:疡,瘓:痪,瘞:瘗,瘡:疮,瘧:疟,瘮:瘆,瘲:疭,瘺:瘘,瘻:瘘,療:疗,癆:痨,癇:痫,癉:瘅,癒:愈,癘:疠,癟:瘪,癡:痴,癢:痒,癤:疖,癥:症,癧:疬,癩:癞,癬:癣,癭:瘿,癮:瘾,癰:痈,癱:瘫,癲:癫,發:发,皁:皂,皚:皑,皰:疱,皸:皲,皺:皱,盃:杯,盜:盗,盞:盏,盡:尽,監:监,盤:盘,盧:卢,盪:荡,眞:真,眥:眦,眾:众,睏:困,睜:睁,睞:睐,瞘:眍,瞜:䁖,瞞:瞒,瞶:瞆,瞼:睑,矇:蒙,矓:眬,矚:瞩,矯:矫,硃:朱,硜:硁,硤:硖,硨:砗,硯:砚,碕:埼,碩:硕,碭:砀,碸:砜,確:确,碼:码,碽:䂵,磑:硙,磚:砖,磠:硵,磣:碜,磧:碛,磯:矶,磽:硗,磾:䃅,礄:硚,礎:础,礙:碍,礦:矿,礪:砺,礫:砾,礬:矾,礱:砻,祕:秘,祿:禄,禍:祸,禎:祯,禕:祎,禡:祃,禦:御,禪:禅,禮:礼,禰:祢,禱:祷,禿:秃,秈:籼,稅:税,稈:秆,稏:䅉,稜:棱,稟:禀,種:种,稱:称,穀:谷,穇:䅟,穌:稣,積:积,穎:颖,穠:秾,穡:穑,穢:秽,穩:稳,穫:获,穭:穞,窩:窝,窪:洼,窮:穷,窯:窑,窵:窎,窶:窭,窺:窥,竄:窜,竅:窍,竇:窦,竈:灶,竊:窃,竪:竖,競:竞,筆:笔,筍:笋,筧:笕,筴:䇲,箇:个,箋:笺,箏:筝,箚:札,節:节,範:范,築:筑,篋:箧,篔:筼,篠:筿,篤:笃,篩:筛,篳:筚,簀:箦,簍:篓,簑:蓑,簞:箪,簡:简,簣:篑,簫:箫,簹:筜,簽:签,簾:帘,籃:篮,籌:筹,籔:䉤,籙:箓,籛:篯,籜:箨,籟:籁,籠:笼,籤:签,籩:笾,籪:簖,籬:篱,籮:箩,籲:吁,粵:粤,糉:粽,糝:糁,糞:粪,糧:粮,糰:团,糲:粝,糴:籴,糶:粜,糹:纟,糾:纠,紀:纪,紂:纣,約:约,紅:红,紆:纡,紇:纥,紈:纨,紉:纫,紋:纹,納:纳,紐:纽,紓:纾,純:纯,紕:纰,紖:纼,紗:纱,紘:纮,紙:纸,級:级,紛:纷,紜:纭,紝:纴,紡:纺,紬:䌷,紮:扎,細:细,紱:绂,紲:绁,紳:绅,紵:纻,紹:绍,紺:绀,紼:绋,紿:绐,絀:绌,終:终,絃:弦,組:组,絅:䌹,絆:绊,絎:绗,結:结,絕:绝,絛:绦,絝:绔,絞:绞,絡:络,絢:绚,給:给,絨:绒,絰:绖,統:统,絲:丝,絳:绛,絶:绝,絹:绢,綁:绑,綃:绡,綆:绠,綈:绨,綉:绣,綌:绤,綏:绥,綐:䌼,綑:捆,經:经,綜:综,綞:缍,綠:绿,綢:绸,綣:绻,綫:线,綬:绶,維:维,綯:绹,綰:绾,綱:纲,網:网,綳:绷,綴:缀,綵:彩,綸:纶,綹:绺,綺:绮,綻:绽,綽:绰,綾:绫,綿:绵,緄:绲,緇:缁,緊:紧,緋:绯,緑:绿,緒:绪,緓:绬,緔:绱,緗:缃,緘:缄,緙:缂,線:线,緝:缉,緞:缎,締:缔,緡:缗,緣:缘,緦:缌,編:编,緩:缓,緬:缅,緯:纬,緱:缑,緲:缈,練:练,緶:缏,緹:缇,緻:致,緼:缊,縈:萦,縉:缙,縊:缢,縋:缒,縐:绉,縑:缣,縕:缊,縗:缞,縛:缚,縝:缜,縞:缟,縟:缛,縣:县,縧:绦,縫:缝,縭:缡,縮:缩,縱:纵,縲:缧,縳:䌸,縴:纤,縵:缦,縶:絷,縷:缕,縹:缥,總:总,績:绩,繃:绷,繅:缫,繆:缪,繒:缯,織:织,繕:缮,繚:缭,繞:绕,繡:绣,繢:缋,繩:绳,繪:绘,繫:系,繭:茧,繮:缰,繯:缳,繰:缲,繳:缴,繸:䍁,繹:绎,繼:继,繽:缤,繾:缱,繿:䍀,纇:颣,纈:缬,纊:纩,續:续,纍:累,纏:缠,纓:缨,纔:才,纖:纤,纘:缵,纜:缆,缽:钵,罃:䓨,罈:坛,罌:罂,罎:坛,罰:罚,罵:骂,罷:罢,羅:罗,羆:罴,羈:羁,羋:芈,羣:群,羥:羟,羨:羡,義:义,羶:膻,習:习,翫:玩,翬:翚,翹:翘,翽:翙,耬:耧,耮:耢,聖:圣,聞:闻,聯:联,聰:聪,聲:声,聳:耸,聵:聩,聶:聂,職:职,聹:聍,聽:听,聾:聋,肅:肃,脅:胁,脈:脉,脛:胫,脣:唇,脩:修,脫:脱,脹:胀,腎:肾,腖:胨,腡:脶,腦:脑,腫:肿,腳:脚,腸:肠,膃:腽,膕:腘,膚:肤,膞:䏝,膠:胶,膩:腻,膽:胆,膾:脍,膿:脓,臉:脸,臍:脐,臏:膑,臘:腊,臚:胪,臟:脏,臠:脔,臢:臜,臥:卧,臨:临,臺:台,與:与,興:兴,舉:举,舊:旧,舖:铺,舘:馆,艙:舱,艤:舣,艦:舰,艫:舻,艱:艰,艷:艳,芻:刍,苧:苎,茲:兹,荊:荆,莊:庄,莖:茎,莢:荚,莧:苋,華:华,菴:庵,菸:烟,萇:苌,萊:莱,萬:万,萴:荝,萵:莴,葉:叶,葒:荭,葤:荮,葦:苇,葯:药,葷:荤,蒐:搜,蒓:莼,蒔:莳,蒕:蒀,蒞:莅,蒼:苍,蓀:荪,蓆:席,蓋:盖,蓮:莲,蓯:苁,蓴:莼,蓽:荜,蔔:卜,蔘:参,蔞:蒌,蔣:蒋,蔥:葱,蔦:茑,蔭:荫,蕁:荨,蕆:蒇,蕎:荞,蕒:荬,蕓:芸,蕕:莸,蕘:荛,蕢:蒉,蕩:荡,蕪:芜,蕭:萧,蕷:蓣,薀:蕰,薈:荟,薊:蓟,薌:芗,薑:姜,薔:蔷,薘:荙,薟:莶,薦:荐,薩:萨,薴:苧,薵:䓓,薹:苔,薺:荠,藍:蓝,藎:荩,藝:艺,藥:药,藪:薮,藭:䓖,藴:蕴,藶:苈,藹:蔼,藺:蔺,蘀:萚,蘄:蕲,蘆:芦,蘇:苏,蘊:蕴,蘋:苹,蘚:藓,蘞:蔹,蘢:茏,蘭:兰,蘺:蓠,蘿:萝,虆:蔂,處:处,虛:虚,虜:虏,號:号,虧:亏,虯:虬,蛺:蛱,蛻:蜕,蜆:蚬,蝕:蚀,蝟:猬,蝦:虾,蝨:虱,蝸:蜗,螄:蛳,螞:蚂,螢:萤,螮:䗖,螻:蝼,螿:螀,蟄:蛰,蟈:蝈,蟎:螨,蟣:虮,蟬:蝉,蟯:蛲,蟲:虫,蟶:蛏,蟻:蚁,蠁:蚃,蠅:蝇,蠆:虿,蠍:蝎,蠐:蛴,蠑:蝾,蠔:蚝,蠟:蜡,蠣:蛎,蠨:蟏,蠱:蛊,蠶:蚕,蠻:蛮,衆:众,衊:蔑,術:术,衕:同,衚:胡,衛:卫,衝:冲,袞:衮,袷:夹,裊:袅,裏:里,補:补,裝:装,裡:里,製:制,複:复,褌:裈,褘:袆,褲:裤,褳:裢,褸:褛,褻:亵,襇:裥,襉:裥,襏:袯,襖:袄,襝:裣,襠:裆,襤:褴,襪:袜,襬:摆,襯:衬,襲:袭,襴:襕,覈:核,見:见,覎:觃,規:规,覓:觅,視:视,覘:觇,覡:觋,覥:觍,覦:觎,親:亲,覬:觊,覯:觏,覲:觐,覷:觑,覺:觉,覽:览,覿:觌,觀:观,觴:觞,觶:觯,觸:触,訁:讠,訂:订,訃:讣,計:计,訊:讯,訌:讧,討:讨,訐:讦,訒:讱,訓:训,訕:讪,訖:讫,託:托,記:记,訛:讹,訝:讶,訟:讼,訢:䜣,訣:诀,訥:讷,訩:讻,訪:访,設:设,許:许,訴:诉,訶:诃,診:诊,註:注,証:证,詁:诂,詆:诋,詎:讵,詐:诈,詒:诒,詔:诏,評:评,詖:诐,詗:诇,詘:诎,詛:诅,詞:词,詠:咏,詡:诩,詢:询,詣:诣,試:试,詩:诗,詫:诧,詬:诟,詭:诡,詮:诠,詰:诘,話:话,該:该,詳:详,詵:诜,詼:诙,詿:诖,誄:诔,誅:诛,誆:诓,誇:夸,誌:志,認:认,誑:诳,誒:诶,誕:诞,誘:诱,誚:诮,語:语,誠:诚,誡:诫,誣:诬,誤:误,誥:诰,誦:诵,誨:诲,說:说,説:说,誰:谁,課:课,誶:谇,誹:诽,誼:谊,誾:訚,調:调,諂:谄,諄:谆,談:谈,諉:诿,請:请,諍:诤,諏:诹,諑:诼,諒:谅,論:论,諗:谂,諛:谀,諜:谍,諝:谞,諞:谝,諡:谥,諢:诨,諤:谔,諦:谛,諧:谐,諫:谏,諭:谕,諮:咨,諱:讳,諳:谙,諶:谌,諷:讽,諸:诸,諺:谚,諼:谖,諾:诺,謀:谋,謁:谒,謂:谓,謄:誊,謅:诌,謊:谎,謎:谜,謐:谧,謔:谑,謖:谡,謗:谤,謙:谦,謚:谥,講:讲,謝:谢,謠:谣,謡:谣,謨:谟,謫:谪,謬:谬,謭:谫,謳:讴,謹:谨,謾:谩,譁:哗,證:证,譎:谲,譏:讥,譖:谮,識:识,譙:谯,譚:谭,譜:谱,譟:噪,譫:谵,譭:毁,譯:译,議:议,譴:谴,護:护,譸:诪,譽:誉,譾:谫,讀:读,讅:谉,變:变,讋:詟,讌:䜩,讎:雠,讒:谗,讓:让,讕:谰,讖:谶,讚:赞,讜:谠,讞:谳,谿:溪,豈:岂,豎:竖,豐:丰,豔:艳,豬:猪,豶:豮,貍:狸,貓:猫,貙:䝙,貝:贝,貞:贞,貟:贠,負:负,財:财,貢:贡,貧:贫,貨:货,販:贩,貪:贪,貫:贯,責:责,貯:贮,貰:贳,貲:赀,貳:贰,貴:贵,貶:贬,買:买,貸:贷,貺:贶,費:费,貼:贴,貽:贻,貿:贸,賀:贺,賁:贲,賂:赂,賃:赁,賄:贿,賅:赅,資:资,賈:贾,賊:贼,賑:赈,賒:赊,賓:宾,賕:赇,賙:赒,賚:赉,賜:赐,賞:赏,賠:赔,賡:赓,賢:贤,賣:卖,賤:贱,賦:赋,賧:赕,質:质,賫:赍,賬:账,賭:赌,賰:䞐,賴:赖,賵:赗,賺:赚,賻:赙,購:购,賽:赛,賾:赜,贄:贽,贅:赘,贇:赟,贈:赠,贊:赞,贋:赝,贍:赡,贏:赢,贐:赆,贓:赃,贔:赑,贖:赎,贗:赝,贛:赣,贜:赃,赬:赪,趕:赶,趙:赵,趨:趋,趲:趱,跡:迹,踐:践,踰:逾,踴:踊,蹌:跄,蹕:跸,蹟:迹,蹠:跖,蹣:蹒,蹤:踪,蹺:跷,躂:跶,躉:趸,躊:踌,躋:跻,躍:跃,躎:䟢,躑:踯,躒:跞,躓:踬,躕:蹰,躚:跹,躡:蹑,躥:蹿,躦:躜,躪:躏,軀:躯,車:车,軋:轧,軌:轨,軍:军,軑:轪,軒:轩,軔:轫,軛:轭,軟:软,軤:轷,軫:轸,軲:轱,軸:轴,軹:轵,軺:轺,軻:轲,軼:轶,軾:轼,較:较,輅:辂,輇:辁,輈:辀,載:载,輊:轾,輒:辄,輓:挽,輔:辅,輕:轻,輛:辆,輜:辎,輝:辉,輞:辋,輟:辍,輥:辊,輦:辇,輩:辈,輪:轮,輬:辌,輯:辑,輳:辏,輸:输,輻:辐,輼:辒,輾:辗,輿:舆,轀:辒,轂:毂,轄:辖,轅:辕,轆:辘,轉:转,轍:辙,轎:轿,轔:辚,轟:轰,轡:辔,轢:轹,轤:轳,辦:办,辭:辞,辮:辫,辯:辩,農:农,迴:回,逕:径,這:这,連:连,週:周,進:进,遊:游,運:运,過:过,達:达,違:违,遙:遥,遜:逊,遞:递,遠:远,遡:溯,適:适,遲:迟,遶:绕,遷:迁,選:选,遺:遗,遼:辽,邁:迈,還:还,邇:迩,邊:边,邏:逻,邐:逦,郟:郏,郵:邮,鄆:郓,鄉:乡,鄒:邹,鄔:邬,鄖:郧,鄧:邓,鄭:郑,鄰:邻,鄲:郸,鄴:邺,鄶:郐,鄺:邝,酇:酂,酈:郦,醃:腌,醖:酝,醜:丑,醞:酝,醟:蒏,醣:糖,醫:医,醬:酱,醱:酦,釀:酿,釁:衅,釃:酾,釅:酽,釋:释,釐:厘,釒:钅,釓:钆,釔:钇,釕:钌,釗:钊,釘:钉,釙:钋,針:针,釣:钓,釤:钐,釦:扣,釧:钏,釩:钒,釵:钗,釷:钍,釹:钕,釺:钎,釾:䥺,鈀:钯,鈁:钫,鈃:钘,鈄:钭,鈅:钥,鈈:钚,鈉:钠,鈍:钝,鈎:钩,鈐:钤,鈑:钣,鈒:钑,鈔:钞,鈕:钮,鈞:钧,鈡:钟,鈣:钙,鈥:钬,鈦:钛,鈧:钪,鈮:铌,鈰:铈,鈳:钶,鈴:铃,鈷:钴,鈸:钹,鈹:铍,鈺:钰,鈽:钸,鈾:铀,鈿:钿,鉀:钾,鉅:巨,鉆:钻,鉈:铊,鉉:铉,鉋:铇,鉍:铋,鉑:铂,鉕:钷,鉗:钳,鉚:铆,鉛:铅,鉞:钺,鉢:钵,鉤:钩,鉦:钲,鉬:钼,鉭:钽,鉳:锫,鉶:铏,鉸:铰,鉺:铒,鉻:铬,鉿:铪,銀:银,銃:铳,銅:铜,銍:铚,銑:铣,銓:铨,銖:铢,銘:铭,銚:铫,銛:铦,銜:衔,銠:铑,銣:铷,銥:铱,銦:铟,銨:铵,銩:铥,銪:铕,銫:铯,銬:铐,銱:铞,銳:锐,銷:销,銹:锈,銻:锑,銼:锉,鋁:铝,鋃:锒,鋅:锌,鋇:钡,鋌:铤,鋏:铗,鋒:锋,鋙:铻,鋝:锊,鋟:锓,鋣:铘,鋤:锄,鋥:锃,鋦:锔,鋨:锇,鋩:铓,鋪:铺,鋭:锐,鋮:铖,鋯:锆,鋰:锂,鋱:铽,鋶:锍,鋸:锯,鋼:钢,錁:锞,錄:录,錆:锖,錇:锫,錈:锩,錏:铔,錐:锥,錒:锕,錕:锟,錘:锤,錙:锱,錚:铮,錛:锛,錟:锬,錠:锭,錡:锜,錢:钱,錦:锦,錨:锚,錩:锠,錫:锡,錮:锢,錯:错,録:录,錳:锰,錶:表,錸:铼,錼:镎,鍀:锝,鍁:锨,鍃:锪,鍅:钫,鍆:钔,鍇:锴,鍈:锳,鍊:炼,鍋:锅,鍍:镀,鍔:锷,鍘:铡,鍚:钖,鍛:锻,鍠:锽,鍤:锸,鍥:锲,鍩:锘,鍬:锹,鍰:锾,鍵:键,鍶:锶,鍺:锗,鍼:针,鍾:钟,鎂:镁,鎄:锿,鎇:镅,鎊:镑,鎌:镰,鎔:镕,鎖:锁,鎘:镉,鎚:锤,鎛:镈,鎡:镃,鎢:钨,鎣:蓥,鎦:镏,鎧:铠,鎩:铩,鎪:锼,鎬:镐,鎭:镇,鎮:镇,鎰:镒,鎲:镋,鎳:镍,鎵:镓,鎶:鿔,鎸:镌,鎿:镎,鏃:镞,鏇:旋,鏈:链,鏌:镆,鏍:镙,鏐:镠,鏑:镝,鏗:铿,鏘:锵,鏜:镗,鏝:镘,鏞:镛,鏟:铲,鏡:镜,鏢:镖,鏤:镂,鏨:錾,鏰:镚,鏵:铧,鏷:镤,鏹:镪,鏺:䥽,鏽:锈,鐃:铙,鐋:铴,鐐:镣,鐒:铹,鐓:镦,鐔:镡,鐘:钟,鐙:镫,鐝:镢,鐠:镨,鐥:䦅,鐦:锎,鐧:锏,鐨:镄,鐫:镌,鐮:镰,鐯:䦃,鐲:镯,鐳:镭,鐵:铁,鐶:镮,鐸:铎,鐺:铛,鐿:镱,鑄:铸,鑊:镬,鑌:镔,鑑:鉴,鑒:鉴,鑔:镲,鑕:锧,鑞:镴,鑠:铄,鑣:镳,鑥:镥,鑭:镧,鑰:钥,鑱:镵,鑲:镶,鑷:镊,鑹:镩,鑼:锣,鑽:钻,鑾:銮,鑿:凿,钁:镢,钂:镋,長:长,門:门,閂:闩,閃:闪,閆:闫,閈:闬,閉:闭,開:开,閌:闶,閎:闳,閏:闰,閑:闲,閒:闲,間:间,閔:闵,閘:闸,閡:阂,閣:阁,閤:合,閥:阀,閨:闺,閩:闽,閫:阃,閬:阆,閭:闾,閱:阅,閲:阅,閶:阊,閹:阉,閻:阎,閼:阏,閽:阍,閾:阈,閿:阌,闃:阒,闆:板,闇:暗,闈:闱,闊:阔,闋:阕,闌:阑,闍:阇,闐:阗,闒:阘,闓:闿,闔:阖,闕:阙,闖:闯,關:关,闞:阚,闠:阓,闡:阐,闢:辟,闤:阛,闥:闼,陘:陉,陝:陕,陞:升,陣:阵,陰:阴,陳:陈,陸:陆,陽:阳,隉:陧,隊:队,階:阶,隕:陨,際:际,隨:随,險:险,隯:陦,隱:隐,隴:陇,隸:隶,隻:只,雋:隽,雖:虽,雙:双,雛:雏,雜:杂,雞:鸡,離:离,難:难,雲:云,電:电,霑:沾,霢:霡,霧:雾,霽:霁,靂:雳,靄:霭,靆:叇,靈:灵,靉:叆,靚:靓,靜:静,靝:靔,靦:腼,靨:靥,鞏:巩,鞝:绱,鞦:秋,鞽:鞒,韁:缰,韃:鞑,韆:千,韉:鞯,韋:韦,韌:韧,韍:韨,韓:韩,韙:韪,韜:韬,韝:鞲,韞:韫,韻:韵,響:响,頁:页,頂:顶,頃:顷,項:项,順:顺,頇:顸,須:须,頊:顼,頌:颂,頎:颀,頏:颃,預:预,頑:顽,頒:颁,頓:顿,頗:颇,領:领,頜:颌,頡:颉,頤:颐,頦:颏,頭:头,頮:颒,頰:颊,頲:颋,頴:颕,頷:颔,頸:颈,頹:颓,頻:频,頽:颓,顆:颗,題:题,額:额,顎:颚,顏:颜,顒:颙,顓:颛,顔:颜,願:愿,顙:颡,顛:颠,類:类,顢:颟,顥:颢,顧:顾,顫:颤,顬:颥,顯:显,顰:颦,顱:颅,顳:颞,顴:颧,風:风,颭:飐,颮:飑,颯:飒,颱:台,颳:刮,颶:飓,颸:飔,颺:飏,颻:飖,颼:飕,飀:飗,飄:飘,飆:飙,飈:飚,飛:飞,飠:饣,飢:饥,飣:饤,飥:饦,飩:饨,飪:饪,飫:饫,飭:饬,飯:饭,飱:飧,飲:饮,飴:饴,飼:饲,飽:饱,飾:饰,飿:饳,餃:饺,餄:饸,餅:饼,餈:糍,餉:饷,養:养,餌:饵,餎:饹,餏:饻,餑:饽,餒:馁,餓:饿,餕:馂,餖:饾,餘:余,餚:肴,餛:馄,餜:馃,餞:饯,餡:馅,館:馆,餬:糊,餱:糇,餳:饧,餵:喂,餶:馉,餷:馇,餺:馎,餼:饩,餾:馏,餿:馊,饁:馌,饃:馍,饅:馒,饈:馐,饉:馑,饊:馓,饋:馈,饌:馔,饑:饥,饒:饶,饗:飨,饜:餍,饞:馋,饢:馕,馬:马,馭:驭,馮:冯,馱:驮,馳:驰,馴:驯,馹:驲,駁:驳,駐:驻,駑:驽,駒:驹,駔:驵,駕:驾,駘:骀,駙:驸,駛:驶,駝:驼,駟:驷,駡:骂,駢:骈,駭:骇,駰:骃,駱:骆,駸:骎,駿:骏,騁:骋,騂:骍,騅:骓,騌:骔,騍:骒,騎:骑,騏:骐,騖:骛,騙:骗,騤:骙,騧:䯄,騫:骞,騭:骘,騮:骝,騰:腾,騶:驺,騷:骚,騸:骟,騾:骡,驀:蓦,驁:骜,驂:骖,驃:骠,驄:骢,驅:驱,驊:骅,驌:骕,驍:骁,驏:骣,驕:骄,驗:验,驚:惊,驛:驿,驟:骤,驢:驴,驤:骧,驥:骥,驦:骦,驪:骊,驫:骉,骯:肮,髏:髅,髒:脏,體:体,髕:髌,髖:髋,髮:发,鬆:松,鬍:胡,鬚:须,鬢:鬓,鬥:斗,鬧:闹,鬨:哄,鬩:阋,鬮:阄,鬱:郁,鬹:鬶,魎:魉,魘:魇,魚:鱼,魛:鱽,魢:鱾,魨:鲀,魯:鲁,魴:鲂,魷:鱿,魺:鲄,鮁:鲅,鮃:鲆,鮊:鲌,鮋:鲉,鮍:鲏,鮎:鲇,鮐:鲐,鮑:鲍,鮒:鲋,鮓:鲊,鮚:鲒,鮜:鲘,鮝:鲞,鮞:鲕,鮣:䲟,鮦:鲖,鮪:鲔,鮫:鲛,鮭:鲑,鮮:鲜,鮳:鲓,鮶:鲪,鮺:鲝,鯀:鲧,鯁:鲠,鯇:鲩,鯉:鲤,鯊:鲨,鯒:鲬,鯔:鲻,鯕:鲯,鯖:鲭,鯗:鲞,鯛:鲷,鯝:鲴,鯡:鲱,鯢:鲵,鯤:鲲,鯧:鲳,鯨:鲸,鯪:鲮,鯫:鲰,鯰:鲶,鯴:鲺,鯷:鳀,鯽:鲫,鯿:鳊,鰁:鳈,鰂:鲗,鰃:鳂,鰆:䲠,鰈:鲽,鰉:鳇,鰌:䲡,鰍:鳅,鰏:鲾,鰐:鳄,鰒:鳆,鰓:鳃,鰛:鳁,鰜:鳒,鰟:鳑,鰠:鳋,鰣:鲥,鰥:鳏,鰧:䲢,鰨:鳎,鰩:鳐,鰭:鳍,鰮:鳁,鰱:鲢,鰲:鳌,鰳:鳓,鰵:鳘,鰷:鲦,鰹:鲣,鰺:鲹,鰻:鳗,鰼:鳛,鰾:鳔,鱂:鳉,鱅:鳙,鱈:鳕,鱉:鳖,鱒:鳟,鱔:鳝,鱖:鳜,鱗:鳞,鱘:鲟,鱝:鲼,鱟:鲎,鱠:鲙,鱣:鳣,鱤:鳡,鱧:鳢,鱨:鲿,鱭:鲚,鱯:鳠,鱷:鳄,鱸:鲈,鱺:鲡,鳥:鸟,鳧:凫,鳩:鸠,鳬:凫,鳲:鸤,鳳:凤,鳴:鸣,鳶:鸢,鳾:䴓,鴆:鸩,鴇:鸨,鴉:鸦,鴒:鸰,鴕:鸵,鴛:鸳,鴝:鸲,鴞:鸮,鴟:鸱,鴣:鸪,鴦:鸯,鴨:鸭,鴯:鸸,鴰:鸹,鴴:鸻,鴷:䴕,鴻:鸿,鴿:鸽,鵁:䴔,鵂:鸺,鵃:鸼,鵐:鹀,鵑:鹃,鵒:鹆,鵓:鹁,鵜:鹈,鵝:鹅,鵠:鹄,鵡:鹉,鵪:鹌,鵬:鹏,鵮:鹐,鵯:鹎,鵰:雕,鵲:鹊,鵷:鹓,鵾:鹍,鶄:䴖,鶇:鸫,鶉:鹑,鶊:鹒,鶓:鹋,鶖:鹙,鶘:鹕,鶚:鹗,鶡:鹖,鶥:鹛,鶩:鹜,鶪:䴗,鶬:鸧,鶯:莺,鶲:鹟,鶴:鹤,鶹:鹠,鶺:鹡,鶻:鹘,鶼:鹣,鶿:鹚,鷀:鹚,鷁:鹢,鷂:鹞,鷄:鸡,鷉:䴘,鷊:鹝,鷓:鹧,鷖:鹥,鷗:鸥,鷙:鸷,鷚:鹨,鷥:鸶,鷦:鹪,鷫:鹔,鷯:鹩,鷲:鹫,鷳:鹇,鷴:鹇,鷸:鹬,鷹:鹰,鷺:鹭,鷽:鸴,鸂:㶉,鸇:鹯,鸊:䴙,鸌:鹱,鸏:鹲,鸕:鸬,鸘:鹴,鸚:鹦,鸛:鹳,鸝:鹂,鸞:鸾,鹵:卤,鹹:咸,鹺:鹾,鹼:碱,鹽:盐,麗:丽,麥:麦,麩:麸,麪:面,麫:面,麯:曲,麴:曲,麵:面,麼:么,麽:么,黃:黄,黌:黉,點:点,黨:党,黲:黪,黴:霉,黶:黡,黷:黩,黽:黾,黿:鼋,鼂:鼌,鼉:鼍,鼕:冬,鼴:鼹,齊:齐,齋:斋,齎:赍,齏:齑,齒:齿,齔:龀,齕:龁,齗:龂,齙:龅,齜:龇,齟:龃,齠:龆,齡:龄,齣:出,齦:龈,齧:啮,齪:龊,齬:龉,齲:龋,齶:腭,齷:龌,龍:龙,龎:厐,龐:庞,龑:䶮,龔:龚,龕:龛,龜:龟,鿁:䜤,鿓:鿒";

let _s2tMap = null;
function s2tMap() {
  if (_s2tMap) return _s2tMap;
  const m = {};
  const arr = T2S_PAIRS.split(",");
  for (let i = 0; i < arr.length; i++) {
    const p = arr[i].split(":");
    if (p.length === 2 && p[0] && p[1]) m[p[0]] = p[1];
  }
  _s2tMap = m;
  return m;
}

/** 简体 → 繁体（不做反向转换；繁体输入原样返回） */
function toTraditional(str) {
  const m = s2tMap();
  let out = "";
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    out += m[c] || c;
  }
  return out;
}

/** 生成简繁两种写法，相同则只返回一份 */
function zhVariants(str) {
  const a = String(str || "");
  const b = toTraditional(a);
  if (a === b) return [a];
  return [a, b];
}

function buildKeywords(want) {
  const out = [];
  const push = (s) => {
    const v = String(s || "").replace(/\s+/g, " ").trim();
    if (v && out.indexOf(v) < 0) out.push(v);
  };
  const first = splitSingers(want.singer)[0] || "";
  // 歌名 + 歌手（召回最好，尤其酷狗）
  if (want.name && first) push(want.name + " " + first);
  if (want.name && want.album) push(want.name + " " + want.album);
  if (want.name) push(want.name);
  // 实在不行再单搜歌手
  if (first) push(first);
  const base = out.length ? out : [String(want.name || "")];

  // 再补一套繁体写法。简繁在各平台之间并不互通——
  // 实测《原諒我不明白你的悲傷》只有繁体写法能在 YouTube 命中。
  const withTrad = [];
  for (let i = 0; i < base.length; i++) {
    const vs = zhVariants(base[i]);
    for (let j = 0; j < vs.length; j++) {
      const v = vs[j].replace(/\s+/g, " ").trim();
      if (v && withTrad.indexOf(v) < 0) withTrad.push(v);
    }
  }
  return withTrad;
}


/**
 * 依次尝试多个关键词，返回第一个有结果的。
 * 用于「简体写法 + 繁体写法」两路召回：
 * 各平台对简繁的互通程度不一样，YouTube 基本不互通，
 * 所以不能只试一个就放弃。
 */
async function searchAny(fn, keywords, isEnd) {
  const kws = keywords || [];
  for (let i = 0; i < kws.length; i++) {
    try {
      const list = await fn(kws[i]);
      if (list && list.length) return list;
      if (isEnd && isEnd(kws[i])) return list || [];
    } catch (e) { /* 换下一个关键词 */ }
  }
  return [];
}

/* ============================================================
 * 通道 A：COCO（wy / tx / kg / mg）
 * ============================================================ */
const lossless = (q) => /flac/i.test(String(q || ""));

function cocoExtra(provider, quality) {
  const fl = lossless(quality);
  switch (provider) {
    case "netease":
      return { selectedLevel: fl ? "lossless" : quality === "128k" ? "standard" : "exhigh" };
    case "qq":
      return fl ? { selectedParser: "xcvts", selectedFormat: "flac" }
                : { selectedParser: "vkeys", selectedFormat: "mp3" };
    case "kugou":
      return fl ? { selectedParser: "baka", selectedFormat: "flac" }
                : { selectedParser: "90svip", selectedFormat: "mp3" };
    default: return {};
  }
}

/** 酷狗 CDN 用网宿通用证书，SAN 只含 *.service.kugou.com，两级子域 https 必失败 */
function fixUrl(provider, url) {
  if (!url || typeof url !== "string") return url;
  if (provider === "kugou") return url.replace(/^https:\/\//i, "http://");
  return url;
}

const cocoHeaders = () => ({ Referer: COCO + "/", Accept: "application/json" });

async function cocoFetchUrl(provider, id, quality, baseExtra) {
  const extra = Object.assign({}, baseExtra || {}, cocoExtra(provider, quality));
  const res = await httpGet(COCO + "/api/url",
    { id: id, provider: provider, extra: Object.keys(extra).length ? JSON.stringify(extra) : "" },
    cocoHeaders());
  if (!res || !res.url) throw new Error((res && (res.error || res.message)) || "未返回地址");
  const url = fixUrl(provider, res.url);
  if (!(await verifyPlayable(url))) throw new Error("地址不可播（可能已过期）");
  return url;
}

/**
 * COCO 搜索。
 * ⚠️ 实测：q=酷狗 时后端会**随机返回 0 条**（同一查询连打 5 次得 10,0,0,0,10），
 *    不是限流也不是简繁问题。所以空结果要重试，最多 3 次。
 */
/**
 * COCO 搜索。
 *
 * ⚠️ 两个反直觉的实测结论（2026-10-17）：
 *   1. 酷狗那条链路会**随机返回 0 条**（同一查询连打 10 次：9 次 0、1 次 10），
 *      不是限流也不是简繁问题，是后端自己的毛病。
 *   2. 但重试是有代价的：空结果时如果退避重试 6 次，单次搜索能拖到 4.7 秒。
 *
 * 所以策略改成「**限时重试**」：给整个重试过程一个 2.5 秒预算，
 * 超预算就立刻放弃（结果交给跨平台兜底），不拖累整体搜索。
 * 命中缓存则直接返回。
 */

/* ============================================================
 * 搜索缓存
 * 同一关键词短时间内重复搜（打错字重搜、切回列表再进）直接命中，
 * 不用把所有平台重打一遍。5 分钟过期。
 * ============================================================ */
const SEARCH_CACHE = {};
const SEARCH_CACHE_TTL = 5 * 60 * 1000;

function cacheKey(scope, a, b) {
  return scope + "|" + String(a) + "|" + String(b);
}
function cacheGet(scope, a, b) {
  const k = cacheKey(scope, a, b);
  const v = SEARCH_CACHE[k];
  if (!v) return null;
  if (Date.now() - v.at > SEARCH_CACHE_TTL) { delete SEARCH_CACHE[k]; return null; }
  return v.data;
}
function cachePut(scope, a, b, data) {
  const k = cacheKey(scope, a, b);
  // 简单防膨胀：超过 200 条就清掉最旧的一半
  const keys = Object.keys(SEARCH_CACHE);
  if (keys.length > 200) {
    keys.sort((x, y) => SEARCH_CACHE[x].at - SEARCH_CACHE[y].at);
    for (let i = 0; i < 100; i++) delete SEARCH_CACHE[keys[i]];
  }
  SEARCH_CACHE[k] = { at: Date.now(), data: data };
}

/* ⚠️ 2500 → 1500（2026-10-19）：COCO 掉零是后端随机现象，重试 2.5 秒
   换回来的命中率提升很有限（实测「脆弱少女组」QQ 那次整整跑了 2.7s 仍然 0 条），
   代价却是把整次搜索从 1.5s 拖到 2.7s。1.5 秒足够覆盖「第一次抖动、
   第二次就回来」的常见情况。 */
const COCO_RETRY_BUDGET_MS = 1500;

async function cocoSearch(provider, keyword) {
  const ck = cacheGet("coco", provider, keyword);
  if (ck) return ck;

  // 酷狗和网易云/QQ/咪咕共用 COCO 同一域名，并发时后端会限流它，
  // 表现是「随机 0 条 + 拖到 3 秒」。它掉零时重试几乎没用，
  // 反而加重限流，所以给它一个更短的预算，快速放弃交给别的平台。
  const budget = provider === "kugou" ? 700 : COCO_RETRY_BUDGET_MS;

  const t0 = Date.now();
  let last = [];
  let attempt = 0;
  while (attempt < 8) {
    try {
      const s = await httpGet(COCO + "/api/search",
        { q: keyword, provider: provider, limit: 10, offset: 0 }, cocoHeaders());
      const items = (s && s.items) || [];
      if (items.length) {
        cachePut("coco", provider, keyword, items);
        return items;
      }
      last = items;
    } catch (e) { /* 继续重试 */ }
    attempt++;
    // 预算用完就收手，别为了凑满重试次数把整次搜索拖垮
    if (Date.now() - t0 > budget) break;
    await new Promise((r) => setTimeout(r, 180 + attempt * 120));
  }
  return last;
}

/* ============================================================
 * 通道 B：hi.cn（wyy / kuwo）
 * ============================================================ */
const HI_BITRATE = { flac: 999, "320k": 320, "128k": 128 };

async function hiSearch(platform, keyword, size) {
  const s = await httpPost(HI + "?act=search",
    { platform: platform, keyword: keyword, id: "", page: 1, size: size || 5 }, HI_HEADERS);
  return (s && s.data && s.data.list) || [];
}

async function hiFetchUrl(platform, item, quality) {
  const br = HI_BITRATE[lossless(quality) ? "flac" : quality === "128k" ? "128k" : "320k"] || 320;
  const u = await httpPost(HI + "?act=getUrl", {
    platform: platform, songid: item.id, format: "mp3", bitrate: br,
    time: item.time, sign: item.sign,
  }, HI_HEADERS);
  const url = u && u.data && u.data.url;
  if (!url) throw new Error((u && u.msg) || "hi.cn 未返回地址");
  if (!(await verifyPlayable(url))) throw new Error("hi.cn 地址不可播");
  return url;
}

/* ============================================================
 * 通道 C：网易云官方 outer（免费歌 302 直链）
 * ============================================================ */
async function outerNetease(id) {
  const r = await axios_1.get(NETEASE_OUTER.replace("{id}", encodeURIComponent(String(id))), {
    timeout: 12000,
    responseType: "arraybuffer",
    maxRedirects: 0,
    headers: { "User-Agent": UA },
    validateStatus: () => true,
  });
  const loc = (r.headers && r.headers.location) || "";
  if (loc.indexOf("http") !== 0 || loc.indexOf("/404") >= 0) {
    throw new Error("outer 无版权/VIP（302→404）");
  }
  return loc;
}

/* ============================================================
 * 通道 D：酷我官方直连（搜索 → convert_url）
 * ============================================================ */
const KUWO_FORMAT = { flac: ["flac", "mp3"], "320k": ["mp3", "aac"], "128k": ["mp3", "aac"] };

async function kuwoOfficialSearch(keyword, size) {
  const raw = await httpGet(KUWO_SEARCH, {
    all: keyword, ft: "music", itemset: "web_2013", client: "kt",
    pn: 0, rn: size || 5, rformat: "json", encoding: "utf8", mobi: 1,
  }, { "User-Agent": UA_MOBILE, Cookie: "kw_token=ABC", Referer: "http://www.kuwo.cn/" });
  let j = raw;
  if (typeof raw === "string") { try { j = JSON.parse(raw); } catch (e) { return []; } }
  return (j && j.abslist) || [];
}

async function kuwoOfficialUrl(rid, quality) {
  const fmts = KUWO_FORMAT[lossless(quality) ? "flac" : quality === "128k" ? "128k" : "320k"];
  let lastErr = "无可用格式";
  for (let i = 0; i < fmts.length; i++) {
    const u = KUWO_CONVERT.replace("{fmt}", fmts[i]).replace("{rid}", encodeURIComponent(String(rid)));
    const r = await httpGet(u, null, { "User-Agent": UA_MOBILE, Cookie: "kw_token=ABC" });
    const s = typeof r === "string" ? r.trim() : "";
    if (s.indexOf("http") !== 0) { lastErr = "anti.s: " + String(r).slice(0, 40); continue; }
    if (await verifyPlayable(s)) return s;
    lastErr = "地址不可播";
  }
  throw new Error(lastErr);
}

/* ============================================================
 * 通道 E：溯音酷我
 * ============================================================ */
const SUYIN_BR = { flac: 1, "320k": 5, "128k": 7 };

function parseSuyinMessage(msg) {
  const out = {};
  String(msg).split("\n").forEach((line) => {
    const i = line.indexOf("：");
    if (i < 0) return;
    const k = line.slice(0, i).replace(/[±\s]/g, "");
    const v = line.slice(i + 1).replace(/±/g, "").trim();
    if (k === "歌名") out.song = v;
    if (k === "歌手") out.singer = v;
  });
  return out;
}

async function suyinKuwo(want, quality) {
  const br = SUYIN_BR[lossless(quality) ? "flac" : quality === "128k" ? "128k" : "320k"] || 1;
  const kws = buildKeywords(want);
  let lastErr = "无匹配结果";
  for (let i = 0; i < kws.length; i++) {
    let res;
    try {
      res = await httpGet(SUYIN_KUWO, { msg: kws[i], n: 1, br: br }, { "User-Agent": UA_MOBILE });
    } catch (e) { lastErr = e.message; continue; }
    let url = res && res.data && res.data.url;
    let meta = null;
    if (!url && res && res.message) {
      const m = String(res.message).match(/音乐链接[：:](\S+)/);
      if (m) { url = m[1]; meta = parseSuyinMessage(res.message); }
    }
    if (!url) { lastErr = (res && res.message) || "未返回地址"; continue; }

    // ⚠️ 这里必须用**严格**匹配。溯音只返回 1 条（n:1），
    //    如果拿宽松的 titleMatch（双向包含），
    //    「第100章…我们的怪怎么都没有了」会被当成「怎麼都沒有了」直接返回，
    //    用户就听到听书了。这条事故真发生过。
    if (meta && meta.song) {
      if (!isDefinitelySameSong({ title: meta.song, artist: meta.singer }, want)) {
        lastErr = "溯音返回的不是同一首歌（" + String(meta.song).slice(0, 16) + "）";
        continue;
      }
    } else {
      // 拿不到歌名就没法确认，兜底场景下宁可不接受
      lastErr = "溯音未返回歌名，无法确认是否同一首";
      continue;
    }
    if (await verifyPlayable(url)) return url;
    lastErr = "地址已过期/不可播";
  }
  throw new Error(lastErr);
}

async function changqingKuwo(id, quality) {
  // ⚠️ 长青是纯拼模板 URL：给什么 id 就返回什么，内部不做任何校验。
  //    只能用于「本平台直取」（id 来自用户点的那首歌），
  //    绝不能当跨平台兜底用 —— 兜底时 id 是别的平台的，必然串歌。
  if (!id) throw new Error("长青只能用于本平台直取");
  const level = lossless(quality) ? "lossless" : quality === "128k" ? "standard" : "exhigh";
  const url = CHANGQING_KUWO.replace("{id}", encodeURIComponent(String(id))).replace("{level}", encodeURIComponent(level));
  if (!(await verifyPlayable(url))) throw new Error("长青地址不可播");
  return url;
}

/* ============================================================
 * 单平台解析：每平台多条通道
 * ============================================================ */
async function resolveNetease(id, want, quality) {
  const errors = [];
  // 1. COCO ID 直取（能出 FLAC 2000）
  if (id) {
    try { return await cocoFetchUrl("netease", id, quality); }
    catch (e) { errors.push("coco: " + e.message); }
    // 2. 官方 outer（免费歌 302）
    try { return await outerNetease(id); }
    catch (e) { errors.push("outer: " + e.message); }
    // 3. hi.cn ID 直取
    try {
      const items = await hiSearch("wyy", want.name, 5);
      const hit = items.find((x) => titleMatch(x.name, want.name));
      if (hit) return await hiFetchUrl("wyy", hit, quality);
      errors.push("hi.cn: 无匹配");
    } catch (e) { errors.push("hi.cn: " + e.message); }
  }
  // 4. COCO 搜索
  try {
    const items = await searchAny((kw) => cocoSearch("netease", kw), buildKeywords(want));
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!isDefinitelySameSong(it, want)) continue;
      try { return await cocoFetchUrl("netease", it.id, quality, it.extra); }
      catch (e) { errors.push("coco搜索: " + e.message); }
    }
  } catch (e) { errors.push("coco搜索: " + e.message); }
  throw new Error(errors.join(" | "));
}

async function resolveQQ(id, want, quality) {
  const errors = [];
  if (id) {
    try { return await cocoFetchUrl("qq", id, quality); }
    catch (e) { errors.push("coco直取: " + e.message); }
  }
  try {
    const items = await searchAny((kw) => cocoSearch("qq", kw), buildKeywords(want));
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!isDefinitelySameSong(it, want)) continue;
      try { return await cocoFetchUrl("qq", it.id, quality, it.extra); }
      catch (e) { errors.push("coco搜索: " + e.message); }
    }
  } catch (e) { errors.push("coco搜索: " + e.message); }
  throw new Error(errors.join(" | "));
}

async function resolveKugou(id, want, quality) {
  const errors = [];
  // 1. COCO 直取（出 FLAC，注意 http 修正）
  if (id) {
    try { return await cocoFetchUrl("kugou", id, quality); }
    catch (e) { errors.push("coco直取: " + e.message); }
  }
  // 2. hi.cn 搜索（只需一次搜索 + 一次取流，比 COCO 搜索快）
  try {
    const items = await searchAny((kw) => hiSearch("kuwo", kw, 8), buildKeywords(want));
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!isDefinitelySameSong(it, want)) continue;
      try { return await hiFetchUrl("kuwo", it, quality); }
      catch (e) { errors.push("hi.cn: " + e.message); }
    }
  } catch (e) { errors.push("hi.cn: " + e.message); }
  // 3. COCO 搜索
  try {
    const items = await searchAny((kw) => cocoSearch("kugou", kw), buildKeywords(want));
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!isDefinitelySameSong(it, want)) continue;
      try { return await cocoFetchUrl("kugou", it.id, quality, it.extra); }
      catch (e) { errors.push("coco搜索: " + e.message); }
    }
  } catch (e) { errors.push("coco搜索: " + e.message); }
  throw new Error(errors.join(" | "));
}

/* ============================================================
 * 通道 F：JOOX（需要登录 Cookie）
 * ============================================================ */
function getJooxCookie() {
  try {
    const vars = (typeof env !== "undefined" && env && env.userVariables) || {};
    return (vars.jooxCookie || "").trim();
  } catch (e) { return ""; }
}

/** 从 cookie 串里取某个键
 *  用字符串扫描而不是正则：正则里的 s 之类在跨层传递时容易被吃掉转义
 */
function cookieVal(cookieStr, key) {
  const parts = String(cookieStr || '').split(';');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].trim();
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    if (p.slice(0, eq) === key) return p.slice(eq + 1);
  }
  return '';
}

function jooxSign(params) {
  const qs = Object.keys(params)
    .map((k) => k + "=" + encodeURIComponent(params[k]))
    .join("&");
  return md5Hex(JOOX_SALT + qs);
}

async function jooxSearch(keyword, size) {
  const ck = getJooxCookie();
  const res = await httpGet(JOOX_API + "/openjoox/v3/search",
    { country: "hk", lang: "zh_TW", keyword: keyword },
    ck ? { Cookie: ck, Referer: "https://www.joox.com/hk" } : { Referer: "https://www.joox.com/hk" });
  const out = [];
  const secs = (res && res.section_list) || [];
  for (let i = 0; i < secs.length; i++) {
    const items = secs[i].item_list || [];
    for (let j = 0; j < items.length; j++) {
      const songs = items[j].song || [];
      for (let k = 0; k < songs.length; k++) {
        const si = songs[k].song_info;
        if (!si || !si.id) continue;
        out.push({
          id: si.id,
          title: si.name || "",
          artist: ((si.artist_list || [])[0] || {}).name || "",
          album: si.album_name || "",
          artwork: ((si.images || [])[0] || {}).url || "",
          duration: (si.play_duration || 0) * 1000,
          vip: si.vip_flag,
        });
        if (out.length >= (size || 20)) return out;
      }
    }
  }
  return out;
}

/**
 * 取流。
 * ⚠️ id 放进路径时**不能** URL 编码 —— 编码后服务端用解码前的值验签，
 *    MD5 必然对不上，返回 401 Invalid secret key。
 * ⚠️ 必须带完整的 cookie（含 HttpOnly 的 session_key / user_type / wmid），
 *    少了任何一个都会被降级成 30 秒试听。
 */
async function jooxFetchUrl(songId, quality) {
  const ck = getJooxCookie();
  if (!ck) throw new Error("未配置 JOOX Cookie");
  const uid = cookieVal(ck, "uid");
  const usk = cookieVal(ck, "X-Auth-Ticket");
  if (!uid || !usk) throw new Error("Cookie 缺少 uid 或 X-Auth-Ticket");

  const params = {
    country: "hk", lang: "zh_TW", lyric: 1, fs: 1, im: 0,
    uid: uid, usk: usk, id: songId,
  };
  const secret = jooxSign(params);
  const url = JOOX_API + "/openjoox2/v1/track/" + songId +
    "?country=hk&lang=zh_TW&lyric=1&fs=1&im=0" +
    "&uid=" + encodeURIComponent(uid) +
    "&usk=" + encodeURIComponent(usk) +
    "&secret=" + secret;

  const res = await httpGet(url, null, {
    Cookie: ck,
    Referer: "https://www.joox.com/hk",
    Origin: "https://www.joox.com",
    Accept: "application/json",
  });

  if (!res || res.error) throw new Error((res && res.error) || "无响应");
  const list = res.play_url_list || [];
  if (!list.length) throw new Error("未返回地址");

  const clean = list.map((u) => String(u).replace(/&amp;/g, "&"));
  // C4xx = 320k，C2xx = 128k；super 优先取最长的那条
  let pick = clean[0];
  if (lossless(quality) || quality === "320k") {
    pick = clean.find((u) => /\/C4\d\d/.test(u)) || clean[0];
  } else {
    pick = clean.find((u) => /\/C2\d\d/.test(u)) || clean[clean.length - 1];
  }
  if (!(await verifyPlayable(pick))) throw new Error("JOOX 地址不可播");
  return pick;
}

/* ============================================================
 * 通道 G：YouTube
 * ============================================================ */
function ytCtx(c) {
  return {
    client: {
      clientName: c === YT_IOS ? "IOS" : "ANDROID",
      clientVersion: c.version,
      hl: "zh-CN", gl: "CN",
      userAgent: c.ua,
      androidSdkVersion: c.sdk,
    },
    user: { lockedSafetyMode: false },
    request: { useSsl: true },
  };
}

function ytHeaders(c) {
  return {
    "Content-Type": "application/json",
    "User-Agent": c.ua,
    "X-YouTube-Client-Name": String(c.nameId),
    "X-YouTube-Client-Version": c.version,
  };
}

/** "3:29" / "1:02:33" → 秒 */
/**
 * 把各平台五花八门的时长写法统一成秒。
 * 实测见过的形态：
 *   "4:12"   Bilibili / 酷我搜索
 *   "03:27"  网易云（COCO）
 *   "1:02:33" 长视频
 *   257       酷我 ft=music 的 DURATION（纯秒数）
 *   251       咪咕的 duration（纯秒数）
 *   0 / ""    拿不到
 */
function ytDurSec(s) {
  if (s === undefined || s === null || s === "") return 0;
  const str = String(s).trim();
  // 纯数字 = 已经是秒
  if (/^d+(?:.d+)?$/.test(str)) return Math.round(Number(str));
  const p = str.split(":").map(Number);
  if (p.length === 3 && p.every((n) => !isNaN(n))) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2 && p.every((n) => !isNaN(n))) return p[0] * 60 + p[1];
  return 0;
}

/* ============================================================
 * YouTube Music 目录（music.youtube.com 的 WEB_REMIX innertube）
 *
 * 为什么需要它：国内五家平台上「歌手」条目质量差异极大 ——
 *   搜「李志」，网易云给的是一个只有 2 首的野鸡同名号（musicSize=2），
 *   QQ 的歌手接口 500003 已死，酷狗只回「李志辉 / 李志强 / 李志国…」，
 *   酷我/咪咕的歌手库压根没有这个条目。
 * 但李志在 YouTube Music 上有 **13 张官方专辑 110 首**（ATV 音频，
 * 不是搬运视频），是唯一完整可信的目录。
 *
 * ⚠️ 这里的 browse 走 music.youtube.com 的 WEB_REMIX 客户端，
 *    和取流用的 ANDROID/VISIONOS 是两套东西，互不影响：
 *    取流仍然走 ytPlayer（ANDROID/VISIONOS 才拿得到 streamingData）。
 * ============================================================ */
const YTM_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
let ytmKey = "", ytmVisitor = "", ytmVer = "", ytmName = "67", ytmAt = 0;

async function ytmBootstrap() {
  if (ytmKey && ytmVer && Date.now() - ytmAt < 30 * 60 * 1000) return;
  const r = await axios_1.get("https://music.youtube.com/", {
    timeout: 20000, responseType: "text", transformResponse: [(x) => x],
    headers: { "User-Agent": YTM_UA }, validateStatus: () => true,
  });
  const d = String(r.data || "");
  const g = (re) => (d.match(re) || [])[1] || "";
  ytmKey = g(/"INNERTUBE_API_KEY":"([^"]+)"/);
  ytmVisitor = g(/"VISITOR_DATA":"([^"]+)"/);
  ytmVer = g(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/);
  ytmName = g(/"INNERTUBE_CONTEXT_CLIENT_NAME":(\d+)/) || "67";
  ytmAt = Date.now();
  if (!ytmKey || !ytmVer) throw new Error("ytm bootstrap failed");
}

function ytmCtx() {
  return {
    client: {
      clientName: "WEB_REMIX", clientVersion: ytmVer,
      hl: "zh-TW", gl: "US",
      visitorData: ytmVisitor,
    },
    user: { lockedSafetyMode: false },
    request: { useSsl: true },
  };
}

async function ytmCall(path, body) {
  await ytmBootstrap();
  /* ⚠️ 调用方写的是 ytmCall("search", { context: ytmCtx(), ... })，
     而 ytmCtx() 在**传参前**就求值了 —— 首次运行时 bootstrap 还没跑，
     于是 clientVersion / visitorData 全是空串，服务端直接 404
     "Requested entity was not found"。这里统一用 bootstrap 后的真值覆盖。 */
  if (body && body.context && body.context.client) {
    body.context.client.clientVersion = ytmVer;
    body.context.client.visitorData = ytmVisitor;
  }
  const send = () => axios_1.post(
    "https://music.youtube.com/youtubei/v1/" + path + "?prettyPrint=false&key=" + ytmKey,
    JSON.stringify(body),
    {
      timeout: 20000, validateStatus: () => true,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": YTM_UA,
        "X-YouTube-Client-Name": ytmName,
        "X-YouTube-Client-Version": ytmVer,
        "X-Goog-Visitor-Id": ytmVisitor,
        Origin: "https://music.youtube.com",
        Referer: "https://music.youtube.com/",
      },
    }
  );
  let r = await send();
  /* ⚠️ 冷启动陷阱：刚抓到的 visitorData 第一次请求**稳定**返回
     404 "Requested entity was not found"（实测连打三次都是这个规律：
     第一次 404、第二次 200）。这不是参数错，是这个 visitor 还没被激活。
     所以 404 时原样重发一次，不要重建 bootstrap（重建会换新 visitor，又 404）。 */
  if (r && r.status === 404) {
    await new Promise((res) => setTimeout(res, 150));
    r = await send();
  }
  return r.data;
}

/** 递归捞指定 key 的 renderer（不依赖层级，YouTube 结构改版也不会挂） */
function ytmCollect(root, keyName) {
  const out = [];
  (function walk(o, d) {
    if (!o || typeof o !== "object" || d > 30) return;
    if (Array.isArray(o)) { for (let i = 0; i < o.length; i++) walk(o[i], d + 1); return; }
    const ks = Object.keys(o);
    for (let i = 0; i < ks.length; i++) {
      const k = ks[i];
      if (k === keyName && o[k]) out.push(o[k]);
      walk(o[k], d + 1);
    }
  })(root, 0);
  return out;
}

/** runs 数组 → 纯文本 */
function ytmRuns(node) {
  if (!node) return "";
  if (node.simpleText) return String(node.simpleText);
  return ((node.runs || []).map((r) => r.text || "")).join("");
}

/** 从 musicResponsiveListItemRenderer 取一条曲目 */
function ytmRowToTrack(v, artistFallback, albumFallback) {
  const flex = v.flexColumns || [];
  const col = (i) => (flex[i] && flex[i].musicResponsiveListItemFlexColumnRenderer &&
    ytmRuns(flex[i].musicResponsiveListItemFlexColumnRenderer.text)) || "";
  const title = col(0);
  if (!title) return null;
  // 第 2 列常常是空的（ATV 音轨没有「歌手」列），第 3 列是播放量
  const mid = col(1);
  const plays = col(2);
  let artist = mid && !/plays|播放|次/i.test(mid) ? mid : "";
  if (!artist) artist = artistFallback || "";
  let duration = 0;
  const fixed = v.fixedColumns || [];
  for (let i = 0; i < fixed.length; i++) {
    const f = fixed[i] && fixed[i].musicResponsiveListItemFixedColumnRenderer;
    if (f) { duration = ytDurSec(ytmRuns(f.text)) * 1000; if (duration) break; }
  }
  const s = JSON.stringify(v);
  let vid = v.playlistItemData && v.playlistItemData.videoId;
  if (!vid) {
    const m = s.match(/"videoId":"([A-Za-z0-9_-]{11})"/);
    vid = m && m[1];
  }
  if (!vid) return null;
  // ATV = 唱片公司官方音轨；MUSIC_VIDEO_TYPE_OMV 才是 MV/官方视频
  const atv = /MUSIC_VIDEO_TYPE_ATV/.test(s);
  const art = (s.match(/"thumbnails":\[\{"url":"([^"]+)"/) || [])[1] || "";
  return {
    id: vid,
    platform: "YouTube",
    title: title,
    artist: artist,
    album: albumFallback || "",
    artwork: art || "",
    duration: duration,
    _provider: "youtube",
    _atv: atv,
    _plays: plays,
  };
}

/** 搜歌手 → 拿艺人 channelId（只认 MUSIC_PAGE_TYPE_ARTIST 的那条） */
async function ytmFindArtist(name) {
  const q = String(name || "").trim();
  if (!q) return null;
  /* ⚠️ params 是「只看艺人」的过滤位，实测 EgWKAQIgAWoKEAkQBRAKEAMQBA%3D%3D
     能稳定只回艺人。不过过滤失效时下面还会再按 pageType 兜一遍。 */
  const d = await ytmCall("search", {
    context: ytmCtx(), query: q, params: "EgWKAQIgAWoKEAkQBRAKEAMQBA%3D%3D",
  });
  const rows = ytmCollect(d, "musicResponsiveListItemRenderer");
  const want = singerNorm(q);
  const cands = [];
  for (let i = 0; i < rows.length; i++) {
    const v = rows[i];
    const be = v.navigationEndpoint && v.navigationEndpoint.browseEndpoint;
    const cfg = be && be.browseEndpointContextSupportedConfigs &&
      be.browseEndpointContextSupportedConfigs.browseEndpointContextMusicConfig;
    const pg = cfg && cfg.pageType;
    if (pg !== "MUSIC_PAGE_TYPE_ARTIST") continue;
    const id = be.browseId;
    if (!id || String(id).indexOf("UC") !== 0) continue;
    const nm = ytmRuns((v.flexColumns || [])[0] &&
      v.flexColumns[0].musicResponsiveListItemFlexColumnRenderer &&
      v.flexColumns[0].musicResponsiveListItemFlexColumnRenderer.text) ||
      (v.title && ytmRuns(v.title)) || "";
    /* ⚠️ 名字必须真正相等 —— 搜「李志」YouTube 也会回「李志多」，
       那是另一个人（1 个订阅者）。跟别处同一道闸。 */
    if (singerNorm(nm) !== want) continue;
    const s = JSON.stringify(v);
    const subs = (s.match(/\"text\":\"([\d.,]+[KMB]? subscribers?)\"/) || [])[1] || "";
    cands.push({ id: id, name: nm, subs: subs });
  }
  if (!cands.length) return null;
  /* 同名多个频道时取订阅数最大的 —— 真身 39.4K，山寨 1 个。 */
  const num = (t) => {
    const m = String(t || "").match(/([\d.]+)\s*([KMB])?/i);
    if (!m) return 0;
    const n = Number(m[1]) || 0;
    const u = (m[2] || "").toUpperCase();
    return u === "K" ? n * 1e3 : u === "M" ? n * 1e6 : u === "B" ? n * 1e9 : n;
  };
  cands.sort((a, b) => num(b.subs) - num(a.subs));
  return cands[0];
}

/**
 * 艺人页 → 热门歌曲（页面顶部那一排 musicResponsiveListItemRenderer）。
 *
 * ⚠️ 这一路很重要：李志的代表作《關於鄭州的記憶》《熱河》《天空之城》
 *    都是单曲，**不在任何一张专辑的曲目里**，
 *    只顺着专辑拉曲目会把它们整个漏掉 —— 列表头部于是全是
 *    《門》《日》《死人》这种冷门 B 面。
 *    YTM 艺人页顶部那 5 条就是它自己排的热门，正好补上这个洞。
 */
async function ytmTopSongs(channelId, artistName) {
  const d = await ytmCall("browse", { context: ytmCtx(), browseId: channelId });
  const rows = ytmCollect(d, "musicResponsiveListItemRenderer");
  const out = [];
  const seen = {};
  for (let i = 0; i < rows.length; i++) {
    const t = ytmRowToTrack(rows[i], artistName, "");
    if (!t || seen[t.id]) continue;
    seen[t.id] = 1;
    /* 艺人页的条目没有专辑名，第 2 列是播放量 ——
       ytmRowToTrack 会把播放量当 artist 塞进来，这里纠正成歌手本名。 */
    t.artist = artistName || t.artist;
    t.album = t.album || "";
    out.push(t);
  }
  return out;
}

/** 艺人页 → 专辑列表（MPREb...） */
async function ytmArtistAlbums(channelId) {
  const d = await ytmCall("browse", { context: ytmCtx(), browseId: channelId });
  const items = ytmCollect(d, "musicTwoRowItemRenderer");
  const out = [];
  const seen = {};
  let artistName = "";
  for (let i = 0; i < items.length; i++) {
    const v = items[i];
    const title = ytmRuns(v.title);
    if (!title) continue;
    const bb = v.title && v.title.runs && v.title.runs[0] &&
      v.title.runs[0].navigationEndpoint && v.title.runs[0].navigationEndpoint.browseEndpoint;
    const id = bb && bb.browseId;
    if (!id || String(id).indexOf("MPRE") !== 0) continue;
    if (seen[id]) continue;
    seen[id] = 1;
    const sub = (v.subtitle && v.subtitle.runs || []).map((r) => r.text || "").join(" ");
    /* ⚠️ 艺人页里的专辑 subtitle 只有「2018年」这种年份，没有
       「Album • 歌手 • 年份」三段（那是搜索页的格式）。
       所以年份直接用 /(\d{4})/ 捞，歌手名一律用频道名（art.name），
       别去 subtitle 里猜 —— 猜出来的是「2014年」这种假歌手名。 */
    const ym = sub.match(/(\d{4})/);
    const year = ym ? ym[1] : "";
    const alArtist = "";
    const s = JSON.stringify(v);
    const art = (s.match(/"thumbnails":\[\{"url":"([^"]+)"/) || [])[1] || "";
    out.push({ id: id, title: title, artist: alArtist, date: year, artwork: art });
  }
  return { albums: out, artistName: artistName };
}

/** 专辑页 → 曲目 */
async function ytmAlbumTracks(albumId, artistFallback, albumFallback) {
  const d = await ytmCall("browse", { context: ytmCtx(), browseId: albumId });
  const rows = ytmCollect(d, "musicResponsiveListItemRenderer");
  const out = [];
  const seen = {};
  for (let i = 0; i < rows.length; i++) {
    const t = ytmRowToTrack(rows[i], artistFallback, albumFallback);
    if (!t || seen[t.id]) continue;
    seen[t.id] = 1;
    out.push(t);
  }
  return out;
}

/**
 * 歌手名 → 完整作品表（专辑 + 曲目）。
 * 这是「平台歌手条目不可信」时的目录兜底。
 * 带 1 小时缓存，因为 getArtistWorks 会按专辑反复取。
 */
const YTM_CAT_CACHE = {};
const YTM_CAT_TTL = 60 * 60 * 1000;

async function ytmArtistCatalog(name) {
  const q = String(name || "").trim();
  if (!q) return null;
  const ck = "ytm:" + singerNorm(q);
  const hit = YTM_CAT_CACHE[ck];
  if (hit && Date.now() - hit.at < YTM_CAT_TTL) return hit.v;
  try {
    const art = await ytmFindArtist(q);
    if (!art) return null;
    const al = await ytmArtistAlbums(art.id);
    if (!al.albums.length) return null;
    /* 热门歌曲跟专辑列表并发拉 —— 但 ytmArtistAlbums 已经用了同一个 browse，
       这里单独再发一次是「同一份页面」，代价很小。 */
    const topSongs = await ytmTopSongs(art.id, art.name).catch(function () { return []; });
    /* 逐张拉曲目。李志 13 张，并发 4 路约 4~6 秒 —— 只在兜底路径上跑，
       正常歌手（酷狗/酷我有条目）根本不会走到这里。 */
    const albums = [];
    const tracks = [];
    const seenT = {};
    const CONC = 6;
    for (let i = 0; i < al.albums.length; i += CONC) {
      const batch = al.albums.slice(i, i + CONC);
      const parts = await Promise.all(batch.map(async (a) => {
        const tr = await ytmAlbumTracks(a.id, a.artist || art.name, a.title).catch(() => []);
        return { a: a, tr: tr };
      }));
      for (let j = 0; j < parts.length; j++) {
        const p = parts[j];
        albums.push({
          id: "ytmal:" + p.a.id,
          platform: "YouTube",
          title: p.a.title,
          artist: p.a.artist || art.name,
          artwork: p.a.artwork || "",
          date: p.a.date || "",
          description: "",
          worksNum: p.tr.length,
          _provider: "youtube",
          _kind: "album",
        });
        for (let k = 0; k < p.tr.length; k++) {
          const t = p.tr[k];
          if (seenT[t.id]) continue;
          seenT[t.id] = 1;
          tracks.push(t);
        }
      }
    }
    /* 跟 Apple 目录同构：带上 trackSet / albumSet，
       这样 appleCatScore 那套打分可以直接复用。
       full/complete 语义也照搬：
         full      = 这份目录没被截断（YTM 艺人频道就是他的全部发行）
         complete  = 曲目够多（>=15）才敢当「硬删白名单」用
       ⚠️ 但 YTM 这边**只用来加分和补歌，不用来删** ——
           YTM 频道缺某些发行（地区/版权）比 Apple 常见得多，
           拿它当白名单硬删会误伤平台上的真歌。 */
    const trackSet = {};
    const albumSet = {};
    for (let i = 0; i < tracks.length; i++) {
      const n = normTextZ(tracks[i].title);
      if (n) trackSet[n] = 1;
      const c = normTextZ(coreTitle(tracks[i].title));
      if (c) trackSet[c] = 1;
    }
    for (let i = 0; i < albums.length; i++) {
      const k = normAlbumName(albums[i].title);
      if (k) albumSet[k] = 1;
    }
    /* 热门歌曲并进曲目表：放在最前面（它是 YTM 自己排的「代表作」），
       去重后不重复计入。 */
    const mergedTracks = [];
    const mergedSeen = {};
    for (let i = 0; i < topSongs.length; i++) {
      const t = topSongs[i];
      if (mergedSeen[t.id]) continue;
      mergedSeen[t.id] = 1;
      mergedTracks.push(t);
    }
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (mergedSeen[t.id]) continue;
      mergedSeen[t.id] = 1;
      mergedTracks.push(t);
    }
    for (let i = 0; i < mergedTracks.length; i++) {
      const n = normTextZ(mergedTracks[i].title);
      if (n) trackSet[n] = 1;
      const c = normTextZ(coreTitle(mergedTracks[i].title));
      if (c) trackSet[c] = 1;
    }
    const v = {
      id: art.id, name: art.name, albums: albums, tracks: mergedTracks,
      top: topSongs,
      trackSet: trackSet, albumSet: albumSet,
      _src: "ytm",
      full: true, complete: tracks.length >= 15,
    };
    YTM_CAT_CACHE[ck] = { at: Date.now(), v: v };
    return v;
  } catch (e) {
    return null;
  }
}

/* ============================================================
 * MusicBrainz 目录 —— 只补元数据，不给音源
 *
 * 为什么接它（2026-10-21 实测，四个歌手对比 Apple / YTM / MB）：
 *   赵薇     Apple  1 张 /  10 首   ← 只剩《天使旅行箱》一张
 *            YTM    1 张 /  10 首
 *            MB    13 张 / 118 首   ← 连《左耳》都在
 *   何韵诗   Apple 52 张 / 122 首（截断）
 *            YTM   20 张 / 157 首
 *            MB    38 张 / 236 首
 *   万能青年旅店  Apple 2 张 / 18 首，MB 15 张 / 36 首
 *
 * 它就是「这位歌手到底发过哪些片」的权威答案，比 Apple 全、比 YTM 快
 * （一次请求 1~1.5s，YTM 要逐张拉曲目 2.6s）。但它**没有音频**，
 * 拿到的只有歌名/专辑名/时长，所以只干两件事：
 *   1. 专辑页缺片时当骨架（Apple 截断/太薄的那些歌手）
 *   2. 单曲搜索时给「确实是他作品」的条目标记加分（只加分，不罚）
 *
 * ⚠️ 两条硬规矩：
 *   - 限流 1 req/s，必须串行排队。超了会 503，还不是每次都报，很难查。
 *   - Cover Art Archive 对华语歌手几乎全是空的（实测抽查 15 张，0 张有封面），
 *     所以封面一律走 fallback，别指望它。
 * ============================================================ */
const MB_API = "https://musicbrainz.org/ws/2";
const MB_HEADERS = {
  "User-Agent": "ZongziMusicFree/1.0 ( https://github.com/ZONGZI-000/zongzi-musicfree-plugin )",
  Accept: "application/json",
};
const MB_TIMEOUT = 9000;   // ⚠️ 实测 MB 波动极大：万青 0.4s，赵薇/何韵诗 4.5~6s
const MB_CAT_TTL = 6 * 60 * 60 * 1000;
const MB_FAIL_TTL = 5 * 60 * 1000;
const MB_CACHE = {};
let _mbChain = Promise.resolve();
let _mbLast = 0;

/** 排队发一次 MB 请求：只保证「两次请求的**发出时间**间隔 ≥1.1s」。
 *
 *  ⚠️ 不能串成「等上一个响应回来才发下一个」——
 *     实测 MB 单次延迟波动极大（同一个接口 0.3s / 5.4s 都见过），
 *     一旦排在前面的那个卡住，后面所有请求（哪怕跟自己无关）全被拖着，
 *     整次搜索就死在队列里。限流要的是「发出的频率」，不是「返回的顺序」。
 */
function mbGet(url) {
  const gap = _mbChain.then(async function () {
    const wait = 1100 - (Date.now() - _mbLast);
    if (wait > 0) await new Promise(function (r) { setTimeout(r, wait); });
    _mbLast = Date.now();
  });
  _mbChain = gap.catch(function () { return null; });
  const once = function () {
    return gap.then(function () {
      return axios_1.get(url, {
        timeout: MB_TIMEOUT,
        headers: MB_HEADERS,
        validateStatus: function () { return true; },
      });
    });
  };
  /* ⚠️ 503 / 429 必须重试一次：MB 的限流计数是**滑动窗口**，
     连发两个请求时第二个经常照样被拒（实测「赵薇」第一次搜就撞上了，
     于是那次目录整个拿不到，专辑页只有 1 张，用户以为坏了）。
     等 1.5s 再来一次基本都能过。 */
  return once().then(function (r) {
    if (r.status === 429 || r.status === 503) {
      return new Promise(function (res) { setTimeout(res, 1500); })
        .then(once)
        .then(function (r2) {
          if (r2.status !== 200) throw new Error("MB " + r2.status);
          return r2.data;
        });
    }
    if (r.status !== 200) throw new Error("MB " + r.status);
    return r.data;
  });
}

/**
 * 歌手名 → MusicBrainz 艺人条目。
 * ⚠️ 必须 exact 匹配：搜「李志」时 MB 会同时给「李志辉 77 分」「李志清 74 分」，
 *    拿第一条就会把整份目录指到别人身上（跟 Apple 那条坑一模一样）。
 */
async function mbFindArtist(name) {
  const q = String(name || "").trim();
  if (!q) return null;
  const qn = singerNorm(q);
  const ck = "mbart:" + qn;
  const hit = MB_CACHE[ck];
  if (hit && Date.now() - hit.at < (hit.v ? MB_CAT_TTL : MB_FAIL_TTL)) return hit.v;
  let picked = null;
  try {
    const d = await mbGet(MB_API + "/artist/?query=" + encodeURIComponent('artist:"' + q + '"')
      + "&fmt=json&limit=5");
    const list = (d && d.artists) || [];
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a || !a.id) continue;
      if (!oneNameEq(a.name || "", qn)) continue;
      // 分太低的多半是同名野鸡条目
      if (Number(a.score || 0) < 90) continue;
      picked = { id: a.id, name: a.name || q, score: Number(a.score || 0) };
      break;
    }
  } catch (e) { picked = null; }
  MB_CACHE[ck] = { at: Date.now(), v: picked };
  return picked;
}

/**
 * 歌手名 → 完整作品表，结构跟 appleArtistCatalog / ytmArtistCatalog 对齐，
 * 这样 appleCatScore 那套打分和 mergeAppleAlbums 那套骨架合并能直接复用。
 */
async function mbArtistCatalog(name) {
  const q = String(name || "").trim();
  if (!q) return null;
  const ck = "mbcat:" + singerNorm(q);
  const hit = MB_CACHE[ck];
  if (hit && Date.now() - hit.at < (hit.v ? MB_CAT_TTL : MB_FAIL_TTL)) return hit.v;

  let v = null;
  try {
    const art = await mbFindArtist(q);
    if (art && art.id) {
      /* ⚠️ 一次请求拿完：release?artist= 带 inc=recordings 就带回了全部曲目，
         不用像 YTM 那样逐张拉（那是 2.6s，这是 1.2s）。
         实测 100 条上限够用：李志 64 张 / 赵薇 13 张 / 何韵诗 34 张都在里面；
         真超过 100 的（周杰伦那种）会带 count 字段，标记成 truncated，
         这种大歌手本来也不缺目录，直接当没有。 */
      const d = await mbGet(MB_API + "/release?artist=" + art.id
        + "&inc=recordings+release-groups+artist-credits&fmt=json&limit=100");
      const rels = (d && d.releases) || [];
      const total = Number((d && d.count) || rels.length);
      const truncated = total > rels.length;

      /* 按 release-group 归并 —— 同一张专辑会有多个版本（赵薇《飘》有 2004
         和 2004-11-16 两条），不去重的话专辑页会出现两张《飘》。 */
      const byGroup = {};
      const groupOrder = [];
      for (let i = 0; i < rels.length; i++) {
        const r = rels[i];
        const rg = r["release-group"] || {};
        const gid = rg.id || r.id;
        const tr = [];
        const media = r.media || [];
        for (let m = 0; m < media.length; m++) {
          const tt = media[m].tracks || [];
          for (let k = 0; k < tt.length; k++) {
            if (!tt[k] || !tt[k].title) continue;
            tr.push({
              title: String(tt[k].title),
              duration: Number(tt[k].length || 0),
              no: Number(tt[k].position || 0),
            });
          }
        }
        /* ⚠️ 类型要连 secondary-types 一起看 —— MB 把演唱会实况标成
           「primary: Album + secondary: [Live]」，只听 primary-type 会当成录音室专辑。
           实测何韵诗：28 张骨架里 6 张是 LIVE（On the Pulse of HOCC 2018 LIVE
           29 首、十八種香港伊館站 28 首…），全被甩到专辑页最前面。
           赵薇那张《左耳》是 primary: Single、secondary 空，照收。 */
        const secTypes = (rg["secondary-types"] || []).map(function (x) { return String(x); });
        const prev = byGroup[gid];
        if (!prev) {
          byGroup[gid] = {
            gid: gid,
            title: rg.title || r.title || "",
            date: rg["first-release-date"] || r.date || "",
            type: rg["primary-type"] || "",
            sec: secTypes,
            tracks: tr,
          };
          groupOrder.push(gid);
        } else if (tr.length > prev.tracks.length) {
          prev.tracks = tr;
          if (!prev.date) prev.date = rg["first-release-date"] || r.date || "";
        }
      }

      const albums = [];
      const tracks = [];
      const trackSet = {};
      const albumSet = {};
      const seenT = {};
      for (let i = 0; i < groupOrder.length; i++) {
        const g = byGroup[groupOrder[i]];
        if (!g || !g.title) continue;
        /* ⚠️ Single 要收、LIVE / 精选 不收。
           赵薇那张《左耳》在 MB 里标成 Single（1 首），可它正是用户要的，
           所以 Single 留。但演唱会实况和精选集会挤占专辑页前排
           （实测何韵诗 28 张里有 6 张是全套 LIVE），一律踢掉。
           注意 LIVE/Compilation 藏在 secondary-types 里，不在 primary-type。 */
        const type = String(g.type || "");
        const secStr = (g.sec || []).join(",");
        if (/compilation|live|remix|dj-mix|mixtape|demo|interview|spokenword|soundtrack/i
          .test(type + "," + secStr)) continue;
        const alKey = normAlbumName(g.title);
        if (alKey) albumSet[alKey] = 1;
        albums.push({
          id: "mbal:" + g.gid,
          platform: "MusicBrainz",
          title: g.title,
          artist: art.name,
          artwork: "",
          date: g.date || "",
          description: "MusicBrainz 目录" + (type ? (" · " + type) : ""),
          worksNum: g.tracks.length,
          _provider: "mb",
          _kind: "album",
          _tracks: g.tracks,
        });
        for (let k = 0; k < g.tracks.length; k++) {
          const t = g.tracks[k];
          const n = normTextZ(t.title);
          if (!n || seenT[n]) continue;
          seenT[n] = 1;
          trackSet[n] = 1;
          const c = normTextZ(coreTitle(t.title));
          if (c) trackSet[c] = 1;
          tracks.push({
            title: t.title,
            album: g.title,
            artist: art.name,
            duration: t.duration || 0,
          });
        }
      }
      if (albums.length) {
        v = {
          id: art.id, name: art.name, albums: albums, tracks: tracks,
          trackSet: trackSet, albumSet: albumSet,
          _src: "mb",
          full: !truncated,
          // MB 的目录很全，但没音频；complete 只影响「硬删」，这边永远不删
          complete: false,
        };
      }
    }
  } catch (e) { v = null; }
  MB_CACHE[ck] = { at: Date.now(), v: v };
  return v;
}

/** MB 目录打分：只加分，绝不罚（MB 缺歌比 Apple 少，罚会误伤真歌） */
function mbCatScore(item, cat) {
  if (!cat) return 0;
  const titleN = normTextZ(item.title || "");
  if (!titleN) return 0;
  /* ⚠️ 先验歌手，再验歌名 —— 这一步不能省。
     实测搜「赵薇」：目录里确实有《有一个姑娘》《不能和你分手》，
     但列表前排那些是周漾玥、还珠格格合唱团、嘟拉儿歌的翻唱。
     只看歌名就给 +40，等于把别人的翻唱当成赵薇本人的作品推上去。
     歌手字段对不上目录里的名字 → 不加分（也不扣，它可能真是别的版本）。 */
  const catN = singerNorm(cat.name);
  const parts = String(item.artist || "").split(/[\/&、,，]/).map(singerNorm).filter(Boolean);
  let artistOk = false;
  for (let i = 0; i < parts.length; i++) {
    const a = parts[i];
    if (!a) continue;
    if (a === catN) { artistOk = true; break; }
    /* 跨文字体系（何韻詩 / HOCC、赵薇 / Vicki Zhao）只认「一边不含中文」，
       理由同专辑页的 hitArtist：中文名多一个字就是另一个人。 */
    const aCJK = /[\u4e00-\u9fff]/.test(a);
    const nCJK = /[\u4e00-\u9fff]/.test(catN);
    if (aCJK && nCJK) continue;
    if (a.indexOf(catN) >= 0 || catN.indexOf(a) >= 0) { artistOk = true; break; }
  }
  if (!artistOk) return 0;
  if (cat.trackSet[titleN]) return 40;
  const core = normTextZ(coreTitle(item.title));
  if (core && cat.trackSet[core]) return 40;
  if (core) {
    const keys = Object.keys(cat.trackSet);
    for (let i = 0; i < keys.length; i++) {
      if (keys[i].length >= 2 && (keys[i].indexOf(core) >= 0 || core.indexOf(keys[i]) >= 0)) return 40;
    }
  }
  const albumN = normAlbumName(item.album || "");
  if (albumN && cat.albumSet[albumN]) return 25;
  if (albumN) {
    const keys2 = Object.keys(cat.albumSet);
    for (let i = 0; i < keys2.length; i++) {
      if (keys2[i].length >= 2 && (keys2[i].indexOf(albumN) >= 0 || albumN.indexOf(keys2[i]) >= 0)) return 25;
    }
  }
  return 0;
}

/** MB 目录够不够当专辑页骨架（跟 appleSkeletonOk 同一套门槛） */
async function mbSkeletonOk(cat, eq, query) {
  if (!cat) return false;
  if (!cat.full) return false;
  if (cat.tracks.length < 10) return false;
  const exactNameIdentity = normTextZ(cat.name) === normTextZ(eq);
  if (!(cat.albums.length >= 2 || exactNameIdentity)) return false;
  if (await looksLikeSongQuery(eq)) return false;
  return true;
}

/**
 * 把 MB 有、列表里没有的专辑追加进去（只追加，不删任何平台条目）。
 * 命中的就跳过 —— 同名专辑平台上已经有的（能真播）优先。
 */
function mergeMbAlbums(cat, list) {
  if (!cat || !cat.albums.length) return list;
  const have = {};
  for (let i = 0; i < list.length; i++) {
    const k = normAlbumName(list[i].title || "");
    if (k) have[k] = 1;
  }
  let added = 0;
  for (let i = 0; i < cat.albums.length; i++) {
    const a = cat.albums[i];
    const k = normAlbumName(a.title || "");
    if (!k || have[k]) continue;
    have[k] = 1;
    list.push({
      id: a.id,
      platform: "MusicBrainz",
      title: a.title,
      artist: a.artist || cat.name,
      artwork: "",
      date: a.date || "",
      description: "MusicBrainz 目录（该平台暂无音源）",
      worksNum: a.worksNum || 0,
      _provider: "mb",
      _kind: "album",
    });
    added++;
  }
  if (added) console.log("[粽子] MusicBrainz 目录「" + cat.name + "」补 " + added + " 张");
  return list;
}

async function ytSearchRaw(query) {
  const c = YT_ANDROID;
  const r = await axios_1.post(
    "https://www.youtube.com/youtubei/v1/search?key=" + (await ytPubKey()) + "&prettyPrint=false",
    JSON.stringify({ context: ytCtx(c), query: query }),
    { timeout: 20000, headers: ytHeaders(c), validateStatus: () => true }
  );
  const out = [];
  // 递归遍历响应树，捞出所有 videoRenderer
  (function walk(o, d) {
    if (!o || typeof o !== "object" || d > 22) return;
    if (Array.isArray(o)) { for (let i = 0; i < o.length; i++) walk(o[i], d + 1); return; }
    const keys = Object.keys(o);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k === "videoRenderer" || k === "compactVideoRenderer") {
        const v = o[k];
        if (v && v.videoId) {
          out.push({
            id: v.videoId,
            title: ((v.title && v.title.runs) || []).map((x) => x.text).join("") ||
                   (v.title && v.title.simpleText) || "",
            artist: ((v.ownerText && v.ownerText.runs) || []).map((x) => x.text).join("") ||
                    ((v.longBylineText && v.longBylineText.runs) || []).map((x) => x.text).join("") || "",
            durationText: (v.lengthText && v.lengthText.simpleText) || "",
            artwork: ((v.thumbnail && v.thumbnail.thumbnails) || []).slice(-1)[0]?.url || "",
          });
        }
      }
      walk(o[k], d + 1);
    }
  })(r.data, 0);
  return out;
}

/**
 * 从搜索结果里挑最可能是「原唱/官方发行」的那条。
 * 经验权重：
 *   - "xxx - Topic" 频道 = YouTube 自动生成的官方发行版，命中率最高
 *   - 时长 2~10 分钟像首歌，超长（演唱会/合辑）和超短（切片）降权
 *   - 标题含 歌词/翻唱/remix/DJ/伴奏/纯享 等降权
 */
function ytRank(list, want) {
  const t = normText(want.name);
  const scorer = list.map((v) => {
    let score = 0;
    if (/-\s*Topic$/i.test(v.artist)) score += 50;
    const d = ytDurSec(v.durationText);
    if (d >= 120 && d <= 600) score += 20;
    else if (d > 0) score -= 30;
    const vt = normText(v.title);
    if (t && vt.indexOf(t) >= 0) score += 30;
    if (/歌词|歌詞|lyrics|动态|動態|cover|翻唱|remix|dj|伴奏|纯享|純享|钢琴|piano|合辑|合集/i.test(v.title)) score -= 25;
    if (want.singer) {
      const s = normText(splitSingers(want.singer)[0] || "");
      if (s && (vt.indexOf(s) >= 0 || normText(v.artist).indexOf(s) >= 0)) score += 25;
    }
    return { v: v, score: score, dur: d };
  });
  scorer.sort((a, b) => b.score - a.score);
  return scorer;
}

async function ytPlayer(videoId, client) {
  const c = client || YT_ANDROID;
  const r = await axios_1.post(
    "https://www.youtube.com/youtubei/v1/player?key=" + (await ytPubKey()) + "&prettyPrint=false",
    JSON.stringify({ context: ytCtx(c), videoId: videoId, contentCheckOk: true, racyCheckOk: true }),
    { timeout: 20000, headers: ytHeaders(c), validateStatus: () => true }
  );
  const d = r.data || {};
  const ps = d.playabilityStatus || {};
  if (ps.status !== "OK") throw new Error("yt: " + (ps.status || "?") + " " + String(ps.reason || "").slice(0, 40));
  const sd = d.streamingData || {};
  const all = (sd.formats || []).concat(sd.adaptiveFormats || []);
  const audios = all
    .filter((f) => f.url && /audio/.test(f.mimeType || ""))
    .map((f) => ({
      itag: f.itag,
      mime: (f.mimeType || "").split(";")[0],
      bitrate: Number(f.bitrate || 0),
      url: f.url,
      // contentLength 用于判断「整首能不能取完」（YouTube 对部分内容有约 1MB 配额）
      size: Number(f.contentLength || 0),
    }))
    .sort((a, b) => b.bitrate - a.bitrate);
  if (!audios.length) throw new Error("yt: 无音频流");
  const vd = d.videoDetails || {};
  return {
    audios: audios,
    title: vd.title || "",
    // ⚠️ 搜索结果里的 lengthText 对 Topic 频道的自动生成曲目经常是空的，
    //    导致 UI 显示 00:00。但 player 接口的 videoDetails.lengthSeconds 一定有值。
    lengthSeconds: Number(vd.lengthSeconds || 0),
    author: vd.author || "",
  };
}

/**
 * 选音频流。
 *
 * ⚠️ 踩过的坑：原来按「高音质取 pool[0]，低音质取 pool[末尾]」，
 *    结果 high 档拿到了 itag=599 —— 这是 YouTube 的「省流版」DASH 分片
 *    （32kbps、带 rqh=1 参数、brand=dash，文件头没有完整 moov 索引）。
 *
 *    表现就是：播放器读不出时长 → 一直转圈缓冲，
 *    界面时长还会显示成 38:53:20 这种离谱数字（播放器自己瞎猜的）。
 *
 * 正确的 whitelist（按优先级）：
 *      141  audio/mp4  256k  AAC   —— 有就最好
 *      140  audio/mp4  128k  AAC   —— 标准档，兼容性最好
 *      251  audio/webm 160k  Opus  —— m4a 都没有时备用
 *      250  audio/webm  70k  Opus
 *      139  audio/mp4   48k  AAC   —— 兜底
 *      249  audio/webm  50k  Opus
 *
 *    永远排除：599 / 600（省流 DASH 分片，会被播放器卡死）
 */
const YT_AUDIO_PREFERENCE = [
  { itag: 141, kind: "mp4", minBw: 200000 },
  { itag: 140, kind: "mp4", minBw: 100000 },
  { itag: 251, kind: "webm", minBw: 100000 },
  { itag: 250, kind: "webm", minBw: 50000 },
  { itag: 139, kind: "mp4", minBw: 40000 },
  { itag: 249, kind: "webm", minBw: 40000 },
];

/** 这些 itag 是省流分片，播放器播不了，一律排除 */
const YT_BAD_ITAGS = { 599: 1, 600: 1 };


/* ============================================================
 * YouTube 1MB 配额探测
 *
 * 实测（2026-10-17）：
 *   对「有版权限制」的音乐内容，googlevideo 只放行约 1MB 的字节，
 *   超过就 403。无论用哪种方式请求都一样：
 *
 *     itag=140 (3975KB) → 取到 1024KB 后全 403
 *     itag=599 ( 947KB) → 取到  320KB 后全 403
 *     换 ANDROID / IOS / ANDROID_VR client 全部一样
 *
 *   4 首测试：NEVER GONNA GIVE YOU UP ✅ 可取 / 起風了 ❌ / 目标曲 ❌ / Despacito ❌
 *
 * 所以取流前先探一下 2MB 位置，403 就直接放弃、交给别的平台兜底。
 * 这样用户不会对着转圈界面干等 60~90 秒。
 * ============================================================ */
const YT_QUOTA_PROBE_OFFSET = 2097152;   // 探 2MB 处
const YT_QUOTA_PROBE_LEN = 1024;         // 只要 1KB

/**
 * 探测这条 URL 能不能读到 2MB 之后。
 * 返回 true = 不受限（可以整首播放）
 *      false = 被 1MB 配额掐住（播到一半会断）
 */
async function ytQuotaOk(url, size) {
  // 用 URL 参数 range 而不是 header —— 实测 header 的开放 Range 一律 403
  //
  // ⚠️ 探测点必须落在**文件内部**。
  //    之前固定探 2MB，遇到 887KB 的文件时必然 403（超出文件尾），
  //    于是把整首能下的歌误判成「受限」直接拒绝。
  //    正确做法：探「文件最后一个字节」——能取到尾部就说明整首可下。
  const total = Number(size || 0);
  let start;
  if (total > 0) {
    // 探尾部 1KB（留一点余量，避免边界问题）
    start = Math.max(0, total - YT_QUOTA_PROBE_LEN - 1);
  } else {
    // 不知道大小就退回探 2MB（宁可误判受限，也不要放过播到一半断的）
    start = YT_QUOTA_PROBE_OFFSET;
  }
  const end = total > 0 ? total - 1 : YT_QUOTA_PROBE_OFFSET + YT_QUOTA_PROBE_LEN - 1;
  const probeUrl = url + "&range=" + start + "-" + end;
  try {
    const r = await axios_1.get(probeUrl, {
      timeout: 5000,
      responseType: "arraybuffer",
      validateStatus: () => true,
      headers: { "User-Agent": UA },
      maxContentLength: 65536,
    });
    return r.status >= 200 && r.status < 300;
  } catch (e) {
    return false;
  }
}

function ytPickAudio(list, quality) {
  const usable = (list || []).filter(
    (a) => !YT_BAD_ITAGS[a.itag] && a.url
  );
  if (!usable.length) return null;

  // 低音质时优先取码率最低的那档（省流量），但依然排除坏 itag
  if (!(lossless(quality) || quality === "320k")) {
    const sorted = usable.slice().sort((a, b) => a.bitrate - b.bitrate);
    // 别低到 48k 以下，音质太差
    const ok = sorted.find((a) => a.bitrate >= 40000);
    if (ok) return ok;
  }

  // 高音质：按偏好表找
  for (let i = 0; i < YT_AUDIO_PREFERENCE.length; i++) {
    const p = YT_AUDIO_PREFERENCE[i];
    const hit = usable.find(
      (a) => a.itag === p.itag || (a.mime.indexOf(p.kind) >= 0 && a.bitrate >= p.minBw)
    );
    if (hit) return hit;
  }

  // 都没命中就取码率最高的，但排除省流档
  return usable.sort((a, b) => b.bitrate - a.bitrate)[0];
}


/* ============================================================
 * YouTube 专用：整首下载 → 转成 data: URI 内联给播放器
 *
 * 为什么只给 YouTube 用：
 *   YouTube 的 URL 带时效签名 + 有并发/配额限制，ExoPlayer 边播边拉
 *   会频繁重新缓冲（实测开头 1 分多钟里每 2 秒卡一次，攒够 50 秒缓冲才稳）。
 *   其它平台的直链没有这个问题，走流式反而更快。
 *
 *   把整首下完塞进 data: URI 后，播放器零网络请求 —— 一次到位。
 *
 * 代价：
 *   - 首次等待 = 下载(1~3s) + base64(Hermes 上 0.6~2s)
 *   - 内存占用 ≈ 文件大小 × 1.33
 *   所以必须限大小，超过上限回退流式。
 * ============================================================ */
const YT_INLINE_MAX_BYTES = 6 * 1024 * 1024;   // 超过 6MB 不内联（无损/长音频）

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Uint8Array → base64（纯 JS，Hermes 里没有 Buffer，btoa 也不一定有） */
function b64FromU8(u8) {
  const len = u8.length;
  const parts = [];
  let i = 0;
  for (; i + 2 < len; i += 3) {
    const x = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2];
    parts.push(
      B64_CHARS[(x >> 18) & 63] + B64_CHARS[(x >> 12) & 63] +
      B64_CHARS[(x >> 6) & 63] + B64_CHARS[x & 63]
    );
  }
  const rem = len - i;
  if (rem === 1) {
    const x = u8[i] << 16;
    parts.push(B64_CHARS[(x >> 18) & 63] + B64_CHARS[(x >> 12) & 63] + "==");
  } else if (rem === 2) {
    const x = (u8[i] << 16) | (u8[i + 1] << 8);
    parts.push(B64_CHARS[(x >> 18) & 63] + B64_CHARS[(x >> 12) & 63] + B64_CHARS[(x >> 6) & 63] + "=");
  }
  return parts.join("");
}

function mimeFromExt(mime) {
  const m = String(mime || "");
  if (m.indexOf("webm") >= 0) return "audio/webm";
  if (m.indexOf("mp4") >= 0) return "audio/mp4";
  if (m.indexOf("mpeg") >= 0) return "audio/mpeg";
  if (m.indexOf("ogg") >= 0) return "audio/ogg";
  return "audio/mp4";
}

/* 分块大小。256KB 实测最优：YouTube 单连接传 ~70 秒会 abort，
   分成 256KB 块后每块 150~950ms，整首 2.2MB 只要 3.5 秒。
   ⚠️ 千万别改回「一次 GET 下整首」—— 那条路 100% 卡到 70 秒后 ERR_BAD_RESPONSE。 */
const INLINE_CHUNK = 256 * 1024;
const INLINE_CONCURRENCY = 4;

/** 下载单个 Range 块。返回 Uint8Array，失败返回 null。 */
async function fetchRange(url, start, end, extraHeaders) {
  try {
    const r = await axios_1.get(url, {
      timeout: 20000,
      responseType: "arraybuffer",
      validateStatus: () => true,
      headers: Object.assign({ "User-Agent": UA, Range: "bytes=" + start + "-" + end }, extraHeaders || {}),
      maxContentLength: (end - start + 1) * 2,
    });
    if (!r || !r.data) return null;
    if (r.status !== 206 && r.status !== 200) return null;
    const u8 = new Uint8Array(r.data);
    return u8.length ? u8 : null;
  } catch (e) { return null; }
}

/**
 * 把整首音频下载下来，返回 data: URI。
 * 失败或超限返回 null（调用方回退到流式）。
 *
 * ⚠️ 必须分块并发下载：整文件单请求会被 YouTube 卡死 70 秒后 abort。
 */
async function inlineAudio(url, sizeHint, mimeHint, extraHeaders, maxBytes) {
  const size = Number(sizeHint || 0);
  const cap = Number(maxBytes) || YT_INLINE_MAX_BYTES;
  if (!size || size > cap) return null;

  // 先拉第一块确认能下、并验魔数（省得白下整首才发现是错误页）
  const first = await fetchRange(url, 0, Math.min(INLINE_CHUNK, size) - 1, extraHeaders);
  if (!first || first.length < 4096) return null;
  {
    const x = (i) => first[i] || 0;
    const okHead =
      (x(4) === 0x66 && x(5) === 0x74 && x(6) === 0x79 && x(7) === 0x70) ||  // ftyp
      (x(0) === 0x49 && x(1) === 0x44 && x(2) === 0x33) ||                    // ID3
      (x(0) === 0xff && (x(1) === 0xfb || x(1) === 0xf3)) ||                  // MP3
      (x(0) === 0x1a && x(1) === 0x45 && x(2) === 0xdf && x(3) === 0xa3) ||  // WebM
      (x(0) === 0x4f && x(1) === 0x67 && x(2) === 0x67);                      // OggS
    if (!okHead) return null;
  }

  const u8 = new Uint8Array(size);
  u8.set(first, 0);
  let filled = first.length;

  // 剩下的按块排队，4 路并发
  const ranges = [];
  for (let off = first.length; off < size; off += INLINE_CHUNK) {
    ranges.push([off, Math.min(off + INLINE_CHUNK, size) - 1]);
  }
  let cursor = 0;
  let failed = false;
  async function worker() {
    while (!failed && cursor < ranges.length) {
      const idx = cursor++;
      const [s, e] = ranges[idx];
      const part = await fetchRange(url, s, e, extraHeaders);
      if (!part) { failed = true; return; }
      u8.set(part, s);
      filled += part.length;
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(INLINE_CONCURRENCY, ranges.length); i++) workers.push(worker());
  await Promise.all(workers);

  if (failed || filled < size * 0.98) return null;
  if (u8.length < 4096 || u8.length > cap) return null;

  const isWebm = u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3;
  const b64 = b64FromU8(u8);
  return "data:" + mimeFromExt(mimeHint || (isWebm ? "webm" : "mp4")) + ";base64," + b64;
}

/* ⚠️ 历史教训（2026-10-17）：别改成「一次 GET 下整首」。
   YouTube 对单连接长传输约 70 秒后主动 abort，axios 报
   ERR_BAD_RESPONSE / stream has been aborted，整首永远下不完。
   分块后同样 2.2MB 只要 3.5 秒。 */

/** 是否开启 YouTube 整首内联（默认开） */
function shouldInlineYoutube() {
  try {
    const vars = (typeof env !== "undefined" && env && env.userVariables) || {};
    const v = vars.inlineYoutube;
    if (v === undefined || v === null || v === "") return true;
    return !(v === "0" || v === "false" || v === "off");
  } catch (e) { return true; }
}

async function ytFetchUrl(videoId, quality) {
  // ⚠️ 优先用 VISIONOS：它的 URL 没有 1MB 配额限制。
  //    ANDROID / IOS 的 URL 对部分版权内容只放行开头 1MB，播到一半断。
  let res = null;
  let usedVisionos = false;
  try {
    res = await ytPlayerVisionos(videoId);
    usedVisionos = true;
  } catch (e) {
    // VISIONOS 不可用（极少数视频不支持）→ 退回 ANDROID/IOS
    try { res = await ytPlayer(videoId, YT_ANDROID); }
    catch (e2) { res = await ytPlayer(videoId, YT_IOS); }
  }

  const pick = ytPickAudio(res.audios, quality);
  if (!pick) throw new Error("yt: 没有可用的音频流");

  if (!(await verifyPlayable(pick.url))) throw new Error("yt: 地址不可播");

  /* VISIONOS 签发的 URL 没有 1MB 配额（实测首/中/尾全 200），不用探测。
     ⚠️ 但**不能**在这里提前 return —— 那会跳过下面的整首内联，
     导致 YouTube 又退回流式播放（开头 1 分多钟每 2 秒卡一次）。 */
  let ok = pick;

  if (!usedVisionos && shouldProbeYtQuota()) {
    // 探测点落在每个候选文件的尾部（见 ytQuotaOk），能取到尾部就说明整首可下。
    // 只试 2 个档：同一视频各档的配额表现基本一致，多试只是白花时间。
    const candidates = [pick].concat(res.audios.filter((a) => a !== pick)).slice(0, 2);
    const tried = candidates.map((c) => c.itag);
    const results = await Promise.all(candidates.map((c) => c.url ? ytQuotaOk(c.url, c.size) : Promise.resolve(false)));
    let found = null;
    for (let i = 0; i < candidates.length; i++) {
      if (results[i]) { found = candidates[i]; break; }
    }
    if (!found) {
      throw new Error("yt: 受 YouTube 配额限制（试过 itag " + tried.join("/") + "），无法整首播放");
    }
    if (!(await verifyPlayable(found.url))) throw new Error("yt: 地址不可播");
    ok = found;
  }

  /* YouTube 专用：整首下载 → data: URI。
     播放器拿到的是内存里的完整文件，零网络请求，不再反复缓冲。
     ⚠️ 这一步必须在所有 early-return 之后 —— 否则 VISIONOS 路径会绕过它。 */
  if (shouldInlineYoutube()) {
    try {
      const dataUri = await inlineAudio(ok.url, ok.size, ok.mime);
      if (dataUri) return dataUri;
    } catch (e) { /* 失败就回退流式 */ }
  }

  return ok.url;
}

async function resolveYoutube(id, want, quality) {
  const errors = [];
  if (id) {
    try { return await ytFetchUrl(id, quality); }
    catch (e) { errors.push("直取: " + e.message); }
  }
  try {
    const kws = buildKeywords(want);
    for (let k = 0; k < kws.length; k++) {
      const list = await ytSearchRaw(kws[k]);
      if (!list.length) continue;
      const ranked = ytRank(list, want);
      for (let i = 0; i < Math.min(2, ranked.length); i++) {
        const cand = ranked[i];
        if (cand.score < 0) continue;
        // 兜底场景下必须是同一首歌，别拿同名/近似名的顶替
        if (id === null && !isDefinitelySameSong({ title: cand.v.title, artist: "" }, { name: want.name, singer: "", album: "" })) continue;
        try { return await ytFetchUrl(cand.v.id, quality); }
        catch (e) { errors.push("搜索取流: " + e.message); }
      }
      if (ranked.length) break;
    }
  } catch (e) { errors.push("搜索: " + e.message); }
  throw new Error(errors.join(" | "));
}

/* ============================================================
 * 通道 H：Bilibili
 * ============================================================ */
async function biliEnsureCookie() {
  // 十分钟过期重取
  if (biliCookie && Date.now() - biliCookieAt < 10 * 60 * 1000) return biliCookie;
  try {
    const r = await axios_1.get("https://www.bilibili.com/", {
      timeout: 15000,
      headers: { "User-Agent": BILI_UA, Accept: "text/html" },
      validateStatus: () => true,
    });
    const raw = (r.headers && r.headers["set-cookie"]) || [];
    const picked = [];
    for (let i = 0; i < raw.length; i++) {
      const c = String(raw[i]).split(";")[0];
      if (/^(buvid3|buvid4|b_nut|buvid_fp|buvid_info)/.test(c)) picked.push(c);
    }
    biliCookie = picked.join("; ");
    biliCookieAt = Date.now();
  } catch (e) { /* 拿不到就裸奔，可能被 -352 */ }
  return biliCookie;
}

function biliHeaders() {
  return {
    "User-Agent": BILI_UA,
    Referer: "https://www.bilibili.com/",
    Origin: "https://www.bilibili.com",
    Accept: "application/json, text/plain, */*",
    Cookie: biliCookie,
  };
}

async function biliSearch(keyword, page, zone) {
  await biliEnsureCookie();
  const base = {
    search_type: "video", keyword: keyword, page: page || 1, page_size: 20, order: "totalrank",
  };
  const call = (extra) =>
    axios_1.get("https://api.bilibili.com/x/web-interface/search/type", {
      params: Object.assign({}, base, extra || {}),
      timeout: 20000, headers: biliHeaders(), validateStatus: () => true,
    });
  // ⚠️ 必须限定「音乐区」（tids=3）。不传 tids 就是全站搜：搜「摇晃帝国」
  //    会返回《美国帝国崩溃三部曲》《瑞士独臂接触者》这类时政/新闻视频，
  //    而且 B 站在交错合并里排最前，整个结果列表会被它刷屏。
  //    tids=3 返回的全是 130(音乐综合)/193(MV)/31(翻唱)/59(演奏) 等音乐子分区。
  //
  // zone 三档：
  //   "music"（默认）→ tids=3，搜不到时退回全站
  //   "guichu"       → tids=119（鬼畜区），**不**退全站（退了全是时政和游戏）
  //   "all"          → 不传 tids，全站
  const zoneMode = zone || "music";
  let tids = 3;
  let fallbackAll = true;
  if (zoneMode === "guichu") { tids = 119; fallbackAll = false; }
  else if (zoneMode === "all") { tids = 0; fallbackAll = false; }
  else if (!shouldBiliMusicOnly()) { tids = 0; fallbackAll = false; }
  let r = await call(tids ? { tids: tids } : null);
  let d = r.data || {};
  let raw = (d.data && d.data.result) || [];
  // 音乐区过滤把结果吃光（冷门关键词很常见）就退回全站，至少别空手
  if (d.code === 0 && !raw.length && fallbackAll) {
    r = await call(null);
    d = r.data || {};
    raw = (d.data && d.data.result) || [];
  }
  if (d.code !== 0) throw new Error("bili: " + d.code + " " + (d.message || ""));
  // ⚠️ 搜索结果里混了付费课程（type: ketang）、专栏、直播等非视频条目，
  //    它们没有 bvid，直接取流会返回 -400。必须过滤。
  const list = [];
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    if (!v.bvid) continue;                       // 无 bvid = 非普通视频
    if (v.type && v.type !== "video") continue;   // ketang / article / live 等
    if (v.is_pay || v.badgepay) continue;         // 付费内容
    list.push({
      id: v.bvid,
      title: String(v.title || "").replace(/<[^>]+>/g, ""),
      artist: v.author || "",
      // ⚠️ artist 是 UP 主昵称，不是歌手名。isSameSong 里拿它跟目标歌手比会全灭，
      //    所以匹配阶段只看标题（下方 scored 里单独处理）
      artwork: v.pic ? (v.pic.indexOf("//") === 0 ? "https:" + v.pic : v.pic) : "",
      durationText: v.duration || "",
      // ⚠️ B站返回的 duration 是 "4:12" 这种文本，不是秒数。
      //    用 parseInt 只会拿到 4（秒），导致所有视频都被判成「太短」而全部被剔除。
      duration: ytDurSec(v.duration) * 1000,
      play: v.play || 0,
    });
  }
  return list;
}

/* ============================================================
 * B 站鬼畜区（rid=119）排行榜
 *
 * 为什么单独做一个榜：鬼畜区不在音乐区（父分区 3）底下，
 * 搜索只能靠关键词自己撞 —— 搜「稻香」能撞到《氘香》，
 * 但不会告诉你「这周鬼畜区有什么好听的」。排行榜补的就是这一块。
 *
 * ⚠️ 只进「榜单」页，**不**进推荐页。推荐页是给日常听歌用的，
 *    鬼畜一混进去，整个推荐区就变成整活合集了。
 *
 * ⚠️ rid 只认 119（鬼畜总榜）。用子分区 22/26/126/216 去打
 *    ranking/v2 全部返回 -400，接口不支持。
 * ============================================================ */
const GUICHU_PREFIX = "guichu:";

async function biliGuichuRank() {
  await biliEnsureCookie();
  const r = await axios_1.get("https://api.bilibili.com/x/web-interface/ranking/v2", {
    params: { rid: 119, type: "all" },
    timeout: 20000, headers: biliHeaders(), validateStatus: () => true,
  });
  const d = r.data || {};
  if (d.code !== 0) throw new Error("bili 鬼畜榜: " + d.code);
  const list = (d.data && d.data.list) || [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    const sec = Number(v.duration) || 0;
    // 20~50 秒的整活片段当不成一首歌；超长的多是合集
    if (sec > 0 && (sec < 60 || sec > 900)) continue;
    if (!v.bvid) continue;
    out.push({
      id: v.bvid,
      platform: "Bilibili",
      title: String(v.title || ""),
      artist: (v.owner && v.owner.name) || "",
      album: v.tname || "",
      artwork: v.pic ? (String(v.pic).indexOf("//") === 0 ? "https:" + v.pic : v.pic) : "",
      duration: sec * 1000,
      playCount: Number((v.stat && v.stat.view) || 0),
      _provider: "bilibili",
      _raw: v,
    });
  }
  return out;
}

/** 鬼畜榜的条目（榜单页里那几张卡） */
function biliGuichuEntries() {
  return [{
    id: GUICHU_PREFIX + "hot",
    platform: "Bilibili",
    title: "B站鬼畜区 · 本周热门",
    artist: "Bilibili 鬼畜",
    artwork: "",
    worksNum: 100,
    playCount: 0,
    description: "鬼畜区总榜（rid=119），只收 1~15 分钟、能当歌听的部分。不进推荐页。",
    _provider: "bilibili",
  }];
}

/** 拿音频流。返回按码率降序 */
async function biliStreams(bvid) {
  await biliEnsureCookie();
  const vr = await axios_1.get("https://api.bilibili.com/x/web-interface/view", {
    params: { bvid: bvid }, timeout: 20000, headers: biliHeaders(), validateStatus: () => true,
  });
  const vd = vr.data || {};
  if (vd.code !== 0) throw new Error("bili view: " + vd.code);
  const cid = vd.data.cid;

  const pr = await axios_1.get("https://api.bilibili.com/x/player/playurl", {
    params: { bvid: bvid, cid: cid, fnval: 16, fnver: 0, fourk: 1 },
    timeout: 20000, headers: biliHeaders(), validateStatus: () => true,
  });
  const dash = pr.data && pr.data.data && pr.data.data.dash;
  if (!dash) throw new Error("bili: 无 dash（可能是番剧/付费内容）");

  const out = [];
  // 普通音频（字段是 baseUrl，不是 url）
  // backupUrl 一并收下：B 站给同一档音频分发 3 个 CDN 域名，
  // 单个节点偶尔会慢到超时（实测见过 15 秒才回第一块），换域名比重走兜底快得多。
  (dash.audio || []).forEach((a) => {
    if (a.baseUrl) out.push({ kind: "audio", id: a.id, bw: a.bandwidth || 0, url: a.baseUrl, alts: a.backupUrl || [] });
  });
  // 杜比
  if (dash.dolby && dash.dolby.audio) {
    dash.dolby.audio.forEach((a) => {
      if (a.baseUrl) out.push({ kind: "dolby", id: a.id, bw: a.bandwidth || 0, url: a.baseUrl });
    });
  }
  // Hi-Res（要大会员，通常拿不到）
  if (dash.flac && dash.flac.audio && dash.flac.audio.baseUrl) {
    out.push({ kind: "flac", id: dash.flac.audio.id, bw: dash.flac.audio.bandwidth || 0, url: dash.flac.audio.baseUrl });
  }
  out.sort((a, b) => b.bw - a.bw);
  if (!out.length) throw new Error("bili: 无音频流");
  return out;
}

/* B 站整首预下载。
 *
 * 为什么要做：API 拿到的是带签名的直链，而 B 站 CDN 对"没带 Referer 的请求"
 * 直接 403。插件内部验活时会手动补这个头，但播放器只拿到一条裸 URL ——
 * 它不会补。实际表现是：点播放能"打开"，播两秒超时，自动跳下一首。
 * 预下载成 data: URI 后播放器零网络请求，这个问题从根上消失。
 *
 * 实测：85~129 秒的鬼畜音频 0.8~3MB，下载 + base64 一共 0.3~1 秒。
 */
/* 上限 8MB：内联缓存只留 3 首（见 INLINE_CACHE_MAX），8MB×3 = 24MB 是
   Hermes 能接受的上限。超过 8MB 的长音频自动退回流式，播放器照样能放。 */
const BILI_INLINE_MAX_BYTES = 8 * 1024 * 1024;

function shouldInlineBili() {
  try {
    const vars = (typeof env !== "undefined" && env && env.userVariables) || {};
    const v = vars.inlineBili;
    if (v === undefined || v === null || v === "") return true;
    return !(v === "0" || v === "false" || v === "off");
  } catch (e) { return true; }
}

const BILI_CDN_HEADERS = () => ({ Referer: "https://www.bilibili.com/" });

async function biliFetchUrl(bvid, quality) {
  const list = await biliStreams(bvid);
  const pool = list.filter((x) => x.kind === "audio");
  const use = pool.length ? pool : list;

  /* 挑档规则：先按音质选，再按可用性选节点。
     旧代码对 standard/low 直接取 use[use.length-1]（最低档），
     而 B 站低档就是 48kbps —— 既难听，又正好压在"是否试听片段"的判定线上。 */
  let order;
  if (lossless(quality) || quality === "320k") {
    order = use.slice();                     // 最高档优先
  } else {
    const target = 132000;                   // 最接近 128k 的那档
    order = use.slice().sort((a, b) => Math.abs(a.bw - target) - Math.abs(b.bw - target));
  }

  const errors = [];
  for (let i = 0; i < order.length; i++) {
    const cands = [order[i].url].concat(order[i].alts || []);
    for (let j = 0; j < cands.length; j++) {
      const u = cands[j];
      if (!u) continue;
      // B 站 CDN 必须带 Referer，否则 403
      const pr = await probeAudio(u, BILI_CDN_HEADERS());
      if (!pr.ok) { errors.push(Math.round(order[i].bw / 1000) + "k#" + j); continue; }
      if (shouldInlineBili() && pr.total && pr.total <= BILI_INLINE_MAX_BYTES) {
        try {
          const dataUri = await inlineAudio(u, pr.total, "mp4", BILI_CDN_HEADERS(), BILI_INLINE_MAX_BYTES);
          if (dataUri) return dataUri;       // 播放器零请求，最稳
        } catch (e) { /* 失败就退回流式 */ }
      }
      return u;
    }
  }
  throw new Error("bili: 没有可播的音频节点（试过 " + errors.join("/") + "）");
}

async function resolveBilibili(id, want, quality) {
  const errors = [];
  if (id) {
    try { return await biliFetchUrl(id, quality); }
    catch (e) { errors.push("直取: " + e.message); }
  }
  try {
    const kws = buildKeywords(want);
    for (let k = 0; k < kws.length; k++) {
      let list = [];
      try { list = await biliSearch(kws[k], 1); } catch (e) { errors.push("搜索: " + e.message); continue; }
      if (!list.length) continue;
      // 排序 + 严格过滤。
      // ⚠️ B站的 artist 是 UP 主昵称，不能拿它跟目标歌手做严格比较（会全灭），
      //    但**标题必须**过 isDefinitelySameSong 的标题校验。
      //    以前用宽松的 titleMatch（双向包含）+ sc>=0 就接受，
      //    结果搜「怎麼都沒有了」会命中一堆标题里带这几个字的无关视频。
      const scored = [];
      for (let i = 0; i < list.length; i++) {
        const v = list[i];
        // 先做硬校验：听书、分集、时长不合理的一律丢
        if (isAudiobookTitle(v.title)) continue;
        const d = v.duration / 1000;
        if (d > 0 && (d < 60 || d > 900)) continue;
        if (/伴奏|教学|教程|鼓谱|吉他谱|钢琴谱|纯音乐|karaoke/i.test(v.title)) continue;
        // 标题必须跟查询对得上（复用严格校验，但 artist 传空避免误杀）
        if (!isDefinitelySameSong({ title: v.title, artist: "" }, { name: want.name, singer: "", album: "" })) continue;

        let sc = 40;
        const singer = splitSingers(want.singer)[0] || "";
        if (singer && (v.title.indexOf(singer) >= 0 || (v.artist || "").indexOf(singer) >= 0)) sc += 20;
        if (d >= 120 && d <= 600) sc += 15;
        if (v.play > 100000) sc += 10;
        scored.push({ v: v, sc: sc });
      }
      scored.sort((a, b) => b.sc - a.sc);

      for (let i = 0; i < Math.min(2, scored.length); i++) {
        try { return await biliFetchUrl(scored[i].v.id, quality); }
        catch (e) { errors.push("取流: " + e.message); }
      }
      if (scored.length) break;
    }
  } catch (e) { errors.push("搜索: " + e.message); }
  throw new Error(errors.join(" | "));
}

/* ============================================================
 * 通道 I：咪咕官方直出（旧接口）
 * 这个接口**直接返回音频字节流**，不是 JSON —— 所以不能当普通地址用，
 * 要作为 URL 交给播放器，播放器自己会带着 Range 去下。
 * 不需要任何签名，不需要登录。
 * ============================================================ */
async function miguApiSearch(keyword, size) {
  const r = await axios_1.get(MIGU_SEARCH, {
    params: { text: keyword, pageNo: 1, pageSize: size || 10, searchSwitch: '{"song":1}' },
    timeout: 20000,
    headers: { "User-Agent": MIGU_UA_MOBILE, Referer: "https://music.migu.cn/" },
    validateStatus: () => true,
  });
  const d = r.data || {};
  const songs = (d.songResultData && d.songResultData.result) || [];
  return songs.map((v) => ({
    id: String(v.contentId || ""),
    copyrightId: String(v.copyrightId || ""),
    title: v.name || "",
    // ⚠️ 咪咕的字段叫 singers，不是 singerList —— 写错的话 artist 会是空字符串，
    //    后果不只是显示难看：去重 key 里的歌手位变空，不同歌手的同名曲会被并成一条。
    artist: (((v.singers || v.singerList || [])[0]) || {}).name || "",
    /* ⚠️ albums 这个字段一直都在，只是没人接。
       实测 2026-10-19 搜「叶惠美」：咪咕回的 11 条全是这张专辑里的正经曲目
       （东风破 / 晴天 / 以父之名…），但 album 被写成空串，
       于是「这条跟查询有没有关系」只能靠标题判断 ——
       标题里根本没有「叶惠美」四个字，全部被判成无关（_rel=0）压到最后，
       前面顶着一堆「叶惠美评周杰伦新歌MV」「周杰伦母亲叶惠美罕露面」的解说视频。
       接上之后，搜专辑名时这些曲目能凭专辑名对上号。 */
    album: (((v.albums || [])[0]) || {}).name || "",
    artwork: ((v.imgItems || [])[0] || {}).img || "",
    duration: miguDurationMs(v),
    lyricUrl: v.lyricUrl || "",
    _vip: v.vipType === 1 || false,
  })).filter((x) => x.id);
}

/** 咪咕不直接给时长，但 rateFormats 里每档都带文件大小（字节）。
 *  LQ 档是 64kbps，所以 秒数 = size * 8 / 64000。
 *  实测《稻香》LQ 1788740B → 223 秒 = 3:44，跟实际时长对得上。
 *  这个 size 是「整首歌」的大小，所以它同时能反证是不是完整版：
 *  真给试听的话 size 会只有十几分之一。 */
const MIGU_TIER_BPS = { LQ: 64000, PQ: 128000, HQ: 320000, SQ: 900000 };
function miguDurationMs(v) {
  const rf = (v && v.rateFormats) || [];
  for (let i = 0; i < rf.length; i++) {
    const t = rf[i].formatType;
    const bps = MIGU_TIER_BPS[t];
    const size = Number(rf[i].size) || 0;
    if (bps && size > 0) {
      const sec = (size * 8) / bps;
      if (sec > 10 && sec < 36000) return Math.round(sec * 1000);
    }
  }
  return 0;
}

function miguListenUrl(contentId, copyrightId) {
  return MIGU_LISTEN +
    "?contentId=" + encodeURIComponent(contentId) +
    "&copyrightId=" + encodeURIComponent(copyrightId || "") +
    "&netType=00&resourceType=2&channel=0146951&toneFlag=HQ";
}

/* ============================================================
 * 咪咕「直出」专辑详情
 *
 * ⚠️ 为什么非要有这个：搜索结果里「咪咕直出」的专辑 id 是**咪咕自己的**
 *    albumId（例如 7948），跟酷我的 id 空间毫无关系。原来 getAlbumDetail
 *    没有咪咕分支，于是直直落到最后的酷我兜底，拿 7948 去
 *    www.kuwo.cn/album_detail 查 —— 查出来是《两只小蜜蜂》(李晓杰) 11 首，
 *    跟用户点的《范特西》毫无关系。
 *    实测 2026-10-19：搜「范特西」，第 3 条「范特西 周杰伦 咪咕直出 0 首」
 *    点进去就是这个鬼样子。
 *
 * 接口：
 *   MIGUM3.0/resource/album/song/v2.0?albumId&pageNo&pageSize
 *     → data.songList[]（songName / singerList[0].name / duration 秒 /
 *        contentId / copyrightId / lrcUrl）+ data.totalCount / data.hasNext
 *   MIGUM3.0/resource/album/v2.0?albumId
 *     → data.title / singer / publishTime / summary / imgItems
 * ============================================================ */
const MIGU_ALBUM_INFO = "https://app.c.nf.migu.cn/MIGUM3.0/resource/album/v2.0";
const MIGU_ALBUM_SONG = "https://app.c.nf.migu.cn/MIGUM3.0/resource/album/song/v2.0";

async function miguAlbumDetail(albumId, albumItem, page) {
  const pn = (page || 1);
  const hdr = { "User-Agent": MIGU_UA_MOBILE, Referer: "https://music.migu.cn/" };

  // 第 1 页顺手把专辑元信息也拉回来（并发，不额外等待）
  const [songsRes, infoRes] = await Promise.all([
    axios_1.get(MIGU_ALBUM_SONG, {
      params: { albumId: albumId, pageNo: pn, pageSize: 50 },
      timeout: 20000, headers: hdr, validateStatus: () => true,
    }).catch(() => null),
    pn === 1 ? axios_1.get(MIGU_ALBUM_INFO, {
      params: { albumId: albumId },
      timeout: 20000, headers: hdr, validateStatus: () => true,
    }).catch(() => null) : Promise.resolve(null),
  ]);

  const box = (songsRes && songsRes.data && songsRes.data.data) || {};
  const list = box.songList || [];

  const musicList = list.map((m, i) => {
    const sg = (m.singerList || [])[0] || {};
    const cid = String(m.contentId || "");
    return {
      id: cid,
      platform: "咪咕直出",
      title: m.songName || m.name || "",
      artist: sg.name || albumItem.artist || "",
      album: albumItem.title || "",
      artwork: albumItem.artwork || "",
      duration: Number(m.duration || 0) * 1000,
      _provider: "miguapi",
      /* 播放靠 contentId + copyrightId 拼 listenSong.do，得跟着条目走 */
      _raw: {
        id: cid,
        copyrightId: String(m.copyrightId || ""),
        title: m.songName || "",
        artist: sg.name || "",
        lyricUrl: m.lrcUrl || "",
      },
      _trackNo: i + 1,
    };
  }).filter((x) => x.id);

  const meta = (infoRes && infoRes.data && infoRes.data.data) || {};
  const imgs = meta.imgItems || [];
  const art = (imgs[1] && imgs[1].img) || (imgs[0] && imgs[0].img) || albumItem.artwork || "";

  return {
    isEnd: !box.hasNext,
    albumItem: {
      id: String(albumId),
      platform: "咪咕直出",
      title: meta.title || albumItem.title || "",
      artist: meta.singer || albumItem.artist || "",
      artwork: art,
      date: meta.publishTime || meta.publishDate || albumItem.date || "",
      description: meta.summary || albumItem.description || "",
      worksNum: musicList.length || Number(box.totalCount || 0) || Number(albumItem.worksNum || 0),
    },
    musicList: musicList,
    _isMiguAlbum: true,
  };
}

async function resolveMiguApi(id, want, quality) {
  const errors = [];
  // 直取：id 就是 contentId，但还需要 copyrightId，所以要走搜索补齐
  try {
    const kws = buildKeywords(want);
    for (let k = 0; k < kws.length; k++) {
      let list = [];
      try { list = await miguApiSearch(kws[k], 10); } catch (e) { errors.push("搜索: " + e.message); continue; }
      if (!list.length) continue;
      for (let i = 0; i < Math.min(3, list.length); i++) {
        if (!isDefinitelySameSong(list[i], want)) continue;
        const url = miguListenUrl(list[i].id, list[i].copyrightId);
        if (await verifyPlayable(url)) return url;
        errors.push("地址不可播");
      }
      if (list.length) break;
    }
  } catch (e) { errors.push("搜索: " + e.message); }
  throw new Error(errors.join(" | "));
}


/* ============================================================
 * 四类搜索：单曲 / 专辑 / 歌手 / 歌单
 *
 * 数据来源分工（实测确定，不是拍脑袋）：
 *   单曲  —— 原有的九平台并发合并
 *   专辑  —— 酷我（字段全：albumid/name/artist/pic/musiccnt/pub）
 *   歌手  —— 酷我（还有 artistpic/fans/desc）+ 咪咕（补充）
 *   歌单  —— 酷我 ft=playlist，详情走网页版 __NUXT__ 求值
 *
 * 为什么是酷我扛主力：
 *   COCO 后端只有 /api/search，没有 album/artist/playlist 端点（实测 404 返回 HTML）；
 *   B站只有 video/bili_user，没有专辑概念；
 *   YouTube 的 playlistRenderer 在 ANDROID client 下不返回；
 *   咪咕有 album/singer 但没 playlist；
 *   酷我 ft 参数四类全支持，而且歌单详情能拿到完整歌曲列表。
 * ============================================================ */

const KUWO_PAGE_SIZE = 20;

/** 酷我通用搜索：ft = music | album | artist | playlist */
async function kuwoSearchTyped(keyword, ft, page, size) {
  const raw = await httpGet(KUWO_SEARCH, {
    all: keyword,
    ft: ft,
    pn: (page || 1) - 1,
    rn: size || KUWO_PAGE_SIZE,
    rformat: "json",
    encoding: "utf8",
    mobi: 1,
  }, { "User-Agent": UA_MOBILE, Cookie: "kw_token=ABC", Referer: "http://www.kuwo.cn/" });
  let j = raw;
  if (typeof raw === "string") {
    try { j = JSON.parse(raw); } catch (e) { return { total: 0, list: [] }; }
  }
  if (!j) return { total: 0, list: [] };
  const list = j.abslist || j.albumlist || [];
  // 酷我歌手头像要给 PICPATH 拼 BASEPICPATH 前缀
  if (j.BASEPICPATH && list.length) list.__basePic = j.BASEPICPATH;
  return { total: Number(j.TOTAL || j.total || 0), list: list };
}

/** 咪咕通用搜索：searchSwitch 决定返回哪一类 */
async function miguSearchTyped(keyword, kind, page, size) {
  const sw = {};
  sw[kind] = 1;
  const r = await axios_1.get(MIGU_SEARCH, {
    params: {
      text: keyword,
      pageNo: page || 1,
      pageSize: size || 10,
      searchSwitch: JSON.stringify(sw),
    },
    timeout: 20000,
    headers: { "User-Agent": MIGU_UA_MOBILE, Referer: "https://music.migu.cn/" },
    validateStatus: () => true,
  });
  const d = r.data || {};
  const key = kind + "ResultData";
  const box = d[key] || {};
  return { total: Number(box.totalCount || 0), list: box.result || [] };
}



/* ============================================================
 * 「播不了」黑名单
 *
 * 用户的诉求：查出来不能听的东西，就不该出现在列表里。
 *
 * 但搜索时无法逐首验证（65 条全验要几十秒），所以用「后知后觉」策略：
 *   第 1 次 → 看得见，点播会快速失败（不再无限转圈）
 *   第 N 次 → 直接从列表里消失
 *
 * 记忆范围：本次会话（进程内）。重启后清空是可接受的 ——
 * 直链签名本来也是几小时就过期，隔天重试反而合理。
 * ============================================================ */
const DEAD_TRACKS = {};
const DEAD_TRACKS_TTL = 6 * 60 * 60 * 1000;   // 6 小时

function deadKey(platform, id) {
  return String(platform || "") + "|" + String(id || "");
}
function markTrackDead(platform, id) {
  if (!platform || !id) return;
  DEAD_TRACKS[deadKey(platform, id)] = Date.now();
  // ⚠️ 必须同时清掉搜索缓存：否则同一个词再搜还是命中旧缓存，
  //    黑名单里的条目照样显示（踩过这个坑）。
  clearSearchCache();
}

/** 清空搜索结果缓存（不动平台层缓存） */
function clearSearchCache() {
  const ks = Object.keys(SEARCH_CACHE);
  for (let i = 0; i < ks.length; i++) {
    if (ks[i].indexOf("search|") === 0) delete SEARCH_CACHE[ks[i]];
  }
}
function isTrackDead(platform, id) {
  const k = deadKey(platform, id);
  const t = DEAD_TRACKS[k];
  if (!t) return false;
  if (Date.now() - t > DEAD_TRACKS_TTL) { delete DEAD_TRACKS[k]; return false; }
  return true;
}

/** 搜索结果排序：完全匹配 > 开头匹配 > 包含；酷我优先（字段最全）
 *
 *  ⚠️ artistRank 是「这一条的歌手指向谁」的信息（见 artistConsensus）。
 *     专辑搜索光按名字排是不够的 —— 搜「范特西」时酷狗返回 5 张同名专辑，
 *     名字全都一模一样，名字字数也一模一样，纯按名字排就是随机顺序，
 *     结果「KenYl 的范特西」和「周杰伦的范特西」并列。
 *     有 consensus 才能把真歌手那张顶到最前。
 */
function rankByName(list, query, nameKey, artistRank, auth) {
  const q = String(query || "").toLowerCase();
  const qz = normTextZ(query);
  return list.map((x) => {
    const n = String(x[nameKey] || "").toLowerCase();
    const nz = normTextZ(x[nameKey]);
    let sc = 0;
    // ⚠️ 用繁简归一后的串比，否则「葉惠美」搜不到「叶惠美」
    if (nz === qz) sc += 100;
    else if (nz.indexOf(qz) === 0) sc += 60;
    else if (nz.indexOf(qz) >= 0) sc += 30;
    else if (n === q) sc += 100;
    else if (n.indexOf(q) === 0) sc += 60;
    else if (n.indexOf(q) >= 0) sc += 30;
    // 名字里带额外字符的降权（「周杰伦战队」这种）
    sc -= Math.max(0, nz.length - qz.length) * 3;
    if (x.platform === "酷我") sc += 5;
    // 酷狗有官方标识：官方歌单 / 正版专辑应该压在用户上传自建的前面
    if (x.platform === "酷狗") sc += 8;
    if (x._official) sc += 40;
    // 咪咕的歌手条目字段少（没作品数没头像），只在没有酷我结果时才该出场
    if (x.platform === "咪咕直出" && nz !== qz) sc -= 15;
    // 歌手指向共识歌手 → 加分（最多 90，不足以翻过「名字完全匹配」的 100）
    if (artistRank) sc += artistRank(x);
    /* 权威目录：查询词是**歌名**时，Apple Music 告诉我们
       「这首歌收在哪张专辑、是谁唱的」。那个歌手/专辑对应的条目，
       就是用户真正想找的那张正版专辑，而不是一堆同名翻唱合集。
       加分上限压在 100 以下，不会盖过「名字完全匹配」。 */
    if (auth) {
      const itemArtist = singerNorm(x.artist || "");
      const authArtist = singerNorm(auth.artist || "");
      const itemTitle = normAlbumName(x.title);
      const authAlbum = normAlbumName(auth.album || "");
      if (authArtist && itemArtist && (itemArtist === authArtist ||
          itemArtist.indexOf(authArtist) >= 0 || authArtist.indexOf(itemArtist) >= 0)) {
        sc += 70;
        // 专辑名也对上权威库 → 就是这张，再加
        if (authAlbum && itemTitle && itemTitle === authAlbum) sc += 25;
      }
    }
    return { x: x, sc: sc };
  }).sort((a, b) => b.sc - a.sc).map((y) => y.x);
}

/** 专辑名归一化：在 normTextZ 基础上再去掉 Apple Music 特有的
 *  「- Single」「- EP」「- 單曲」尾巴。
 *  iTunes 里单曲专辑叫《說散就散 - Single》，国内平台就叫《说散就散》，
 * 不削掉尾巴就永远对不上。 */
function normAlbumName(s) {
  return normTextZ(s)
    .replace(/[-–—]\s*(single|ep|album|单曲|單曲)$/i, "")
    .trim();
}

/** 统计「这张专辑到底是谁的」。
 *
 *  只在**名字跟查询完全一致**的条目里统计 —— 「范特西」「葉惠美」这种，
 *  各家平台会同时返回正版和一堆同名翻唱专辑，正版歌手会在多个平台重复出现。
 *  ⚠️ 关键是**按曲目数加权**：翻唱专辑普遍只有 1~3 首，
 *     正版专辑 10 首往上。纯按出现次数算的话，
 *     搜「叶惠美」时「叶惠娟」那三张 1~2 首的杂牌专辑会跟周杰伦打平。
 *
 *  返回打分函数：命中给正分，别人给负分。 */
function artistConsensus(list, query) {
  const qz = normTextZ(query);
  if (!qz) return null;
  const weight = {};
  for (let i = 0; i < (list || []).length; i++) {
    const it = list[i];
    // 只认名字完全一致的（含繁体写法）
    if (normTextZ(it.title) !== qz) continue;
    const a = String(it.artist || "").trim();
    if (!a) continue;
    // 曲目数 0 的（咪咕不返回曲目数）按 1 计，不能因为它字段少就失权
    const w = 1 + Math.min(20, Number(it.worksNum || 0)) / 10;
    // 酷狗专辑里的歌手可能是「周杰伦/方文山」这种拼接，按单个人拆分统计
    const parts = a.split(/[\/&、,，]/);
    for (let j = 0; j < parts.length; j++) {
      const pk = singerNorm(parts[j]);
      if (!pk || pk.length < 2) continue;
      weight[pk] = (weight[pk] || 0) + w;
    }
  }
  const keys = Object.keys(weight);
  if (!keys.length) return null;
  keys.sort((a, b) => weight[b] - weight[a]);
  const top = keys[0];
  // 只有一条同名结果时没有共识可言，别乱加分
  if (keys.length === 1 && weight[top] < 2) return null;

  const fn = function (item) {
    const a = singerNorm(item.artist || "");
    if (!a) return -5;                    // 没歌手信息，略降
    if (a === top) return 90;
    if (a.indexOf(top) >= 0 || top.indexOf(a) >= 0) return 60;
    return -25;                           // 明确是别人 → 压到同名条目的最底部
  };
  /* 把共识歌手挂到函数上：调用方要拿它做「同名翻唱整体沉底」的分组
     （见 searchAlbum 里 rankByName 之后那段）。 */
  fn.top = top;
  fn.weight = weight;
  return fn;
}

/* ============================================================
 * 酷狗 专辑 / 歌单 搜索 + 详情
 *
 * 为什么值得加（实测对比「范特西」）：
 *   酷我专辑搜索 → 周杰伦《范特西》排第 1，但后面全是同名翻唱专辑
 *   网易云专辑   → 周杰伦整张没版权，只有翻唱
 *   酷狗专辑     → 周杰伦《范特西》第 1 条，songcount=10，出版日期 2001-09-14
 *
 * 歌单同理：酷狗有「酷狗音乐官方歌单」账号，官方精选直接排第一。
 * ============================================================ */
const KUGOU_UA_M = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const KUGOU_ALBUM_SEARCH = "http://mobilecdn.kugou.com/api/v3/search/album";
const KUGOU_SPECIAL_SEARCH = "http://mobilecdn.kugou.com/api/v3/search/special";
const KUGOU_ALBUM_SONG = "http://mobilecdn.kugou.com/api/v3/album/song";
const KUGOU_SPECIAL_SONG = "http://mobilecdn.kugou.com/api/v3/special/song";

/** 酷狗图片地址里的 {size} 占位符要替换，否则 404 */
function kugouImg(url, size) {
  const u = String(url || "");
  if (!u) return "";
  return u.replace("{size}", String(size || 400)).replace(/^http:/, "https:");
}

async function kugouSearchAlbum(query, page, size) {
  try {
    const r = await axios_1.get(KUGOU_ALBUM_SEARCH, {
      params: { format: "json", keyword: query, page: page || 1, pagesize: size || 10 },
      timeout: 15000,
      headers: { "User-Agent": KUGOU_UA_M },
      validateStatus: () => true,
    });
    const info = (r.data && r.data.data && r.data.data.info) || [];
    return info.map((a) => ({
      id: String(a.albumid || ""),
      platform: "酷狗",
      title: a.albumname || "",
      artist: a.singername || "",
      artwork: kugouImg(a.imgurl, 400),
      date: String(a.publishtime || "").slice(0, 10),
      description: "",
      worksNum: Number(a.songcount || 0),
      _provider: "kugou",
      _kind: "album",
    })).filter((x) => x.id && x.title);
  } catch (e) { return []; }
}

async function kugouSearchSpecial(query, page, size) {
  try {
    const r = await axios_1.get(KUGOU_SPECIAL_SEARCH, {
      params: { format: "json", keyword: query, page: page || 1, pagesize: size || 10 },
      timeout: 15000,
      headers: { "User-Agent": KUGOU_UA_M },
      validateStatus: () => true,
    });
    const info = (r.data && r.data.data && r.data.data.info) || [];
    return info.map((a) => {
      const nick = String(a.nickname || "");
      return {
        id: String(a.specialid || ""),
        platform: "酷狗",
        title: a.specialname || "",
        artist: nick,
        artwork: kugouImg(a.imgurl, 400),
        playCount: Number(a.playcount || 0),
        worksNum: Number(a.songcount || 0),
        description: "",
        _provider: "kugou",
        _kind: "special",
        // 官方歌单账号（「酷狗音乐官方歌单」等）优先展示
        _official: /官方|编辑|精选|kugou|酷狗音乐/.test(nick) ? 1 : 0,
      };
    }).filter((x) => x.id && x.title);
  } catch (e) { return []; }
}

/** 酷狗歌曲 → 统一的 musicItem */
function kugouSongToItem(s) {
  const raw = String(s.filename || s.songname || "");
  // filename 形如「周杰伦 - 爱在西元前」，拆开更好用
  let artist = String(s.singername || "");
  let title = String(s.songname || "");
  if (!title && raw) {
    const p = raw.split(" - ");
    if (p.length >= 2) { artist = artist || p[0]; title = p.slice(1).join(" - "); }
    else title = raw;
  }
  if (!title && raw) title = raw;
  return {
    id: String(s.hash || ""),
    platform: "酷狗",
    title: title,
    artist: artist,
    album: String(s.albumname || s.remark || ""),
    artwork: kugouImg(s.imgurl || s.album_img || "", 300),
    duration: parseDuration(s.duration || s.timelen || 0),
    _provider: "kugou",
  };
}

/** 酷狗专辑/歌单详情。type = "album" | "special" */
async function kugouDetail(id, type, page, size) {
  const url = type === "album" ? KUGOU_ALBUM_SONG : KUGOU_SPECIAL_SONG;
  const params = { format: "json", page: page || 1, pagesize: size || 50, version: 9108 };
  if (type === "album") params.albumid = id; else params.specialid = id;
  const r = await axios_1.get(url, {
    params: params,
    timeout: 20000,
    headers: { "User-Agent": KUGOU_UA_M },
    validateStatus: () => true,
  });
  const d = (r.data && r.data.data) || {};
  const info = d.info || [];
  const songs = info.map(kugouSongToItem).filter((x) => x.id && x.title);
  const total = Number(d.total || songs.length);
  return {
    isEnd: (page || 1) * (size || 50) >= total || !songs.length,
    musicList: songs,
  };
}

/* ============================================================
 * 歌手页（作品列表）—— 走酷狗
 *
 * 为什么不用酷我：
 *   www.kuwo.cn/api/www/artist/artistAlbum 和 artistMusic 都已失效
 *   （返回 code=undefined、data 为空，加 csrf 和 cookie 也救不回来）。
 *   而酷狗的 singer/song（1848 首）和 singer/album（49 张）都活着。
 *
 * 酷狗没有「按名字查歌手」的接口了（search/singer 返回 0 条），
 * 所以用两步换算 singerId：
 *     搜歌 → 第 1 条的 album_id → album/info → singerid
 * ============================================================ */
const KUGOU_SINGER_SONG = "http://mobilecdn.kugou.com/api/v3/singer/song";
const KUGOU_SINGER_ALBUM = "http://mobilecdn.kugou.com/api/v3/singer/album";
const KUGOU_ALBUM_INFO = "http://mobilecdn.kugou.com/api/v3/album/info";
const KUGOU_SEARCH_SONG = "http://mobilecdn.kugou.com/api/v3/search/song";

/** 名字 → 酷狗 singerId。找不到返回 ""。 */
async function kugouSingerIdByName(name) {
  const nm = String(name || "").trim();
  if (!nm) return "";
  // 名字本身可能就带 id 前缀（我们自己塞的 kgs:3520）
  if (/^kgs:/.test(nm)) return nm.slice(4);
  try {
    const r = await axios_1.get(KUGOU_SEARCH_SONG, {
      params: { format: "json", keyword: nm, page: 1, pagesize: 3 },
      timeout: 15000,
      headers: { "User-Agent": KUGOU_UA_M },
      validateStatus: () => true,
    });
    const list = (r.data && r.data.data && r.data.data.info) || [];
    for (let i = 0; i < list.length; i++) {
      const albumId = list[i].album_id;
      if (!albumId) continue;
      const ai = await axios_1.get(KUGOU_ALBUM_INFO, {
        params: { format: "json", albumid: albumId, version: 9108 },
        timeout: 15000,
        headers: { "User-Agent": KUGOU_UA_M },
        validateStatus: () => true,
      });
      const info = (ai.data && ai.data.data) || {};
      // 歌手名要对得上，否则可能抓到别人的专辑
      if (info.singerid && flatTitle(String(info.singername || "")).indexOf(flatTitle(nm)) >= 0) {
        return String(info.singerid);
      }
    }
  } catch (e) { /* 忽略 */ }
  return "";
}

/** 查「这个歌手一共多少首」。查不到返回 0。 */
async function kugouSingerSongCount(name) {
  const sid = await kugouSingerIdByName(name);
  if (!sid) return 0;
  const r = await axios_1.get(KUGOU_SINGER_SONG, {
    params: { format: "json", singerid: sid, page: 1, pagesize: 1, version: 9108 },
    timeout: 12000,
    headers: { "User-Agent": KUGOU_UA_M },
    validateStatus: () => true,
  });
  const box = (r.data && r.data.data) || {};
  return Number(box.total || 0);
}

/** 酷狗歌手歌曲 / 专辑列表 */
async function kugouArtistWorks(singerId, page, type, size) {
  const ps = size || 30;
  const url = type === "album" ? KUGOU_SINGER_ALBUM : KUGOU_SINGER_SONG;
  const r = await axios_1.get(url, {
    params: { format: "json", singerid: singerId, page: page || 1, pagesize: ps, version: 9108 },
    timeout: 20000,
    headers: { "User-Agent": KUGOU_UA_M },
    validateStatus: () => true,
  });
  const box = (r.data && r.data.data) || {};
  const list = box.info || [];
  const total = Number(box.total || 0);

  if (type === "album") {
    return {
      isEnd: (page || 1) * ps >= total || !list.length,
      data: list.map((a) => ({
        id: String(a.albumid || ""),
        platform: "酷狗",
        title: a.albumname || "",
        artist: a.singername || "",
        artwork: kugouImg(a.imgurl, 400),
        date: String(a.publishtime || "").slice(0, 10),
        description: "",
        worksNum: Number(a.songcount || 0),
        _provider: "kugou",
      })).filter((x) => x.id && x.title),
    };
  }
  return {
    isEnd: (page || 1) * ps >= total || !list.length,
    data: list.map(kugouSongToItem).filter((x) => x.id && x.title),
  };
}


/** QQ 按歌手名搜歌，只留歌手字段真的对得上的那些。
 *
 *  ⚠️ 为什么不用 musicu 的 GetSingerSongList：2026-10-20 实测
 *     singerId / singerMid / 两者都传，全部返回 code 500003；
 *     老接口 fcg_v8_singer_track_cp.fcg 直接 404。
 *     soso 的 t=0（搜歌）还活着，而且按歌手名搜出来的前 30 条
 *     全是这个人的代表作（实测周杰伦：晴天/发如雪/搁浅/一路向北/枫…），
 *     足够当歌手页第一页。 */
async function qqSearchSongsByArtist(name, page, rn) {
  const nm = singerNorm(name);
  if (!nm) return [];
  const pg = Math.max(1, page || 1);
  try {
    const r = await axios_1.get("https://c.y.qq.com/soso/fcgi-bin/client_search_cp", {
      params: { w: name, t: 0, p: pg, n: 30, format: "json" },
      timeout: 8000,
      headers: { "User-Agent": UA, Referer: "https://y.qq.com/" },
      validateStatus: () => true,
    });
    const so = (r.data && r.data.data && r.data.data.song) || {};
    const list = so.list || [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const x = list[i];
      const singers = x.singer || [];
      let hit = false;
      for (let j = 0; j < singers.length; j++) {
        const s = singerNorm(singers[j].name);
        if (!s) continue;
        if (s === nm || s.indexOf(nm) >= 0 || nm.indexOf(s) >= 0) { hit = true; break; }
      }
      if (!hit) continue;
      out.push({
        id: String(x.songmid || ""),
        platform: "QQ音乐",
        title: x.songname || "",
        artist: singers.map((s) => s.name).join("/"),
        album: x.albumname || "",
        artwork: x.albummid ? "https://y.gtimg.cn/music/photo_new/T002R300x300M000" + x.albummid + ".jpg" : "",
        duration: Number(x.interval || 0) * 1000,
        _provider: "qq",
      });
    }
    return out.filter((x) => x.id && x.title);
  } catch (e) { return []; }
}

/** QQ 按歌手名搜专辑。soso 的 t=1（专辑）已经返回空列表，
 *  这里改用搜歌拿到的 albummid 去聚合 —— 同一位歌手的歌大多集中在
 *  他自己的正规专辑里，聚合出来就是一串可用专辑。 */
async function qqSearchAlbumByName(name, page) {
  if ((page || 1) > 1) return [];
  const songs = await qqSearchSongsByArtist(name, 1, 60);
  const byAlbum = {};
  const order = [];
  for (let i = 0; i < songs.length; i++) {
    const s = songs[i];
    const am = String(s.artwork || "").match(/T002R300x300M000([0-9A-Za-z]+)/);
    const mid = am ? am[1] : "";
    const key = (s.album || "") + "|" + mid;
    if (!s.album || !mid) continue;
    if (!byAlbum[key]) { byAlbum[key] = { mid: mid, title: s.album, artist: s.artist, n: 0 }; order.push(key); }
    byAlbum[key].n++;
  }
  return order.map((k) => {
    const a = byAlbum[k];
    return {
      id: "qqal:" + a.mid,
      platform: "QQ音乐",
      title: a.title,
      artist: a.artist,
      artwork: "https://y.gtimg.cn/music/photo_new/T002R300x300M000" + a.mid + ".jpg",
      date: "",
      description: "",
      worksNum: a.n,
      _provider: "qq",
      _kind: "album",
    };
  });
}


/* ============================================================
 * 「这次搜的是个歌手名」—— 用酷狗歌手库判定
 *
 * 为什么需要：搜「周杰伦」，专辑页前 14 条全是**别人发的同名专辑**
 * （昕一的《周杰伦》17 首、贺瑄的《周杰伦》1 首……），
 * 因为专辑名真的就叫「周杰伦」，名字匹配度 100%，纯按名字排必然它们在前。
 * 用户想看的却是周杰伦本人的专辑（魔杰座 / 范特西 / 七里香）。
 *
 * 判定方法：拿查询词去酷狗歌手库搜一次。
 *   - 第一条的歌手名 == 查询词 → 这是歌手名查询，拿到 singerId
 *   - 该歌手的专辑必须有量（实测周杰伦 49 张、林俊杰 88 张、陈奕迅 162 张），
 *     而同名翻唱歌手是 0 张 —— 这条同时挡掉了「周杰伦战队」这种山寨号
 *   - 反过来搜「晴天」「七里香」时，酷狗歌手库也有一堆同名歌手，
 *     但都是 0 张专辑，判定不通过，走原来的歌名逻辑
 *
 * ⚠️ 别再假设 search/singer 接口死了 —— 它活着，返回的是
 *    {status:1, data:[{singername, singerid}, ...]}（没有 info 包一层），
 *    之前的实现只看 data.info，于是一直拿到空数组。
 * ============================================================ */
const KUGOU_SINGER_SEARCH = "http://mobilecdn.kugou.com/api/v3/search/singer";

async function kugouSingerAlbumTotal(singerId) {
  try {
    const r = await axios_1.get(KUGOU_SINGER_ALBUM, {
      params: { format: "json", singerid: singerId, page: 1, pagesize: 1, version: 9108 },
      timeout: 12000,
      headers: { "User-Agent": KUGOU_UA_M },
      validateStatus: () => true,
    });
    const box = (r.data && r.data.data) || {};
    return Number(box.total || 0);
  } catch (e) { return 0; }
}

/** 这个词**是歌名还是歌手名** —— 返回 0~1 的「标题命中率」。
 *
 *  做法：拿这个词去 Apple 查歌曲，看返回的 25 条里有多少条
 *  **歌名**真的含这个词。歌手名是搜不出同名歌的（他的歌叫别的名字），
 *  歌名则必然大量命中。
 *
 *  实测 42 个歌手名全部 ≤0.32（周杰伦 0.00 / 陈奕迅 0.00 / 五月天 0.16
 *  / 告五人 0.04 / 刺猬 0.68 是唯一偏高的，因为「刺猬」本身也是常用词）；
 *  38 个歌名里 36 个 ≥0.60（后来 0.96 / 起风了 1.00 / 孤勇者 1.00）。
 *  取 0.55 当分界。
 *
 *  ⚠️ 返回 -1 表示「查不到，无从判断」—— 调用方要当成「不是歌名」处理，
 *     不能因为网络抖一下就把正经歌手查询废掉。
 */
const SONGQ_CACHE = {};
/** 这个词在 Apple 里长什么样：{ n, title, artist }
 *
 *  n      = 返回的曲目条数（太少说明两个比例都没意义）
 *  title  = 歌名命中率 —— 高 = 这是**歌名**
 *  artist = 歌手命中率 —— 高 = 这是**歌手名**
 *
 *  ⚠️ 两个比例必须一起看：
 *     歌名查询里歌手字段是各路翻唱者，歌手命中率≈0；
 *     歌手查询里歌手字段必然反复出现同一个名字，命中率≈1。
 *     实测（2026-10-20，20 个歌名 artist ≤0.12，11 个歌手 ≥0.84）。
 *     只看标题命中率会漏：Apple 把「印第安老斑鸠」写作「印地安老斑鳩」，
 *     严格比对只有 1/9，可它明明是歌名 —— 歌手命中 0.00 一眼就分开了。
 */
async function queryShape(query) {
  const q = String(query || "").trim();
  const none = { n: 0, title: -1, artist: -1 };
  if (!q) return none;
  const ck = normTextZ(q);
  const hit = SONGQ_CACHE[ck];
  if (hit && Date.now() - hit.at < APPLE_CAT_TTL) return hit.v;

  let shape = none;
  try {
    const sres = await itunesSearchAny("/search", { term: q, entity: "song", limit: 25 });
    const res = ((sres && sres.results) || []).filter((x) => x.wrapperType === "track");
    if (res.length) {
      const qn = ck.replace(/[^0-9a-z一-鿿]/g, "");
      let t = 0, a = 0;
      for (let i = 0; i < res.length; i++) {
        if (titleSimZ(res[i].trackName || "", q) >= 0.8) t++;
        const art = normTextZ(res[i].artistName || "").replace(/[^0-9a-z一-鿿]/g, "");
        if (art && qn && (art.indexOf(qn) >= 0 || titleSimZ(art, qn) >= 0.8)) a++;
      }
      shape = { n: res.length, title: t / res.length, artist: a / res.length };
    }
  } catch (e) { shape = none; }

  SONGQ_CACHE[ck] = { at: Date.now(), v: shape };
  return shape;
}

async function songQueryRatio(query) {
  const sh = await queryShape(query);
  return sh.n >= 8 ? sh.title : -1;
}

/** 这个词更像「一首歌的名字」而不是「一位歌手」。 */
async function looksLikeSongQuery(query) {
  const r = await songQueryRatio(query);
  return r >= 0.55;
}

/** 查询词是歌手名 → 返回 { id, name }，否则返回 null */
async function detectSingerQuery(query) {
  const qn = singerNorm(query);
  if (!qn || qn.length < 2) return null;
  // 缓存：命中歌手存对象，判定「不是歌手名」存 { none: 1 }（不能存 null，
  // cacheGet 用 null 表示「没缓存」，两者会混淆）
  const hit = cacheGet("singerq", "detect", qn);
  if (hit !== null) return hit.none ? null : hit;

  let result = null;
  try {
    const r = await axios_1.get(KUGOU_SINGER_SEARCH, {
      params: { format: "json", keyword: String(query || "").trim(), page: 1, pagesize: 8 },
      timeout: 12000,
      headers: { "User-Agent": KUGOU_UA_M },
      validateStatus: () => true,
    });
    // ⚠️ 这个接口的 data 就是数组本身，没有 info 包一层
    const arr = (r.data && (r.data.data || r.data.info)) || [];
    for (let i = 0; i < arr.length; i++) {
      const nm = String(arr[i].singername || "");
      if (!nm) continue;
      const nn = singerNorm(nm);
      /* 只认两种写法：
         A. 完全一致 ——「周杰伦」=「周杰伦」
         B. 「拉丁艺名 + 中文名」—— 酷狗上邓紫棋叫「g.e.m. 邓紫棋」，
            归一化后是「g.e.m.邓紫棋」，以查询词结尾，前缀全是拉丁字符/标点。
         ⚠️ B 的前缀**不能含中文**，否则搜歌名「稻香」会命中歌手「袁稻香」
            （他也真有 34 张专辑，专辑数这条挡不住），
            搜「周杰伦」会命中「周杰伦战队」「十分想见周杰伦」。 */
      let nameOk = nn === qn;
      if (!nameOk && nn.endsWith(qn)) {
        const prefix = nn.slice(0, nn.length - qn.length);
        if (prefix && !/[\u4e00-\u9fff]/.test(prefix)) nameOk = true;
      }
      if (!nameOk) continue;
      const sid = String(arr[i].singerid || "");
      if (!sid) continue;
      // 真歌手有专辑；同名山寨号/电台号是 0（「周杰伦战队」= 0 张）
      const total = await kugouSingerAlbumTotal(sid);
      if (total < 3) continue;

      /* ⚠️ 「有 3 张专辑」不代表「这是个歌手」，歌名查询也能过这一关 ——
         酷狗上有一批**用歌名当艺名**的小号，实测：
           搜「后来」  → 歌手「后来」，3 张专辑《从前》《会相信你的》《翻唱l》
           搜「起风了」→ 歌手「起风」，5 张《成吉思汗》《苹果香》《醉乡》
           搜「漠河舞厅」→ 歌手「漠河舞厅」，5 张全是别人的歌
           搜「孤勇者」→ 歌手「孤勇者」，9 张全是别人的歌
         一旦认成歌手，整个专辑标签页就被这个号的杂牌专辑占满
         （《后来》的真专辑一张都出不来）。

         判据用 Apple 的**标题命中率**：查这个词，返回的曲目里有多少
         标题真的含这个词。
           歌手名：周杰伦 0.00 / 陈奕迅 0.00 / 五月天 0.16 / 告五人 0.04
           歌  名：后来 0.96 / 起风了 1.00 / 孤勇者 1.00 / 晴天 0.96
         实测 42 个歌手名全部 ≤0.32，38 个歌名里只有「范特西」(0.00,
         那是专辑名) 和「七里香」(0.60) 落进中间地带。
         取 0.55 当分界：歌名不会被误判成歌手，歌手也不会被误判成歌名。
         查不到 Apple（0 条）时无从证伪，维持原判。 */
      /* ⚠️ 判据换成 queryShape 的双比例：
         实测「印第安老斑鸠」Apple 写作「印地安老斑鳩」，标题严格命中 0.11，
         旧判据（≥0.55）直接放行 → 认成歌手「印第安老斑鸠」
         （酷狗真有一个 3 张专辑的同名号），专辑页整个变成他那些
         《淋湿嘴角》《眉间情意曲》。歌手命中率 0.00 一眼能证伪。 */
      const shq = await queryShape(query);
      if (shq.n >= 6 && shq.title >= 0.25 && shq.artist <= 0.35) {
        console.log("[粽子]「" + nm + "」名下 " + total + " 张专辑，但这个词是歌名（标题命中 "
          + shq.title.toFixed(2) + " / 歌手命中 " + shq.artist.toFixed(2) + "）→ 不按歌手查询处理");
        break;
      }
      result = { id: sid, name: nm, albumTotal: total };
      break;
    }
  } catch (e) { /* 忽略，当歌名查询处理 */ }

  cachePut("singerq", "detect", qn, result || { none: 1 });
  return result;
}

/** 拿这位歌手的**全部**正版专辑（酷狗歌手页）。
 *
 *  ⚠️ 这个接口的 page 参数是坏的：page=1 给 30 条、page=2 又从头重给，
 *     实测 49 张专辑会返回「前 18 张重复一遍」。好在 pagesize 调大能一次给全
 *     （周杰伦 49 张、陈奕迅 162 张都一次拿完），所以干脆一次拉满，本地分页。
 */
async function singerAlbumAll(singerId) {
  try {
    const r = await kugouArtistWorks(singerId, 1, "album", 200);
    return r.data || [];
  } catch (e) { return []; }
}

/** 专辑页排序。三档权重依次是：
 *
 *  1. 个人专辑 vs 合作/合辑
 *     搜「五月天」，歌手页里排在最前的几条是
 *     《欢迎光临二代咖啡 电视剧原声带 ‖ 五月天、丁当、萧秉治…》——
 *     他确实是第一署名人，但那是别人的 OST。真正的《自传》《后青春期的诗》
 *     反而在后面。个人专辑（歌手字段里只有他自己）才该排前面。
 *
 *  2. 整张专辑（≥3 首）vs 单曲/单曲 EP
 *     周杰伦新专辑发完之后密密麻麻全是 1 首的单曲，
 *     纯按时间倒序会把《范特西》《七里香》压到 30 位之后。
 *
 *  3. 同组内按发行时间倒序，再按曲目数。
 */
function sortAlbums(list, artistN) {
  const name = singerNorm(artistN || "");
  const solo = (x) => {
    if (!name) return 1;
    const parts = String(x.artist || "").split(/[\/&、,，]/).map(singerNorm).filter(Boolean);
    if (parts.length !== 1) return 0;
    const a = parts[0];
    return (a === name || a.indexOf(name) >= 0 || name.indexOf(a) >= 0) ? 1 : 0;
  };
  const multi = (x) => (Number(x.worksNum || 0) >= 3 ? 1 : 0);
  return list.slice().sort((a, b) => {
    const sa = solo(a), sb = solo(b);
    if (sa !== sb) return sb - sa;
    const ma = multi(a), mb = multi(b);
    if (ma !== mb) return mb - ma;
    const da = String(a.date || ""), db = String(b.date || "");
    if (da !== db) return db.localeCompare(da);
    return Number(b.worksNum || 0) - Number(a.worksNum || 0);
  });
}

/* ---------- 专辑 ---------- */
/** 跨平台合并同一张专辑（合并的是「唱片」，不是「曲目」）
 *
 *  ⚠️ 实测搜「范特西」，未合并时前三条是同一张唱片的三个副本：
 *     1|范特西|周杰伦|酷狗|10首
 *     2|范特西|周杰伦|酷我|10首
 *     3|范特西|周杰伦|咪咕直出|0首
 *     用户看到「周杰伦的范特西」出现三次，还得自己猜点哪个是对的。
 *
 *  key 用「规范化专辑名 + 规范化歌手」——光看名字不行，
 *  《范特西》在酷狗有一堆 KenYl / 李艾军 / 金华王珏 的同名翻唱，
 *  必须带上歌手才不会把正版和翻唱并成一条。
 *
 *  保留哪一条：曲目数最多的（曲目数是「这张是不是正版」最硬的旁证），
 *  平手按原顺序（酷我跟酷狗在前）。**注意**：这个函数只做合并，
 *  不能拿去当排序输入 —— 原来把它放在排序之前，周杰伦那三条副本一并，
 *  共识票数就掉了，结果被 20 首的翻唱专辑顶到第 1 名。
 */
function dedupeAlbumList(list) {
  const pos = {};
  const keep = [];
  for (let i = 0; i < list.length; i++) {
    const x = list[i];
    if (!x || x._isAudiobook) { keep.push(x); continue; }
    const n = normAlbumName(x.title);
    const a = singerNorm(x.artist);
    /* 名字或歌手为空就不合并 —— 没有判据时的合并会把不相干的东西并掉 */
    if (!n || !a) { keep.push(x); continue; }
    const key = n + "|" + a;
    if (!(key in pos)) { pos[key] = keep.length; keep.push(x); continue; }
    const j = pos[key];
    if (Number(x.worksNum || 0) > Number(keep[j].worksNum || 0)) keep[j] = x;
  }
  if (keep.length !== list.length) {
    console.log("[粽子] 专辑跨平台合并：" + list.length + " → " + keep.length + " 条");
  }
  return keep;
}

/** Apple 目录能不能当「唱片骨架」用。
 *
 *  三条门槛缺一不可：
 *   ① 目录没被 lookup 的 200 条上限截断（截断说明还有唱片没拿到）；
 *   ② 曲目 ≥10 首 —— iTunes 里有大量跟歌手同名的野鸡小号
 *      （搜「晴天」给一个只有 3 张 5 首的「晴天」），挡掉它们；
 *   ③ 名字完全一致（赵薇只有 1 张专辑但确实是她的）或者 ≥2 张专辑；
 *   ④ 这个词不能是歌名 —— 搜「后来」Apple 会认成歌手「後來者」
 *      （15 张 45 首，前三条全过），专辑页就只剩别人的唱片了。
 */
async function appleSkeletonOk(cat, eq, query) {
  if (!cat) return false;
  if (cat.truncated || cat.tracks.length < 10) return false;
  const exactNameIdentity = normTextZ(cat.name) === normTextZ(eq);
  if (!(cat.albums.length >= 2 || exactNameIdentity)) return false;
  if (await looksLikeSongQuery(eq)) {
    console.log("[粽子]「" + cat.name + "」目录 " + cat.albums.length + " 张，"
      + "但「" + String(query).trim() + "」是歌名 → 不走 Apple 目录");
    return false;
  }
  return true;
}

/** 用 Apple 的唱片清单校正平台专辑列表。
 *
 *  skeleton=true  —— 以 Apple 为准：只保留能对上 Apple 唱片的平台条目，
 *                   Apple 有、平台没有的补一条占位（点进去走 Apple 播放）。
 *                   平台整个不可信时用（酷狗压根没这个歌手）。
 *  skeleton=false —— 平台条目一条不动，只把「Apple 有、平台没有」的唱片
 *                   追加到后面。平台目录残缺时用（赵薇只剩几张抖音翻唱，
 *                   而 Apple 还有整张《天使旅行箱》）。
 */
function mergeAppleAlbums(cat, pool, skeleton) {
  const used = {};
  const extra = [];
  const list = skeleton ? [] : pool.slice();
  for (let i = 0; i < cat.albums.length; i++) {
    const a = cat.albums[i];
    const an = normAlbumName(a.title);
    let best = -1, bestSc = -1;
    for (let j = 0; j < pool.length; j++) {
      if (used[j]) continue;
      const xn = normAlbumName(pool[j].title);
      if (!xn) continue;
      let sc = 0;
      if (an && xn === an) sc = 100;
      else if (an && an.length >= 3 && (xn.indexOf(an) >= 0 || an.indexOf(xn) >= 0)) sc = 60;
      else continue;
      // 曲目数对得上更可信（正规专辑 8~13 首，单曲 1~2 首）
      if (a.worksNum >= 5 && Number(pool[j].worksNum || 0) >= 5) sc += 20;
      if (sc > bestSc) { bestSc = sc; best = j; }
    }
    if (best >= 0) {
      used[best] = 1;
      /* ⚠️ 平台条目的 date / worksNum 经常是缺的 ——
         咪咕那条《没有人在乎你在乎的事》worksNum=0、date=""，
         排序时会掉进「单曲」那档被甩到最后，明明它是 2014 年的正规专辑。
         用 Apple 的权威值补上（平台自己有值就不覆盖）。 */
      const x = pool[best];
      if (!Number(x.worksNum)) x.worksNum = a.worksNum;
      if (!String(x.date || "").trim()) x.date = a.date;
      if (!x.artwork) x.artwork = a.artwork;
      if (skeleton) list.push(x);
      continue;
    }
    /* ⚠️ 占位条目的 id / provider 必须跟着目录来源走 ——
       骨架现在可能是 Apple，也可能是 MusicBrainz（见 mbArtistCatalog）。
       以前写死 "apple:" + cat.id，换成 MB 目录时会生成
       「apple:<MB的uuid>:<i>」，点进去按 Apple 的 id 去查，当然查不到。 */
    const srcKind = (cat._src === "mb") ? "mb" : "apple";
    const ph = {
      id: srcKind + ":" + cat.id + ":" + i,
      platform: (srcKind === "mb") ? "MusicBrainz" : "Apple Music",
      title: a.title,
      artist: a.artist,
      artwork: a.artwork,
      date: a.date,
      description: (srcKind === "mb")
        ? "MusicBrainz 目录（该平台暂无音源）"
        : "Apple Music 目录（该平台暂无音源）",
      worksNum: a.worksNum,
      _provider: srcKind,
      _kind: "album",
    };
    if (skeleton) list.push(ph);
    else extra.push(ph);
  }
  return list.concat(extra);
}

async function searchAlbum(query, page) {
  /* 同 searchArtist：译名搜不出唱片，得先换成原名。
     实测「摇晃帝国」原样搜，51 条里全是《摇晃的红酒杯》《摇晃的时光》，
     真乐队的 15 张专辑一张都看不到；换成「ゆらゆら帝国」后 15 张全出。 */
  const aliasP = aliasCandidates(query).catch(() => ({ q: query, names: [query], auth: [] }));
  // 平台搜索先用原查询并发发出去（理由同 searchArtist：别串行等反查）
  const baseP = Promise.all([
    kuwoSearchTyped(query, "album", page, KUWO_PAGE_SIZE).catch(() => ({ total: 0, list: [] })),
    miguSearchTyped(query, "album", page, 10).catch(() => ({ total: 0, list: [] })),
    // 酷狗补正版专辑：实测「范特西」酷我前几条被翻唱专辑占满，
    // 而酷狗第 1 条就是周杰伦原版（songcount=10）
    kugouSearchAlbum(query, page, 10).catch(() => []),
  ]);

  const pick = await pickEffectiveName(query, aliasP).catch(() => ({ name: query, via: "", names: [query] }));
  const eq = pick.name;
  let [kw, mg, kg] = await baseP;

  /* 换名重搜的条件跟歌手页一致：QQ 声明的权威原名 → 一定换；
     推断出来的别名 → 只有原查询彻底空了才换。 */
  const authList = (pick.auth || []).map(normTextZ);
  const isAuth = eq !== query && authList.indexOf(normTextZ(eq)) >= 0;
  const isEmpty = !kw.list.length && !mg.list.length && !kg.length;
  /* ⚠️ 「有结果」不等于「有他的唱片」：
     搜「摇摆帝国」，酷我/咪咕照样返回一堆《闪烁着摇摆》，
     isEmpty 判成 false 就不重搜了，可那些全是分词噪声，
     最后 hitArtist 一过滤，页面上只剩酷狗歌手页那 5 张，
     而真正的 15 张里另外 10 张在酷我，全被漏掉了。
     判据改成：原查询的结果里，**有没有一条的歌手字段真的对得上 eq**。 */
  const eqFlat = flatTitle(eq);
  const rawHit = (() => {
    if (!eqFlat) return false;
    for (let i = 0; i < kw.list.length; i++) {
      if (flatTitle(kw.list[i].artist || "").indexOf(eqFlat) >= 0) return true;
    }
    for (let i = 0; i < mg.list.length; i++) {
      if (flatTitle(mg.list[i].singer || "").indexOf(eqFlat) >= 0) return true;
    }
    for (let i = 0; i < kg.length; i++) {
      if (flatTitle(kg[i].artist || "").indexOf(eqFlat) >= 0) return true;
    }
    return false;
  })();
  if (eq !== query && (isAuth || isEmpty || !rawHit)) {
    const [kw2, mg2, kg2] = await Promise.all([
      kuwoSearchTyped(eq, "album", page, KUWO_PAGE_SIZE).catch(() => ({ total: 0, list: [] })),
      miguSearchTyped(eq, "album", page, 10).catch(() => ({ total: 0, list: [] })),
      kugouSearchAlbum(eq, page, 10).catch(() => []),
    ]);
    console.log("[粽子] 专辑「" + query + "」" + (isAuth ? "有权威原名" : "原查询无结果")
      + " → 改用「" + eq + "」重搜");
    kw = kw2; mg = mg2; kg = kg2;
  }

  const out = [];
  const seen = {};

  // 酷我
  for (let i = 0; i < kw.list.length; i++) {
    const a = kw.list[i];
    const id = String(a.albumid || a.id || "");
    if (!id || seen[id]) continue;
    seen[id] = 1;
    out.push({
      id: id,
      platform: "酷我",
      title: a.name || a.title || "",
      artist: a.artist || "",
      artwork: a.pic || a.hts_img || "",
      date: a.pub || a.showtime || "",
      description: a.info || a.company || "",
      worksNum: Number(a.musiccnt || 0),
      _provider: "kuwo",
    });
  }

  // 酷狗（正版专辑命中率最高，排在同名翻唱前面）
  for (let i = 0; i < kg.length; i++) {
    const a = kg[i];
    // 酷我的 id 空间跟酷狗不同，不能共用 seen；加前缀区分
    const key = "kg:" + a.id;
    if (seen[key]) continue;
    seen[key] = 1;
    out.push(a);
  }

  // 咪咕补充（字段少但曲库不同）
  for (let i = 0; i < mg.list.length; i++) {
    const a = mg.list[i];
    const id = String(a.id || "");
    if (!id || seen[id]) continue;
    seen[id] = 1;
    const imgs = a.imgItems || [];
    out.push({
      id: id,
      platform: "咪咕直出",
      title: a.name || "",
      artist: a.singer || "",
      artwork: (imgs[0] && imgs[0].img) || "",
      date: a.publishDate || "",
      description: a.desc || "",
      worksNum: 0,
      _provider: "miguapi",
    });
  }

  // ---- 并入「听书专辑」----
  // 这些是搜索单曲时识别出来的（见 searchMusicAll），
  // 按书名合并成一个专辑，用户想听书就来这里点。
  const pool = cacheGet("audiobook", "pool", String(query).trim().toLowerCase()) || [];
  if (pool.length) {
    const byBook = {};
    for (let i = 0; i < pool.length; i++) {
      const p = pool[i];
      const k = bookKey(p.book);
      if (!byBook[k]) {
        byBook[k] = {
          id: "ab:" + k,
          platform: p.platform,
          title: p.book,
          artist: p.artist || "有声书",
          artwork: p.artwork || "",
          date: "",
          description: "听书 / 有声书（共 " + 0 + " 个来源）",
          worksNum: 0,
          _provider: "audiobook",
          _isAudiobook: true,
          _items: [],
        };
      }
      byBook[k]._items.push(p);
    }
    const books = Object.keys(byBook);
    for (let i = 0; i < books.length; i++) {
      const b = byBook[books[i]];
      b.worksNum = b._items.length;
      b.description = "听书 / 有声书 · " + b._items.length + " 集（来自 " +
        Array.from(new Set(b._items.map((x) => x.platform))).join("、") + "）";
      // 把内部明细藏到 _raw 里，点进专辑时取
      b._raw = { items: b._items };
      out.push(b);
    }
    console.log("[粽子] 听书聚合出 " + books.length + " 张专辑");
  }

  /* ---- 搜的是歌手名：换成「这个人的正版专辑目录」----
     搜「周杰伦」时，各平台返回的同名专辑《周杰伦》全是别人的翻唱合集
     （昕一 17 首、贺瑄 1 首…），名字完全一致，纯按名字排永远排在最前。
     判定成歌手名查询后，直接去酷狗歌手页拉他的专辑，并把列表里
     「不是这位歌手的」全部剔除 —— 用户搜歌手，想看的就是他的唱片。 */
  /* ⚠️ 判定要用**换过名之后**的词：原译名「摇晃帝国」在酷狗歌手库里
     根本不存在，拿它去判定永远是 null，于是整条「歌手目录」分支被跳过，
     用户搜歌手却看到一堆歌名里带「摇晃」的单曲专辑。 */
  const singerHit = await detectSingerQuery(eq);

  /* ---- Apple 目录兜底：酷狗查不到这个歌手时，别放弃 ----
     实测搜「那我懂你意思了」，酷狗歌手接口 data:null，
     于是整个「歌手目录」分支被跳过，专辑页第 1 条是
     《那我懂你意思了》(2 首)——同名的野鸡单曲，接着全是冒名歌手的
     《凤囚凰》《那年夏天》《金秋的足迹》《梦灯笼引路》，各 1 首。
     而 Apple 里这个乐团的三张专辑整整齐齐。

     ⚠️ 这里**用 Apple 的专辑来纠偏**，不是直接拿 Apple 当结果源 ——
        Apple 给不了播放地址，只能指认「哪些是真专辑」。 */
  let appleAlbums = null;
  if (!singerHit) {
    const cat = await appleArtistCatalog(eq);
    /* ⚠️ 门槛必须卡「目录够完整」，不能只看「有专辑」：
       iTunes 里有大量跟歌名/专辑名同名的小歌手 —— 搜「晴天」它会给出
       一个叫「晴天」的野鸡歌手（2~3 张单曲），搜「叶惠美」给「周婕纶」，
       于是整个结果页被这个小歌手的 3 首单曲顶掉，正经结果全没了。
       真歌手（那我懂你意思了 31 首 / 3 张完整专辑）才过得了这道闸。 */
    /* ⚠️ 不能卡 cat.complete（它要求 ≥15 首）：
       「脆弱少女組」Apple 只有 4 张 EP 共 13 首，可它确实是这位歌手，
       卡 complete 会把整个 Apple 骨架丢掉，退回酷狗那堆
       《脆弱少女》《总在脆弱的时候怀念你·少女泪》的同名杂牌单曲。
       改成「专辑 ≥2 张且曲目 ≥10」：晴天那种同名野鸡歌手（3 张 5 首）
       依然过不来，正规发过片的独立乐团能过。 */
    /* ⚠️ 还要过「这不是一首歌的名字」那道闸 —— 上面卡专辑数/曲目数只能
       挡住「3 张 5 首」的野鸡，挡不住同名大号：
       搜「后来」，Apple 把它认成歌手「後來者」（15 张专辑 45 首 → 全过），
       然后专辑页只剩《何时了却这牵挂》《未了的缘》——刘若英的《后来》
       一张都看不到。 */
    /* ⚠️ 专辑数门槛不能再死卡 2 张（搜「赵薇」）：
       赵薇在 Apple 里只有一张《天使旅行箱》10 首 —— 是货真价实的完整专辑，
       只是她作品本来就少。卡 2 张就把整个骨架丢掉，专辑页退回
       酷我/酷狗那堆同名翻唱：《断送青春爱错人》《花开又花谢花满天》
       《愿你》《秋风经过》，全是「赵薇薇」「赵雪薇」「赵紫薇」的。
       取而代之的判据：**艺人实体跟查询词完全同名 + 曲目够多（≥10）**。
       晴天那种同名野鸡歌手只有 3 张 5 首，曲目数过不了；
       只发过一两张正经专辑的真歌手能过。 */
    if (await appleSkeletonOk(cat, eq, query)) {
      appleAlbums = cat;
      console.log("[粽子] 酷狗无此歌手，改用 Apple 目录「" + cat.name + "」"
        + cat.albums.length + " 张");
    }
  }

  /* ---- Apple 也不给骨架时，退到 MusicBrainz ----
     实测（2026-10-21）搜「何韵诗」：
       酷狗/酷我/咪咕歌手接口全空，Apple 倒是有 52 张 122 首，
       但 **truncated=true**（lookup 200 条上限把曲目截断了），
       于是 appleSkeletonOk 直接把整个骨架丢掉 → 专辑页 0 张。
     而 MB 有 38 张发行 236 首，全都在一次请求里。
     ⚠️ 只在「本来就没歌手条目、Apple 也没给骨架」时问 MB ——
        有歌手条目的走上面那条 Apple 补齐的路，不重复问。 */
  if (!singerHit && !appleAlbums) {
    try {
      /* ⚠️ 这里已经是「零结果」了，多等 5s 换一整个页面的唱片值得。
         请求本身不取消，超了也会写进 MB_CACHE，下次搜就秒回。
         （实测 MB 延迟波动极大：万青 0.4s，赵薇/何韵诗 4.5~6s。） */
      const mcat = await Promise.race([
        mbArtistCatalog(eq).catch(function () { return null; }),
        new Promise(function (res) { setTimeout(function () { res(null); }, 5000); }),
      ]);
      if (await mbSkeletonOk(mcat, eq, query)) {
        appleAlbums = mcat;
        console.log("[粽子] Apple 无骨架，改用 MusicBrainz 目录「" + mcat.name + "」"
          + mcat.albums.length + " 张");
      }
    } catch (e) { /* MB 挂了就当没有 */ }
  }

  if (singerHit) {
    // 翻页也要继续用歌手目录，否则第 2 页又变回一堆同名翻唱
    const own = await singerAlbumAll(singerHit.id);
    const artistN = singerNorm(singerHit.name);
    /* 这条专辑是不是「他的」。
       ⚠️ 不能只看「歌手字段里含他的名字」：实测搜周杰伦会捞到
          「十年 ‖ 谭瑛&刘家文化传媒有限公司&周杰伦（中国港台）&世俗&华语群」——
          那是合辑，他只是被挂名的第 3 个。所以要求他排在前 2 位。 */
    const hitArtist = (x) => {
      const parts = String(x.artist || "").split(/[\/&、,，]/).map(singerNorm).filter(Boolean);
      if (!parts.length) return false;
      for (let i = 0; i < Math.min(2, parts.length); i++) {
        const a = parts[i];
        /* ⚠️ 这里的包含判断只在「一边是拉丁/纯英文写法」时成立。
           中文名多一个字就是另一个人：「赵薇薇」包含「赵薇」，
           于是搜赵薇时专辑页塞满《断送青春爱错人》《花开又花谢花满天》
           这些抖音翻唱 —— 而赵薇本人只有一张《天使旅行箱》。
           「陈奕迅 / Eason Chan」这种中英对照写法仍然要留，
           所以放宽条件设成「其中一边不含 CJK」。 */
        if (a === artistN) return true;
        const aHasCJK = /[\u4e00-\u9fff]/.test(a);
        const nHasCJK = /[\u4e00-\u9fff]/.test(artistN);
        if (aHasCJK && nHasCJK) continue;          // 两边都是中文 → 只认全等
        if (a.indexOf(artistN) >= 0 || artistN.indexOf(a) >= 0) return true;
      }
      return false;
    };

    /* 其余平台里也属于这位歌手的专辑，跟酷狗目录**混在一起**再排序。
       ⚠️ 必须跨平台按「专辑名 + 歌手」去重：
          周杰伦《范特西》在酷狗(10首)、酷我(10首)、咪咕都有，
          不去重的话前 62 条里有 20 多条是重复的同一张唱片。
       只在第 1 页接 —— 那些来源单次只给 10~20 条，翻页接不干净。 */
    const seenAlbum = {};
    const albumKey = (x) => singerNorm(x.artist || "") + "|" + normAlbumName(x.title);
    const kept = [];
    const push = (x) => {
      if (!x || !x.title) return;
      const k = albumKey(x);
      if (seenAlbum[k]) return;
      seenAlbum[k] = 1;
      kept.push(x);
    };
    // 酷狗（歌手页）优先，其次酷我/咪咕。
    // ⚠️ 歌手页里也混着「不能说的秘密 电影原声带 ‖ 华语群星」这种合辑，
    //    歌手字段写的是别人 —— 一样要过 hitArtist
    for (let i = 0; i < own.length; i++) {
      const x = own[i];
      if (x.artist && !hitArtist(x)) continue;
      push(x);
    }
    if (page === 1) {
      for (let i = 0; i < out.length; i++) {
        const x = out[i];
        if (x._isAudiobook || !hitArtist(x)) continue;
        push(x);
      }
    }

    /* ---- 平台目录太薄时，拿 Apple 的唱片补齐 ----
       酷狗认得出这位歌手，不等于它的唱片是齐的：
       实测搜「赵薇」，酷狗歌手页只挂着她几张单曲，
       真正的《天使旅行箱》整张十首只在 Apple 里有；
       搜「脆弱少女組」也是同样情况（4 张 EP 全在 Apple，酷狗只有同名杂牌）。
       所以「平台唱片少于 4 张」时补一次 Apple —— 平台条目一条不删（不硬删，
       真歌可能在别的平台），只把 Apple 有、平台没有的整张追加在后面。 */
    if (page === 1 && kept.length < 4) {
      try {
        const cat = await appleArtistCatalog(singerHit.name);
        if (await appleSkeletonOk(cat, singerHit.name, query)) {
          const before = kept.length;
          const merged2 = mergeAppleAlbums(cat, kept, false);
          kept.length = 0;
          for (let i = 0; i < merged2.length; i++) kept.push(merged2[i]);
          console.log("[粽子] 平台唱片只有 " + before + " 张 → 用 Apple 目录「"
            + cat.name + "」补到 " + kept.length + " 张");
        }
      } catch (e) { /* Apple 挂了就维持平台结果 */ }
    }

    /* ---- 还嫌薄？问 MusicBrainz ----
       实测（2026-10-21）：
         赵薇    Apple 1 张 / 10 首   → MB 13 张 / 118 首（《左耳》《双》《飘》全在）
         五条人？不用 —— 国内平台齐的歌手走不到这里。
       Apple 那边的问题是「香港区库不全 + lookup 200 条截断」，
       何韵诗 52 张被截断、赵薇直接只剩一张。MB 是纯社区录入，反而更全。
       ⚠️ 只在平台 + Apple 都补不够 8 张时才问 —— MB 一次要 1.2~4s，
          而且全局 1 req/s 限流，不能每个歌手都去问一遍。 */
    if (page === 1 && kept.length < 8) {
      try {
        /* 超时预算按「现在手里有几张」分档 —— 越空越值得等：
             0 张    → 7s（不等到就是整页空白）
             1~2 张  → 6s
             3~7 张  → 2.6s（有东西看就别再拖）
           ⚠️ MB 走两步（找艺人 + 拉发行），中间还有 1.1s 的限流间隔，
              所以一次完整调用实测 4~7s，预算给小了必然「第一次没有、
              第二次才有」。超时只是这一页少几张 —— 请求本身不取消，
              跑完照样写进 MB_CACHE，用户下次搜同一个歌手立刻就有。 */
        const mbBudget = kept.length === 0 ? 7000 : (kept.length < 3 ? 6000 : 2600);
        const mcat = await Promise.race([
          mbArtistCatalog(singerHit.name).catch(function () { return null; }),
          new Promise(function (res) { setTimeout(function () { res(null); }, mbBudget); }),
        ]);
        if (mcat && mcat.albums.length > kept.length) {
          /* ⚠️ mergeMbAlbums 是**原地追加**（返回的就是传进去那个数组），
             别再写成「取返回值 → 清空原数组 → 按返回值回填」——
             那两行指的是同一个数组，清空的瞬间返回值也空了，
             实测「平台 4 张 → 补到 0 张」，整页专辑全没。 */
          const before = kept.length;
          mergeMbAlbums(mcat, kept);
          console.log("[粽子] 平台 + Apple 只有 " + before + " 张 → 用 MusicBrainz「"
            + mcat.name + "」补到 " + kept.length + " 张");
        }
      } catch (e) { /* MB 挂了就维持现状 */ }
    }

    // 听书聚合条目照旧带出来（它本来就不是专辑）
    const books = page === 1 ? out.filter((x) => x._isAudiobook) : [];

    // 目录已经整份在手里 → 本地分页（别的平台补进来的只在第 1 页接）
    const full = sortAlbums(kept, singerHit.name);
    const begin = (page - 1) * 30;
    const slice = full.slice(begin, begin + 30);
    const merged = (page === 1 ? slice.concat(books) : slice);
    console.log("[粽子] 歌手名查询「" + singerHit.name + "」目录 " + full.length
      + " 张 → 第" + page + "页 " + merged.length + " 条");
    return { isEnd: begin + 30 >= full.length, data: merged };
  }

  /* ---- 酷狗没这个歌手，但有 Apple 目录：以 Apple 的唱片清单为准 ----
     第 1 条《那我懂你意思了》(2 首) 是野鸡单曲，
     后面八条《凤囚凰》《那年夏天》… 是冒名歌手的 1 首单曲。
     用户搜一个乐团，只想看到这个乐团真出过的唱片。 */
  if (appleAlbums) {
    /* Apple 的专辑名对到各平台结果上。
       用户搜歌手时看不到歌名列表，光有专辑名没有播放地址也没用，
       所以必须从平台结果里**配对**——名字对得上、歌手也对得上才算。 */
    const hitByName = (x) => {
      const a = singerNorm(x.artist || "");
      const names = [singerNorm(appleAlbums.name), singerNorm(eq), singerNorm(query)];
      for (let i = 0; i < names.length; i++) {
        if (names[i] && a && (a === names[i] || a.indexOf(names[i]) >= 0)) return true;
      }
      return false;
    };

    /* 以 **Apple 的唱片清单当骨架**，每张去平台结果里找对应条目替换。
       这样：Apple 有 3 张就一定是 3 张，顺序也是 Apple 的出版顺序；
       平台上真有的就用平台条目（能点进去听），没有的保留 Apple 条目占位。
       反过来做（以平台结果为主）会漏 —— 实测平台只有 1 条名字对得上，
       Apple 明明有 3 张。 */
    const pool = [];
    for (let i = 0; i < out.length; i++) {
      const x = out[i];
      if (x._isAudiobook) continue;
      if (!hitByName(x)) continue;
      pool.push(x);
    }
    const kept2 = mergeAppleAlbums(appleAlbums, pool, true);
    console.log("[粽子] Apple 目录「" + appleAlbums.name + "」" + appleAlbums.albums.length
      + " 张，其中 " + kept2.filter((x) => x._provider !== "apple").length + " 张配到平台音源");

    /* ---- Apple 自己就薄的时候，再让 MusicBrainz 补一次 ----
       实测（2026-10-21）搜「赵薇」：Apple 目录只有《天使旅行箱》一张，
       骨架跑完专辑页就 1 张；而 MB 有 13 张 118 首（《双》《飘》《左耳》
       全在）。DB 里她的其它片子 Apple 香港区根本没有。
       ⚠️ 只在骨架跑出来不到 8 张时补，别让周杰伦那种走这条（他本来就齐）。 */
    if (kept2.length < 8) {
      try {
        /* 预算同理（越空越值得等）：0 张 7s / 1~2 张 6s / 3 张以上 2.6s。 */
        const mbBudget2 = kept2.length === 0 ? 7000 : (kept2.length < 3 ? 6000 : 2600);
        const mcat = await Promise.race([
          mbArtistCatalog(appleAlbums.name || eq).catch(function () { return null; }),
          new Promise(function (res) { setTimeout(function () { res(null); }, mbBudget2); }),
        ]);
        if (mcat && mcat.albums.length > kept2.length) {
          const before = kept2.length;
          mergeMbAlbums(mcat, kept2);
          console.log("[粽子] Apple 只有 " + before + " 张 → 用 MusicBrainz「"
            + mcat.name + "」补到 " + kept2.length + " 张");
        }
      } catch (e) { /* MB 挂了就维持 Apple 骨架 */ }
    }

    const full2 = sortAlbums(kept2, appleAlbums.name);
    const begin2 = (page - 1) * 30;
    return { isEnd: begin2 + 30 >= full2.length, data: full2.slice(begin2, begin2 + 30) };
  }

  /* 排序：先按名字匹配度，再按「这张是谁的」。
     ⚠️ 必须在**所有平台合并完之后**才统计共识 ——
        只看酷狗那批的话，「范特西 周杰伦」和「范特西 KenYl」各出现一次，
        等于没有共识，顺序还是随机的。

     权威目录在这里补的是另一种情况：用户搜的其实是**歌名**
     （搜「晴天」「花海」，想看这首歌收在哪张专辑）。
     那种查询下同名专辑全是翻唱合集，共识统计反而会指向翻唱者；
     让 Apple Music 指路才靠谱。 */
  const albumAuth = await authorityHint(eq, null);
  let data = rankByName(out, eq, "title", artistConsensus(out, eq), albumAuth);

  /* ---- 用权威目录把「这首歌的正版专辑」顶到最前 ----
     实测搜「晴天」，各平台返回 50 张名字含「晴天」的专辑，头部全是翻唱合集，
     周杰伦《叶惠美》虽然也在结果里，却排在第 12 名 —— 因为名字里没有「晴天」。
     但用户搜一首歌，最想看的恰恰是「这首歌收在哪张专辑」。
     Apple Music 已经给了专辑名和歌手，直接按这个把它提上去。 */
  if (albumAuth && albumAuth.album) {
    const authAlbumN = normAlbumName(albumAuth.album);
    const authArtistN = singerNorm(albumAuth.artist);

    // 打标：哪些条目就是权威库指的那张正版专辑
    const marked = [];
    for (let i = 0; i < data.length; i++) {
      const x = data[i];
      if (normAlbumName(x.title) !== authAlbumN) continue;
      const xa = singerNorm(x.artist);
      if (authArtistN && xa && xa !== authArtistN &&
          xa.indexOf(authArtistN) < 0 && authArtistN.indexOf(xa) < 0) continue;
      x._authAlbum = 1;
      marked.push(x);
    }

    // 结果里没有 → 主动去查一张补进来
    if (!marked.length) {
      try {
        const [kw2, kg2] = await Promise.all([
          kuwoSearchTyped(albumAuth.album, "album", 1, 20).catch(() => ({ total: 0, list: [] })),
          kugouSearchAlbum(albumAuth.album, 1, 20).catch(() => []),
        ]);
        const cands = [];
        for (let i = 0; i < kw2.list.length; i++) {
          const a = kw2.list[i];
          cands.push({
            id: String(a.albumid || a.id || ""), platform: "酷我",
            title: a.name || a.title || "", artist: a.artist || "",
            artwork: a.pic || a.hts_img || "", date: a.pub || a.showtime || "",
            description: a.info || a.company || "",
            worksNum: Number(a.musiccnt || 0), _provider: "kuwo",
          });
        }
        for (let i = 0; i < kg2.length; i++) cands.push(kg2[i]);

        for (let i = 0; i < cands.length && marked.length < 2; i++) {
          const c = cands[i];
          if (!c.id || !c.title) continue;
          if (normAlbumName(c.title) !== authAlbumN) continue;
          const ca = singerNorm(c.artist);
          if (authArtistN && ca && ca !== authArtistN &&
              ca.indexOf(authArtistN) < 0 && authArtistN.indexOf(ca) < 0) continue;
          c._authAlbum = 1;
          marked.push(c);
        }
        const seenId = {};
        for (let i = 0; i < data.length; i++) seenId[data[i].platform + "|" + data[i].id] = 1;
        const fresh = marked.filter((c) => c && !seenId[c.platform + "|" + c.id]);
        if (fresh.length) data = fresh.concat(data);
      } catch (e) { /* 补不进来就算了，不影响主结果 */ }
    }

    /* ---- 专辑名对不上时的退路：按**权威歌手**排队 ----
       ⚠️ 实测搜「印第安老斑鸠」，Apple 给的是
          「印地安老斑鳩 / 周杰倫 / 专辑《杰倫》10 首」——
          可这张专辑在酷狗/酷我上叫《Jay》，名字怎么比都比不上，
          于是 29 条里头三位是《印第安老斑鸠》王肖百(8首)、宋辰(1首)、小傲(1首)
          这些同名翻唱，周杰伦《Jay》被压在 4~8 位。

          这时候专辑名不可靠，但**歌手**可靠：用户搜歌名，
          最该看到的就是「原唱把这首歌收录在哪张专辑」。
          所以把权威歌手名下的专辑整体提到前面，
          组内用酷狗原始顺序（酷狗的专辑搜索本来就是按「这张专辑里有这首歌」
          排的，《Jay》在第 1 位），曲目数多的优先。 */
    if (!marked.length && authArtistN) {
      for (let i = 0; i < data.length; i++) {
        const x = data[i];
        const xa = singerNorm(x.artist);
        if (!xa) continue;
        if (xa === authArtistN || xa.indexOf(authArtistN) >= 0 || authArtistN.indexOf(xa) >= 0) {
          x._authAlbum = 2;
          marked.push(x);
        }
      }
      if (marked.length) {
        console.log("[粽子] 专辑名对不上（" + albumAuth.album + "）→ 按权威歌手「"
          + albumAuth.artist + "」提权 " + marked.length + " 张");
      }
    }

    // 提到最前：曲目数多的在前（正版专辑曲目最多，也最能代表这张专辑）
    if (marked.length) {
      const top = marked.slice().sort((a, b) => (b.worksNum || 0) - (a.worksNum || 0));
      const inTop = {};
      for (let i = 0; i < top.length; i++) inTop[top[i].platform + "|" + top[i].id] = 1;
      const rest = data.filter((x) => !inTop[x.platform + "|" + x.id]);
      data = top.concat(rest);
    }
  }

  /* ---- 同名翻唱整体沉底（放在权威目录提权**之后**）----
     实测搜「叶惠美」返回 29 条，前 6 名里 5 条是同名翻唱专辑：
       叶惠美 / 周婕纶 7 首、叶惠美 / Jue Wang 19 首、王珏子乔 18 首、
       夜未央&小可 10 首、周杰伦《叶惠美》吉他翻唱版 / 涛李TAOLEE 3 首
     它们跟正版（11 首）名字一模一样，纯按名字匹配度打分完全打平，
     只能靠曲目数分先后 —— 于是 19 首的翻唱合集反而压过 11 首的正版。

     这里把「名字跟查询词一致、但歌手不是正主」的整批挪到后面（**不删**，
     想听翻唱还能往下翻）。正主从两处取，谁有信谁：
       ① Apple 权威目录（albumAuth）—— 最强，它直接说「这歌/这专辑是谁的」
       ② artistConsensus 的共识歌手 —— 兜底
     ⚠️ 两处都拿不到正主时**整段跳过**：搜「晴天」这种同名歌一堆的查询，
        搞不好「正主」本身就错，宁可保持原顺序也别乱动。 */
  const _owner = (albumAuth && albumAuth.artist ? singerNorm(albumAuth.artist) : "")
    || (function () {
      const c = artistConsensus(out, eq);
      return c && c.top ? c.top : "";
    })();
  if (_owner) {
    const qz2 = normTextZ(eq);
    const same = [];
    const rest2 = [];
    for (let i = 0; i < data.length; i++) {
      const x = data[i];
      const xa = singerNorm(x.artist || "");
      const xz = normTextZ(x.title || "");
      /* 「同名」只认**名字完全一致**（归一化后）：
         翻唱合集通常就叫《叶惠美》，跟正版一模一样。
         ⚠️ 别放宽到 indexOf —— 那样《天青色心湖》《橘子画卷》（歌手恰好叫叶惠美）
            也会被当成同名翻唱拉下去，可它们压根不是这张专辑。 */
      /* 除了名字完全一致，还认「名字里含查询词 + 带翻唱字样」的那种：
         实测《周杰伦<叶惠美>吉他翻唱版》就是这么写的，名字不相等，
         但它在用户眼里就是同一张专辑的翻唱版，一样该往后排。 */
      const isSameNamed = xz === qz2 ||
        (qz2.length >= 2 && xz.indexOf(qz2) >= 0 && /翻唱|cover|伴奏|纯音乐|純音樂|吉他|钢琴|鋼琴|remix|dj/i.test(String(x.title || "")));
      const isOwner = !!xa && (xa === _owner || xa.indexOf(_owner) >= 0);
      if (isSameNamed && !isOwner) same.push(x);
      else rest2.push(x);
    }
    if (same.length && rest2.length) {
      data = rest2.concat(same);
      console.log("[粽子] 同名翻唱沉底 " + same.length + " 条（正主：" + _owner + "）");
    }
  }

  /* 合并放在**排序之后**（理由见 dedupeAlbumList 的注释：放前面会削掉共识票数） */
  data = dedupeAlbumList(data);
  return { isEnd: out.length < KUWO_PAGE_SIZE, data: data };
}

/* ---------- 歌手 ---------- */
async function searchArtist(query, page) {
  /* ---- 原名反查：译名搜不到歌手时，换成平台认得的名字 ----
     实测 2026-10-18：
       摇晃帝国   酷我/咪咕/酷狗 全部 0 条 → 歌手页空白
       彩虹乐队   酷我返回 3 条，全是山寨号（128 首 / 1 首 / 慵懒彩虹乐队），
                 真身 L'Arc〜en〜Ciel（613 首）根本不在结果里
     反查拿到原名后再搜，两条都能出正确的人。
     ⚠️ 原查询自己就是歌手时一个字都不改（周杰伦、草东没有派对），
        否则会引入反查误判的风险。 */
  const aliasP = aliasCandidates(query).catch(() => ({ q: query, names: [query], auth: [] }));
  /* ⚠️ 平台搜索先用**原查询**发出去，跟反查**并发**跑。
     反查（QQ 1~2 秒 + 可能的酷狗判定）比平台搜索慢，
     串行等它就是白等；并发之后正常查询的耗时基本不变。 */
  const baseP = Promise.all([
    kuwoSearchTyped(query, "artist", page, KUWO_PAGE_SIZE).catch(() => ({ total: 0, list: [] })),
    miguSearchTyped(query, "singer", page, 10).catch(() => ({ total: 0, list: [] })),
    // 冷门独立乐团在酷我/咪咕根本没有条目，只有 YouTube 的官方 Topic 频道路过
    page === 1 ? ytSearchRaw(query).catch(() => []) : Promise.resolve([]),
    /* 网易云 / 酷狗 / QQ 三路补进来（2026-10-20）。
       原来只有酷我+咪咕，搜「周杰伦」只回一条、搜「五月天」还冒出山寨号。
       ⚠️ 三路都带超时：QQ 实测 1.4~1.5 秒，跟酷我同批并发不会拖慢整次搜索
          （它本来就是最慢那个）；网易云 130~250ms、酷狗 ~300ms。 */
    neteaseSearchArtist(query, page, 10).catch(() => []),
    kugouSearchSinger(query, page, 10).catch(() => []),
    qqSearchArtist(query, page, 10).catch(() => []),
  ]);

  const pick = await pickEffectiveName(query, aliasP).catch(() => ({ name: query, via: "", names: [query] }));
  const eq = pick.name;
  let [kw, mg, yt, ne, kgs, qqs] = await baseP;

  /* 什么时候要拿原名重搜：
     - QQ 明确声明过（authoritative）：一定换 —— 译名条目在原查询下
       往往全是山寨号（彩虹乐队 → 3 条假货，本尊明明 613 首）
     - 只是推断出来的别名：只有原查询**什么都没搜到**才换，
       有结果就别动，避免把正常查询搞乱。 */
  const authList = (pick.auth || []).map(normTextZ);
  const isAuth = eq !== query && authList.indexOf(normTextZ(eq)) >= 0;
  /* ⚠️ 只认酷我/咪咕的歌手库，别把 YouTube 算进来：
     它按分词召回，搜「摇晃帝国」也会回一堆视频，`yt.length` 非 0，
     于是 isEmpty 判成 false、不触发重搜 —— 可那些视频的频道名里
     根本没有这个词，过滤后 out 依然是空的，结果白等一次。
     酷我/咪咕是真正的歌手库，它们空 = 平台不认这个名字。 */
  const isEmpty = !kw.list.length && !mg.list.length;
  if (eq !== query && (isAuth || isEmpty)) {
    const [kw2, mg2, yt2, ne2, kgs2, qqs2] = await Promise.all([
      kuwoSearchTyped(eq, "artist", page, KUWO_PAGE_SIZE).catch(() => ({ total: 0, list: [] })),
      miguSearchTyped(eq, "singer", page, 10).catch(() => ({ total: 0, list: [] })),
      page === 1 ? ytSearchRaw(eq).catch(() => []) : Promise.resolve([]),
      neteaseSearchArtist(eq, page, 10).catch(() => []),
      kugouSearchSinger(eq, page, 10).catch(() => []),
      qqSearchArtist(eq, page, 10).catch(() => []),
    ]);
    console.log("[粽子] 歌手「" + query + "」" + (isAuth ? "有权威原名" : "原查询无结果")
      + " → 改用「" + eq + "」重搜");
    kw = kw2; mg = mg2; yt = yt2; ne = ne2; kgs = kgs2; qqs = qqs2;
  }

  /* 过滤用的名字集合：原名 + 原查询 + 其余别名。
     ⚠️ 原名必须在里面 —— 换了名字去搜，结果里当然只有原名。 */
  const nameSet = [];
  const addName = (s) => {
    const n = String(s || "").trim();
    if (!n) return;
    for (let i = 0; i < nameSet.length; i++) if (flatTitle(nameSet[i]) === flatTitle(n)) return;
    nameSet.push(n);
  };
  addName(eq);
  addName(query);
  for (let i = 0; i < (pick.names || []).length; i++) addName(pick.names[i]);

  const out = [];
  const seen = {};

  // ⚠️ 酷我 ft=artist 返回的字段是**全大写**（ARTIST / ARTISTID / SONGNUM），
  //    而且头像要给 PICPATH 拼上 BASEPICPATH 前缀。
  //
  // ⚠️ 更要命的是：它会把**相关歌手**一起塞回来。
  //    搜「周杰伦」实测 8 条里只有 1 条是周杰伦，其余是
  //    陈奕迅 / 刘欢 / 那英 / 费玉清 / 张惠妹 —— 全是「风格相近」推荐。
  //    不做过滤的话，用户搜歌手会看到一堆完全不相干的人。
  const basePic = kw.list.length && kw.list[0].__basePic ? kw.list[0].__basePic : "";
  for (let i = 0; i < kw.list.length; i++) {
    const a = kw.list[i];
    const id = String(a.ARTISTID || a.artistid || a.DC_TARGETID || "");
    if (!id || seen[id]) continue;
    const nm = String(a.ARTIST || a.artist || "").replace(/&nbsp;/g, " ").trim();
    if (!nm) continue;
    /* 只留名字对得上的（允许繁简/大小写差异）。
       ⚠️ 这里必须用 artistNameOk 而不是 nameMatchesAny：
          nameMatchesAny 是「包含即通过」，会把「赵薇薇」当成「赵薇」
          （酷我搜「赵薇」第一条歌手结果就是「赵薇薇」，459 首），
          于是搜赵薇先跳出一个名字多一个字的别人。
          artistNameOk 要求完全相等，或者「拉丁前缀 + 中文名」那种
          写法（g.e.m. 邓紫棋），中文多字一律不算。 */
    if (!artistNameOk(nm, nameSet, query)) continue;
    seen[id] = 1;
    let pic = a.PICPATH || a.hts_PICPATH || "";
    if (pic && pic.indexOf("http") !== 0) pic = (basePic || "http://img1.kuwo.cn/star/starheads/") + pic;
    out.push({
      id: id,
      platform: "酷我",
      name: nm,
      avatar: pic,
      worksNum: Number(a.SONGNUM || a.ALBUMNUM || 0),
      fans: Number(a.SHOW || 0),
      description: String(a.desc || "").replace(/&nbsp;/g, " "),
      _provider: "kuwo",
    });
  }

  for (let i = 0; i < mg.list.length; i++) {
    const a = mg.list[i];
    const id = String(a.id || "");
    if (!id || seen[id]) continue;
    /* 咪咕的 singer 搜索会混进两类垃圾：
     *   ①「周杰伦战队」「周杰伦是我粉丝」这类用户/组合 —— 长度能挡住；
     *   ② 完全无关的「相关歌手」—— 搜「IGU Band」它回 The Band / OK Band
     *      / Alex Band / This Band，长度跟查询几乎一样，光靠长度过滤不掉。
     * 所以必须要求**名字里真的含查询词**（繁简归一后比），才留下。 */
    const nm = String(a.name || "");
    if (!nameMatchesAny(nm, nameSet)) continue;
    /* ⚠️ 长度松紧度不能替代名字校验：搜「王菲」，咪咕会回「王菲菲」「王菲儿」，
       长度只多一个字，旧的「≤ 查询词+1」卡不住。这两个是另外的歌手。
       名字本身必须对得上（全等，或「拉丁前缀 + 中文名」那种写法）。 */
    if (!artistNameOk(nm, nameSet, query)) continue;
    // 换名搜索时不能再按「查询词长度」卡，否则「ゆらゆら帝国」会被算太长
    if (pick.via && nm.length > eq.length + 1) continue;
    if (!pick.via && nm.length > String(query).length + 1) continue;
    seen[id] = 1;
    const imgs = a.imgItems || [];
    out.push({
      id: id,
      platform: "咪咕直出",
      name: nm,
      avatar: (imgs[0] && imgs[0].img) || "",
      worksNum: 0,
      fans: 0,
      description: "",
      _provider: "miguapi",
    });
  }

  /* ---- 网易云 / 酷狗 / QQ 三路（2026-10-20 补）----
     跟酷我/咪咕走同一道闸：名字必须对上，否则这三家会捎回来一堆
     「相关歌手」和蹭词山寨号（实测搜「周杰伦」，QQ 顺带回了
     Lara梁心颐、张惠妹；酷狗回了 8 个「周杰伦战队」式的号）。

     ⚠️ 作品数这里有坑：
       网易云 musicSize 是"参与过的曲目总数"（周杰伦 581），
       酷我 SONGNUM 是 1708 —— 两家口径不同，但都比 0 靠谱，
       所以直接采信，只做「比已有值大就更新」而不覆盖。
       QQ 的 songNum 口径跟酷我接近，同样处理。 */

  for (let i = 0; i < (ne || []).length; i++) {
    const a = ne[i];
    /* ⚠️ 名字闸只能挡「非拉丁前缀」那种（东北周杰伦），挡不住
       「周杰伦.」「周杰伦♚」—— 它们归一化后以查询词结尾，前缀是标点。
       这类的共同特征是**几乎没作品**（网易云实测各 1~20 首，本尊 581 首）。
       所以再加一道：名字不完全等于查询词的，作品数得够看。 */
    if (singerNorm(a.name) !== singerNorm(String(query).trim()) &&
        !nameSet.some((n) => singerNorm(n) === singerNorm(a.name)) &&
        Number(a.worksNum || 0) < 50) continue;
    if (!a.id || seen["ne:" + a.id]) continue;
    if (!artistNameOk(a.name, nameSet, query)) continue;
    // 精确匹配才留全名，别名命中只是「可能」，压到后面由排序器决定
    seen["ne:" + a.id] = 1;
    out.push({
      id: "neart:" + a.id,
      platform: "网易云",
      name: a.name,
      avatar: a.avatar,
      worksNum: a.worksNum,
      albumNum: a.albumNum,
      fans: 0,
      description: "",
      _provider: "netease",
    });
  }

  for (let i = 0; i < (kgs || []).length; i++) {
    const a = kgs[i];
    if (!a.id || seen["kg:" + a.id]) continue;
    if (!artistNameOk(a.name, nameSet, query)) continue;
    seen["kg:" + a.id] = 1;
    out.push({
      id: "kgs:" + a.id,
      platform: "酷狗",
      name: a.name,
      avatar: a.avatar,
      worksNum: 0,
      albumNum: 0,
      fans: 0,
      description: "",
      _provider: "kugou",
    });
  }

  for (let i = 0; i < (qqs || []).length; i++) {
    const a = qqs[i];
    if (!a.id || seen["qq:" + a.id]) continue;
    if (!artistNameOk(a.name, nameSet, query)) continue;
    seen["qq:" + a.id] = 1;
    out.push({
      id: "qqa:" + a.mid,          // 取流一路都用 mid，不用数字 id
      platform: "QQ音乐",
      name: a.name,
      avatar: a.avatar,
      worksNum: a.worksNum,
      albumNum: a.albumNum,
      fans: 0,
      description: "",
      _provider: "qq",
    });
  }


  /* YouTube 兜底：冷门独立乐团在酷我/咪咕整个库里没有条目 ——
     搜「IGU Band」酷我回 0 条、咪咕回一堆同名无关的乐队。
     但它自己的歌在 YouTube 上有整套官方发行（「IGU Band - Topic」频道）。
     这里把「频道名 = xxx - Topic」的收敛成一条歌手条目，
     作品数按这次搜到的曲目数给，点进去 getArtistWorks 会用频道名再搜。 */
  if (yt && yt.length) {
    const ytArt = {};
    const ytOrder = [];
    for (let i = 0; i < yt.length; i++) {
      const ch = String(yt[i].artist || "").replace(/\s*[-–—]\s*Topic\s*$/i, "").trim();
      if (!ch) continue;
      const cn = flatTitle(ch);
      if (!cn) continue;
      // 频道名必须含查询词/原名，否则「My Weekend with Books」这种翻唱频道也会进来
      if (!nameMatchesAny(ch, nameSet)) continue;
      if (!ytArt[cn]) { ytArt[cn] = { name: ch, n: 0, avatar: yt[i].artwork || "" }; ytOrder.push(cn); }
      ytArt[cn].n++;
    }
    for (let i = 0; i < ytOrder.length; i++) {
      const a = ytArt[ytOrder[i]];
      const cn = ytOrder[i];
      /* 已经有「正经歌手库」的条目时别再出一条 YouTube 的 ——
         搜「周杰伦」会多出一个「周杰倫 Jay Chou」频道条目，跟酷我的
         「周杰伦」其实是同一个人，用户看到就是重复。 */
      let dup = false;
      for (let j = 0; j < out.length; j++) {
        const en = flatTitle(out[j].name || "");
        if (en && (en === cn || cn.indexOf(en) >= 0)) { dup = true; break; }
      }
      if (dup) continue;
      const id = "ytch:" + a.name;
      if (seen[id]) continue;
      seen[id] = 1;
      /* 作品数别直接报「本次搜到几条」—— 按频道名搜只回 5~6 条，
         界面上会写「6 首」，可这团实际有 31 首。有 Apple 目录就用它的曲目数。
         （catalog 有 1 小时缓存，getArtistWorks 里再取是命中缓存，不会再打请求） */
      let worksNum = a.n;
      try {
        const c = await appleArtistCatalog(a.name);
        if (c && c.tracks && c.tracks.length > worksNum) worksNum = c.tracks.length;
      } catch (e) { /* 拿不到就按搜到的条数 */ }
      out.push({
        id: id,
        platform: "YouTube",
        name: a.name,
        avatar: a.avatar,
        worksNum: worksNum,
        fans: 0,
        description: "",
        _provider: "youtube",
      });
    }
  }

  /* ---- Apple 目录兜底：冷门独立乐团在酷我/咪咕/酷狗/YouTube 全都没有条目 ----
     实测搜「脆弱少女组」：酷我 total=0，咪咕只回「开心少女组 / 花季少女三人组 /
     冰淇淋少女组」三条完全无关的组合，YouTube 也搜不出 Topic 频道 ——
     于是歌手页空白，界面写「没有找到相关结果」。
     但 Apple Music 里它整整齐齐：艺人 id 1223943074，10 首。

     判据：三个平台加起来**一条都没有**，才去问 Apple。
     有一条就不兜底 —— 否则搜「周杰伦」会多出一个重复的 Apple 条目。 */
  if (!out.length) {
    try {
      /* 换名了就先拿原名问 Apple（Apple 通常也只认原名），
         原名也没有再退回原查询。 */
      let cat = await appleArtistCatalog(eq);
      if (!(cat && cat.id) && eq !== query) cat = await appleArtistCatalog(query);
      if (cat && cat.id && (cat.albums.length || cat.tracks.length)) {
        console.log("[粽子] 平台全无此歌手，Apple 目录「" + cat.name + "」"
          + cat.albums.length + " 张 / " + cat.tracks.length + " 首");
        /* ⚠️ 列表里的「N 首」也得是真的。
           实测「赵薇」：Apple 香港区只有《天使旅行箱》10 首，
           于是歌手条目写着「10 首」，用户以为她只发过一张唱片 ——
           实际上 MusicBrainz 有 77 首。点进去已经补全了，但列表这一行
           是用户第一眼看到的东西，不能留着错的。
           ⚠️ 4s 预算 + 只在 Apple 明显薄（<20 首）时才问，别拖累正常歌手。 */
        let worksNum = cat.tracks.length || cat.albums.length;
        if (cat.tracks.length < 20) {
          try {
            const mcat = await Promise.race([
              mbArtistCatalog(cat.name || eq).catch(function () { return null; }),
              new Promise(function (res) { setTimeout(function () { res(null); }, 4000); }),
            ]);
            if (mcat && mcat.tracks.length > worksNum) {
              worksNum = mcat.tracks.length;
              console.log("[粽子] 「" + cat.name + "」Apple 只有 "
                + cat.tracks.length + " 首 → 按 MusicBrainz 记 " + worksNum + " 首");
            }
          } catch (e) { /* 拿不到就按 Apple 的算 */ }
        }
        out.push({
          id: "apart:" + cat.id,
          platform: "Apple Music",
          name: cat.name || eq,
          avatar: (cat.albums[0] && cat.albums[0].artwork) || "",
          worksNum: worksNum,
          fans: 0,
          description: "",
          _provider: "apple",
        });
      }
    } catch (e) { /* 拿不到就维持空结果 */ }

    /* Apple 也没有（或 iTunes 那几个区都没铺这个人）→ 问 YouTube Music。
       实测「脆弱少女组」Apple 目录取不到（null），YTM 有 3 张 16 首。
       两家都是「平台全无」时的兜底，先 Apple 后 YTM，谁有就用谁。 */
    if (!out.length) {
      try {
        let cat = await ytmArtistCatalog(eq);
        if (!cat && eq !== query) cat = await ytmArtistCatalog(query);
        if (cat && (cat.albums.length || cat.tracks.length)) {
          console.log("[粽子] 平台与 Apple 全无此歌手，YouTube Music 目录「" + cat.name + "」"
            + cat.albums.length + " 张 / " + cat.tracks.length + " 首");
          out.push({
            id: "ytmcat:" + cat.id,
            platform: "YouTube",
            name: cat.name || eq,
            avatar: (cat.albums[0] && cat.albums[0].artwork) || "",
            worksNum: cat.tracks.length || cat.albums.length,
            albumNum: cat.albums.length,
            fans: 0,
            description: "",
            _provider: "youtube",
            _ytmCh: cat.id,
          });
        }
      } catch (e) { /* 还拿不到就维持空结果 */ }
    }
  }

  /* 排序：统一走 sortArtistResults（2026-10-21）。
     原来分两条路 —— 没别名用 rankByName、有别名用 rankArtistCandidates，
     两条各自加减分，结果「同档里名字短的排前面」这条规则两边都没有，
     于是搜「彩虹乐队」时 13 字的 L'Arc-en-Ciel 压着 4 字的彩虹乐队。
     现在档位（权威原名 > 全等 > 别名全等 > 包含 > 沾边）之后直接比长度，
     短的在前，跟 LX Music 一样。 */
  const ranked = sortArtistResults(out, query, pick.names, pick.auth);
  const deduped = dedupeArtists(ranked);

  /* 咪咕的歌手数据只有 id/name/highlightStr 三个字段（没有作品数、没有头像），
     单独出现时会显示成「0 首」的空条目，看着像坏数据。
     这里对作品数为 0 的条目补一次真实数量（最多补 3 条，控制耗时）。 */
  const needFix = deduped.filter((x) => !Number(x.worksNum)).slice(0, 3);
  if (needFix.length) {
    await Promise.all(needFix.map(async (x) => {
      try {
        const n = await kugouSingerSongCount(x.name);
        if (n > 0) x.worksNum = n;
      } catch (e) { /* 忽略 */ }
    }));
  }

  /* ---- YouTube Music 目录兜底（2026-10-21）----
     有些歌手在国内平台上根本没有正经条目，只有一个同名野鸡号：
       搜「李志」网易云给的是 musicSize=2 的空壳（《Tbzjfdasg》《Ozjdgwaasd》
       这种乱码歌名），QQ 歌手接口 500003 已死，酷狗只回「李志辉 / 李志强」，
       酷我/咪咕压根没有。但李志在 YouTube Music 上有 13 张官方专辑 110 首 ATV。
     判据：条目作品数少得离谱（<10）→ 问 YTM。YTM 明显更全才接管，
     否则不动（周杰伦 1708 首永远走国内源，不会去问 YTM）。 */
      /* ⚠️ 别让 YTM 抢走本来更全的平台条目（2026-10-21 实测「木马」）：
         酷我「木马Muma」有 101 首，但列表里第一条是 YTM 的「木马」9 首，
         于是网易云那条 9 首的野鸡条目被判「只有 9 首」→ 改用 YTM 目录 →
         用户点进去看到 9 首《旧城之王 (Live)》，以为乐队只有现场版。
         判据改成「YTM 要明显更全（1.5 倍以上）才接管」，
         而且接管后**别把 platform 改成 YouTube** —— 酷我那 101 首还在 _alts 里，
         标成 YouTube 会让它看起来只有一个源。 */
  const ytmTargets = deduped.filter((x) => Number(x.worksNum) < 10).slice(0, 2);
  if (ytmTargets.length) {
    await Promise.all(ytmTargets.map(async (x) => {
      try {
        const cat = await ytmArtistCatalog(x.name);
        if (!cat || !cat.tracks || !cat.tracks.length) return;
        if (cat.tracks.length <= Number(x.worksNum || 0)) return;
        /* ⚠️ 比较基准不能只看这一条自己的 worksNum ——
           同一个乐队在各平台的名字常写成「木马 / 木马Muma / muma木马」，
           分开成三条，而第一条（YTM 那条）写着 4 首。
           实测「木马」：第一条 4 首 → YTM 9 首「明显更全」→ 接管，
           可酷我「木马Muma」明明有 101 首，用户只看到 9 首 Live。
           所以基准取「自己 + 名字相近的兄弟条目」里最大的那个。 */
        let base = Number(x.worksNum || 0);
        const selfN = singerNorm(x.name || "");
        for (let i = 0; i < deduped.length; i++) {
          const s = deduped[i];
          if (!s || s === x) continue;
          const sn = singerNorm(s.name || "");
          if (!sn || !selfN) continue;
          if (sn !== selfN && !oneNameEq(s.name, selfN) && !oneNameEq(x.name, sn)) continue;
          if (Number(s.worksNum || 0) > base) base = Number(s.worksNum || 0);
        }
        /* 「明显更全」才接管（1.5 倍），否则留在原平台（能直取音源）。 */
        if (cat.tracks.length <= base) return;
        if (cat.tracks.length < base * 1.5 && base >= 5) return;
        console.log("[粽子] 「" + x.name + "」平台条目只有 " + Number(x.worksNum || 0)
          + " 首，改用 YouTube Music 目录 " + cat.albums.length + " 张 / " + cat.tracks.length + " 首");
        x._ytmCh = cat.id;
        /* 平台名也跟着换 —— 点进去出来的全是 YouTube 的曲目，
           还挂着「网易云」的标签会让人以为串源了。 */
        x.platform = "YouTube";
        x.worksNum = cat.tracks.length;
        x.albumNum = cat.albums.length;
        if (!x.avatar && cat.albums[0] && cat.albums[0].artwork) x.avatar = cat.albums[0].artwork;
      } catch (e) { /* 拿不到就维持原样 */ }
    }));
  }

  /* ⚠️「有数字」不等于「数字对」：实测「那我懂你意思了」，
     酷狗把名字指向了冒名歌手（名下只有 2 首），列表就写「2 首」，
     用户会以为源坏了 —— 其实真乐团 31 首。Apple 目录更全时以它为准。 */
  const fewWorks = deduped.filter((x) => Number(x.worksNum) < 10 && !x._ytmCh).slice(0, 3);
  if (fewWorks.length) {
    await Promise.all(fewWorks.map(async (x) => {
      try {
        const cat = await appleArtistCatalog(x.name);
        if (cat && cat.tracks.length > Number(x.worksNum)) x.worksNum = cat.tracks.length;
      } catch (e) { /* 忽略 */ }
    }));
  }

  /* ---- 空壳号指向真身（八仙饭店 1 首 → 八仙 8Immortals 22 首）----
     ⚠️ 别名那条路不可靠：aliasCandidates 要联网反查，实测同一个词
        有时给「八仙 8Immortals」有时只给原名，于是补条目时灵时不灵。
     换一个**完全本地**的判据：同一次搜索的两条结果，名字共享 ≥2 个汉字前缀，
     且一条几乎没作品（≤3 首）、另一条有货（≥5 首）——
     这种组合实际就是「空壳号 + 真身」（网易云/QQ 各建了一条）。
     ⚠️ 只改数字 + 登记 id，**不删条目**：万一那 2 首是真的，
        合并过去用户照样能看到（_alts 会把两边的曲目并起来）。 */
  const shellTargets = deduped.filter((x) => Number(x.worksNum || 0) <= 3).slice(0, 3);
  if (shellTargets.length) {
    await Promise.all(shellTargets.map(async (x) => {
      const xn = normTextZ(x.name || "");
      if (xn.length < 2) return;
      let twin = null;
      for (let i = 0; i < deduped.length; i++) {
        const y = deduped[i];
        if (!y || y === x) continue;
        if (Number(y.worksNum || 0) < 5) continue;
        const yn = normTextZ(y.name || "");
        if (yn.length < 2) continue;
        let shared = 0;
        while (shared < xn.length && shared < yn.length && xn[shared] === yn[shared]) shared++;
        /* 前缀要 ≥2 个**汉字**（数字/拉丁不算，否则「8」开头的会乱撞） */
        let cjk = 0;
        for (let k = 0; k < shared; k++) if (/[\u4e00-\u9fff]/.test(xn[k])) cjk++;
        if (cjk < 2) continue;
        if (!twin || Number(y.worksNum) > Number(twin.worksNum)) twin = y;
      }
      if (!twin) return;
      console.log("[粽子] 「" + x.name + "」只有 " + Number(x.worksNum || 0)
        + " 首，同批里的「" + twin.name + "」有 " + twin.worksNum + " 首 → 合并取源");
      x.worksNum = Number(twin.worksNum);
      if (!x._alts) x._alts = [{ id: x.id, platform: x.platform, provider: x._provider }];
      const ta = twin._alts && twin._alts.length
        ? twin._alts
        : [{ id: twin.id, platform: twin.platform, provider: twin._provider }];
      for (let i = 0; i < ta.length; i++) {
        let dup3 = false;
        for (let j = 0; j < x._alts.length; j++) if (x._alts[j].id === ta[i].id) { dup3 = true; break; }
        if (!dup3) x._alts.push(ta[i]);
      }
    }));
  }

  const aliasTargets = deduped.filter((x) => Number(x.worksNum) < 10 && !x._ytmCh).slice(0, 2);
  if (aliasTargets.length) {
    try {
      const ap = await aliasCandidates(query).catch(() => null);
      const names = (ap && ap.names) || [];
      const siblings = names.filter((n) => n && singerNorm(n) !== singerNorm(query));
      /* ⚠️ 别名那条可能根本没出现在这次的条目里 —— 实测「八仙饭店」：
         别名解析给出「八仙 8Immortals」，但各平台歌手搜索只回了「八仙饭店」
         这一条（那个带着 22 首的网易云条目这次没搜出来）。
         所以别名查不到兄弟条目时，得**自己拿别名再搜一次歌手列表**。 */
      if (siblings.length && !deduped.some((y) =>
        siblings.some((n) => singerNorm(n) === singerNorm(y.name)))) {
        try {
          /* 三家一起问。⚠️ 不能只问酷我/酷狗 ——
             实测「八仙 8Immortals」这个写法**只有网易云有**，
             酷我/酷狗搜它一条都不回，于是补了个寂寞，
             下一轮搜索又退回到「八仙饭店 | 1 首」那条野鸡号。
             （网易云那次搜索本身是间歇性的：它偶尔返回 405「操作频繁」，
               所以同一首歌有时候第一条是 1 首、有时候是 22 首。） */
          const [kwA, kgA, neA] = await Promise.all([
            kuwoSearchTyped(siblings[0], "artist", 1, 10).catch(() => ({ total: 0, list: [] })),
            kugouSearchSinger(siblings[0], 1, 10).catch(() => []),
            neteaseSearchArtist(siblings[0], 1, 10).catch(() => []),
          ]);
          const extra = [];
          for (let i = 0; i < (kwA.list || []).length; i++) {
            const a2 = kwA.list[i];
            if (!a2 || !a2.name || !a2.id) continue;
            if (!siblings.some((n) => singerNorm(n) === singerNorm(a2.name))) continue;
            extra.push({
              id: String(a2.id), platform: "酷我", name: a2.name,
              avatar: a2.pic || "", worksNum: Number(a2.musiccnt || 0),
              _provider: "kuwo",
            });
          }
          for (let i = 0; i < (kgA || []).length; i++) {
            const a2 = kgA[i];
            if (!a2 || !a2.name) continue;
            if (!siblings.some((n) => singerNorm(n) === singerNorm(a2.name))) continue;
            extra.push({
              id: "kgs:" + a2.id, platform: "酷狗", name: a2.name,
              avatar: a2.avatar || "", worksNum: 0, _provider: "kugou",
            });
          }
          for (let i = 0; i < (neA || []).length; i++) {
            const a2 = neA[i];
            if (!a2 || !a2.name || !a2.id) continue;
            if (!siblings.some((n) => singerNorm(n) === singerNorm(a2.name))) continue;
            extra.push({
              id: "neart:" + a2.id, platform: "网易云", name: a2.name,
              avatar: a2.avatar || "", worksNum: Number(a2.worksNum || 0),
              albumNum: Number(a2.albumNum || 0), _provider: "netease",
            });
          }
          if (extra.length) {
            for (let i = 0; i < extra.length; i++) deduped.push(extra[i]);
            console.log("[粽子] 别名「" + siblings[0] + "」补回 " + extra.length + " 条歌手条目");
          }
        } catch (e) { /* 补不到就算了 */ }
      }
      if (siblings.length) {
        await Promise.all(aliasTargets.map(async (x) => {
          let best = Number(x.worksNum || 0);
          for (let i = 0; i < siblings.length; i++) {
            try {
              const sib = deduped.filter((y) => singerNorm(y.name) === singerNorm(siblings[i]))[0];
              if (sib && Number(sib.worksNum) > best) best = Number(sib.worksNum);
            } catch (e) { /* 忽略 */ }
          }
          if (best > Number(x.worksNum || 0)) {
            console.log("[粽子] 「" + x.name + "」同名号只有 " + Number(x.worksNum || 0)
              + " 首 → 按别名「" + siblings[0] + "」记 " + best + " 首");
            x.worksNum = best;
          }
          /* ⚠️ 光改数字没用 —— 数字说 22 首，点进去还是 2 首，更难受。
             把别名那条更全的 id 登记进 _alts，歌手页会两边一起取再合并
             （_alts 那套本来就是给跨平台版权分流用的，这里正好复用）。 */
          for (let i = 0; i < siblings.length; i++) {
            const sib = deduped.filter((y) => singerNorm(y.name) === singerNorm(siblings[i]))[0];
            if (!sib || sib.id === x.id) continue;
            if (!x._alts) x._alts = [{ id: x.id, platform: x.platform, provider: x._provider }];
            let dup2 = false;
            for (let j = 0; j < x._alts.length; j++) if (x._alts[j].id === sib.id) { dup2 = true; break; }
            if (!dup2) x._alts.push({ id: sib.id, platform: sib.platform, provider: sib._provider });
          }
        }));
      }
    } catch (e) { /* 别名解析失败就算了 */ }
  }

  return { isEnd: deduped.length < KUWO_PAGE_SIZE, data: deduped };
}

/**
 * 歌手去重：同名歌手只留信息最全的那一条。
 *
 * 背景：搜「周杰伦」会同时返回
 *    [酷我]     周杰伦  worksNum=1708  ← 字段齐全
 *    [咪咕直出] 周杰伦  worksNum=0     ← 点进去其实有 30 首（走酷狗通道）
 *
 * 用户会觉得「0」是坏数据想删掉，但它**并不是空的** —— 真的删了反而少一个源。
 * 正确做法是按名字合并，保留 worksNum 大的那个（信息更全），
 * 而不是看到 0 就过滤。
 */
function dedupeArtists(list) {
  const byName = {};
  const order = [];
  const score = (x) =>
    (Number(x.worksNum) > 0 ? 2 : 0) +
    (x.avatar ? 1 : 0) +
    (x.description ? 1 : 0);

  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    // 跨平台也合并：用户不需要看到两个「周杰伦」。
    // 这样咪咕那条 worksNum=0 的重复条目就自然消失了，
    // 留下的是酷我那条 1708 的 —— 而不是简单地「看到 0 就删」。
    const k = singerNorm(a.name || "");
    if (!k) continue;
    const prev = byName[k];
    if (!prev) {
      /* ⚠️ 合并会丢掉别的源的 id —— 而每个源的作品是分开拉的
         （酷我 id / neart:<id> / kgs:<id> / qqa:<mid>）。
         这里把所有来源登记到 _alts 上，歌手页会挨个去取、合并去重，
         这样搜「周杰伦」点进去既有酷我的 1708 首，也有网易云/QQ 那边
         酷我缺的曲目（版权分流，各家都不全）。 */
      a._alts = [{ id: a.id, platform: a.platform, provider: a._provider }];
      byName[k] = a;
      order.push(k);
      continue;
    }
    if (!prev._alts) prev._alts = [{ id: prev.id, platform: prev.platform, provider: prev._provider }];
    let dup = false;
    for (let j = 0; j < prev._alts.length; j++) if (prev._alts[j].id === a.id) { dup = true; break; }
    if (!dup) prev._alts.push({ id: a.id, platform: a.platform, provider: a._provider });
    if (score(a) > score(prev)) {
      // 换主条目，但 _alts 要带走
      a._alts = prev._alts;
      for (let j = 0; j < a._alts.length; j++) if (a._alts[j].id === a.id) { a._alts.splice(j, 1); break; }
      a._alts.unshift({ id: a.id, platform: a.platform, provider: a._provider });
      byName[k] = a;
    }
  }
  return order.map((k) => byName[k]);
}

/* ---------- 歌单 ---------- */
async function searchSheet(query, page) {
  const [kw, kg, ne] = await Promise.all([
    kuwoSearchTyped(query, "playlist", page, KUWO_PAGE_SIZE).catch(() => ({ total: 0, list: [] })),
    // 酷狗歌单有官方运营账号，实测「陈奕迅」第 1 条就是
    // 「陈奕迅生日快乐丨陪你度过漫长岁月 / 酷狗音乐官方歌单」137 首
    kugouSearchSpecial(query, page, 10).catch(() => []),
    // 网易云补歌单。酷我对冷门乐团常常 0 条（实测「那我懂你意思了」
    // 酷我 total=0，只剩酷狗在乱凑），而网易云正好有真实歌单。
    neteaseSearchSheet(query, page, 10).catch(() => []),
  ]);

  const out = [];
  const seen = {};
  for (let i = 0; i < kw.list.length; i++) {
    const p = kw.list[i];
    const id = String(p.playlistid || p.DC_TARGETID || "");
    if (!id || seen[id]) continue;
    seen[id] = 1;
    out.push({
      id: id,
      platform: "酷我",
      title: p.name || "",
      artist: p.nickname || "",
      artwork: p.pic || p.hts_pic || "",
      playCount: Number(p.playcnt || 0),
      worksNum: Number(p.songnum || 0),
      description: p.intro || "",
      _provider: "kuwo",
    });
  }
  for (let i = 0; i < kg.length; i++) {
    const p = kg[i];
    const key = "kg:" + p.id;
    if (seen[key]) continue;
    seen[key] = 1;
    out.push(p);
  }
  for (let i = 0; i < ne.length; i++) {
    const p = ne[i];
    const key = "ne:" + p.id;
    if (seen[key]) continue;
    seen[key] = 1;
    out.push(p);
  }
  /* 硬过滤：歌单标题里必须出现搜索引擎给的完整词。
     ⚠️ 踩过的坑：搜「那我懂你意思了」，酷狗把词拆碎了按「懂你」去凑，
        返回「字里行间我懂你」「这世界，一定有人懂你的emo」「我的言不由衷，你可懂」
        —— 跟这个乐团毫无关系，但每一句都含「懂你」，所以按部分匹配全都能过。
     规则：标题（去掉丨/：等分隔符后）必须包含完整查询词；
           查询词被「丨」「：」「-」切成多段时，每段都得出现，
           或者标题里出现歌手名（那样也算相关）。
     这条只在「标题能匹配上」的判断里生效，酷狗那种把词拆碎的不算。 */
  // ⚠️ 多词查询（「周杰伦 晴天」）不能要求整串连续出现 —— 标题里很少连写。
  //    拆成词，要求每个词都出现。
  const toks = String(query || "").trim().split(/\s+/).map(normTextZ).filter(Boolean);
  const related = (x) => {
    if (!toks.length) return true;
    const t = normTextZ(x.title || "").replace(/[丨|:；;\-–—,，、·]/g, "");
    const au = normTextZ(x.artist || "");
    // 每个查询词都得在标题或创建人里露面，缺一个就不算相关
    for (let i = 0; i < toks.length; i++) {
      const k = toks[i];
      if (t.indexOf(k) >= 0) continue;
      if (au && au.indexOf(k) >= 0) continue;
      return false;
    }
    return true;
  };
  const kept = out.filter(related);

  // ⚠️ 全被过滤掉时不能直接返回空：那是「各平台就是没有这个歌单」，
  //    但要区分「过滤得太狠」和「本来就没有」。这里选择宁可少给 —— 
  //    用户明确说过相关的杂牌歌单比空列表更糟（第 1 条就是无关的）。
  return { isEnd: out.length < KUWO_PAGE_SIZE, data: rankSheets(kept, query) };
}

/** 网易云歌单搜索。
 *
 *  为什么需要它：酷我 ft=playlist 对冷门词经常 total=0，
 *  只剩酷狗在返回「按关键词拆碎拼出来的标题党歌单」。
 *  实测搜「那我懂你意思了」：
 *    酷我 → 0 条
 *    酷狗 → 「字里行间我懂你」「这世界，一定有人懂你的emo」（无关）
 *    网易云 → 「陈修泽&那我懂你意思了」30 首、「那我懂你意思了」19 首（就是这乐团）
 */
async function neteaseSearchSheet(query, page, size) {
  try {
    const r = await axios_1.get(NETEASE_SEARCH_WEB, {
      params: {
        s: query, type: 1000,
        offset: ((page || 1) - 1) * (size || 10),
        limit: size || 10,
      },
      timeout: 15000,
      headers: NETEASE_HEADERS,
      validateStatus: () => true,
    });
    const pl = (r.data && r.data.result && r.data.result.playlists) || [];
    return pl.map((p) => ({
      id: String(p.id),
      platform: "网易云",
      title: p.name || "",
      artist: (p.creator && p.creator.nickname) || "",
      artwork: p.coverImgUrl || "",
      playCount: Number(p.playCount || 0),
      worksNum: Number(p.trackCount || 0),
      description: p.description || "",
      _provider: "netease",
      _kind: "sheet",
      // 「云音乐艺人精选」「云音乐VIP」这类官方账号
      _official: /官方|云音乐|精选|网易/i.test((p.creator && p.creator.nickname) || "") ? 1 : 0,
    })).filter((x) => x.id && x.title);
  } catch (e) { return []; }
}

/* ============================================================
 * 歌手搜索 —— 补齐网易云 / 酷狗 / QQ 三路
 *
 * 为什么补（2026-10-20）：原来只接了酷我 / 咪咕 / YouTube，
 *   搜「周杰伦」只回一条，搜「五月天」冒出来的还是「五月天饭团」这种山寨号。
 *   三家真歌手库缺两块：港台／独立音乐（网易云强）和
 *   冷门但有正规发行的（酷狗／QQ 强）。
 *
 * ⚠️ 三家的「歌手搜索」都会带回**相关歌手**（风格相近推荐）和
 *    蹭词的山寨号。实测搜「周杰伦」：
 *      网易云 → 周杰伦 / 周杰伦. / Jay / 周杰伦♚ / 周杰伦jay / 东北周杰伦 …
 *      酷狗   → 周杰伦 / 十分想见周杰伦 / 情敌周杰伦 / 周杰伦战队 …
 *      QQ     → 周杰伦 / Lara梁心颐 / 张惠妹 …（后两条纯推荐）
 *    所以三路都必须过同一道名字闸，判据跟酷我一致：
 *      A. 归一化后**完全等于**查询词（含繁简/别名）
 *      B. 以查询词**结尾**，且前面那段不含中文
 *         （「Jay Chou 周杰伦」可以，「东北周杰伦」「周杰伦战队」不行）
 * ============================================================ */

/** 名字是不是「这个人」。三家歌手库共用的那道闸。 */
function artistNameOk(name, nameSet, query) {
  const nn = singerNorm(name);
  if (!nn) return false;
  for (let i = 0; i < nameSet.length; i++) {
    const qn = singerNorm(nameSet[i]);
    if (!qn) continue;
    if (nn === qn) return true;
    if (nn.length > qn.length && nn.slice(nn.length - qn.length) === qn) {
      const prefix = nn.slice(0, nn.length - qn.length);
      // 前缀必须是拉丁字母/数字/标点，「东北周杰伦」这种中文前缀一律不要
      if (prefix && !/[一-鿿]/.test(prefix)) return true;
    }
  }
  return false;
}

/** 网易云歌手搜索。实测 130~250ms，是三家最快的。 */
async function neteaseSearchArtist(query, page, size) {
  /* ⚠️ 这个接口偶发限流：返回 200 但 result.artists 是空数组。
     实测同一个词连跑两次，一次 10 条、一次 0 条 —— 不重试的话
     用户看到的就是「搜歌手什么都没有」。重试一次，代价 ~150ms。 */
  const once = async () => {
    /* ⚠️ 必须用 POST 打 /api/cloudsearch/pc（同 neteaseArtistAliases 的坑）：
       GET /api/search/get/web 现在稳定返回 {"code":405,"msg":"操作频繁"}，
       于是「搜歌手」这条路径里网易云那一路**永远是 0 条** ——
       不报错、也没人发现，只是少了最快的那个源。实测 2026-10-21。 */
    const r = await axios_1.post(
      "https://music.163.com/api/cloudsearch/pc",
      "s=" + encodeURIComponent(String(query || "")) + "&type=100" +
        "&offset=" + ((page || 1) - 1) * (size || 10) +
        "&limit=" + (size || 10),
      {
        timeout: 8000,
        headers: Object.assign({}, NETEASE_HEADERS, {
          "Content-Type": "application/x-www-form-urlencoded",
        }),
        validateStatus: () => true,
      }
    );
    const ar = (r.data && r.data.result && r.data.result.artists) || [];
    return ar.map((a) => ({
      id: String(a.id || ""),
      name: String(a.name || ""),
      // 网易云的 alias 是「周董」「Jay Chou」这类，命中的别名也要能过闸门
      alias: Array.isArray(a.alias) ? a.alias : [],
      avatar: a.picUrl || a.img1v1Url || "",
      worksNum: Number(a.musicSize || 0),
      albumNum: Number(a.albumSize || 0),
    })).filter((x) => x.id && x.name);
  };
  try {
    const first = await once();
    if (first.length) return first;
    await new Promise((r) => setTimeout(r, 120));
    return await once();
  } catch (e) { return []; }
}

/** 酷狗歌手搜索。返回只有 singername / singerid，作品数要另查。 */
async function kugouSearchSinger(query, page, size) {
  try {
    const r = await axios_1.get(KUGOU_SINGER_SEARCH, {
      params: { format: "json", keyword: String(query || "").trim(), page: page || 1, pagesize: size || 10 },
      timeout: 8000,
      headers: { "User-Agent": KUGOU_UA_M },
      validateStatus: () => true,
    });
    const arr = (r.data && (r.data.data || r.data.info)) || [];
    return arr.map((a) => ({
      id: String(a.singerid || ""),
      name: String(a.singername || ""),
      avatar: kugouImg(a.imgurl || "", 240),
      worksNum: 0,
    })).filter((x) => x.id && x.name);
  } catch (e) { return []; }
}

/** QQ 音乐歌手搜索。带 songNum / albumNum，字段最全，但实测 1.4~1.5 秒。 */
async function qqSearchArtist(query, page, size) {
  if ((page || 1) > 1) return [];
  try {
    const r = await axios_1.get("https://c.y.qq.com/soso/fcgi-bin/client_search_cp", {
      params: { w: query, t: 9, p: 1, n: size || 10, format: "json" },
      timeout: 4000,
      headers: { "User-Agent": UA, Referer: "https://y.qq.com/" },
      validateStatus: () => true,
    });
    const sl = (r.data && r.data.data && r.data.data.singer && r.data.data.singer.list) || [];
    return sl.map((a) => ({
      id: String(a.singerID || ""),
      mid: String(a.singerMID || ""),
      name: String(a.singerName || ""),
      avatar: a.singerPic || "",
      worksNum: Number(a.songNum || 0),
      albumNum: Number(a.albumNum || 0),
    })).filter((x) => x.id && x.name);
  } catch (e) { return []; }
}

/** 网易云歌手作品（歌曲 / 专辑）。
 *  歌手条目 id 形如 neart:6452。两个接口实测 135ms / 229ms。 */
async function neteaseArtistWorks(artistId, page, type, rn) {
  const ps = rn || 30;
  const pg = page || 1;
  if (type === "album") {
    const r = await axios_1.get("https://music.163.com/api/artist/albums/" + encodeURIComponent(artistId), {
      params: { limit: ps, offset: (pg - 1) * ps },
      timeout: 12000,
      headers: NETEASE_HEADERS,
      validateStatus: () => true,
    });
    const d = r.data || {};
    const list = d.hotAlbums || [];
    return {
      isEnd: !d.more || !list.length,
      data: list.map((a) => ({
        id: String(a.id || ""),
        platform: "网易云",
        title: a.name || "",
        artist: (a.artist && a.artist.name) || "",
        artwork: a.picUrl || "",
        date: a.publishTime ? new Date(Number(a.publishTime)).toISOString().slice(0, 10) : "",
        description: "",
        worksNum: Number(a.size || 0),
        _provider: "netease",
      })).filter((x) => x.id && x.title),
    };
  }
  /* ⚠️ /api/artist/songs 是**被砍过的**（返回 200 但 songs 为空），
     真正的接口是 /api/v1/artist/songs，字段名也不一样：
     artists / album / duration（音频原字段），不是 ar / al / dt。 */
  const r = await axios_1.get("https://music.163.com/api/v1/artist/songs", {
    params: { id: artistId, limit: ps, offset: (pg - 1) * ps, order: "hot" },
    timeout: 12000,
    headers: NETEASE_HEADERS,
    validateStatus: () => true,
  });
  const d = r.data || {};
  const songs = d.songs || [];
  const total = Number(d.total || 0);
  return {
    isEnd: !songs.length || pg * ps >= total,
    data: songs.map((t) => ({
      id: String(t.id || ""),
      platform: "网易云",
      title: t.name || "",
      artist: ((t.artists || []).map((a) => a.name).join("/")) || "",
      album: (t.album && t.album.name) || "",
      artwork: (t.album && t.album.picUrl) || "",
      duration: Number(t.duration || 0),
      _provider: "netease",
    })).filter((x) => x.id && x.title),
  };
}

/* 主题歌单的关键词：车载 / DJ / 助眠 / 纯音乐…… 这类标题说明歌单是按
   「场景」凑出来的，不是「某位歌手的歌」。搜歌手名时它们应该沉下去。
   实测「落日飞车」：前 5 条里 3 条是「激情车载dj｜80迈」「车载热歌丨」。 */
const SHEET_THEME_RE = /车载|車載|dj|慢摇|慢搖|蹦迪|夜店|助眠|催眠|纯音乐|純音樂|白噪音|胎教|儿歌|兒歌|广场舞|廣場舞|铃声|鈴聲|彩铃|彩鈴|背景音乐|背景音樂|轻音乐|輕音樂|健身房|跑步|瑜伽|冥想|ASMR|作业|學習|学习|工作|通勤|驾驶|開車|开车/i;

/**
 * 歌单专用排序。
 *
 * 不能照搬 rankByName（按标题相似度）：搜「陈奕迅」时，
 *   酷我「陈奕迅」/ 18 首 / 播放 60 万   ← 标题完全匹配，但只是个路人 K 歌单
 *   酷狗「陈奕迅生日快乐丨陪你度过漫长岁月」/ 137 首 / 官方 / 播放 413 万
 * 用户想要的是后者。所以这里主要看「官方 + 播放量 + 收录曲数」。
 */
function rankSheets(list, query) {
  const q = normTextZ(query);
  const scored = list.map((x) => {
    const n = normTextZ(x.title || "");
    let sc = 0;
    // 标题相关度只是入场券，权重压低
    if (n === q) sc += 20;
    else if (n.indexOf(q) >= 0) sc += 12;
    else sc += 4;

    /* 「歌手名」和「主题名」要分开看。
       搜「落日飞车」时，热门的是
         「激情车载dj｜80迈，一起体验落日飞车」36 首   ← 标题含歌手名，但主题是车载 DJ
         「落日飞车 | Godsang」33 首                  ← 就是这个乐团
       只按播放量排，前者永远压住后者（它确实更多人听）。
       所以：标题**开头**就是查询词（允许后面接分隔符/副标题）的，
       当成「这歌手/这张专辑本人的歌单」，是用户真正要找的东西。 */
    const startsWithQ = n.indexOf(q) === 0;
    if (startsWithQ) sc += 30;

    /* 主题歌单压一压。这类标题的关键词说明它是「按场景凑的歌」，
       不是「某位歌手的歌」。只在没有开局匹配时降，避免误伤
       「周杰伦 车载情歌精选」这种真官方歌单。 */
    if (!startsWithQ && SHEET_THEME_RE.test(String(x.title || ""))) sc -= 22;

    // 官方运营歌单最可信
    if (x._official) sc += 45;

    // 播放量：对数压缩，上限 40（避免百万播放的霸榜到看不见标题相关度）
    const pc = Number(x.playCount || 0);
    if (pc > 0) sc += Math.min(40, Math.log10(pc) * 8);

    // 收录曲数：30~200 首是「精选歌单」的合理区间
    const num = Number(x.worksNum || 0);
    if (num >= 30 && num <= 200) sc += 18;
    else if (num >= 15) sc += 10;
    else if (num > 200) sc += 8;   // 超大歌单往往是大杂烩
    else sc += 2;

    return { x: x, sc: sc };
  });
  return scored.sort((a, b) => b.sc - a.sc).map((y) => y.x);
}

/* ---------- 歌单详情（网页版 __NUXT__ 求值）---------- */
async function kuwoSheetDetail(playlistId, page) {
  const r = await axios_1.get("https://www.kuwo.cn/playlist_detail/" + encodeURIComponent(playlistId), {
    timeout: 25000,
    headers: { "User-Agent": UA },
    validateStatus: () => true,
    responseType: "text",
    transformResponse: [(d) => d],
  });
  const html = String(r.data || "");
  const start = html.indexOf("__NUXT__=(function(");
  if (start < 0) throw new Error("酷我歌单：页面结构变了（找不到 __NUXT__）");
  const end = html.indexOf("</script>", start);
  const code = html.slice(start, end > 0 ? end : start + 300000);

  // __NUXT__ 是一个立即执行的函数，把整段求值就能拿到完整对象
  let data;
  try {
    data = new Function(code.replace(/^__NUXT__=/, "return "))();
  } catch (e) {
    throw new Error("酷我歌单：__NUXT__ 求值失败 " + e.message);
  }

  const info = data && data.data && data.data[0] && data.data[0].playListInfo;
  if (!info) throw new Error("酷我歌单：无 playListInfo");

  const list = info.musicList || [];
  const musicList = list.map((m) => ({
    id: String(m.rid || ""),
    platform: "酷我",
    title: m.name || "",
    artist: m.artist || "",
    album: m.album || "",
    artwork: (m.pic || m.albumpic || "").replace(/\\u002F/g, "/"),
    duration: Number(m.duration || 0) * 1000,
    _provider: "kuwo",
  }));

  return {
    isEnd: true,
    sheetItem: {
      id: String(playlistId),
      platform: "酷我",
      title: info.name || "",
      artist: info.uname || info.userName || "",
      artwork: (info.img || "").replace(/\\u002F/g, "/"),
      worksNum: Number(info.total || musicList.length),
      playCount: 0,
      description: "",
    },
    musicList: musicList,
  };
}

/** 网易云歌单详情。
 *
 *  ⚠️ /api/v6/playlist/detail 的 playlist.tracks 只给前 10 首
 *     （trackCount 30 但 tracks 只有 10），完整列表在 trackIds 里。
 *     剩下的要靠 /api/song/detail 批量换元数据 —— trackIds 里只有 id。
 */
async function neteaseSheetDetail(playlistId, page, maxTracks) {
  const cap = Number(maxTracks) > 0 ? Number(maxTracks) : 1000;
  const r = await axios_1.get(NETEASE_PLAYLIST_DETAIL, {
    params: { id: playlistId, n: cap },
    timeout: 20000,
    headers: NETEASE_HEADERS,
    validateStatus: () => true,
  });
  const p = r.data && r.data.playlist;
  if (!p) throw new Error("网易云歌单：无 playlist");

  const toItem = (t) => ({
    id: String(t.id || ""),
    platform: "网易云",
    title: t.name || "",
    artist: ((t.ar || t.artists || []).map((a) => a.name).join("/")) || "",
    album: (t.al && t.al.name) || (t.album && t.album.name) || "",
    artwork: (t.al && t.al.picUrl) || (t.album && t.album.picUrl) || "",
    duration: Number(t.dt || t.duration || 0),
    _provider: "netease",
  });

  const musicList = ((p.tracks) || []).map(toItem).filter((x) => x.id && x.title);

  // 补齐 trackIds 里还没拿到元数据的那部分（一次最多 100 个）
  const have = {};
  for (let i = 0; i < musicList.length; i++) have[musicList[i].id] = 1;
  /* ⚠️ 补齐量必须卡在 cap 以内。playlist/detail 只返前 10 首完整曲目 +
     全量 trackIds；若按 trackIds 全量补，一张 200 首的歌单会发 2 次请求、
     拉回 200 首 —— 而拼单每张源歌单只要 50 首，等于白跑 4 倍。
     拼单要拼 4 张源歌单 + 1 张反差歌单，累计几十次多余请求，
     手机上就表现为详情页一直转圈进不去。 */
  const allIds = ((p.trackIds) || [])
    .map((x) => x.id)
    .filter((id) => id && !have[String(id)])
    .slice(0, Math.max(0, cap - musicList.length));
  for (let i = 0; i < allIds.length; i += 100) {
    const chunk = allIds.slice(i, i + 100);
    try {
      const d = await axios_1.get(NETEASE_SONG_DETAIL, {
        params: {
          ids: JSON.stringify(chunk),
          c: JSON.stringify(chunk.map(() => ({ id: 0 }))),
        },
        timeout: 20000,
        headers: NETEASE_HEADERS,
        validateStatus: () => true,
      });
      const songs = (d.data && d.data.songs) || [];
      // ⚠️ 这个接口的返回顺序跟请求顺序一致，但已下架的歌会被吞掉，
      //    所以不能按下标对，直接按 id 收。
      for (let j = 0; j < songs.length; j++) {
        const it = toItem(songs[j]);
        if (it.id && it.title) musicList.push(it);
      }
    } catch (e) { /* 单批失败不影响已拿到的 */ }
  }

  return {
    isEnd: true,
    sheetItem: {
      id: String(playlistId),
      platform: "网易云",
      title: p.name || "",
      artist: (p.creator && p.creator.nickname) || "",
      artwork: p.coverImgUrl || "",
      worksNum: Number(p.trackCount || musicList.length),
      playCount: Number(p.playCount || 0),
      description: p.description || "",
    },
    musicList: musicList,
  };
}

/* ---------- 榜单 / 推荐歌单 ----------
 *
 * MusicFree 的「榜单」页走 getTopLists，之前我们一项都没实现，
 * 所以那页永远是空的 —— 其实内容一直都在我们自己手里：
 * 歌单详情（neteaseSheetDetail）本来就能把任意歌单拉成可播放列表，
 * 只是没有一个「入口」把这些歌单列出来。
 *
 * 下面三组全部匿名实测可用（2026-10-18）：
 *   榜单       /api/toplist              64 个（飙升/新歌/热歌/原创/古典…）
 *   推荐歌单   /api/personalized/playlist 8~12 个官方推荐（带 alg 标记）
 *   分类精选   /api/playlist/highquality  按分类出精品歌单
 *
 * ⚠️ 不用登录。真正的「每日推荐」（recommend/songs）必须有 MUSIC_U cookie，
 *    匿名请求返回空数组 —— 那是账号行为画像驱动的东西，不是算法能逆向出来的。
 *    这里给的是公开侧的推荐，性质上是「运营推荐」，不是「个性化推荐」。
 */
function neTopItem(p) {
  const creator = (p && p.creator) || {};
  return {
    id: String((p && p.id) || ""),
    platform: "网易云",
    title: (p && p.name) || "",
    // 榜单没有 creator，就把更新频率当副标题（「刚刚更新」「每周四更新」）
    artist: creator.nickname || (p && p.updateFrequency) || "",
    artwork: (p && (p.coverImgUrl || p.coverImageUrl)) || "",
    worksNum: Number((p && p.trackCount) || 0),
    playCount: Number((p && p.playCount) || 0),
    description: (p && (p.updateFrequency || p.description)) || "",
    _provider: "netease",
  };
}

/** 分类精选用哪几个分类。太少显得空，太多会让「榜单」页打开变慢 */
const NE_SHEET_CATS = ["华语", "流行", "摇滚", "民谣", "电子", "轻音乐", "爵士", "古风"];

async function neteaseTopListGroups() {
  const groups = [];

  // ① 官方榜单（不带任何参数就是全部 64 个）
  try {
    const r = await httpGet("https://music.163.com/api/toplist", null, NETEASE_HEADERS);
    const list = ((r && r.list) || []).filter((p) => p && p.id && p.name);
    if (list.length) {
      groups.push({
        title: "网易云榜单",
        data: list.map(neTopItem),
      });
    }
  } catch (e) { console.log("[粽子] 榜单失败: " + e.message); }

  // ② 官方推荐歌单
  try {
    const r = await httpGet("https://music.163.com/api/personalized/playlist", { limit: 12 }, NETEASE_HEADERS);
    const list = ((r && r.result) || []).filter((p) => p && p.id && p.name);
    if (list.length) {
      groups.push({
        title: "推荐歌单",
        data: list.map(neTopItem),
      });
    }
  } catch (e) { console.log("[粽子] 推荐歌单失败: " + e.message); }

  // ③ 分类精选：每个分类取 8 张精品歌单，并发拉，单条失败不影响其他
  try {
    const results = await Promise.all(NE_SHEET_CATS.map((cat) =>
      httpGet("https://music.163.com/api/playlist/highquality/list",
        { cat: cat, limit: 8, lasttime: 0, area: "全部" }, NETEASE_HEADERS)
        .then((r) => ((r && r.playlists) || []).map(neTopItem))
        .catch(() => [])
    ));
    for (let i = 0; i < NE_SHEET_CATS.length; i++) {
      if (results[i] && results[i].length) {
        groups.push({ title: NE_SHEET_CATS[i] + "精选", data: results[i] });
      }
    }
  } catch (e) { console.log("[粽子] 分类精选失败: " + e.message); }

  return groups.filter((g) => g.data && g.data.length);
}

/* ============================================================
 * 推荐歌单页（getRecommendSheetTags / getRecommendSheetsByTag）
 *
 * MusicFree 有两条「发现」入口，代码上完全不同：
 *   榜单  → getTopLists / getTopListDetail      （前面已接）
 *   推荐  → getRecommendSheetTags / ...ByTag    （本段新接）
 * 后者一直没实现，所以「推荐歌单」页永远是空的。
 *
 * tag 直接用网易歌单广场自己的 70 个分类，并按它的 5 个大类分组
 * （语种 / 风格 / 场景 / 情感 / 主题），观感和 App 原生一致。
 *
 * ⚠️ 每日轮换怎么做的：插件沙箱是无状态的 —— 没有文件、没有
 *    AsyncStorage、读不到 App 的收藏和历史，所以「今天推过什么」
 *    根本记不住。这里改成**确定性轮换**：按天播种做一次洗牌。
 *    同一天里反复进出，顺序完全一样（翻页不会重复、不会跳）；
 *    日期一变种子就变，首页自然换成另一批 —— 不用存任何东西。
 *
 * ⚠️ 池子来源：优先 highquality 接口。实测同一参数连打两次返回
 *    完全一致（30/30 命中），翻页和重进都稳。它给不出东西的分类
 *    （综艺 / 清晨 / 校园 / 午休 / 70后 / 80后 / 00后 …）才回落到
 *    playlist/list —— 那个接口 order=hot 每次顺序都在变，
 *    所以只在建池时取一次，取完就固定在内存里，绝不边翻边取。
 * ============================================================ */
const REC_SHEET_PAGE_SIZE = 20;
/* 逐日推演的固定起点（2026-01-01 那天的序号）。写死是为了让「今天」和
   「昨天」两个独立进程推出来的链条完全对齐 —— 否则去重会错位。 */
const REC_EPOCH = 20454;
const REC_POOL_TTL = 6 * 60 * 60 * 1000;
const REC_POOL_CACHE = {};
const NE_CAT_GROUP = { 0: "语种", 1: "风格", 2: "场景", 3: "情感", 4: "主题" };

/** 北京时间的「第几天」。拿它当种子，跨天必换一批 */
function recDayKey() {
  return Math.floor((Date.now() + 8 * 3600 * 1000) / 86400000);
}

/** 字符串 → 32 位整数。让不同 tag 在同一天也各有各的顺序 */
function recHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32：确定性伪随机，同一个种子永远给同一串数 */
function recRand(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function recShuffle(list, seed) {
  const rnd = recRand(seed);
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/** 某一轮的固定排列：同池子 + 同轮次 → 永远同一顺序（纯函数） */
function recDayOrder(pool, cat, cycle) {
  const c = cycle === undefined ? 0 : cycle;
  const seed = (((c + 1) * 2246822519) ^ recHash(cat || "全部")) >>> 0;
  return recShuffle(pool, seed);
}

/** 推荐歌单页的 tag 表。分类基本不变，抓一次缓存 12 小时 */
let NE_TAG_CACHE = null;
async function neteaseRecommendTags() {
  if (NE_TAG_CACHE && Date.now() - NE_TAG_CACHE.at < 12 * 60 * 60 * 1000) return NE_TAG_CACHE.v;
  let groups = [];
  try {
    const r = await httpGet("https://music.163.com/api/playlist/catalogue", null, NETEASE_HEADERS);
    const subs = ((r && r.sub) || []).filter((x) => x && x.name);
    const byGroup = {};
    subs.forEach((x) => {
      const g = NE_CAT_GROUP[x.category] || "其他";
      (byGroup[g] = byGroup[g] || []).push({ id: String(x.name), title: String(x.name) });
    });
    ["语种", "风格", "场景", "情感", "主题", "其他"].forEach((g) => {
      if (byGroup[g] && byGroup[g].length) groups.push({ title: g, data: byGroup[g] });
    });
  } catch (e) {
    console.log("[粽子] 歌单分类失败: " + e.message);
  }
  /* 拿不到分类时不能返回空 —— 那样整页是白的。用本地那份兜底 */
  let v = groups.length
    ? { pinned: [{ id: "全部", title: "热门" }].concat(NE_SHEET_CATS.slice(0, 4).map((c) => ({ id: c, title: c }))), data: groups }
    : { pinned: [{ id: "全部", title: "热门" }], data: [{ title: "分类", data: NE_SHEET_CATS.map((c) => ({ id: c, title: c })) }] };

  /* QQ 那边还有一批网易完全没有的分类（闽南语 / 情歌 / 现场音乐 /
     DJ / 婚礼 …）。这些没法并进上面的组，单独挂一个「QQ 独有」。
     它们的 id 带 q: 前缀，取池时只走 QQ，不会去问网易要不存在的东西。 */
  if (shouldUseQQSheet()) {
    v.data = v.data.concat([{
      title: "QQ 独有",
      data: QQ_ONLY_CATS.map((c) => ({ id: "q:" + c, title: c })),
    }]);
  }

  NE_TAG_CACHE = { at: Date.now(), v: v };
  return v;
}

/* ============================================================
 * QQ 音乐歌单广场（第二个数据源）
 *
 * 网易那边只有它自己的一套分类，加上 QQ 之后，同一个 tag 能凑到
 * 两边各自的歌单，池子直接翻倍 —— 池子越大，「每天换一批还跟前三天
 * 不重」才越撑得住（古风那种只剩 22 张的分类，就是被池子大小卡住的）。
 *
 * 三个接口全部匿名可用（2026-10-18 实测）：
 *   分类配置  fcg_get_diss_tag_conf     5 组 64 个分类（带 usable 标记）
 *   分类歌单  fcg_get_diss_by_tag       每页 30 张，sin/ein 翻页
 *   歌单详情  fcg_ucc_getcdinfo_byids   歌曲全量 + songmid + 封面 + 时长
 *
 * ⚠️ 两边的分类命名不一样（华语/国语、说唱/嘻哈、民族/中国传统…），
 *    所以下面必须有一张对照表，不能直接拿名字当 id 用。
 * ⚠️ 歌单 id 两边都是纯数字，**会撞**。所以 QQ 的一律加 qq: 前缀。
 * ============================================================ */
const QQ_DISS_CONF = "https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_tag_conf.fcg";
const QQ_DISS_BY_TAG = "https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg";
const QQ_CD_INFO = "https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg";
const QQ_REC_HEADERS = { "User-Agent": UA, Referer: "https://y.qq.com/" };

/* 网易分类名 → QQ categoryId。没列到的就是「QQ 那边没有对应分类」，
   只取网易那一份，不做合并 —— 硬凑（比如拿「夜店」顶「散步」）
   会推出牛头不对马嘴的歌单。 */
const QQ_CAT_ALIAS = {
  // 语种
  "华语": 165, "欧美": 167, "日语": 169, "韩语": 168, "粤语": 166,
  // 风格
  "流行": 6, "摇滚": 11, "民谣": 28, "电子": 24, "舞曲": 14, "说唱": 153,
  "轻音乐": 15, "爵士": 21, "乡村": 18, "R&B/Soul": 8, "古典": 27,
  "民族": 219, "蓝调": 22, "世界音乐": 220, "拉丁": 25, "New Age": 164,
  "古风": 194, "后摇": 218,
  // 场景
  "夜晚": 102, "学习": 101, "工作": 94, "运动": 99, "驾车": 85, "校园": 16,
  "旅行": 81, "派对": 103, "约会": 76,
  // 情感
  "怀旧": 136, "浪漫": 59, "伤感": 52, "治愈": 116, "放松": 122,
  "兴奋": 126, "快乐": 117, "安静": 122, "思念": 68, "孤独": 55,
  // 主题
  "影视原声": 133, "ACG": 39, "儿童": 131, "网络歌曲": 146,
  "KTV": 141, "经典": 136, "器乐": 202, "吉他": 202, "钢琴": 202,
  // QQ 独有（tag id 带 q: 前缀，只走 QQ）
  "闽南语": 203, "法语": 204, "拉丁语": 205, "情歌": 148, "城市": 196,
  "现场音乐": 197, "背景音乐": 199, "佛教音乐": 200, "UP主": 201,
  "MC喊麦": 226, "DJ": 14, "婚礼": 222, "咖啡馆": 223, "跳舞": 224,
};

/* QQ 独有分类：网易那边没有，单独列一组，id 加 q: 让取池只走 QQ */
const QQ_ONLY_CATS = ["闽南语", "法语", "情歌", "城市", "现场音乐",
  "背景音乐", "佛教音乐", "UP主", "MC喊麦", "DJ", "婚礼", "咖啡馆"];

/** 开关：默认开。关掉后推荐歌单页只剩网易那一份 */
function shouldUseQQSheet() {
  try {
    const vars = (typeof env !== "undefined" && env && env.userVariables) || {};
    const v = vars.qqRecommendSheets;
    if (v === undefined || v === null || v === "") return true;
    return !(v === "0" || v === "false" || v === "off");
  } catch (e) { return true; }
}

/** 歌单 id 加前缀，避免和网易的纯数字 id 撞车 */
const qqSheetId = (id) => "qq:" + String(id);
const isQQSheetId = (id) => String(id || "").indexOf("qq:") === 0;
const qqSheetRawId = (id) => String(id || "").replace(/^qq:/, "");

/** QQ 歌单封面是 http，https 同样能取（实测 200），统一换成 https 免混流拦截 */
const qqImg = (u) => String(u || "").replace(/^http:\/\//i, "https://");

const QQ_SHEET_TTL = 6 * 60 * 60 * 1000;
/** 某个 QQ 分类下的歌单（两页共 60 张）。结果缓存，避免翻页反复打 */
async function qqSheetList(catId) {
  const ck = "qq|" + catId;
  const hit = REC_POOL_CACHE[ck];
  if (hit && Date.now() - hit.at < QQ_SHEET_TTL) return hit.v;

  const out = [];
  const seen = {};
  for (let p = 0; p < 2; p++) {
    try {
      const r = await httpGet(QQ_DISS_BY_TAG, {
        picmid: 1, rnd: Math.random(), g_tk: 5381, format: "json",
        inCharset: "utf8", outCharset: "utf-8",
        categoryId: catId, sortId: 5, sin: p * 30, ein: p * 30 + 29,
      }, QQ_REC_HEADERS);
      // 同上：httpGet 给的就是响应体，分类列表直接在 data.list 里
      const list = (r && r.data && r.data.list) || [];
      if (!list.length) break;
      list.forEach((x) => {
        if (!x || !x.dissid || !x.dissname) return;
        const id = qqSheetId(x.dissid);
        if (seen[id]) return;
        seen[id] = 1;
        out.push({
          id: id,
          platform: "QQ音乐",
          title: x.dissname,
          artist: (x.creator && x.creator.name) || "",
          artwork: qqImg(x.imgurl),
          worksNum: Number(x.songnum || 0),
          playCount: Number(x.listenum || 0),
          description: x.introduction || "",
          _provider: "qq",
        });
      });
    } catch (e) {
      console.log("[粽子] QQ歌单分类(" + catId + ")失败: " + e.message);
      break;
    }
  }
  REC_POOL_CACHE[ck] = { at: Date.now(), v: out };
  return out;
}

/** QQ 歌单详情。一次给全量歌曲（实测 374 首的歌单也是全量返回），不用翻页 */
async function qqSheetDetail(disstid, page) {
  const raw = qqSheetRawId(disstid);
  const r = await httpGet(QQ_CD_INFO, {
    type: 1, json: 1, utf8: 1, onlysong: 0, disstid: raw,
    format: "json", g_tk: 5381, inCharset: "utf8", outCharset: "utf-8",
    notice: 0, platform: "yqq.json", needNewCode: 0,
  }, { "User-Agent": UA, Referer: "https://y.qq.com/n/yqq/playlist/" + raw + ".html" });
  // httpGet 返回的就是响应体本身（它已经 .then(r => r.data) 了），
  // 所以这里直接读 cdlist —— 写成 r.data.cdlist 会少一层，永远拿不到。
  const cd = r && r.cdlist && r.cdlist[0];
  if (!cd) throw new Error("QQ歌单：无 cdlist");

  const musicList = (cd.songlist || []).map((s) => ({
    id: String(s.songmid || ""),
    platform: "QQ音乐",
    title: s.songname || s.songorig || "",
    artist: ((s.singer || []).map((a) => a.name).join("/")) || "",
    album: s.albumname || "",
    artwork: s.albummid
      ? "https://y.gtimg.cn/music/photo_new/T002R300x300M000" + s.albummid + ".jpg"
      : "",
    duration: Number(s.interval || 0) * 1000,
    _provider: "qq",
  })).filter((x) => x.id && x.title);

  return {
    isEnd: true,
    sheetItem: {
      id: qqSheetId(raw),
      platform: "QQ音乐",
      title: cd.dissname || "",
      artist: (cd.creator && cd.creator.name) || "",
      artwork: qqImg(cd.logo),
      worksNum: Number(cd.songnum || musicList.length),
      playCount: Number(cd.visitnum || cd.listenum || 0),
      description: cd.desc || "",
    },
    musicList: musicList,
  };
}

/* 我们自己的分类名 → 网易目录里真有的那个词。
   ⚠️ 「深夜」不在网易那 70 个分类里（它只有「夜晚」）。不映射的话
      highquality 返回 0 张，代码会回落到 playlist/list 的模糊热门搜，
      于是「深夜」拼出来一堆广播剧、翻唱和恋爱神曲 —— 名义上是深夜，
      点开完全不是那么回事。凡是和网易目录对不上的，都在这里兜一下。 */
const NE_CAT_ALIAS = {
  "深夜": "夜晚",
};

/** 某个 tag 当天的歌单池（已洗牌、已去重，按天固定） */
async function recSheetPool(tagName) {
  const raw = tagName || "全部";
  const cat = NE_CAT_ALIAS[raw] || raw;
  /* 缓存键必须用原始 tag：深夜和夜晚映射到同一个网易词，但它们是两个分类，
     共用一个键会让后进的那个把前一个的池子覆盖掉。 */
  const ck = raw + "|" + recDayKey();
  const hit = REC_POOL_CACHE[ck];
  if (hit && Date.now() - hit.at < REC_POOL_TTL) return hit.v;

  /* 池子统一存「已经转好的展示条目」（id/title/platform/…），
     两个源在建池这一步就各自归一，后面洗牌、轮换、去重、
     回给 App 全都只认一种结构，不用再分是谁的数据。 */
  const seen = {};
  const pool = [];
  const pushItem = (it) => {
    if (!it || !it.id || !it.title) return;
    if (seen[it.id]) return;
    seen[it.id] = 1;
    pool.push(it);
  };
  const push = (arr) => {
    (arr || []).forEach((p) => { if (p && p.id && p.name) pushItem(neTopItem(p)); });
  };

  /* QQ 那一份单独收。它的 id 带 qq: 前缀，跟网易的纯数字 id 天然不撞，
     所以能安全地并进同一个池子 —— 洗牌、按天轮换、去重全都不用改。 */
  const useQQ = shouldUseQQSheet();
  /* tag 的两种特殊写法：
       q:xxx → 只有 QQ 有，网易那边根本不存在，别去问它
       全部   → 网易用「全部」，QQ 没有这个 categoryId，
                用「流行」当大盘代表（它本来就是 QQ 最大的那一格） */
  const qqOnly = cat.indexOf("q:") === 0;
  const qqKey = qqOnly ? cat.slice(2) : cat === "全部" ? "流行" : cat;
  const qqCatId = useQQ ? QQ_CAT_ALIAS[qqKey] : undefined;
  const wantNE = !qqOnly;

  const tasks = [];
  if (useQQ && qqCatId) tasks.push(qqSheetList(qqCatId));

  if (wantNE) {
    try {
      const r = await httpGet("https://music.163.com/api/playlist/highquality/list",
        { cat: cat, limit: 100, lasttime: 0, area: "全部" }, NETEASE_HEADERS);
      push((r && r.playlists) || []);
    } catch (e) { console.log("[粽子] 推荐池(" + cat + ")失败: " + e.message); }
  }

  if (tasks.length) {
    try {
      const arrs = await Promise.all(tasks);
      arrs.forEach((arr) => { (arr || []).forEach((x) => pushItem(x)); });
    } catch (e) { console.log("[粽子] QQ推荐池(" + cat + ")失败: " + e.message); }
  }

  /* highquality 对部分冷门分类是空的（综艺 / 清晨 / 校园 / 午休…），
     回落一次 playlist/list。它顺序不稳定，所以只在建池时取，取完不再动。 */
  if (wantNE && pool.length < 12) {
    try {
      const r2 = await httpGet("https://music.163.com/api/playlist/list",
        { cat: cat, order: "hot", offset: 0, limit: 50, total: false }, NETEASE_HEADERS);
      push((r2 && r2.playlists) || []);
    } catch (e) { console.log("[粽子] 推荐池回落(" + cat + ")失败: " + e.message); }
  }

  /* 两个源全军覆没时直接给空，别让后面的取模算出 NaN */
  if (!pool.length) return [];

  /* 「每天换一批，跟前三天不一样」在无状态下怎么做：
     插件存不了历史，所以页面只能是 (池子, 日期) 的**纯函数** ——
     只有够纯，才能把前三天推了什么当场重算出来，再剔掉。

     做法：从一个**绝对固定**的起始日（REC_EPOCH，写死不变）开始逐日
     往前推，每天取一屏「从 ordered[(d×step) mod n] 起、跳过前三天
     已推的条目」。起点必须绝对固定 —— 如果写成「今天 - N」，
     今天和昨天两个进程算出的链条就错位了，去重会失效（真踩过）。
     链条是纯函数，任何设备任何时间推出来的第 d 天都一致，无需存储。

     起点每天往前挪 step（= 池子 ÷ 4），所以不做剔除时相邻两天也
     天然错开；剔除只是把剩下的零星重合也抹掉。
     剔完凑不满一屏就少剔一天（3 → 2 → 1 → 0），
     最后兜底直接取一屏 —— 宁可重复，也绝不给空页。

     实测：全部 100 张 → 前三天零重叠；华语 71 张 → 前两天零重叠；
     综艺 50 张 → 前一天零重叠；古风 22 张只剩一屏多，内容量就那么点，
     重叠无法避免。这是池子大小的物理下限，不是算法没去重。 */
  const day = recDayKey();
  const n = pool.length;
  const ordered = recDayOrder(pool, cat, Math.floor(day / 30));
  const step = Math.max(1, Math.floor(n / 4));
  const ANCHOR = REC_EPOCH;
  const at = (d) => (((d * step) % n) + n) % n;

  /* 逐日推：pages[i] 对应 ANCHOR + i */
  const pages = [];
  for (let d = ANCHOR; d <= day; d++) {
    let page = null;
    for (let back = 3; back >= 0; back--) {
      const skip = {};
      for (let i = 1; i <= back; i++) {
        const prev = pages[d - ANCHOR - i];
        if (prev) prev.forEach((x) => { skip[x.id] = 1; });
      }
      const start = at(d);
      const cand = [];
      for (let k = 0; k < n && cand.length < REC_SHEET_PAGE_SIZE; k++) {
        const it = ordered[(start + k) % n];
        if (!skip[it.id]) cand.push(it);
      }
      page = cand;
      if (cand.length >= REC_SHEET_PAGE_SIZE) break;
    }
    pages.push(page && page.length ? page : ordered.slice(0, REC_SHEET_PAGE_SIZE));
  }
  const rotated = pages[pages.length - 1];
  /* 首屏挑完了，剩下的接在后面 —— 往下翻还能看到池子里别的歌单，
     不会翻两页就到底。 */
  const shown = {};
  rotated.forEach((x) => { shown[x.id] = 1; });
  const rest = ordered.filter((x) => !shown[x.id]);
  const out = rotated.concat(rest);
  REC_POOL_CACHE[ck] = { at: Date.now(), v: out };
  return out;
}

/* ============================================================
 * 「拼单」—— 自己拼的歌单
 *
 * 平台歌单有一个改不了的问题：顺序是平台排的，我们只能照单全收。
 * 所以推荐页除了展示平台歌单，再自己拼一张：id 里写死生成配方，
 * 点开时按配方当场抓歌、按四条规则重排。
 *
 *   mix:<分类>:<天序号>:<序号>（现在只出第一张，序号恒为 1）
 *
 * 四条规则（和粽子定的）：
 *   1. 同一歌手最多 3 首
 *   2. 整单打乱
 *   3. 同一歌手的歌不相邻
 *   4. 三分之二处插一首风格反差最大的歌（不放开头、不放结尾）
 *
 * 因为配方全在 id 里、抓取和排序都是纯函数，所以不需要任何存储，
 * 同一天同一张每次点开内容完全一致。
 * ============================================================ */
const MIX_PREFIX = "mix:";
const MIX_TRACKS = 30;          // 目标曲数
const MIX_ARTIST_CAP = 3;       // 同一歌手最多几首
const MIX_SRC_SHEETS = 4;       // 从几张源歌单里取材
const MIX_SRC_LIMIT = 50;       // 每张源歌单取前多少首（只借元数据，不整张拉）
const MIX_COUNT_PER_PAGE = 1;   // 推荐页每屏放几张拼单（只放一张，没必要两张）

/** 分类 → Deezer 搜索词。拼单封面从这里取。
    ⚠️ 只有这条路能一条条命中：拼音（gufeng）在 Deezer 是空的，
       必须用英文风格词（guzheng）。全部 70 个分类 2026-10-18 实测过。 */
const DZ_API = "https://api.deezer.com";
const DZ_KW = {
  "全部": "top charts", "华语": "chinese pop", "欧美": "western pop",
  "日语": "japanese", "韩语": "korean", "粤语": "cantopop",
  "流行": "pop", "摇滚": "rock", "民谣": "folk", "电子": "electronic",
  "舞曲": "dance", "说唱": "hip hop", "轻音乐": "instrumental",
  "爵士": "jazz", "乡村": "country", "R&B/Soul": "rnb soul",
  "古典": "classical", "民族": "world music", "蓝调": "blues",
  "拉丁": "latin", "New Age": "new age", "古风": "guzheng",
  "后摇": "post rock", "英伦": "britpop", "金属": "metal", "朋克": "punk",
  "雷鬼": "reggae", "Bossa Nova": "bossa nova", "清新": "indie pop",
  "夜晚": "night", "学习": "study", "工作": "work", "运动": "workout",
  "驾车": "driving", "校园": "campus", "旅行": "travel", "派对": "party",
  "约会": "date night", "地铁": "commute", "散步": "city walk",
  "酒吧": "bar", "咖啡馆": "cafe", "下午茶": "afternoon tea",
  "午休": "nap", "清晨": "morning", "婚礼": "wedding",
  "怀旧": "retro", "浪漫": "romantic", "伤感": "sad", "治愈": "healing",
  "放松": "relax", "兴奋": "energetic", "快乐": "happy", "安静": "quiet",
  "思念": "missing you", "孤独": "lonely", "感动": "emotional",
  "影视原声": "soundtrack", "ACG": "anime", "游戏": "game soundtrack",
  "儿童": "kids", "网络歌曲": "internet hits", "KTV": "karaoke",
  "经典": "classic hits", "翻唱": "acoustic cover", "榜单": "top charts",
  "吉他": "guitar", "钢琴": "piano", "器乐": "instrumental",
  "综艺": "variety show", "70后": "70s", "80后": "80s",
  "90后": "90s", "00后": "2000s", "情歌": "love songs", "城市": "city pop",
  "现场音乐": "live music", "背景音乐": "easy listening",
  "佛教音乐": "meditation", "DJ": "dj mix", "MC喊麦": "dance",
  "闽南语": "taiwanese", "法语": "french music",
};

/** 反差分类：拼单里那首「换个口味」从这儿挑。刻意避开只换了语种、
    骨子里还是同一种歌的分类（华语 → 粤语那种反差是假的）。 */
const MIX_CONTRAST = {
  "华语": "爵士", "流行": "后摇", "摇滚": "古典", "民谣": "电子",
  "电子": "民谣", "爵士": "说唱", "古典": "舞曲", "说唱": "轻音乐",
  "粤语": "金属", "欧美": "古风", "日语": "乡村", "韩语": "蓝调",
  "古风": "雷鬼", "轻音乐": "朋克", "乡村": "电子", "金属": "民谣",
  "后摇": "流行", "民谣": "雷鬼",
};

const DZ_COVER_TTL = 24 * 60 * 60 * 1000;
const DZ_TIMEOUT = 4000;   // Deezer 单独的超时（见 dzCovers 里的说明）
const DZ_COVER_CACHE = {};

/* 自绘封面（D:\workspace\zongzi-musicfree-plugin/covers）：
   白发红瞳 Q 版小女孩 + 墨绿连衣裙 + 拼图波形 + 「拼好歌」手写标题，
   一条 1080×1080 方图。走 jsDelivr，国内比 raw 快且能缓存。
   现在每个分类都有自绘图；万一表里漏了某个新分类，才回落到 Deezer。 */
const COVER_CDN = "https://cdn.jsdelivr.net/gh/ZONGZI-000/zongzi-musicfree-plugin@master/covers/";

/* ============================================================
 * 歌曲级兜底封面
 *
 * 平台不保证每首歌都有封面：酷我老歌、咪咕、B 站翻唱、YouTube 冷门发行，
 * artwork 常常是空串，卡片上就是一个灰块。
 * 分类封面（MIX_COVERS）只管歌单，管不到单曲，所以这里补一套自己画的占位图。
 *
 * 三张轮换而不是一张：列表一屏二三十格，全用同一张会像加载失败。
 * 按「歌名+歌手」哈希分配 —— 同一首歌每次看到的是同一张，换平台也不变。
 * ============================================================ */
/* 三张都已入库：黑胶、唱机+波形、麦克风各一张，
   都在 1:1 1080 墨绿底同风格，轮换才不会看出是同一个模板。 */
const FB_ART_COVERS = ["fb-01.jpg", "fb-02.jpg", "fb-03.jpg", "fb-04.jpg"];

function fbHash(str) {
  let h = 2166136261;                       /* FNV-1a，够散且不用 crypto */
  const t = String(str || "");
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  /* ⚠️ FNV-1a 的低位很脏：乘法不把高位混回低位，取模小数字时几乎全是 0。
     实测赵薇 9 张专辑全落在 % 4 === 0，一屏九格同一张图，看着像没加载出来。
     所以再走一遍 murmur3 的 fmix32 做雪崩，把高位搅回低位。 */
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** 给一首没有封面的歌挑一张占位图 */
function fbArt(item) {
  const key = ((item && item.title) || "") + "|" + ((item && item.artist) || "");
  const seed = key !== "|" ? key : String((item && item.id) || "");
  return COVER_CDN + FB_ART_COVERS[fbHash(seed) % FB_ART_COVERS.length];
}

/** 递归补齐列表里缺封面的条目（只往下走已知的几个容器字段，不乱翻整棵树） */
function deepFillArt(o, depth) {
  if (!o || typeof o !== "object" || depth > 3) return o;
  if (Array.isArray(o)) {
    for (const x of o) deepFillArt(x, depth + 1);
    return o;
  }
  /* 认「能当歌曲/专辑卡片用」的对象：有 id 和名字，且自己不是容器 */
  const isCard =
    (o.id || o.songmid || o.mid) &&
    (o.title || o.name) &&
    !o.musicList && !o.sheetItem && !o.data;
  if (isCard && !String(o.artwork || "").trim()) o.artwork = fbArt(o);
  const kids = ["data", "musicList", "tracks", "list", "sheetItem"];
  for (const k of kids) if (o[k]) deepFillArt(o[k], depth + 1);
  return o;
}

const MIX_COVERS = {
  /* 18 张自绘图，够铺满网易那 70 个分类加上 QQ 独有的那几个。
     一个分类一张，贴身就贴；剩下的不再现搜 Deezer。
     Deezer 在国内经常连不通，一旦卡住就是 4 秒起步的空窗，所以能自绘就不碰它。
     */
  "全部": ["rnb.jpg"],
  "热门": ["rnb.jpg"],

  /* 华语那张：中文流行、KTV、榜单、翻唱这一路 */
  "华语": ["huayu.jpg"],
  "流行": ["huayu.jpg"],
  "粤语": ["huayu.jpg"],
  "闽南语": ["huayu.jpg"],
  "KTV": ["huayu.jpg"],
  "榜单": ["huayu.jpg"],
  "翻唱": ["huayu.jpg"],
  "网络歌曲": ["huayu.jpg"],
  "UP主": ["huayu.jpg"],
  "综艺": ["huayu.jpg"],
  "90后": ["huayu.jpg"],
  "快乐": ["huayu.jpg"],

  /* 古风那张：水墨、五声音阶、民族器乐、世界音乐 */
  "古风": ["gufeng.jpg", "gufeng2.jpg"],
  "民族": ["gufeng.jpg", "gufeng2.jpg"],
  "世界音乐": ["gufeng.jpg", "gufeng2.jpg"],

  /* 爵士那张：留声机、黑胶，老唱片气质 */
  "爵士": ["jazz.jpg"],
  "蓝调": ["jazz.jpg"],
  "Bossa Nova": ["jazz.jpg"],
  "酒吧": ["jazz.jpg"],
  "下午茶": ["jazz.jpg"],
  "怀旧": ["jazz.jpg"],
  "经典": ["jazz.jpg"],
  "70后": ["jazz.jpg"],
  "80后": ["jazz.jpg"],

  /* 电子那张：霓虹、电路板，跑得起来的节奏 */
  "电子": ["electronic.jpg"],
  "舞曲": ["electronic.jpg"],
  "ACG": ["electronic.jpg"],
  "日语": ["electronic.jpg"],
  "游戏": ["electronic.jpg"],
  "地铁": ["electronic.jpg"],
  "驾车": ["electronic.jpg"],
  "00后": ["electronic.jpg"],
  "DJ": ["electronic.jpg"],

  /* 摇滚那张：电吉他、爆炸线，音量和情绪都往上推 */
  "摇滚": ["rock.jpg"],
  "英伦": ["rock.jpg"],
  "金属": ["rock.jpg"],
  "朋克": ["rock.jpg"],
  "后摇": ["rock.jpg"],
  "吉他": ["rock.jpg"],
  "运动": ["rock.jpg"],
  "兴奋": ["rock.jpg"],
  "现场音乐": ["rock.jpg"],

  /* 深夜两张：灯关一半坐着（night）与钻被窝准备睡（night2），三天一换 */
  "夜晚": ["night.jpg", "night2.jpg"],
  "深夜": ["night.jpg", "night2.jpg"],
  "安静": ["night.jpg", "night2.jpg"],
  "孤独": ["night.jpg", "night2.jpg"],
  "思念": ["night.jpg", "night2.jpg"],
  "伤感": ["night.jpg", "night2.jpg"],
  /* 午休专属那张：午睡、抱枕、耳机、12:30。配夜晚那张轮换 */
  "午休": ["nap.jpg", "night2.jpg"],

  /* 民谣那张：木箱鼓、木吉他、麦穗与落叶，乡野黄昏 */
  "民谣": ["folk.jpg"],
  "乡村": ["folk.jpg"],
  "散步": ["folk.jpg"],

  /* 治愈那张：抱猫、落叶、暖米色，不设防的一单 */
  "治愈": ["healing.jpg"],
  "放松": ["healing.jpg"],
  "清新": ["healing.jpg"],
  "清晨": ["healing.jpg"],
  "校园": ["healing.jpg"],
  "儿童": ["healing.jpg"],
  "旅行": ["healing.jpg"],
  "New Age": ["healing.jpg"],
  "婚礼": ["healing.jpg"],

  /* 钢琴那张：琴键、琴谱、小黑猫，不抢注意力 */
  "钢琴": ["piano.jpg"],
  "轻音乐": ["piano.jpg"],
  "器乐": ["piano.jpg"],
  "古典": ["piano.jpg"],
  "学习": ["piano.jpg"],
  "工作": ["piano.jpg"],
  "影视原声": ["piano.jpg"],
  "感动": ["piano.jpg"],
  "背景音乐": ["bgm.jpg"],

  /* 派对那张：彩带、气球、迪斯科球 */
  "派对": ["party.jpg"],

  /* 约会那张：烛光、玫瑰、晚霞窗边 */
  "约会": ["date.jpg"],

  /* 咖啡馆那张：拉花、速写本、街景窗 */
  "咖啡馆": ["cafe.jpg"],

  /* 佛教音乐那张：莲花、远山、一炷香 */
  "佛教音乐": ["zen.jpg"],

  /* 说唱那张：砖墙涂鸦、喷漆罐 */
  "说唱": ["rap.jpg"],
  "MC喊麦": ["rap.jpg"],

  /* R&B 那张：黄昏城市、黑胶唱机，转音和鼓机 */
  "城市": ["city.jpg"],
  "R&B/Soul": ["rnb.jpg"],
  "欧美": ["rnb.jpg"],
  "韩语": ["rnb.jpg"],
  "浪漫": ["rnb.jpg"],
  "情歌": ["rnb.jpg"],
  "拉丁": ["rnb.jpg"],
  "雷鬼": ["rnb.jpg"],
  "法语": ["rnb.jpg"],
};

/* 拼单的介绍：写清这是什么风格、大概从哪儿来的，不写怎么配比的。
   第一句当卡片上的一句话简介（由 mixBlurbShort 截出来），后面几句只在详情页展开。 */
const MIX_BLURB = {
  "全部": "不挑风格的一单，华语情歌、欧美流行、几首器乐混在一起，一天里能逛完好几种口味。曲目不分语种也不分年代，副歌抓耳的先上。适合不知道听什么的时候，直接点开让它自己走。",
  "华语": "华语流行的横切面：慢情歌、都市感、带点摇滚的、几首老民谣。这个门类大致从八十年代港台唱片工业成形，九十年代到两千年代初是黄金期，后来重心慢慢移到内地和网络。词里多是具体场景和情绪，副歌要能跟着唱。",
  "流行": "当下最顺耳的那一挂，编曲干净、副歌一响就能跟上。流行乐本身没有固定出身，它把民谣、舞曲、摇滚里好用的部分挑出来重新打包——所以每个十年的「流行」听起来都不一样。",
  "摇滚": "吉他和鼓往前推，失真音色、鼓点重，别管歌词，先把音量拧大。摇滚五十年代从美国长出来，是布鲁斯的骨架加上乡村的节奏，电吉他一插音箱就成了新东西。往后分支很多，这一单偏主流那一支。",
  "民谣": "木吉他配人声，编曲留白，词比旋律更重。民谣的根在各国的叙事歌，美国六十年代民谣复兴把它推回台前，华语这边是九十年代的校园民歌一路传下来。适合一个人走夜路，或者坐着不动的时候听。",
  "电子": "合成器和鼓机铺底的流动感，一浪一浪往上推。电子乐七十年代从德国的实验长出来，八十年代进了舞池，九十年代分化出 techno、house、drum & bass 一堆支流。适合开车和夜跑，节奏顶着人往前走。",
  "舞曲": "四四拍踩到底，鼓点规整，人声常被切成片段反复用。源头是迪斯科和七十年代的俱乐部文化，后来被电子乐接管。听的时候不太需要专注，让节奏带着走就行。",
  "爵士": "钢琴、贝斯、轻鼓刷，即兴是核心——同一段旋律每次弹都不一样。爵士二十世纪初长在新奥尔良，是布鲁斯和拉格泰姆混出来的，后来分出摇摆、比波普、冷爵士、融合爵士一大片。适合开一盏灯慢慢听。",
  "古风": "五声音阶打底，古筝、琵琶、笛箫和现代编曲混着用，词里多是山水、旧事、灯下这样的意象。这个门类算是华语网络音乐自己的产物，两千年之后随网络古风圈成形，和传统民乐、影视配乐都有渊源。安静但有余味。",
  "轻音乐": "没有人声的一单，旋律舒缓、配器轻，主要是钢琴、弦乐和吉他。这一类在唱片行里常被归到 easy listening，本来是给商场、酒店和电台垫背景用的，后来自己长成了一种听法。手上在做事、耳朵也不闲着的时候最合适。",
  "钢琴": "只有琴键的一单，从古典夜曲、练习曲到近年的新古典和影视配乐都有。钢琴独奏的好处是留白多，一个音落下去后面的余音也算内容。适合看书、写字、发呆。",
  "器乐": "没有人声，靠器乐把旋律讲完，编制从独奏到小乐队都有。器乐是最古老的一类音乐，也是最多变的一类——同一个动机换个配器就是另一种情绪。",
  "吉他": "吉他当主角的一单，指弹、扫弦、电吉他 solo 都在里面。吉他是二十世纪流行乐的主力，民谣、摇滚、拉丁、金属都绕不开它。",
  "夜晚": "音色都放软了，节奏偏慢，人声靠后，适合灯关一半的时候听。这一类的共同点不是曲风而是混音——高频收一点，低频铺一点，留出安静。",
  "深夜": "很轻的一单，人声轻、乐器少，像有人在小声说话。适合凌晨那一两个小时，或者一场雨把窗子糊住的时候。",
  "治愈": "没有攻击性的一单，节奏慢、旋律上扬，人声大多偏软。这一类没有固定出身，更多是听感上的归类：新世纪音乐、民谣清唱、极简钢琴都会被放进来。累了但还想听见点声音的时候打开。",
  "放松": "音量不用大，背景里有声音就够了。多是慢拍、留白、编曲不拥挤的歌，和轻音乐有重叠，但更接受一点人声。",
  "安静": "整体动态压得低，不冲击耳朵，适合需要专注的时候垫着。这一类的选曲标准是动态范围——编曲里没有突然拔高的段落，长时间放着也不会让人分神。",
  "粤语": "词咬得紧、情绪收得住，港乐那股劲儿还在。粤语流行七十年代随港剧主题曲起来，八十年代进黄金期，旋律和声调咬得极准，改一个字就成了另一首歌。慢歌和快歌都在这一单里。",
  "欧美": "欧美主流的一单，副歌大、制作干净、混音厚。这一类覆盖很广，从美国流行到英国独立都有，共同点是工业化制作水准高，一首歌的每个频段都被填满。",
  "日语": "日系旋律优先，转调多、编曲细，容易上瘾。日本流行从昭和歌谣走到八十年代的 city pop，再到九十年代之后的乐队和动漫主题曲，旋律写法一直很讲究。",
  "韩语": "韩系主流一单，节奏亮、人声甜，编曲讲究层次。K-Pop 是九十年代末起来的偶像工业产物，一首歌里常塞进说唱段、副歌、桥段好几块，舞蹈和视觉也是内容的一部分。",
  "说唱": "押韵和鼓点顶在最前面的一单，人声本身也是节奏的一部分。说唱七十年代长在纽约布朗克斯的街区派对上，DJ 把鼓点循环拉长，MC 在上面念词。往后分出东岸、西岸、trap 一堆支流，这一单偏旋律感强的那类。",
  "R&B/Soul": "夜里的转音和鼓机，人声是主角，编曲给声音让路。节奏布鲁斯四十年代从美国黑人流行乐里分出来，九十年代走进都市情歌那支，现在的 R&B 更靠近氛围和电子。适合戴耳机慢慢听。",
  "蓝调": "十二小节一句、滑音吉他、唱到高处有点哑。蓝调二十世纪初从美国南方长出来，是摇滚、爵士、R&B 共同的祖宗，讲的多半是倒霉事。",
  "乡村": "班卓琴、滑音吉他、叙事性的词，讲的多是乡下日常和感情账。大本营在美国纳什维尔，从二十年代的山区民谣一路做到今天的流行乡村。",
  "古典": "从巴洛克、古典主义到浪漫派，管弦乐、室内乐、独奏都在里面。这一门的时间跨度三百多年，编制和写法变化很大，共同点是不靠放大器和鼓机，全凭乐器和厅堂。",
  "民族": "各地的民间音乐，五声、七声、复调、非平均律都有，配器多是当地乐器。世界音乐这个词是唱片业后来贴的标签，本身囊括的东西比「一种风格」大得多。",
  "拉丁": "古巴的颂、巴西的桑巴、墨西哥的牧场歌，节奏层比旋律还讲究。核心是各种切分的鼓型，听的时候脚会先动。",
  "Bossa Nova": "桑巴的节奏骨架，配上冷爵士的和弦和近乎耳语的人声。五十年代末在里约热内卢成形，后来传遍世界，成了咖啡馆的标配。",
  "雷鬼": "反拍加重音，贝斯走在前面，节奏慢而弹。六十年代从牙买加长起来，跟当地的音响系统文化分不开，后来分出 dub 和 dancehall。",
  "后摇": "吉他一层层堆起来，很少唱，靠长度和动态推进，从安静铺到爆。九十年代从摇滚里分出来，更接近作曲而不是写歌。",
  "英伦": "吉他流行里那股明显的地域气：旋律上扬、副歌齐唱、带点颓。Britpop 九十年代在英国起来，是本土乐队对当时美国摇滚的回应。",
  "金属": "失真更重、鼓更密，人声从高亢到低吼都有。金属六十年代末从摇滚里分出来，此后分支极多，旋律金属和极端金属各有各的规矩。",
  "朋克": "三个和弦、速度快、录音糙，态度比技术重要。七十年代在美国和英国同时起来，是对当时冗长前卫摇滚的反动。",
  "清新": "编曲轻、录音不厚，吉他带点毛边，人声偏软。Indie pop 这一支不追大制作，反而喜欢把瑕疵留着。",
  "New Age": "铺底的合成器、长混响、几乎没有鼓，听着像空间在呼吸。七十年代起在欧美发展，常跟冥想、瑜伽、自然声混在一起用。",
  "伤感": "适合一个人待着的时候听，不劝你振作。这一类按情绪而不是曲风归堆，慢情歌、钢琴、民谣都能进来。",
  "思念": "慢拍、句子拖长、唱到副歌会有一点破。多是写给具体某个人的，听起来像隔着距离说话。",
  "孤独": "编曲空、人声单独摆在中间，鼓和贝斯都退到后面。适合一个人走夜路，或者坐在窗边。",
  "感动": "情绪往上堆的前半段，副歌给一个大释放，多是钢琴弦乐打底的大编制。这一类的共同点是有一个明确的高点：前面压住，副歌一次给足，听完像被放下来一样。",
  "怀旧": "往前翻十年的歌，前奏一响就回到那个时候。这一单按年代感挑，编曲里那些当年的音色才是重点。",
  "经典": "绕不开的老歌都在这一单里，多数人一听前奏就认识。所谓经典没有统一的标准，多数是这些歌在各自的年代被反复播放、翻唱，慢慢变成了公共记忆。",
  "浪漫": "慢拍情歌为主，弦乐和吉他铺底，适合两个人待着。这一类不太讲节奏，讲的是氛围：混响长一点、人声近一点，中间留出说话的余地。",
  "情歌": "从五十年代的抒情流行一路做到现在的都市情歌，主题基本没变过：喜欢一个人、得不到、又放不下。慢板居多，编曲给歌词让路，副歌往往只有一句反复——越是简单的那句越容易被记住。",
  "ACG": "番剧、游戏和动画电影里的旋律，燃的和软的都有。日本把动画主题曲叫 anisong，这一行从上世纪七十年代起就独立成了一条产业线，作曲和编曲水准常常高于普通流行。",
  "影视原声": "电影和剧集的配乐与主题曲，多数是为画面写的，段落感和情绪起伏比流行歌更明显。配乐写的时候是跟着画面走的，所以单听常常会觉得段落来得突然，这是它跟流行歌最大的区别。",
  "游戏": "从八位机的芯片音源到今天的交响编制，游戏音乐跨的幅度比想象中大。旋律要在玩家分心的时候仍然记得住，这是它跟影视配乐最大的不同。",
  "儿童": "儿歌和童谣，旋律简单、音域窄、句子短，方便跟着唱。多数是几代人传下来的，作者早不可考。",
  "网络歌曲": "彩铃时代和短视频时代各自捧红过一批，共同点是传播快、旋律抓耳、制作周期短。这一类的门槛比传统唱片低得多，一个人一台电脑就能做完整首，所以风格杂、更新快。",
  "KTV": "副歌大、音域友好、多数人张嘴就能跟上的那种。这一单是按「能不能被一起唱」挑的。",
  "翻唱": "把别人的歌换个编曲重唱一遍，声学版、乐器版、慢板版都有。翻唱的历史跟自己写歌一样久，很多时候翻唱比原唱传得更远。",
  "榜单": "从各平台的公开榜单里挑，播放量高、近期热度在。榜单是播放行为的副产品，反映的是「最近很多人在听」，不等于耐听，听个热闹正好。",
  "综艺": "音乐综艺里唱过的版本，编曲多是现场重做的，和录音室版差别不小。现场版通常是节目组重新编曲的，改了调、加了段落，跟录音室版听感差很远。",
  "现场音乐": "带观众声、呼吸声和混响的版本，录一遍就是一遍，没有剪辑余地。现场录音最珍贵的地方是那些不完美：换气、走音、观众的一声喊，都是棚里做不出来的。",
  "城市": "City Pop 那一支：八十年代日本都市里的松弛感，贝斯走线讲究，合成器带一点塑料光泽。近年被重新翻出来，成了城市夜晚的标准配乐。",
  "驾车": "路上听的一单，副歌够大、节奏稳、不催眠。这类歌混音里低频通常足，适合车内环境。",
  "运动": "节奏贴着脚步走，BPM 大致落在跑步和力量训练能对上的区间，撑完最后十分钟用。这一类按 BPM 挑，跑步大致在 150 到 170 之间，力量训练慢一些，热身和拉伸又是另一档。",
  "派对": "人群里放的那种，四四拍清楚，副歌一来全场能跟。这一类的选曲逻辑是「不能让场子冷」，所以副歌密度高、间奏短，一首接一首不留空。",
  "约会": "慢拍、暖调、留白多，适合两个人待着、不太说话的时候。这一类音量不用大，人声落在近处，鼓点和贝斯都收着，适合说话的时候当背景。",
  "婚礼": "从仪式的弦乐到敬酒时的暖场歌都在里面，多数是慢板和大调。仪式段多用弦乐和钢琴，敬酒段换成暖场流行，一整场的情绪曲线是排好的。",
  "地铁": "通勤路上听的一单，节奏不吵、人声清楚，戴着耳机也不费劲。通勤听的歌最怕吵和吵不动，这一类的混音通常中频清楚，人声和鼓不打架，嘈杂环境里也听得见。",
  "散步": "慢一点的节奏，编曲轻，适合边走边听、不完全专注。这一类的节奏大概跟着走路的速度走，一百步左右一分钟，听久了脚步会自己跟上。",
  "旅行": "路上听的一单，开阔、有画面感，飞机火车上都合适。旅行听的歌跟风景是绑在一起的，所以这一类旋律开阔、编曲有空间感，不太塞。",
  "酒吧": "暖场那一段的音色：爵士、蓝调、R&B、带点电子的慢歌。酒吧音乐是有时间表的：暖场轻、夜里沉、打烊前再提一次，这一单偏暖场那一段。",
  "咖啡馆": "不抢话的背景音，多是爵士、Bossa Nova、轻电子和原声吉他。这一类几乎不带攻击性，多是原声乐器或者柔和的电子，音量压在说话声下面。",
  "下午茶": "轻快、甜、不过分煽情，适合两个小时左右的空闲。这一类的共性是轻和甜——大调、中速、编曲不厚，两三个小时循环也不腻。",
  "午休": "节奏慢、动态小，睡着不吵醒，醒过来也不突兀。这一类动态压得很低，睡着不会被突然的鼓点吵醒，醒来也不会被吓一跳。",
  "清晨": "音色干净、速度偏中，配器带一点明亮。适合起床到出门之间那半小时。",
  "校园": "从校园民谣到青春片主题曲，共同点是那种还没被磨过的语气。校园民谣那一支从九十年代传下来，编曲简单、词写得直白，讲的多是还没发生的事。",
  "学习": "没有人声或者人声很轻，节奏稳定，适合放在背景里长时间循环。这一类多数没有人声，或者人声被处理成音色的一部分，避免跟阅读抢注意力。",
  "工作": "不抢注意力的一单，编曲规整、情绪平，写代码和写文档都能垫着。这一类适合长时间循环：节奏稳定、没有大起伏，情绪平到不会把人从手头的事里拽出来。",
  "兴奋": "节奏快、副歌大、鼓点密，适合需要把情绪顶起来的时候。这一类不讲究耐听，讲究的是那一下把情绪顶起来，所以鼓点密、副歌早、前奏短。",
  "快乐": "大调、速度快、编曲亮，听着就想动。这一类几乎是条件反射：大调、快速度、明亮的配器，听觉上直接对应「高兴」这个判断。",
  "背景音乐": "功能性最强的一类：不抢戏、不突然、可以一直循环。这一类在唱片业里有个专门的说法叫功能性音乐，评判标准不是好不好听，而是会不会抢戏。",
  "佛教音乐": "诵经、梵呗和现代编曲混着用，节奏慢、混响长，多用于静坐和仪式。传统梵呗是单声部的，现代编曲会加上弦乐和环境音，两种听感差别不小，这一单都有。",
  "DJ": "连续混音的一单，一首接一首不断，重点在段落之间的过渡。这一类看重的是曲序而不是单曲，一首歌只取用得上的那一段，剩下的交给下一首。",
  "MC喊麦": "网络直播间里长出来的一种形式，鼓点固定、词密集、靠气势推。这一类多在直播间和短视频里传播，节奏固定、词押得密，靠气势和现场互动撑起来。",
  "闽南语": "闽南语的语感跟普通话差很远——声调多、句尾会拖，台湾和福建各有一支传统。这一类的老歌多跟台湾的唱片工业和闽南的民间歌谣有关，很多旋律其实是从歌仔戏里长出来的。",
  "法语": "法语的连读和鼻音让旋律听上去更软，从香颂到今天的法语流行都是这个底色。这一类从香颂一路到今天的法语流行，共同点是咬字清楚、句子短，旋律跟着语感走。",
  "70后": "七十年代出生那批人的青春配乐，多数集中在八九十年代的港台和内地流行。这一代的青春正好赶上磁带和录像厅的年代，歌是跟着剧和电台一起记住的。",
  "80后": "八十年代出生那批人的青春配乐，磁带和 CD 时代的歌。这一代赶上了唱片工业最后的高峰，专辑还是一整张地听，所以这一单里的歌多是同张专辑连着出现的。",
  "90后": "九十年代出生那批人的青春配乐，MP3 和网络歌曲开始流行的那些年。这一代是 MP3 和网络歌曲一起长大的，听歌变成了单曲循环，记忆里的歌往往只有副歌。",
  "00后": "两千年出生那批人的青春配乐，流媒体和短视频时代的歌。这一代从一开始就是流媒体和短视频，一首歌的走红周期可能只有两周，所以这一单更新得更快。",
};
/* 卡片上只放第一句，详情页给整段。 */
const mixBlurb = (cat) => MIX_BLURB[cat] ||
  (cat + "这一类的今日份：风格集中，编排尽量放进同一条线里，从头听下去不跳戏。");
const mixBlurbShort = (cat) => {
  const s = mixBlurb(cat);
  const i = s.indexOf("。");
  return i > 0 ? s.slice(0, i + 1) : s;
};
/* 曲目从哪儿来 —— 详情页末尾补一句，免得看着像凭空生成的。 */
const MIX_SOURCE_NOTE = "曲目取自网易云、QQ 音乐等平台的公开歌单，每天重拼一次，同一天内容固定。";

/** 某个分类的拼单封面：优先自绘那套，没有就回 Deezer 现搜（缓存 24h，一次 5 张） */
async function dzCovers(cat) {
  const key = cat || "全部";
  const own = MIX_COVERS[key];
  /* 一个分类画了几张就轮着用，不是「主图 + 备用」，几张地位一样。
     三天一换（不是天天换，天天换反而像在抖），同一天里固定不变。 */
  if (own && own.length) {
    const off = Math.floor(recDayKey() / 3) % own.length;
    return own.map((_, k) => COVER_CDN + own[(off + k) % own.length]);
  }
  const hit = DZ_COVER_CACHE[key];
  if (hit && Date.now() - hit.at < DZ_COVER_TTL) return hit.v;
  /* 降级链：分类词 → 泛流派词 → 空。宁可没图，也不能卡住整页。
     ⚠️ Deezer 在国内经常连不通（丢包而非拒绝），httpGet 默认 20 秒超时。
        串行重试 3 次 = 最长 60 秒卡在这里，拼单详情页就变成一个永远转不完的圈
        —— 真机上被这个坑过。所以：给 Deezer 单独 4 秒超时，三个词并发，
        取最先回来的那个；全挂了就空图，走下面的兜底。 */
  const tries = [DZ_KW[key] || key, "pop", "rock"];
  const one = (q) => axios_1.get(DZ_API + "/search/playlist", {
    params: { q: q, limit: 5 }, timeout: DZ_TIMEOUT, validateStatus: () => true,
  }).then((r) => {
    const arr = (r && r.data && r.data.data) || [];
    return arr.map((x) => x.picture_big || x.picture_medium || "").filter(Boolean);
  }).catch(() => []);
  let out = [];
  try {
    const all = await Promise.all(tries.map(one));
    for (let i = 0; i < all.length && !out.length; i++) out = all[i] || [];
  } catch (e) { out = []; }
  DZ_COVER_CACHE[key] = { at: Date.now(), v: out };
  return out;
}

const isMixId = (id) => String(id || "").indexOf(MIX_PREFIX) === 0;
/* 分类名本身可能带冒号（QQ 独有的 q:闽南语），所以从右往前切：
   最后两段一定是 <天序号> 和 <第几张>，剩下的整个是分类。 */
function parseMixId(id) {
  const body = String(id || "").slice(MIX_PREFIX.length);
  const p = body.split(":");
  const seq = Number(p.pop() || 1);
  const day = Number(p.pop() || 0);
  return { cat: p.join(":") || "全部", day: day, seq: seq };
}

/* QQ 独有的分类在 tag id 上带 q: 前缀（q:闽南语），
   那是给取池用的，拼单的标题和封面关键词都不能带这个前缀。 */
const mixCatName = (c) => String(c || "全部").replace(/^q:/, "");

/** 推荐页顶部这几张拼单（封面异步拿，拿不到就退回池子里第一张的图，
    保证不会出现没图的卡片） */
async function mixEntries(cat, fallbackArt) {
  const c = mixCatName(cat) || "全部";
  const tag = cat || "全部";
  const day = recDayKey();
  let covers = [];
  try { covers = await dzCovers(c); } catch (e) { covers = []; }
  const fb = fallbackArt || "";
  const out = [];
  for (let i = 1; i <= MIX_COUNT_PER_PAGE; i++) {
    out.push({
      /* id 里存带前缀的 tag —— 取池时要靠它判断「这是 QQ 独有的分类」 */
      id: MIX_PREFIX + tag + ":" + day + ":" + i,
      platform: "粽子",
      title: c + " · 拼好歌",
      artist: "拼好歌",
      artwork: covers.length ? covers[(i - 1) % covers.length] : fb,
      worksNum: MIX_TRACKS,
      playCount: 0,
      /* 卡片位置窄，只放第一句；整段留给详情页 */
      description: mixBlurbShort(c),
      _provider: "mix",
    });
  }
  return out;
}

/** 从某分类的当天池子里挑几张源歌单，把它们的前 N 首收成候选曲库 */
async function mixSourceSongs(cat, day, seq, skipOrigin, opts) {
  const nSheets = (opts && opts.sheets) || MIX_SRC_SHEETS;
  const nLimit = (opts && opts.limit) || MIX_SRC_LIMIT;
  const pool = await recSheetPool(cat);
  if (!pool.length) return [];
  const ordered = recDayOrder(pool, "mix|" + cat + "|" + seq, Math.floor(day / 30));
  /* 优先网易（取流最稳），不够再补 QQ */
  const ne = ordered.filter((x) => x.platform === "网易云" || x._provider === "netease");
  const qq = ordered.filter((x) => x._provider === "qq");
  const picks = ne.slice(0, nSheets).concat(qq.slice(0, nSheets)).slice(0, nSheets);

  const jobs = picks.map((p) => {
    if (p._provider === "qq") {
      return qqSheetDetail(p.id, 1).then((r) => ((r && r.musicList) || []).slice(0, nLimit));
    }
    return neteaseSheetDetail(p.id, 1, nLimit).then((r) => ((r && r.musicList) || []).slice(0, nLimit));
  });
  const arrs = await Promise.all(jobs.map((j) => j.catch(() => [])));
  const seen = {};
  const out = [];
  arrs.forEach((arr) => arr.forEach((s) => {
    if (!s || !s.id || !s.title) return;
    /* 跨歌单会撞同一首歌。用「标题+主歌手」当键，比 id 更能去重
       （同一首在网易有不同版本 id）。 */
    const k = normText(toSimplified(s.title)) + "|" + normText(splitSingers(s.artist)[0] || "");
    if (seen[k]) return;
    seen[k] = 1;
    out.push(s);
  }));
  if (skipOrigin) return out.filter((s) => s._provider !== skipOrigin);
  return out;
}

/** 按四条规则排一张拼单 */
function mixArrange(songs, seed, contrast) {
  const list = recShuffle(songs, seed);
  /* 规则 1：同一歌手最多 MIX_ARTIST_CAP 首 */
  const cnt = {};
  const keep = [];
  list.forEach((s) => {
    const k = normText(splitSingers(s.artist)[0] || s.artist || "");
    cnt[k] = (cnt[k] || 0) + 1;
    if (cnt[k] <= MIX_ARTIST_CAP) keep.push(s);
  });
  /* 规则 3：同歌手不相邻。贪心 —— 每次从剩下的里挑第一个「不是上一个歌手」的。 */
  const out = [];
  const left = keep.slice();
  let last = "";
  while (left.length) {
    let idx = 0;
    for (let i = 0; i < left.length; i++) {
      const k = normText(splitSingers(left[i].artist)[0] || left[i].artist || "");
      if (k !== last) { idx = i; break; }
    }
    const pick = left.splice(idx, 1)[0];
    last = normText(splitSingers(pick.artist)[0] || pick.artist || "");
    out.push(pick);
  }
  /* 反差歌要算进总数，所以主体先少留一格的余量 */
  const trimmed = out.slice(0, contrast ? MIX_TRACKS - 1 : MIX_TRACKS);
  /* 规则 4：三分之二处插反差歌。不放开头（一上来就换口味太突然），
     不放结尾（最后一首反差大会像歌单没排完）。 */
  if (contrast) {
    let pos = Math.floor(trimmed.length * 2 / 3);
    const ck = normText(splitSingers(contrast.artist)[0] || "");
    const at = (i) => (i >= 0 && i < trimmed.length ? normText(splitSingers(trimmed[i].artist)[0] || "") : "");
    /* 别让它跟前一首撞歌手，最多挪两格 */
    for (let t = 0; t < 2 && (at(pos - 1) === ck || at(pos) === ck); t++) pos += 1;
    if (pos > 0 && pos < trimmed.length) trimmed.splice(pos, 0, contrast);
  }
  return trimmed;
}

/** 拼单详情：当场按配方抓歌、排序 */
async function mixSheetDetail(recipe) {
  const tag = recipe.cat || "全部";        // 带 q: 前缀，取池用
  const cat = mixCatName(tag);             // 干净名，标题和封面关键词用
  const day = recipe.day || recDayKey();
  const seq = recipe.seq || 1;
  const seed = ((day * 2654435761) ^ recHash("mix|" + cat + "|" + seq)) >>> 0;

  /* 主体和反差歌的取数互不依赖，必须并发。
     串行的话就是「4 张源歌单 → 再 4 张反差歌单」两波网络往返，
     手机上点进详情要等十秒以上（表现为一直转圈）。
     反差歌只要一首，所以给它 1 张歌单、20 首候选就够，不用整份拉。
     ⚠️ 用 allSettled 而不是 all：反差歌挂了不能让整张拼单跟着失败。 */
  const far = MIX_CONTRAST[cat] || "爵士";
  /* 封面也塞进这批并发里。它要过一次网络（没自绘封面的分类走 Deezer），
     放在歌曲之后串行等，就白搭上一次往返；并发进来是零成本。 */
  const coverJob = dzCovers(cat).catch(() => []);
  const both = await Promise.all([
    mixSourceSongs(tag, day, seq),
    mixSourceSongs(far, day, seq + 7, null, { sheets: 1, limit: 20 }).catch(() => []),
  ]);
  const songs = both[0];
  const farPool = both[1];
  if (!songs.length) throw new Error("拼单：源曲库为空");

  /* 反差歌：不能是已经在单里的歌手 */
  let contrast = null;
  try {
    const used = {};
    songs.forEach((s) => { used[normText(splitSingers(s.artist)[0] || "")] = 1; });
    const cand = farPool.filter((s) => !used[normText(splitSingers(s.artist)[0] || "")]);
    if (cand.length) contrast = cand[day % cand.length];
  } catch (e) { /* 拿不到反差歌就少一首，不影响整张 */ }

  const musicList = mixArrange(songs, seed, contrast);
  let covers = [];
  try { covers = await coverJob; } catch (e) { covers = []; }

  return {
    isEnd: true,
    sheetItem: {
      id: MIX_PREFIX + tag + ":" + day + ":" + seq,
      platform: "粽子",
      title: cat + " · 拼好歌",
      artist: "拼好歌",
      artwork: covers.length ? covers[(seq - 1) % covers.length] : (musicList[0] && musicList[0].artwork) || "",
      worksNum: musicList.length,
      playCount: 0,
      description: (() => {
        /* 详情页给整段：曲风介绍 + 单子里有谁 + 曲目来源。
           不写怎么配比的（同歌手上限、反差歌位置那些）。 */
        const names = [];
        musicList.forEach((s) => {
          const n = splitSingers(s.artist)[0];
          if (n && names.indexOf(n) < 0) names.push(n);
        });
        const head = names.slice(0, 3).join("、");
        const who = head
          ? "\n本单收录 " + head + " 等 " + musicList.length + " 首。"
          : "\n本单共 " + musicList.length + " 首。";
        return mixBlurb(cat) + who + "\n" + MIX_SOURCE_NOTE;
      })(),
    },
    musicList: musicList,
  };
}

/* ============================================================
 * 口味画像（taste profile）
 *
 * MusicFree 插件沙箱是**无状态**的：没有文件、没有 AsyncStorage、
 * 读不到 App 的播放历史和收藏（见 core/pluginManager/plugin.ts 里
 * env 的定义，只有 getUserVariables 一个只读方法）。所以「自动
 * 记录你听了什么」这条路根本走不通 —— 不是没写，是拿不到。
 *
 * 能拿到的只有 userVariables：用户自己填、存在 App 里、每次调用
 * 都读得到的字符串。于是画像就建在这上面 ——
 *
 *   tasteSeeds  用户填的种子：歌手名（也可填歌名，会自动解析成歌手）
 *   tasteSkip   不想再看到的歌手，同样逗号分隔
 *
 * 有了种子之后**不需要**预先存一份画像：每次请求现算即可，
 * 计算全部是确定性函数，同样的种子永远给同样的结果。
 *
 * 扩张靠两条路，都不是「猜」：
 *   ① 歌单共现 —— 用种子歌手搜歌单，统计同一张歌单里还出现了谁。
 *      ⚠️ 这条比「相似歌手」准得多：榜单/推荐类歌单是运营拼的，
 *      同档歌手会被拼在一起；而匿名可用的相似歌手接口基本都死了
 *      （网易 simiSong 匿名返回空数组、QQ musicu 500003、
 *      酷狗 Access Deny），Deezer 能替代但中文覆盖率差
 *      （草东没有派对 直接查无此人），只能当补充。
 *   ② 候选校验 —— 共现出来的名字必须能通过「歌手名匹配 + 曲库规模」
 *      两道关，把 UGC 歌单里那些私人号的杂名滤掉。
 *
 * ⚠️ 性能：整条链路 26 个请求、实测 1.6 秒（本机直连）。
 *    手机上慢一些，所以结果缓存 30 分钟，翻页不重复算。
 * ============================================================ */

/** 种子/排除名单解析：逗号、顿号、分号、竖线、换行都算分隔符 */
function tasteList(v) {
  return String(v || "")
    .split(/[,，、;；|\n]/)
    .map((x) => x.trim())
    .filter((x) => x && x.length <= 40);
}

/* 翻奏 / 伴奏 / 纯音乐号的名字特征。这类号规模往往很大（Piano Echoes 3168 首），
   单看曲库规模完全拦不住，只能从名字认。 */
const TASTE_COVER_NAME = /(piano|cover|karaoke|instrumental|伴奏|翻奏|翻唱|纯音乐|钢琴版|吉他版|八音盒|music box|tribute|lullaby|ringtone|dj版|remix)/i;

/* 曲目级的翻奏标记。只在括号或歌名尾部出现才算 —— 有些正经歌名本身
   就带「Piano」这个词（比如《Piano Man》），照名字一刀切会误杀。
   ⚠️ 实测混进来的还有更脏的一类：「晴天(抖音热搜版)」「XX (BGM版)」
   —— 那是短视频翻唱号蹭原曲名，必须和钢琴版一起压掉。 */
const TASTE_COVER_TRACK = /[（(【\[][^）)】\]]*(piano|cover|karaoke|instrumental|伴奏|翻奏|纯音乐|钢琴版|吉他版|八音盒|music box|remix|dj版|抖音|热搜|bgm|片段|铃声|女声|男声|童声|纯享|accelerated|sped up|nightcore)[^）)】\]]*[）)】\]]/i;

/* 短视频翻唱号另有一招：直接把标记写在歌名尾巴上、不带括号，
   比如「故事开头总是极致温柔 - 抖音版」。这类号名字也很杂，
   用同一个词表扫全文。 */
const TASTE_DOUYIN_TAIL = /(抖音|热搜|短视频|片段|女声|男声|童声)(版|$)/i;

/** 歌手名与用户输入的匹配强度。3 = 完全同名，2 = 别名或前后缀只有拉丁字符，0 = 不算 */
const TASTE_LATIN_EXTRA = /^[A-Za-z0-9 .,'&()\-·]+$/;
function artistNameRelation(cand, q) {
  const name = String((cand && cand.name) || "");
  const aliases = [].concat((cand && cand.alias) || [], (cand && cand.alia) || [], (cand && cand.trans) || []);
  const want = String(q || "").trim();
  if (!name || !want) return 0;
  if (name === want) return 3;
  if (aliases.indexOf(want) >= 0) return 2;
  /* 「G.E.M.邓紫棋」查「邓紫棋」、「Taylor Swift」查「Taylor」都该命中；
     但「李志辉」查「李志」不能命中 —— 多出来的部分只要有中文字就不算。 */
  if (name.indexOf(want) === 0 && TASTE_LATIN_EXTRA.test(name.slice(want.length))) return 2;
  if (name.length > want.length &&
      name.lastIndexOf(want) === name.length - want.length &&
      TASTE_LATIN_EXTRA.test(name.slice(0, name.length - want.length))) return 2;
  return 0;
}

/* 歌手搜索 → 择优。同名歌手在网易有一堆山寨号（「周杰伦.」「syE_21」
   这种），只按名字匹配会挑错。实测「曲库规模」是最稳的判别式：
   真身 581 首 vs 山寨 20 首，真身 1863 首 vs 粉丝号 3 首。
   ⚠️ 但规模不能单独用 —— 「李志辉」有 290 首，比「李志」的 2 首多得多。
      所以关系必须先过硬（名字对得上），规模只在**彼此关系同级**时排序。 */
const TASTE_ARTIST_TTL = 24 * 60 * 60 * 1000;
const TASTE_ARTIST_CACHE = {};

async function tasteFindArtist(q) {
  const key = normText(q);
  const hit = TASTE_ARTIST_CACHE[key];
  if (hit && Date.now() - hit.at < TASTE_ARTIST_TTL) return hit.v;
  let best = null;
  try {
    const r = await httpGet("https://music.163.com/api/search/get",
      { s: q, type: 100, limit: 10 }, NETEASE_HEADERS);
    const list = (r && r.result && r.result.artists) || [];
    const scored = [];
    for (let i = 0; i < list.length; i++) {
      const rel = artistNameRelation(list[i], q);
      if (rel <= 0) continue;
      scored.push({ rel: rel, size: Number(list[i].musicSize || 0), item: list[i] });
    }
    scored.sort((a, b) => (b.rel - a.rel) || (b.size - a.size));
    if (scored.length) best = scored[0].item;
  } catch (e) {
    console.log("[粽子] 找歌手失败(" + q + "): " + e.message);
  }
  TASTE_ARTIST_CACHE[key] = { at: Date.now(), v: best };
  return best;
}

/** 把用户输入的种子落成一位真歌手，失败返回空串。
    ⚠️ 「填歌名自动解析成歌手」这条路**走不通**，2026-10-19 实测：
       匿名搜「晴天」，前 30 条没有一条是周杰伦的原唱，全是
       《晴天(深情版)》/Lucky小爱、《晴天 (原唱 周杰伦)》/RyaVocal
       这类翻唱号。加 Cookie、换关键词组合都一样 —— 网易的匿名搜索
       结果被翻唱内容淹了。拿第一条当原唱只会把种子带偏。
    所以改成反过来的验证：**先当作歌手名去找**，找到后用它热门曲的
    主唱占比自证身份。曲目全是我唱的 → 这是个真歌手，种子有效；
    热门全是别人的歌 → 这是个蹭歌号或压根不是歌手，种子作废。
    这样既不用猜歌名，也不会把假歌手当真。 */
async function tasteResolveSeed(seed) {
  const a = await tasteFindArtist(seed);
  if (!a) return "";
  const size = Number(a.musicSize || 0);
  /* 曲库太小的同名号基本是私人上传（搜「晴天」会冒出一堆 0~16 首、
     名字就叫「晴天」的假歌手）。但小众真乐队也可能只有 20 来首
     （草东 24 首、万青 21 首），所以不能只看规模 ——
     小曲库继续验证，大曲库直接放行省一次请求。 */
  if (size < 5) return "";
  if (size >= 20) return String(a.name);
  /* 曲库小的时候再加一道专辑数门槛。
     ⚠️ 只靠「主唱是不是自己」判不出来：实测有十几个叫「晴天」的私人号，
        曲库 10~16 首、全是他自己唱的，占比 100%，但那不是歌手 ——
        是个人上传。真乐队就算曲库小（草东 24 首、万青 21 首），
        专辑数是 3 / 2 这种成规模的值；私人号普遍只有 1 张。 */
  const alb = Number(a.albumSize || 0);
  if (alb < 2) return "";
  const songs = await tasteArtistSongs(a.id, 20);
  if (!songs.length) return "";
  const want = normText(a.name);
  let own = 0;
  for (let i = 0; i < songs.length; i++) {
    const main = normText(splitSingers(songs[i].artist)[0] || songs[i].artist || "");
    if (main && (main.indexOf(want) >= 0 || want.indexOf(main) >= 0)) own += 1;
  }
  /* 主唱占比过半才算歌手本人。蹭歌号（热门一半是别人的歌）直接作废 */
  return own / songs.length >= 0.5 ? String(a.name) : "";
}

/** 拿某位歌手的代表曲（热门 50 首）。
    ⚠️ 两个接口的字段名**不一样**，必须都兼容：
        artist/top/song → ar / al / dt
        artist/songs    → artists / album / duration
        （没有 al 就直接没有专辑和封面）
    踩过的坑：只读 ar 时，走 artist/songs 的分支拿到的 artist 全是空串，
    后面「主歌手不符就丢」那条规则把整批歌全判成不符，一首不剩。 */
async function tasteArtistSongs(artistId, limit) {
  const cap = Number(limit) > 0 ? Number(limit) : 50;
  const pick = (songs) => {
    const out = [];
    for (let i = 0; i < songs.length && out.length < cap; i++) {
      const t = songs[i];
      if (!t || !t.id || !t.name) continue;
      const ars = t.ar || t.artists || [];
      const al = t.al || t.album || null;
      out.push({
        id: String(t.id),
        platform: "网易云",
        title: t.name,
        artist: ars.map((x) => x.name).filter(Boolean).join("/"),
        album: (al && al.name) || "",
        artwork: (al && al.picUrl) || "",
        duration: Number(t.dt || t.duration || 0),
        _provider: "netease",
      });
    }
    return out;
  };
  try {
    const r = await httpGet("https://music.163.com/api/v1/artist/songs",
      { id: artistId, limit: cap, offset: 0, order: "hot" }, NETEASE_HEADERS);
    const list = pick((r && r.songs) || []);
    if (list.length) return list;
  } catch (e) { /* 换旧接口再试 */ }
  try {
    const r2 = await httpGet("https://music.163.com/api/artist/top/song", { id: artistId }, NETEASE_HEADERS);
    return pick((r2 && r2.songs) || []);
  } catch (e) {
    console.log("[粽子] 歌手曲目失败(" + artistId + "): " + e.message);
    return [];
  }
}

/* 歌单共现：搜种子歌手的歌单，统计同一张里还出现了谁。
   ⚠️ 两个计数缺一不可：
      · sheets = 在**几张不同的**歌单里出现过
      · n      = 累计出现在多少首歌里
      「sheets」才是判别噪声的关键。只在一张歌单里刷 57 次的私人号
      （实测：「扎进心脏的智齿」）sheets 只有 1，而温岚、蔡依林这种
      真合作歌手会横跨 3~4 张 —— 刷单刷不出跨歌单的分布。
      所以排序第一权重是 sheets，n 只用来在同分布度里分先后。 */
const TASTE_CO_MAX_SHEETS = 4;
const TASTE_CO_MAX_TRACKS = 150;

/* ⚠️ 歌单详情接口只回前 10 首完整曲目，剩下的都在 trackIds 里。
   这是一个非常容易漏的坑：直接读 playlist.tracks 会以为「一张 143 首的
   歌单只有 10 首」，共现统计只剩 35 个名字、相似歌手只有 2 个，
   但整个流程一切正常、不报错。（本文件另一处的歌单详情早就踩过，
   那里是补曲目，这里是补统计用的人。）
   所以必须按 trackIds 批量取详情，100 个一批。 */
async function tasteSheetTracks(pl, maxTracks) {
  const cap = Number(maxTracks) > 0 ? Number(maxTracks) : 1000;
  const out = [];
  const have = {};
  const push = (t) => {
    if (!t || !t.id) return;
    if (have[t.id]) return;
    have[t.id] = 1;
    out.push(t);
  };
  (pl.tracks || []).forEach(push);
  const ids = (pl.trackIds || []).map((x) => x && x.id).filter(Boolean);
  const missing = [];
  for (let i = 0; i < ids.length && missing.length < cap; i++) {
    if (!have[ids[i]]) missing.push(ids[i]);
  }
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    try {
      const d = await axios_1.get(NETEASE_SONG_DETAIL, {
        params: {
          ids: JSON.stringify(chunk),
          c: JSON.stringify(chunk.map(() => ({ id: 0 }))),
        },
        timeout: 20000,
        headers: NETEASE_HEADERS,
        validateStatus: () => true,
      });
      const songs = (d.data && d.data.songs) || [];
      songs.forEach(push);
    } catch (e) { /* 单批失败不影响已拿到的 */ }
    if (out.length >= cap) break;
  }
  return out.slice(0, cap);
}

async function tasteCoArtists(seedName) {
  const co = {};
  try {
    const r = await httpGet("https://music.163.com/api/search/get",
      { s: seedName, type: 1000, limit: 8 }, NETEASE_HEADERS);
    const sheets = (r && r.result && r.result.playlists) || [];
    const pick = sheets.filter((p) => p && p.id).slice(0, TASTE_CO_MAX_SHEETS);
    const details = await Promise.all(pick.map((p) =>
      httpGet(NETEASE_PLAYLIST_DETAIL, { id: p.id, n: TASTE_CO_MAX_TRACKS }, NETEASE_HEADERS)
        .catch(() => null)
    ));
    for (let i = 0; i < details.length; i++) {
      const pl = details[i] && details[i].playlist;
      if (!pl) continue;
      const tracks = await tasteSheetTracks(pl, TASTE_CO_MAX_TRACKS);
      /* 同一张歌单里同一个人只记一次 sheets，歌数照常累加 */
      const inThisSheet = {};
      for (let j = 0; j < tracks.length; j++) {
        const ars = (tracks[j] && (tracks[j].ar || tracks[j].artists)) || [];
        for (let k = 0; k < ars.length; k++) {
          const name = (ars[k] && ars[k].name) || "";
          const key = normText(name);
          if (!key || key.length < 2) continue;
          co[key] = co[key] || { name: name, n: 0, sheets: 0 };
          co[key].n += 1;
          if (!inThisSheet[key]) { inThisSheet[key] = 1; co[key].sheets += 1; }
        }
      }
    }
  } catch (e) {
    console.log("[粽子] 共现失败(" + seedName + "): " + e.message);
  }
  return Object.keys(co).map((k) => co[k]).sort((a, b) => (b.sheets - a.sheets) || (b.n - a.n));
}

/* 画像缓存。种子里任何一个字变了整份就作废 —— 缓存键直接拼种子串。 */
const TASTE_TTL = 30 * 60 * 1000;
const TASTE_CACHE = {};
/* 一次请求能带的歌手数。每个歌手要 1~2 个请求，太多就超时了 */
const TASTE_MAX_SEEDS = 8;

async function buildTasteProfile(seedsRaw, skipRaw) {
  const seeds = tasteList(seedsRaw).slice(0, TASTE_MAX_SEEDS);
  const skip = tasteList(skipRaw).map(normText);
  const cacheKey = seeds.join("|") + "##" + skip.join("|");
  const hit = TASTE_CACHE[cacheKey];
  if (hit && Date.now() - hit.at < TASTE_TTL) return hit.v;

  /* ① 种子落成真歌手。解析不出来的直接跳过（不拿原词硬凑）。
     ⚠️ 必须并发：一个种子两次请求，8 个种子串行就是十几趟往返，
        手机上要等十秒以上（表现为「为你推荐」一直转圈）。
        并发后本机冷启动 4.6s → 2s 出头。 */
  const settled = await Promise.all(seeds.map((s) =>
    tasteResolveSeed(s).then((name) => name).catch(() => "")
  ));
  const resolved = [];
  const seen = {};
  for (let i = 0; i < settled.length; i++) {
    const name = settled[i];
    if (!name) {
      console.log("[粽子] 种子无效，跳过: " + seeds[i]);
      continue;
    }
    const key = normText(name);
    if (!key || seen[key]) continue;
    if (skip.indexOf(key) >= 0) continue;
    seen[key] = 1;
    resolved.push(name);
  }
  if (!resolved.length) return { seeds: [], artists: [], songs: [], empty: true };

  /* ② 每位歌手：歌单共现（找同档的人）+ 自己的热门曲。
     同样并发 —— tasteFindArtist 命中 24h 缓存时不发请求，
     首次则是一次搜索，并发能省掉大半等待。 */
  const infos = await Promise.all(resolved.map((n) => tasteFindArtist(n).catch(() => null)));
  const seedArtists = [];
  for (let i = 0; i < infos.length; i++) {
    const info = infos[i];
    if (!info || Number(info.musicSize || 0) < 3) continue;
    seedArtists.push({
      id: String(info.id), name: info.name,
      size: Number(info.musicSize || 0), albumSize: Number(info.albumSize || 0),
    });
  }
  /* 种子里有一半解析不出真歌手（比如全被「不想听到」排掉了），或者
     全都查不到曲库 → 直接判空，别拿空列表往下算。
     踩过的坑：这里不断开时，后面的步骤全都拿空数组继续跑，
     最后返回一个 songs 为空的画像，调用方拿到 0 首的歌单再取详情就崩。 */
  if (!seedArtists.length) return { seeds: [], artists: [], songs: [], empty: true };
  const coLists = await Promise.all(seedArtists.map((a) => tasteCoArtists(a.name)));

  /* ③ 共现结果合并。可信度 = 横跨了几张歌单 × 被几位种子带出来。
     ⚠️ 「被几位种子带出来」是防止某一位种子的私单把榜单带偏；
        「横跨几张歌单」是防止刷单号。两个都是分布指标，不是热度指标 ——
        热度（累计歌数）在这里几乎没用，刷单号能把它的数字堆得很高。 */
  /* ⚠️ 种子之间必须互相排除。踩过的坑：三位种子会同时出现在同一批歌单里
     （「林俊杰＋周杰伦＋陈奕迅＋薛之谦」这种），于是它们互相把对方的
     权重顶到满分，占掉前 24 个候选名额，把真正的相似歌手（蔡依林、
     G.E.M. 这些）挤出去 —— 表现为「相似歌手只有 2 个」。
     排除之后权重才反映「有多少个**非种子**环境里出现」。 */
  const merged = {};
  for (let i = 0; i < coLists.length; i++) {
    const list = coLists[i];
    for (let j = 0; j < list.length; j++) {
      const key = normText(list[j].name);
      if (!key || key.length < 2) continue;
      if (skip.indexOf(key) >= 0) continue;
      if (seen[key]) continue;                 // 种子自己不算相似
      merged[key] = merged[key] || { name: list[j].name, n: 0, sheets: 0, seeds: 0 };
      merged[key].n += list[j].n;
      merged[key].sheets = Math.max(merged[key].sheets, list[j].sheets || 0);
      merged[key].seeds += 1;
    }
  }
  const cands = Object.keys(merged)
    .map((k) => merged[k])
    /* 至少要在 2 张歌单里出现过才算候选：只在单张里出现的基本是私单噪声 */
    .filter((x) => x.sheets >= 2)
    .sort((a, b) => ((b.seeds * 10 + b.sheets) - (a.seeds * 10 + a.sheets)) || (b.n - a.n))
    .slice(0, 30);

  /* ④ 校验：名字得对得上、曲库得有规模。这一步专治共现里的杂名
     （实测未过滤时榜首是「扎进心脏的智齿」这种私人号，
      过滤后剩下的才是林俊杰 / 薛之谦 / 蔡依林）。 */
  /* 校验同样并发跑：cands 最多 30 个，串行就是 30 趟往返。
     并发后仍按原顺序过滤，结果和串行完全一致（tasteFindArtist 有缓存，
     同一名字不会重复请求）。 */
  const candInfos = await Promise.all(cands.map((c) =>
    tasteFindArtist(c.name).catch(() => null)
  ));
  const checked = [];
  for (let i = 0; i < cands.length; i++) {
    const info = candInfos[i];
    if (!info) continue;
    const size = Number(info.musicSize || 0);
    if (size < 8) continue;
    /* 翻奏 / 伴奏 / 纯音乐号整位排除。
       ⚠️ 实测：「Piano Echoes」靠曲子里的原唱关系被共现带进周杰伦的圈，
          它自己有 3168 首、专辑 237 张，规模判据完全拦不住；但它出的
          全是《青花瓷 (Piano Ver.)》这种翻奏，用户点进「因为你在听
          周杰伦」看到一排钢琴版，会以为推荐坏了。
          判据看名字，因为这类号一定会把「翻奏」写进名字（不然没人搜得到）。 */
    if (TASTE_COVER_NAME.test(String(info.name || ""))) continue;
    checked.push({
      id: String(info.id), name: info.name, size: size,
      albumSize: Number(info.albumSize || 0),
      weight: cands[i].seeds * 10 + cands[i].sheets,
    });
    if (checked.length >= 12) break;
  }

  /* ⑤ 取曲：种子歌手全带，相似的按权重补位，避免整单都是同一个人 */
  const artists = seedArtists.concat(checked);
  const jobs = artists.map((a) => tasteArtistSongs(a.id, 20).then((s) => ({ a: a, s: s })));
  const got = await Promise.all(jobs);

  /* ⑤b 原创占比闸门：整批热门里「主唱就是本人」的比例太低，说明这是个
     蹭歌号（热门全靠在别人歌里挂名），整位踢掉。
     ⚠️ 实测「姜辰辰」50 首热门里有一半主唱不是自己，靠曲名过滤只能
        压掉一部分（《网抑热播伤感合集》《如果忧郁是天赋》这类名字
        干干净净、完全没有翻唱标记）。曲名这条路走不通，只能看结构。
     阈值 0.5 的依据：正常人 44/50≈0.88，草东 24/24，而这类号不到一半。 */
  for (let i = seedArtists.length; i < got.length; i++) {
    const g = got[i];
    if (!g.s.length) continue;
    const want = normText(g.a.name);
    let own = 0;
    let short = 0;
    for (let j = 0; j < g.s.length; j++) {
      const main = normText(splitSingers(g.s[j].artist)[0] || g.s[j].artist || "");
      if (main && (main.indexOf(want) >= 0 || want.indexOf(main) >= 0)) own += 1;
      /* 90 秒以下的算「碎片」。短视频号会把一整首歌剪成几十个片段发，
         正经歌手的热门里几乎不会有。 */
      if (g.s[j].duration && g.s[j].duration < 90000) short += 1;
    }
    /* 判据（满足任一就踢）：
       ① 原创占比 < 50% —— 蹭歌号（热门一半是别人的歌）
       ② 碎片率 > 15% —— 短视频搬运号
         实测：姜辰辰 20 首热门里 4 首短于 90 秒（20%），
         周深 0/50、华晨宇 0/50、草东 0/24。
     ⚠️ 不设「专辑数多就豁免」：姜辰辰有 127 张「专辑」，
        但那些是单曲发行堆出来的（每首歌发一张），数量上比
        周杰伦（42 张）还多，用它做豁免等于给搬运号开后门。
       ⚠️ 也不设「原创占比豁免」：初音ミク这类合成音声的主唱字段
        常挂制作人名字，占比只有 1/20 —— 但它名下有几千首、
        在多个歌手的歌单里稳定共现，碎片率是 0，靠 ② 这条判据放行。 */
    const bad = (own / g.s.length < 0.5) || (short / g.s.length > 0.15);
    if (bad) {
      console.log("[粽子] 画像剔除搬运号: " + g.a.name +
        "（原创 " + own + "/" + g.s.length + "，碎片 " + short + "/" + g.s.length + "）");
      g.s = [];
    }
  }

  /* ⚠️ 取曲顺序必须先种子、后相似。按「每位歌手轮流取 1 首」时，
     相似的歌手有十几个，12 轮就被他们填满了，种子歌手拿不到几首 ——
     实测「因为你在听 周杰伦」里周杰伦只占 3/40。
     改成两段：种子区间铺满，相似歌手只在后面补位。 */

  /** 某位歌手的曲目过滤出可用列表（去翻奏、去挂名合唱） */
  function usableSongs(artistName, list, seenId, seenTk) {
    const want = normText(artistName);
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const song = list[i];
      if (!song || !song.id || seenId[song.id]) continue;
      /* 翻奏版（《青花瓷 (Piano Ver.)》）和短视频蹭名版（《晴天(抖音热搜版)》）
         一起压掉 —— 用户要原曲 */
      const ttl = String(song.title || "");
      if (TASTE_COVER_TRACK.test(ttl)) continue;
      if (TASTE_DOUYIN_TAIL.test(ttl)) continue;
      /* 时长过短的也丢：实测「晴天(抖音热搜版)」只有 36 秒，
         正经歌不会这么短，这基本就是剪辑片段。 */
      if (song.duration && song.duration < 70000) continue;
      /* ⚠️ 挂名合唱要丢掉。实测周杰伦 50 首热门里 39 首的主歌手是
         蔡依林 / 李玟 / 李荣浩 —— 那是《布拉格广场》这类别人主场、
         他参与合唱的歌。它们属于对方，硬算成他的歌会让推介失真。 */
      const mainArtist = normText(splitSingers(song.artist)[0] || song.artist || "");
      if (mainArtist && want && mainArtist.indexOf(want) < 0 && want.indexOf(mainArtist) < 0) continue;
      const tkey = normText(song.title) + "|" + mainArtist;
      if (seenTk[tkey]) continue;
      seenTk[tkey] = 1;
      seenId[song.id] = 1;
      out.push(song);
    }
    return out;
  }

  const seenSong = {};
  const seenTitle = {};
  const songs = [];
  const seedCount = seedArtists.length;

  /* 第一段：种子歌手，每位最多 8 首，按轮次交替取，避免一个人占满 */
  const seedPools = got.slice(0, seedCount).map((g) => usableSongs(g.a.name, g.s, seenSong, seenTitle));
  for (let round = 0; round < 8; round++) {
    for (let i = 0; i < seedPools.length; i++) {
      if (round < seedPools[i].length) songs.push(seedPools[i][round]);
    }
  }

  /* 第二段：相似歌手补位。每人 2 首即可 —— 相似歌手有十几位，
     每人 4 首会把 40 首的位子占掉大半，种子歌手反而又变稀。
     目标配比：种子占 60% 左右，其余平摊给相似的歌手。 */
  const simPools = got.slice(seedCount).map((g) => usableSongs(g.a.name, g.s, seenSong, seenTitle));
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < simPools.length; i++) {
      if (round < simPools[i].length) songs.push(simPools[i][round]);
    }
  }

  const out = {
    seeds: seedArtists.map((a) => a.name),
    artists: artists.map((a) => a.name),
    similar: checked.map((a) => a.name),
    songs: songs,
    empty: false,
  };
  /* 一首都取不到（种子全是蹭歌号、或者被过滤规则压光了）→ 判空，
     不缓存空结果之外的东西，也不让调用方拿到一张 0 首的歌单。 */
  if (!songs.length) {
    console.log("[粽子] 画像为空：种子都没能取到可用曲目");
    return { seeds: [], artists: [], songs: [], empty: true };
  }
  TASTE_CACHE[cacheKey] = { at: Date.now(), v: out };
  return out;
}

/** 用户填的种子（插件设置页里那两项）。
    ⚠️ 两种取法都得支持：真机沙箱里 env.userVariables 是 getter，
       而本地 Node 测试只能塞 getUserVariables 函数。 */
function tasteVars() {
  try {
    if (typeof env === "undefined" || !env) return { seeds: "", skip: "" };
    let vars = null;
    if (typeof env.getUserVariables === "function") {
      try { vars = env.getUserVariables(); } catch (e) { vars = null; }
    }
    if (!vars || typeof vars !== "object") vars = env.userVariables;
    if (!vars || typeof vars !== "object") return { seeds: "", skip: "" };
    return { seeds: vars.tasteSeeds || "", skip: vars.tasteSkip || "" };
  } catch (e) { return { seeds: "", skip: "" }; }
}

/* 「为你推荐」在标签栏里的 id。用不可能和平台分类撞车的前缀，
   与 mix: / applaylist: 那套自造 id 的策略一致。 */
const TAG_TASTE = "taste:for-you";
const TASTE_PREFIX = "taste:";
const TASTE_SHEET_TRACKS = 40;

/* 画像单的 id 里带着「种子指纹」和「第几张」——
   id 是客户端回传的唯一线索，配方得能自解释，不能在内存里找。
   指纹只取哈希，不把歌手名写进 id（避免长中文串和特殊字符）。 */
function tasteFingerprint(seedsRaw, skipRaw) {
  return recHash("taste|" + tasteList(seedsRaw).join(",") + "|" + tasteList(skipRaw).join(",")).toString(36);
}

const isTasteId = (id) => String(id || "").indexOf(TASTE_PREFIX) === 0;
function parseTasteId(id) {
  const p = String(id || "").slice(TASTE_PREFIX.length).split(":");
  /* taste:<指纹>:<第几张> */
  return { fp: p[0] || "", seq: Number(p[1] || 1) };
}

/* 把画像曲目按「歌手不过密」排一下。逐首挑：优先选和上一首不同歌手的，
   挑不到就退而求其次 —— 不能让排序把整张单拖成同一人循环。 */
function tasteArrange(songs, seed) {
  const out = [];
  if (!songs || !songs.length) return out;
  const left = recShuffle(songs, seed);
  let last = "";
  while (left.length) {
    let idx = 0;
    for (let i = 0; i < left.length; i++) {
      const k = normText(splitSingers(left[i].artist)[0] || left[i].artist || "");
      if (k !== last) { idx = i; break; }
    }
    const pick = left.splice(idx, 1)[0];
    last = normText(splitSingers(pick.artist)[0] || pick.artist || "");
    out.push(pick);
  }
  return out;
}

/** 画像拆成几张单：主单 + 按种子歌手分的分支单，让「为你推荐」不止一张卡 */
async function tasteSheets() {
  const tv = tasteVars();
  const prof = await buildTasteProfile(tv.seeds, tv.skip);
  if (prof.empty || !prof.songs.length) return [];

  const fp = tasteFingerprint(tv.seeds, tv.skip);
  const day = recDayKey();
  const seedNames = prof.seeds.slice(0, 4);

  const out = [];
  /* ① 主单：全部曲目混排，40 首 */
  out.push({
    id: TASTE_PREFIX + fp + ":1",
    platform: "粽子",
    title: "为你推荐 · 每日精选",
    artist: "粽子",
    artwork: (prof.songs[0] && prof.songs[0].artwork) || "",
    worksNum: Math.min(prof.songs.length, TASTE_SHEET_TRACKS),
    playCount: 0,
    description: tasteBlurb(prof, seedNames),
    _provider: "taste",
  });

  /* ② 分支单：每位种子歌手一张，内容是该歌手 + 相似歌手同框，
     方便想听某一路的时候直接点进去。最多 3 张，再多就没意义了。 */
  for (let i = 0; i < Math.min(seedNames.length, 3); i++) {
    const name = seedNames[i];
    const key = normText(name);
    const mine = prof.songs.filter((s) => normText(s.artist).indexOf(key) >= 0);
    const rest = prof.songs.filter((s) => normText(s.artist).indexOf(key) < 0);
    const list = mine.concat(rest).slice(0, TASTE_SHEET_TRACKS);
    if (list.length < 5) continue;
    out.push({
      id: TASTE_PREFIX + fp + ":" + (i + 2),
      platform: "粽子",
      title: "因为你在听 " + name,
      artist: "粽子",
      artwork: (mine[0] && mine[0].artwork) || (list[0] && list[0].artwork) || "",
      worksNum: list.length,
      playCount: 0,
      description: name + " 和同档歌手的曲目，共 " + list.length + " 首。每天重排一次。",
      _provider: "taste",
    });
  }
  return out;
}

function tasteBlurb(prof, seedNames) {
  const who = seedNames.join("、");
  const sim = (prof.similar || []).slice(0, 4).join("、");
  return "根据你填的种子（" + who + "）推的。" +
    (sim ? "\n顺着歌单里的同框关系，又找到了 " + sim + " 这些歌手。" : "") +
    "\n这不是平台算法 —— 插件读不到你的播放历史，只能靠你手填的种子往外扩。" +
    "想换口味就去插件设置改「口味种子」。";
}

/** 画像单详情：按 id 里的指纹找回同一种子组合，现算现给 */
async function tasteSheetDetail(recipe) {
  const tv = tasteVars();
  const fp = tasteFingerprint(tv.seeds, tv.skip);
  const prof = await buildTasteProfile(tv.seeds, tv.skip);
  if (prof.empty || !prof.songs.length) return null;
  const day = recDayKey();
  const seed = ((day * 2654435761) ^ recHash("taste|" + recipe.seq)) >>> 0;

  let list;
  if (recipe.seq <= 1) {
    list = prof.songs;
  } else {
    const name = (prof.seeds || [])[recipe.seq - 2];
    if (!name) return null;
    const key = normText(name);
    list = prof.songs.filter((s) => normText(s.artist).indexOf(key) >= 0)
      .concat(prof.songs.filter((s) => normText(s.artist).indexOf(key) < 0));
  }
  const musicList = tasteArrange(list, seed).slice(0, TASTE_SHEET_TRACKS);
  if (!musicList.length) return null;

  const seedNames = (prof.seeds || []).slice(0, 4);
  const title = recipe.seq <= 1
    ? "为你推荐 · 每日精选"
    : "因为你在听 " + (seedNames[recipe.seq - 2] || "");
  return {
    isEnd: true,
    sheetItem: {
      id: TASTE_PREFIX + fp + ":" + recipe.seq,
      platform: "粽子",
      title: title,
      artist: "粽子",
      artwork: (musicList[0] && musicList[0].artwork) || "",
      worksNum: musicList.length,
      playCount: 0,
      description: tasteBlurb(prof, seedNames),
    },
    musicList: musicList,
  };
}

/* ============================================================
 * 评论（getMusicComments）
 *
 * MusicFree 客户端里有「查看评论」入口（歌曲菜单里），
 * 但它不在官方插件文档里 —— 是客户端 core/panels/types/musicComment 直接
 * 调 plugin.methods.getMusicComments(musicItem, page)，
 * 只要插件实例上有这个方法，菜单里那项就会自己出现（源码里按
 * supportedMethods.has("getMusicComments") 判断显隐）。
 *
 * 返回结构（src/types/media.d.ts 的 IComment）：
 *   { nickName, avatar, comment, like, createAt, location, replies? }
 *
 * 两个数据源：
 *   网易云  匿名可用，实测一首歌 197 万条，offset 正常翻页
 *   YouTube 走 innertube next，先用 watch 页 HTML 里的 ytInitialData
 *           找到 comment-item-section 的 token，再换
 *           frameworkUpdates.entityBatchUpdate 里的评论实体
 *
 * ⚠️ 其余平台（QQ/酷狗/咪咕/酷我/B站…）自己没有公开评论接口，
 *    所以走「按歌名+歌手反查网易同一首歌」的路子 —— 评论本来就该跟着
 *    这首歌走，而不是跟着某个平台的 copy 走。
 * ============================================================ */
const NE_COMMENT_API = "https://music.163.com/api/v1/resource/comments/";
const NE_COMMENT_TTL = 10 * 60 * 1000;
const NE_COMMENT_CACHE = {};
/* 网易的评论分页是 offset 制，一页固定 20 条（给多了也只回 20）。
   客户端按 page 翻，我们换算成 offset。 */
const NE_COMMENT_PAGE = 20;

/** 网易一条评论 → IComment */
function neCommentItem(c) {
  const u = c.user || {};
  return {
    id: String(c.commentId || ""),
    nickName: u.nickname || "网易云用户",
    avatar: u.avatarUrl || "",
    comment: String(c.content || ""),
    like: Number(c.likedCount || 0),
    createAt: Number(c.time || 0),
    location: (c.ipLocation && c.ipLocation.location) || "",
    /* 楼层回复。网易只给「被回复的那一条」，不是完整对话树，
       所以这里挂成一层的 replies，够看，不做假的多层展开。 */
    replies: (c.beReplied || []).filter((r) => r && r.content).map((r) => ({
      id: String(r.beRepliedCommentId || ""),
      nickName: (r.user && r.user.nickname) || "网易云用户",
      comment: String(r.content || ""),
      createAt: 0,
      like: 0,
    })),
  };
}

/** 拉网易某首歌的评论。hotFirst=true 时把热评排在最前面 */
async function neteaseComments(songId, page, hotFirst) {
  const p = Number(page) > 0 ? Number(page) : 1;
  const offset = (p - 1) * NE_COMMENT_PAGE;
  const ck = "ne|" + songId + "|" + offset;
  const hit = NE_COMMENT_CACHE[ck];
  if (hit && Date.now() - hit.at < NE_COMMENT_TTL) return hit.v;

  const r = await httpGet(NE_COMMENT_API + "R_SO_4_" + songId,
    { limit: NE_COMMENT_PAGE, offset: offset }, NETEASE_HEADERS);
  if (!r || r.code !== 200) throw new Error("网易评论: code " + (r && r.code));

  const seen = {};
  const out = [];
  const push = (c) => {
    const it = neCommentItem(c);
    if (!it.comment) return;             // 空内容（已删除）跳过
    if (it.id && seen[it.id]) return;
    if (it.id) seen[it.id] = 1;
    out.push(it);
  };
  /* 第一页把热评顶上去。热评和普通流有重合，靠 id 去重
     （实测 15 条热评里只有 1 条出现在前 20 条普通流里）。 */
  if (hotFirst) (r.hotComments || []).forEach(push);
  (r.comments || []).forEach(push);

  const total = Number(r.total || 0);
  const v = {
    isEnd: offset + NE_COMMENT_PAGE >= total || !(r.more || r.comments && r.comments.length),
    data: out,
  };
  NE_COMMENT_CACHE[ck] = { at: Date.now(), v: v };
  return v;
}

/* ---------------- YouTube ---------------- */
const YT_WEB = { clientName: "WEB", clientVersion: "2.20240101.00.00", hl: "zh-CN", gl: "US" };
const YT_WEB_UA = UA;
const YT_COMMENT_TTL = 10 * 60 * 1000;
/* 存的是「下一条链」：第一页的 token 要从 watch 页现找，
   之后每页的 token 靠上一页响应带回来 —— 所以缓存里同时存 token。 */
const YT_COMMENT_CACHE = {};

function ytWebCtx() {
  return { client: YT_WEB };
}

async function ytNext(continuation) {
  const r = await axios_1.post(
    "https://www.youtube.com/youtubei/v1/next?prettyPrint=false",
    JSON.stringify({ context: ytWebCtx(), continuation: continuation }),
    { timeout: 25000, headers: { "User-Agent": YT_WEB_UA, "Content-Type": "application/json" }, validateStatus: () => true }
  );
  return r.data || {};
}

/** 从响应里捞所有评论实体（它们躺在 frameworkUpdates 的 mutations 里） */
function ytCollectComments(data) {
  const out = [];
  const fu = data && data.frameworkUpdates;
  const muts = (fu && fu.entityBatchUpdate && fu.entityBatchUpdate.mutations) || [];
  muts.forEach((m) => {
    const p = m && m.payload && m.payload.commentEntityPayload;
    if (!p) return;
    const pr = p.properties || {};
    const au = p.author || {};
    const tb = p.toolbar || {};
    const likeText = tb.likeCountNotliked || tb.likeCountLiked || "";
    out.push({
      id: String(pr.commentId || ""),
      nickName: au.displayName || "YouTube 用户",
      avatar: au.avatarThumbnailUrl || "",
      comment: String((pr.content && pr.content.content) || ""),
      /* YouTube 只给「10万」这种约数，不是精确数，能转就转 */
      like: ytCountToNum(likeText),
      createAt: 0,
      location: "",
      _time: pr.publishedTime || "",
    });
  });
  return out;
}

/** 「10万」/「1.2K」/「1,234」→ 数字。转不出来就 0（宁可显 0，不显示 NaN） */
function ytCountToNum(s) {
  const t = String(s || "").replace(/,/g, "").trim();
  if (!t) return 0;
  const m = t.match(/^([\d.]+)\s*([万亿KkMm]?)/);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!isFinite(n)) return 0;
  const unit = m[2];
  const mul = unit === "万" ? 10000 : unit === "亿" ? 1e8
    : /[Kk]/.test(unit) ? 1000 : /[Mm]/.test(unit) ? 1e6 : 1;
  return Math.round(n * mul);
}

/** 下一段 continuation token。只认评论区那个 target，
    否则会挑到「相关视频」的 token，翻出来全是别的视频。 */
function ytNextToken(data) {
  const eps = (data && data.onResponseReceivedEndpoints) || [];
  for (let i = 0; i < eps.length; i++) {
    const rc = eps[i] && eps[i].reloadContinuationItemsCommand;
    if (!rc || rc.targetId !== "engagement-panel-comments-section") continue;
    const cs = rc.continuationItems || [];
    for (let j = cs.length - 1; j >= 0; j--) {
      const t = cs[j] && cs[j].continuationItemRenderer;
      const cm = t && t.continuationEndpoint && t.continuationEndpoint.continuationCommand;
      if (cm && cm.token) return cm.token;
    }
  }
  return null;
}

/** 拉 YouTube 某视频的评论。page 1 现找入口，之后顺着 token 走 */
async function youtubeComments(videoId, page) {
  const p = Number(page) > 0 ? Number(page) : 1;
  const ck = "yt|" + videoId + "|" + p;
  const hit = YT_COMMENT_CACHE[ck];
  if (hit && Date.now() - hit.at < YT_COMMENT_TTL) return hit.v;

  let token = null;
  if (p === 1) {
    /* 第一页：评论区的入口 token 只在 watch 页的 ytInitialData 里。
       直接打 /next 拿不到（ANDROID client 直接 400，WEB 的响应里也没有），
       这个坑踩过，别改成纯 API 调用。 */
    const r = await axios_1.get(
      "https://www.youtube.com/watch?v=" + encodeURIComponent(videoId) + "&hl=zh-CN",
      { timeout: 30000, headers: { "User-Agent": YT_WEB_UA }, validateStatus: () => true }
    );
    const html = String(r.data || "");
    const m = html.match(/ytInitialData\s*=\s*(\{.+?\});/s);
    if (!m) throw new Error("yt: 无 ytInitialData");
    const init = JSON.parse(m[1]);
    (function walk(o) {
      if (!o || typeof o !== "object" || token) return;
      if (Array.isArray(o)) { o.forEach(walk); return; }
      const sec = o.itemSectionRenderer;
      if (sec && sec.sectionIdentifier === "comment-item-section") {
        const mm = JSON.stringify(sec).match(/"token":"([^"]+)"/);
        if (mm) token = mm[1];
        return;
      }
      for (const k of Object.keys(o)) walk(o[k]);
    })(init);
    if (!token) throw new Error("yt: 该视频没有评论区");
  } else {
    const prev = YT_COMMENT_CACHE["yt|" + videoId + "|" + (p - 1)];
    token = prev && prev.next;
    if (!token) throw new Error("yt: 翻页令牌丢失，请重新打开");
  }

  const data = await ytNext(token);
  const list = ytCollectComments(data).filter((c) => c.comment);
  const next = ytNextToken(data);

  const v = {
    isEnd: !next,
    data: list.map((c) => {
      delete c._time;
      return c;
    }),
  };
  YT_COMMENT_CACHE[ck] = { at: Date.now(), v: v, next: next };
  return v;
}

/* ---------------- Bilibili ---------------- */
/* 完全匿名可用（实测 BV1GJ411x7h7 有 23.7 万条）。
   ⚠️ oid 可以直接传 bvid（实测 code 0），不用先转 aid —— 少一次请求。
   sort=1 是按热度，评论区第一屏就是精华。 */
const BILI_REPLY_API = "https://api.bilibili.com/x/v2/reply";
const BILI_COMMENT_TTL = 10 * 60 * 1000;
const BILI_COMMENT_CACHE = {};
const BILI_COMMENT_PAGE = 20;

function biliCommentItem(r) {
  const m = r.member || {};
  const ct = r.content || {};
  return {
    id: String(r.rpid_str || r.rpid || ""),
    nickName: m.uname || "B站用户",
    avatar: m.avatar || "",
    comment: String(ct.message || ""),
    like: Number(r.like || 0),
    createAt: Number(r.ctime || 0) * 1000,      // B站给秒，统一成毫秒
    location: "",
    /* B站第一屏就带 3 条楼中楼。只挂这一层，不递归 —— 深翻会变成
       一个视频打好几十次请求，评论区不该这么用。 */
    replies: (r.replies || []).filter((x) => x && x.content && x.content.message).map(biliCommentItem),
  };
}

async function bilibiliComments(bvid, page) {
  const p = Number(page) > 0 ? Number(page) : 1;
  const ck = "bili|" + bvid + "|" + p;
  const hit = BILI_COMMENT_CACHE[ck];
  if (hit && Date.now() - hit.at < BILI_COMMENT_TTL) return hit.v;

  const r = await axios_1.get(BILI_REPLY_API, {
    params: { type: 1, oid: bvid, pn: p, ps: BILI_COMMENT_PAGE, sort: 1 },
    timeout: 20000, headers: biliHeaders(), validateStatus: () => true,
  });
  const d = r.data || {};
  if (d.code !== 0) throw new Error("bili reply: " + d.code + " " + (d.message || ""));
  const box = d.data || {};
  const list = (box.replies || []).map(biliCommentItem).filter((c) => c.comment);
  const count = Number((box.page && box.page.count) || 0);

  const v = {
    isEnd: !list.length || (count > 0 && p * BILI_COMMENT_PAGE >= count),
    data: list,
  };
  BILI_COMMENT_CACHE[ck] = { at: Date.now(), v: v };
  return v;
}

/* ---------------- 跨平台：反查网易同一首 ---------------- */

/** 反查缓存。key 是「歌名|主歌手」。命中过一次就记住那个网易 id。 */
const NE_LOOKUP_TTL = 6 * 60 * 60 * 1000;
const NE_LOOKUP_CACHE = {};

/**
 * 评论反查专用的宽松匹配：标题照旧严格，歌手放宽成「整串互相包含」。
 *
 * 只放宽歌手、不放宽标题，是因为歌手名在跨平台之间本来就写法各异
 * （冯沁苑(买辣椒也用券) / 买辣椒也用券 / 买辣椒），
 * 而标题一旦放宽，翻唱和 remix 立刻就会混进来。
 */
function sameSongLooseArtist(it, want) {
  /* 标题规则原样复用：先挡听书、分集编号，再比对核心字符 */
  const rawTitle = it.title || "";
  if (!want.name || !rawTitle) return false;
  if (isAudiobookTitle(rawTitle)) return false;
  if (EPISODE_RE.test(rawTitle)) return false;
  const t = coreTitle(toSimplified(rawTitle));
  const q = coreTitle(toSimplified(want.name));
  if (!t || !q) return false;
  if (!(t === q || t.indexOf(q) >= 0 || q.indexOf(t) >= 0)) return false;

  /* 歌手：拿**未经 normText 的原始串**比包含关系。
     ⚠️ normText 也会剥括号，所以这里不能用它 ——
        「冯沁苑(买辣椒也用券)」被它变成「冯沁苑」，别名又丢一次。
     所以只做最轻的清洗：去空白、统一大小写、全角括号转半角。 */
  const clean = (x) => String(x || "")
    .replace(/（/g, "(").replace(/）/g, ")")
    .replace(/\s+/g, "").toLowerCase();
  const a = clean(it.artist);
  const s = clean(splitSingers(want.singer)[0] || "");
  if (!a || !s) return false;
  return a.indexOf(s) >= 0 || s.indexOf(a) >= 0;
}

/**
 * 在网易搜到「和这首同一首歌」，拿它的 songId。
 *
 * 为什么要反查：QQ / 酷狗 / 咪咕 / 酷我 / B站 都没有公开评论接口，
 * 但同一首歌在网易云基本都有条目，评论跟着歌走才对。
 * 匹配沿用 isDefinitelySameSong（为「兜底」写的严格版）—— 这里宁可找不到，
 * 也不能把《稻香》的评论挂到《稻香(深情版)》上。
 * 但它有个对评论场景不合适的硬伤：核心标题会剔掉括号，歌手只认第一个。
 *   《起风了》原唱在网易写作「冯沁苑(买辣椒也用券)」，coreTitle 剩下「冯沁苑」，
 *   而 QQ 那边歌手是「买辣椒也用券」，两边一对，直接判不通过 ——
 *   明明就是同一首。所以这里额外补一条「整串包含」的歌手判定，
 *   标题仍然走严格规则，不会放过翻唱。
 */
async function neteaseIdFor(musicItem) {
  const want = {
    name: musicItem.title || "",
    singer: musicItem.artist || "",
  };
  if (!want.name) return null;
  const key = normText(toSimplified(want.name)) + "|" + normText(splitSingers(want.singer)[0] || "");
  const hit = NE_LOOKUP_CACHE[key];
  if (hit && Date.now() - hit.at < NE_LOOKUP_TTL) return hit.v;

  let found = null;
  /* ⚠️ 必须用 cloudsearch，不能用 COCO / search/get/web。
     实测同一首歌：
       cloudsearch  「起风了 买辣椒也用券」→ 第 1 条就是正版
       COCO / web   「起风了 买辣椒也用券」→ 全是 remix 和翻唱，正版被挤没了
     cloudsearch 是网易搜索接口里召回最全的一个，而且匿名可用（要带 appver 才不返回空）。 */
  try {
    const r = await httpGet("https://music.163.com/api/cloudsearch/pc",
      { s: (want.name + " " + (splitSingers(want.singer)[0] || "")).trim(), type: 1, limit: 30, offset: 0 },
      Object.assign({ Cookie: "appver=2.0.2" }, NETEASE_HEADERS));
    const songs = ((r && r.result && r.result.songs) || []);
    /* 不取「第一个通过的就走」—— 搜索结果里 (Acoustic) / (治愈版) / (Live)
       这类同歌手变体会排在同一首正版前面，先到先得就会挂错评论。
       改成给每条打分，最后取分最高的那个：
         3 分：通过严格匹配，且标题一字不差（最理想，通常就是正版）
         2 分：通过严格匹配
         1 分：只有歌手宽松匹配（标题剥掉括号后才对得上）
       同分保留排在前面的（搜索相关度天然有序）。 */
    let best = 0;
    for (let i = 0; i < songs.length; i++) {
      const s = songs[i];
      const it = {
        id: String(s.id || ""),
        title: s.name || "",
        artist: ((s.ar || []).map((a) => a.name).join("/")) || "",
      };
      let score = 0;
      if (isDefinitelySameSong(it, want)) {
        score = coreTitle(toSimplified(it.title)) === coreTitle(toSimplified(want.name)) &&
                String(it.title).replace(/\s+/g, "") === String(want.name).replace(/\s+/g, "") ? 3 : 2;
      } else if (sameSongLooseArtist(it, want)) {
        score = 1;
      }
      if (score > best) { best = score; found = it.id; }
      if (best === 3) break;   // 再高也就 3 分，提前收工
    }
  } catch (e) { /* 查不到就认栽，返回空列表 */ }

  NE_LOOKUP_CACHE[key] = { at: Date.now(), v: found };
  return found;
}

/** 主入口：按平台分发 */
async function musicComments(musicItem, page) {
  if (!musicItem) return { isEnd: true, data: [] };
  const provider = musicItem._provider || "";

  if (provider === "youtube") {
    try {
      return await youtubeComments(String(musicItem.id || ""), page);
    } catch (e) {
      console.log("[粽子] YouTube 评论失败: " + e.message);
      return { isEnd: true, data: [] };
    }
  }

  /* B站自己有完整评论区，别绕去网易 —— 它那边往往是原视频，
     评论比网易的歌曲页面还热闹（一首歌 20 多万条很常见）。 */
  if (provider === "bilibili") {
    try {
      return await bilibiliComments(String(musicItem.id || ""), page);
    } catch (e) {
      console.log("[粽子] Bilibili 评论失败: " + e.message);
      /* 拿不到就退到网易反查，别直接给空 */
    }
  }

  /* 网易系（含从网易搜到的歌）直接查 */
  if (provider === "netease") {
    try {
      return await neteaseComments(String(musicItem.id || ""), page, Number(page) <= 1);
    } catch (e) {
      console.log("[粽子] 网易评论失败: " + e.message);
      return { isEnd: true, data: [] };
    }
  }

  /* 其他平台：先反查网易同一首。
     ⚠️ 反查只在第一页做，之后从缓存拿 —— 否则每次翻页都多打一次搜索。 */
  try {
    const neId = await neteaseIdFor(musicItem);
    if (!neId) return { isEnd: true, data: [] };
    return await neteaseComments(neId, page, Number(page) <= 1);
  } catch (e) {
    console.log("[粽子] 跨平台评论失败: " + e.message);
    return { isEnd: true, data: [] };
  }
}

/* ============================================================
 * Apple Music 榜单（官方 Marketing Tools 公开接口）
 *
 * https://rss.applemarketingtools.com/api/v2/<区>/music/most-played/100/songs.json
 *
 * 为什么值得接进来：不用登录、不用 key、不是逆向，是苹果自己给
 * 「营销工具」用的公开 feed。字段有歌名 / 歌手 / 封面 / 发行日期 /
 * 专辑 id / 歌曲 id，一次 100 首。缺点是不给时长和专辑名 ——
 * 这两样用一次 itunes lookup 批量补（100 个 id 一次给全，约 1 秒）。
 *
 * ⚠️ 实测延迟不稳定：cn 3~5s、us 有时 20s 超时、tw/de 偶尔 502。
 *    所以榜单入口**不预拉数据**，只放静态的地区条目，点进去才请求 ——
 *    否则「榜单」页每次打开都要等好几秒，体验还不如不做。
 *    拉到的结果缓存 30 分钟，反复进出不重复打苹果。
 * ============================================================ */
const APPLE_CHART_BASE = "https://rss.applemarketingtools.com/api/v2";

/** 参与的地区。只挑华语用户真的会看的，全上会让榜单页太长 */
const APPLE_CHART_REGIONS = [
  ["cn", "中国"], ["hk", "香港"], ["tw", "台灣"], ["jp", "日本"],
  ["kr", "韩国"], ["us", "美国"], ["gb", "英国"], ["sg", "新加坡"],
];

/** 专辑榜 / 歌单榜只做这三个区（再多就是摆设了） */
const APPLE_CHART_ALBUM_REGIONS = [["cn", "中国"], ["us", "美国"], ["jp", "日本"]];

const APPLE_CHART_CACHE = {};
const APPLE_CHART_TTL = 30 * 60 * 1000;

function shouldUseAppleChart() {
  try {
    const vars = (typeof env !== "undefined" && env && env.userVariables) || {};
    const v = vars.useAppleChart;
    if (v === undefined || v === null || v === "") return true;
    return !(v === "0" || v === "false" || v === "off");
  } catch (e) { return true; }
}

/** 带重试的 Apple 榜单请求。单次 8s，失败再来一次 —— 苹果这边超时是常态 */
async function appleChartRaw(cc, kind, limit) {
  const ck = cc + ":" + kind + ":" + limit;
  const hit = APPLE_CHART_CACHE[ck];
  if (hit && Date.now() - hit.at < APPLE_CHART_TTL) return hit.v;

  const url = APPLE_CHART_BASE + "/" + cc + "/music/most-played/" + limit + "/" + kind + ".json";
  let out = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await axios_1.get(url, {
        timeout: 8000,
        headers: { "User-Agent": UA },
        validateStatus: () => true,
      });
      if (r && r.status === 200 && r.data && r.data.feed) { out = r.data.feed; break; }
    } catch (e) { /* 换一次重试 */ }
  }
  if (out) APPLE_CHART_CACHE[ck] = { at: Date.now(), v: out };
  return out;
}

/** 批量补时长 + 专辑名。查不到就算了，不影响列表出来 */
async function appleChartMeta(cc, ids) {
  const meta = {};
  if (!ids || !ids.length) return meta;
  try {
    const r = await axios_1.get("https://itunes.apple.com/lookup", {
      params: { id: ids.join(","), country: cc, entity: "song", limit: 200 },
      timeout: 10000,
      headers: { "User-Agent": UA },
      validateStatus: () => true,
    });
    const res = (r && r.data && r.data.results) || [];
    for (let i = 0; i < res.length; i++) {
      const x = res[i];
      if (x && x.kind === "song" && x.trackId) meta[String(x.trackId)] = x;
    }
  } catch (e) { /* 用榜单自带字段顶上 */ }
  return meta;
}

/** 热门歌曲榜 → 可播放列表 */
async function appleChartSongList(cc, limit) {
  const feed = await appleChartRaw(cc, "songs", limit);
  const list = (feed && feed.results) || [];
  if (!list.length) return [];
  const meta = await appleChartMeta(cc, list.map((x) => x.id));
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const x = list[i] || {};
    const m = meta[String(x.id)] || {};
    if (!x.name) continue;
    out.push({
      id: "apsong:" + cc + ":" + x.id,
      platform: "Apple Music",
      title: x.name,
      artist: x.artistName || "",
      album: m.collectionName || "",
      artwork: String(x.artworkUrl100 || "").replace("100x100", "600x600"),
      duration: Number(m.trackTimeMillis || 0),
      _provider: "apple",
    });
  }
  return out;
}

/* ---------- Apple 网页结构（专辑 / 歌单的曲目表） ----------
 *
 * itunes lookup 对**一部分**专辑直接返回 0 首（实测《太阳之子》
 * 五个区都查不到曲目，而专辑页明明有 13 首）；对歌单更是根本不支持
 * （pl.xxx 传进 lookup 直接 400）。所以曲目表改从网页里读：
 * music.apple.com 的页面内嵌一段 <script id="serialized-server-data">，
 * 里面是完整 JSON，曲目在 itemKind 为 trackLockup 的 section 里，
 * 带标题 / 时长 / 歌手 / 专辑 / 封面 / 歌曲 id。实测专辑 13 首、
 * 歌单 98 首全部完整，一次请求 2 秒。
 */
async function applePageData(cc, kind, pageId) {
  const url = "https://music.apple.com/" + cc + "/" + kind + "/" + pageId;
  try {
    const r = await axios_1.get(url, {
      timeout: 12000,
      headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9" },
      validateStatus: () => true,
      responseType: "text",
    });
    if (!r || r.status !== 200) return null;
    const m = String(r.data).match(/<script[^>]*id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return null;
    return JSON.parse(m[1]);
  } catch (e) {
    console.log("[粽子] Apple 页面解析失败: " + e.message);
    return null;
  }
}

/** Apple 的封面 url 带 {w}x{h} 占位符，换成实际尺寸 */
function appleArtUrl(it) {
  const d = (it && it.artwork && it.artwork.dictionary) || {};
  const u = String(d.url || "");
  if (!u) return "";
  return u.replace("{w}", "600").replace("{h}", "600").replace("{f}", "jpg");
}

/** 从页面 JSON 里把曲目捞出来（专辑页和歌单页结构一致） */
function applePageTracks(json) {
  const page = (json && json.data && json.data[0] && json.data[0].data) || {};
  const secs = page.sections || [];
  const out = [];
  let pageTitle = "";
  let pageArtist = "";
  let pageArt = "";
  for (let s = 0; s < secs.length; s++) {
    const sec = secs[s] || {};
    const items = sec.items || [];
    if (!pageTitle && sec.itemKind === "containerDetailHeaderLockup" && items.length) {
      const h = items[0] || {};
      pageTitle = h.title || pageTitle;
      pageArtist = ((h.subtitleLinks || [])[0] || {}).title || pageArtist;
      pageArt = appleArtUrl(h);
    }
    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      const tid = String(it.id || "");
      if (tid.indexOf("track-lockup") < 0) continue;
      if (!it.title) continue;
      const parts = tid.split(" - ");
      out.push({
        songId: parts.length >= 3 ? parts[parts.length - 1] : "",
        name: it.title,
        artist: ((it.subtitleLinks || [])[0] || {}).title || "",
        album: ((it.tertiaryLinks || [])[0] || {}).title || "",
        dur: Number(it.duration || 0),
        artwork: appleArtUrl(it),
      });
    }
  }
  return { title: pageTitle, artist: pageArtist, artwork: pageArt, tracks: out };
}

/** 榜单入口。
 *  歌曲榜是静态条目（8 个地区各 100 首），点进去才联网；
 *  专辑榜 / 歌单榜必须**展开成一条一条的条目** ——
 *  MusicFree 的「榜单详情」页是按歌曲列表渲染的，返回专辑条目会被
 *  当成歌去播放，所以不能把 50 张专辑塞进一个详情页里。
 *  代价是打开榜单页时要多拉 2 个 chart（中国区专辑 + 歌单），
 *  实测 1~3 秒，都有 30 分钟缓存，不重复请求。
 */
async function appleChartEntries() {
  const groups = [];

  const songs = [];
  for (let i = 0; i < APPLE_CHART_REGIONS.length; i++) {
    const cc = APPLE_CHART_REGIONS[i][0];
    const name = APPLE_CHART_REGIONS[i][1];
    songs.push({
      id: "apchart:" + cc + ":songs",
      platform: "Apple Music",
      title: "Apple " + name + " · 热门歌曲 100",
      artist: "Apple Music 官方榜",
      artwork: "",
      worksNum: 100,
      description: "每日更新 · 该地区播放量最高",
      _provider: "apple",
    });
  }
  groups.push({ title: "Apple Music 热门歌曲", data: songs });

  /* 专辑 / 歌单只展开中国区：再多个区，榜单页会长到要滚好几屏，
     而且这几个 chart 是打开页面就得等的，多了会明显变慢。 */
  const cc = "cn";
  const feeds = await Promise.all([
    appleChartRaw(cc, "albums", 50).catch(() => null),
    appleChartRaw(cc, "playlists", 50).catch(() => null),
  ]);
  const albumsFeed = feeds[0];
  const plsFeed = feeds[1];

  const albums = ((albumsFeed && albumsFeed.results) || []).filter((x) => x && x.name).slice(0, 12);
  if (albums.length) {
    groups.push({
      title: "Apple Music 热门专辑（中国）",
      data: albums.map((x) => ({
        id: "apalbum:" + cc + ":" + x.id,
        platform: "Apple Music",
        title: x.name,
        artist: x.artistName || "",
        artwork: String(x.artworkUrl100 || "").replace("100x100", "600x600"),
        worksNum: 0,
        description: x.releaseDate || "",
        _provider: "apple",
      })),
    });
  }

  const pls = ((plsFeed && plsFeed.results) || []).filter((x) => x && x.name).slice(0, 12);
  if (pls.length) {
    groups.push({
      title: "Apple Music 热门歌单（中国）",
      data: pls.map((x) => ({
        id: "applaylist:" + cc + ":" + x.id,
        platform: "Apple Music",
        title: x.name,
        artist: "Apple Music 编辑精选",
        artwork: String(x.artworkUrl100 || "").replace("100x100", "600x600"),
        worksNum: 0,
        description: "",
        _provider: "apple",
      })),
    });
  }
  return groups;
}

/** 榜单详情：MusicFree 的详情页就是「歌曲列表」，所以三类都归一到歌曲 */
async function appleChartDetail(topListItem) {
  const id = String((topListItem && topListItem.id) || "");

  // 各地区歌曲榜
  if (id.indexOf("apchart:") === 0) {
    const parts = id.split(":");
    const musicList = await appleChartSongList(parts[1] || "cn", 100);
    return { isEnd: true, musicList: musicList };
  }

  // 专辑 → 曲目（读专辑网页：itunes lookup 对一部分专辑返回 0 首）
  if (id.indexOf("apalbum:") === 0) {
    const parts = id.split(":");
    const json = await applePageData(parts[1] || "cn", "album", parts[2] || "");
    const parsed = applePageTracks(json);
    const tracks = parsed.tracks || [];
    return {
      isEnd: true,
      musicList: tracks.length
        ? await appleTracksToPlayable(tracks, parsed.artist, parsed.artwork, parsed.title)
        : [],
    };
  }

  // 歌单 → 曲目
  if (id.indexOf("applaylist:") === 0) {
    const parts = id.split(":");
    const json = await applePageData(parts[1] || "cn", "playlist", parts[2] || "");
    const parsed = applePageTracks(json);
    const tracks = parsed.tracks || [];
    return {
      isEnd: true,
      musicList: tracks.length
        ? await appleTracksToPlayable(tracks, parsed.artist, parsed.artwork, parsed.title)
        : [],
    };
  }

  return { isEnd: true, musicList: [] };
}


/* ---------- Apple 曲目表 → 可播放条目 ----------
 * Apple 的页面里只有元数据，音频还得靠跨平台兜底（_provider: "apple"，
 * 走 resolveMediaSource 的兜底链路）。和「Apple 目录占位专辑」那段一样，
 * 先用 YouTube 找一遍 —— 找到了直接标 YouTube，播放时省一次兜底搜索。
 * 并发 4 路，13 首大约 3 秒；串行要十几秒，点进去像卡死了。
 */
async function appleTracksToPlayable(tracks, artist, artwork, albumTitle, preLimit) {
  const out = new Array(tracks.length);
  /* 预搜只做前 preLimit 首。98 首的歌单要是每首都去 YouTube 搜一遍，
     实测点进去要等 14 秒 —— 用户眼里就是卡死。
     没预搜的条目照样 _provider: "apple"，播放时才走跨平台兜底，
     点哪首等哪首，比整个列表一起等 14 秒好得多。 */
  const limit = Math.min(tracks.length, Number(preLimit || 40));
  let idx = 0;
  const worker = async () => {
    while (idx < limit) {
      const i = idx++;
      const t = tracks[i];
      let ytHit = null;
      try {
        const list = await ytSearchRaw(t.name + " " + (t.artist || artist || ""));
        const tn = normTextZ(t.name);
        if (tn) {
          let best = null, bestSc = -Infinity;
          for (let j = 0; j < (list || []).length; j++) {
            const y = list[j];
            const yn = normTextZ(y.title || "");
            if (!yn || yn.indexOf(tn) < 0) continue;
            let sc = 0;
            if (/[-–—]\s*Topic$/i.test(String(y.artist || ""))) sc += 60;
            if (yn === tn) sc += 40;
            else sc -= (yn.length - tn.length);
            const sec = ytDurSec(y.durationText);
            if (sec > 0 && t.dur > 0) {
              const d = Math.abs(sec - Math.round(t.dur / 1000));
              sc += d <= 12 ? 30 : (d <= 40 ? 5 : -80);
            }
            if (/live|現場|现场|演唱會|演唱会|翻唱|cover|remix|伴奏|純享|纯享/i.test(y.title || "")) sc -= 50;
            if (sc > bestSc) { bestSc = sc; best = y; }
          }
          if (best && bestSc > -60) ytHit = best;
        }
      } catch (e) { /* 单首失败不影响别的 */ }

      const ySec = ytHit ? ytDurSec(ytHit.durationText) : 0;
      out[i] = {
        id: ytHit ? String(ytHit.id) : "",
        platform: ytHit ? "YouTube" : "Apple Music",
        title: t.name,
        artist: t.artist || artist || "",
        album: t.album || albumTitle || "",
        artwork: t.artwork || artwork || "",
        duration: ySec > 0 ? ySec * 1000 : Number(t.dur || 0),
        _provider: ytHit ? "youtube" : "apple",
      };
    }
  };
  const n = Math.min(6, Math.max(1, limit));
  const ws = [];
  for (let k = 0; k < n; k++) ws.push(worker());
  await Promise.all(ws);
  /* 没预搜到的尾部条目也要成型（否则数组里有空洞，列表会少歌） */
  for (let i = 0; i < tracks.length; i++) {
    if (out[i]) continue;
    const t = tracks[i];
    out[i] = {
      id: "",
      platform: "Apple Music",
      title: t.name,
      artist: t.artist || artist || "",
      album: t.album || albumTitle || "",
      artwork: t.artwork || artwork || "",
      duration: Number(t.dur || 0),
      _provider: "apple",
    };
  }
  return out;
}

/* ---------- 专辑详情 ---------- */
async function getAlbumDetail(albumItem, page) {
  const id = albumItem && albumItem.id;
  if (!id) return null;

  /* MusicBrainz 专辑（mbal:<release-group-id>）—— MB 没有音频，
     曲目表照 MB 给，每首再去 YouTube 找官方音源（跟 Apple 占位那条同一个套路）。
     ⚠️ 曲目一律从 MB 目录缓存里取，不信条目自带的 _tracks：
        列表可能被用户刷新/缓存过，_tracks 会丢。 */
  if (albumItem._provider === "mb" || String(id).indexOf("mbal:") === 0) {
    const albumTitle = String(albumItem.title || "");
    const albumN = normAlbumName(albumTitle);
    const artistName = String(albumItem.artist || "");
    let cat = null;
    try { cat = await mbArtistCatalog(artistName); } catch (e) { cat = null; }
    let mbAlb = null;
    if (cat) {
      for (let i = 0; i < cat.albums.length; i++) {
        if (normAlbumName(cat.albums[i].title || "") === albumN) { mbAlb = cat.albums[i]; break; }
      }
    }
    if (!mbAlb || !(mbAlb._tracks || []).length) return null;

    const tracks = mbAlb._tracks.slice().sort(function (a, b) {
      return Number(a.no || 0) - Number(b.no || 0);
    });
    /* 逐首去 YouTube 找官方音源。MB 的时长（毫秒）正好用来卡时长差，
       这对压掉「翻唱 / 现场 / 加速版」特别有效 —— MB 的时长是权威的。 */
    const musicList = [];
    const CONC = 6;
    for (let i = 0; i < tracks.length; i += CONC) {
      const batch = tracks.slice(i, i + CONC);
      const parts = await Promise.all(batch.map(async function (t) {
        const tn = normTextZ(t.title);
        const tBare = tn.replace(/[.,!?;:'"·、。，！？；：…—–\-]/g, "");
        let list = [];
        try { list = await ytSearchRaw(t.title + " " + artistName); } catch (e) { return null; }
        let best = null, bestSc = -Infinity;
        for (let j = 0; j < (list || []).length; j++) {
          const y = list[j];
          const yn = normTextZ(y.title || "");
          if (!yn) continue;
          const yBare = yn.replace(/[.,!?;:'"·、。，！？；：…—–\-]/g, "");
          const hitTitle = yn.indexOf(tn) >= 0 || tn.indexOf(yn) >= 0 ||
            (tBare && yBare.indexOf(tBare) >= 0) ||
            (tBare && tBare.indexOf(yBare) >= 0 && yBare.length >= 2);
          if (!hitTitle) continue;
          let sc = 0;
          if (/[-–—]\s*Topic$/i.test(String(y.artist || ""))) sc += 100;
          if (yn === tn) sc += 40;
          else if (yBare === tBare) sc += 30;
          else sc -= Math.max(0, yn.length - tn.length);
          if (/歌词|歌詞|lyrics|翻唱|cover|remix|dj|伴奏|純享|纯享|live|現場|现场|演唱[会會]/i.test(y.title || "")) sc -= 60;
          const sec = ytDurSec(y.durationText);
          if (sec > 0 && t.duration > 0) {
            const dd = Math.abs(sec - Math.round(t.duration / 1000));
            sc += dd <= 12 ? 45 : (dd <= 40 ? 5 : -100);
          }
          if (sc > bestSc) { bestSc = sc; best = y; }
        }
        if (!best || bestSc <= 0) return null;
        return best;
      }));
      for (let j = 0; j < batch.length; j++) {
        const t = batch[j];
        const y = parts[j];
        musicList.push({
          id: y ? String(y.id) : "",
          platform: y ? "YouTube" : "MusicBrainz",
          title: t.title,
          artist: artistName,
          album: albumTitle,
          artwork: (y && y.artwork) || albumItem.artwork || "",
          duration: y && ytDurSec(y.durationText) > 0
            ? ytDurSec(y.durationText) * 1000 : Number(t.duration || 0),
          _provider: y ? "youtube" : "mb",
        });
      }
    }
    return {
      isEnd: true,
      albumItem: {
        id: String(id),
        platform: "MusicBrainz",
        title: albumTitle,
        artist: artistName,
        artwork: albumItem.artwork || "",
        date: albumItem.date || "",
        description: albumItem.description || "",
        worksNum: musicList.length || Number(albumItem.worksNum || 0),
      },
      musicList: musicList,
    };
  }

  /* YouTube Music 专辑（ytmal:MPREb_xxx）—— 曲目直接读 YTM 专辑页。
     YTM 返回的是 ATV 官方音轨，取流走的是同一个 videoId，能直接播。 */
  if (String(id).indexOf("ytmal:") === 0) {
    const mid = String(id).slice(6);
    if (!mid) return null;
    try {
      const tr = await ytmAlbumTracks(mid, albumItem.artist || "", albumItem.title || "");
      if (!tr.length) return null;
      return {
        isEnd: true,
        albumItem: {
          id: String(id),
          platform: "YouTube",
          title: albumItem.title || "",
          artist: albumItem.artist || "",
          artwork: (tr[0] && tr[0].artwork) || albumItem.artwork || "",
          date: albumItem.date || "",
          description: "",
          worksNum: tr.length,
        },
        musicList: tr,
      };
    } catch (e) { return null; }
  }

  /* Apple Music 目录占位专辑：平台没这张唱片，但用户点了得有东西看。
     曲目表从 Apple 的歌手目录里按专辑名捞，再用 YouTube 找可播放的音频 ——
     找到了就能听，找不到至少知道这张专辑有哪几首。 */
  /* Apple 榜单里的专辑（apalbum:<区>:<专辑id>）：曲目直接读专辑页，
     因为 itunes lookup 对一部分专辑返回 0 首（实测《太阳之子》五个区全空）。 */
  /* QQ 专辑（qqal:<albumMid>）—— 曲目用 fcg_v8_album_info_cp，
     实测一次就回整张（《叶惠美》11 首，含 interval），不用翻页。 */
  if (String(id).indexOf("qqal:") === 0) {
    const mid = String(id).slice(5);
    if (!mid) return null;
    try {
      const r = await axios_1.get("https://c.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg", {
        params: { albummid: mid, format: "json", g_tk: 1, platform: "yqq.json", needNewCode: 0 },
        timeout: 15000,
        headers: { "User-Agent": UA, Referer: "https://y.qq.com/" },
        validateStatus: () => true,
      });
      const d = (r.data && r.data.data) || {};
      const list = d.list || [];
      if (!list.length) return null;
      const musicList = list.map((x) => ({
        id: String(x.songmid || ""),
        platform: "QQ音乐",
        title: x.songname || "",
        artist: ((x.singer || []).map((s) => s.name).join("/")) || d.singername || "",
        album: x.albumname || d.name || "",
        artwork: x.albummid ? "https://y.gtimg.cn/music/photo_new/T002R300x300M000" + x.albummid + ".jpg" : "",
        duration: Number(x.interval || 0) * 1000,
        _provider: "qq",
      })).filter((x) => x.id && x.title);
      return {
        isEnd: true,
        albumItem: {
          id: String(id),
          platform: "QQ音乐",
          title: d.name || albumItem.title || "",
          artist: d.singername || albumItem.artist || "",
          artwork: musicList[0] && musicList[0].artwork || albumItem.artwork || "",
          date: String(d.aDate || "").slice(0, 10) || albumItem.date || "",
          description: String(d.desc || ""),
          worksNum: musicList.length,
        },
        musicList: musicList,
      };
    } catch (e) { return null; }
  }


  /* 网易云专辑（id 是纯数字）。⚠️ 用 /api/v1/album/，
     老的 /api/album/ 返回 200 但 album 是 undefined（实测 2026-10-20）。 */
  if (albumItem._provider === "netease" && /^d+$/.test(String(id))) {
    try {
      const r = await axios_1.get("https://music.163.com/api/v1/album/" + encodeURIComponent(String(id)), {
        timeout: 15000,
        headers: NETEASE_HEADERS,
        validateStatus: () => true,
      });
      const d = r.data || {};
      const al = d.album || {};
      const songs = d.songs || [];
      if (!songs.length) return null;
      const musicList = songs.map((t) => ({
        id: String(t.id || ""),
        platform: "网易云",
        title: t.name || "",
        artist: ((t.ar || t.artists || []).map((a) => a.name).join("/")) || "",
        album: (t.al && t.al.name) || al.name || "",
        artwork: (t.al && t.al.picUrl) || al.picUrl || "",
        duration: Number(t.dt || t.duration || 0),
        _provider: "netease",
      })).filter((x) => x.id && x.title);
      return {
        isEnd: true,
        albumItem: {
          id: String(id),
          platform: "网易云",
          title: al.name || albumItem.title || "",
          artist: ((al.artists || []).map((a) => a.name).join("/")) || albumItem.artist || "",
          artwork: al.picUrl || albumItem.artwork || "",
          date: al.publishTime ? new Date(Number(al.publishTime)).toISOString().slice(0, 10) : (albumItem.date || ""),
          description: al.description || "",
          worksNum: musicList.length,
        },
        musicList: musicList,
      };
    } catch (e) { /* 失败就往下走，交给通用兜底 */ }
  }


  if (String(id).indexOf("apalbum:") === 0) {
    const parts = String(id).split(":");
    const cc = parts[1] || "cn";
    const albumId = parts[2] || "";
    const json = await applePageData(cc, "album", albumId);
    const parsed = applePageTracks(json);
    const tracks = parsed.tracks || [];
    const musicList = tracks.length
      ? await appleTracksToPlayable(tracks, parsed.artist || albumItem.artist, parsed.artwork || albumItem.artwork, parsed.title || albumItem.title)
      : [];
    return {
      isEnd: true,
      albumItem: {
        id: String(id),
        platform: "Apple Music",
        title: parsed.title || albumItem.title || "",
        artist: parsed.artist || albumItem.artist || "",
        artwork: parsed.artwork || albumItem.artwork || "",
        date: albumItem.date || "",
        description: "",
        worksNum: musicList.length || Number(albumItem.worksNum || 0),
      },
      musicList: musicList,
    };
  }

  if (albumItem._provider === "apple" || String(id).indexOf("apple:") === 0) {
    const parts = String(id).split(":");
    const artistId = parts[1] || "";
    const albumTitle = String(albumItem.title || "");
    const albumN = normAlbumName(albumTitle);

    let tracks = [];
    try {
      /* ⚠️ 别再用 lookup?id=<艺人>&entity=song 自己过滤 ——
         那条接口给的曲目只有一部分（实测 4 张 19 首里只回 14 首，
         《尋找尼歐 - Single》整张缺失），于是这张专辑点进去是空的。
         appleArtistWorks 里已经按专辑 id 逐张补全过，直接复用它的结果。 */
      const aw = await appleArtistWorks(artistId, 1, "music", 200);
      const all = (aw && aw.data) || [];
      for (let i = 0; i < all.length; i++) {
        const x = all[i];
        if (normAlbumName(x.album || "") !== albumN) continue;
        tracks.push({
          name: String(x.title || ""),
          no: i + 1,
          dur: Number(x.duration || 0),
        });
      }
      if (!tracks.length) {
        const songRes = await itunesLookupAll(artistId, "song", ITUNES_COUNTRIES[0]);
        for (let i = 0; i < songRes.length; i++) {
          const x = songRes[i];
          if (x.wrapperType !== "track") continue;
          if (normAlbumName(x.collectionName || "") !== albumN) continue;
          tracks.push({
            name: String(x.trackName || ""),
            no: Number(x.trackNumber || 0),
            dur: Number(x.trackTimeMillis || 0),
          });
        }
        tracks.sort((a, b) => a.no - b.no);
      }
    } catch (e) { /* 拿不到就空着 */ }

    /* 拿 YouTube 找同名音源，找到就能直接播。
       ⚠️ 只取标题里带歌名的，别把「XX翻唱」塞进来。 */
    const musicList = [];
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      let ytHit = null;
      try {
        const q = t.name + " " + (albumItem.artist || "");
        const list = await ytSearchRaw(q);
        const tn = normTextZ(t.name);
        if (tn) {
          let best = null, bestSc = -Infinity;
          for (let j = 0; j < (list || []).length; j++) {
            const y = list[j];
            const yn = normTextZ(y.title || "");
            if (!yn || yn.indexOf(tn) < 0) continue;
            let sc = 0;
            /* 「xxx - Topic」是 YouTube 给唱片公司自动生成的官方频道，
               几乎必然是正版录音室版 —— 这是最硬的信号。 */
            if (/[-–—]\s*Topic$/i.test(String(y.artist || ""))) sc += 60;
            // 标题正好就是歌名（不含「XX翻唱」「@某音乐节」这些）
            if (yn === tn) sc += 40;
            else sc -= (yn.length - tn.length);   // 多出来的字越多越不像
            // 时长对得上加分（YouTube 的 Android client 常常不给时长，给了才用）
            const sec = ytDurSec(y.durationText);
            if (sec > 0 && t.dur > 0) {
              const d = Math.abs(sec - Math.round(t.dur / 1000));
              sc += d <= 12 ? 30 : (d <= 40 ? 5 : -80);
            }
            // 直播/现场降权
            if (/live|現場|现场|演唱會|演唱会|翻唱|cover|remix|伴奏|純享|纯享/i.test(y.title || "")) sc -= 50;
            if (sc > bestSc) { bestSc = sc; best = y; }
          }
          /* ⚠️ 门槛必须为负也得给：YouTube 上这个乐团的官方曲目
             全靠「IGU Band - Topic」这类频道，标题里不带歌手名，
             拿严门槛会把它们全滤掉 —— 那就一首也播不了。 */
          if (best && bestSc > -60) ytHit = { y: best };
        }
      } catch (e) { /* 单个失败不影响别的 */ }

      musicList.push({
        id: ytHit ? String(ytHit.y.id) : "",
        platform: ytHit ? "YouTube" : "Apple Music",
        title: t.name,
        artist: albumItem.artist || "",
        album: albumTitle,
        artwork: albumItem.artwork || "",
        // YouTube 的 Android client 常常不给时长 → 退回 Apple 的（更准）
        duration: (ytHit && ytDurSec(ytHit.y.durationText) > 0)
          ? ytDurSec(ytHit.y.durationText) * 1000 : t.dur,
        _provider: ytHit ? "youtube" : "apple",
      });
    }

    return {
      isEnd: true,
      albumItem: {
        id: String(id),
        platform: "Apple Music",
        title: albumTitle,
        artist: albumItem.artist || "",
        artwork: albumItem.artwork || "",
        date: albumItem.date || "",
        description: albumItem.description || "",
        worksNum: musicList.length || Number(albumItem.worksNum || 0),
      },
      musicList: musicList,
    };
  }

  // 酷狗专辑：走 mobilecdn 的 album/song
  if (albumItem._provider === "kugou" || albumItem.platform === "酷狗") {
    const r = await kugouDetail(id, "album", page, 50);
    return {
      isEnd: r.isEnd,
      albumItem: {
        id: String(id),
        platform: "酷狗",
        title: albumItem.title || "",
        artist: albumItem.artist || "",
        artwork: albumItem.artwork || "",
        date: albumItem.date || "",
        description: albumItem.description || "",
        worksNum: albumItem.worksNum || r.musicList.length,
      },
      musicList: r.musicList,
    };
  }

  // 听书专辑：曲目就是从搜索里攒下来的那些集
  if (albumItem._provider === "audiobook" || String(id).indexOf("ab:") === 0) {
    const raw = albumItem._raw || {};
    const items = raw.items || [];
    return {
      isEnd: true,
      albumItem: {
        id: id,
        platform: albumItem.platform || "有声书",
        title: albumItem.title || "",
        artist: albumItem.artist || "",
        artwork: albumItem.artwork || "",
        date: "",
        description: albumItem.description || "",
        worksNum: items.length,
      },
      musicList: items.map((x) => ({
        id: x.id,
        platform: x.platform,
        title: x.title,
        artist: x.artist || "",
        album: x.book || "",
        artwork: x.artwork || "",
        duration: 0,
        _provider: x.provider,
        _raw: x,
      })),
    };
  }

  /* ---- 咪咕「直出」专辑 ----
     ⚠️ 这条分支必须在酷我兜底**之前**：咪咕的 albumId（7948）跟酷我的
        id 空间完全无关。没有这条分支时，点「范特西 周杰伦 咪咕直出」
        会一路落到下面的 kuwoSheetsByAlbum(7948)，查出《两只小蜜蜂》
        (李晓杰) 11 首 —— 用户点了周杰伦，进去看到李晓杰。 */
  if (albumItem._provider === "miguapi" || albumItem.platform === "咪咕直出") {
    const d = await miguAlbumDetail(id, albumItem, page).catch(() => null);
    if (d && d.musicList && d.musicList.length) return d;
    /* 接口没曲目：给一个**诚实的空专辑**（元信息还是咪咕的），
       绝不往下落到酷我拿别人的唱片来充数。 */
    if (d) return d;
    return {
      isEnd: true,
      albumItem: {
        id: String(id),
        platform: "咪咕直出",
        title: albumItem.title || "",
        artist: albumItem.artist || "",
        artwork: albumItem.artwork || "",
        date: albumItem.date || "",
        description: albumItem.description || "",
        worksNum: 0,
      },
      musicList: [],
    };
  }

  // 酷我：用 album 页面的 __NUXT__ 拿曲目
  /* ⚠️ 只有真的是酷我条目才走这里。原来这里是「谁都没匹配上」的默认兜底，
     拿别的平台的 id 去酷我查 —— id 空间一撞就返回别人的唱片，
     而且看着还挺像那么回事（有曲目、有封面），特别难发现。
     认不出平台的条目宁可返回 null，让客户端显示空列表。 */
  if (albumItem._provider === "kuwo" || albumItem.platform === "酷我") {
    try {
      const d = await kuwoSheetsByAlbum(id);
      if (d && d.musicList && d.musicList.length) return d;
    } catch (e) { /* 落到下面 */ }
  }
  console.log("[粽子] 专辑详情认不出来源: " + String(albumItem.platform || albumItem._provider || "?") + " id=" + id);
  return null;
}

async function kuwoSheetsByAlbum(albumId) {
  const r = await axios_1.get("https://www.kuwo.cn/album_detail/" + encodeURIComponent(albumId), {
    timeout: 25000,
    headers: { "User-Agent": UA },
    validateStatus: () => true,
    responseType: "text",
    transformResponse: [(d) => d],
  });
  const html = String(r.data || "");
  const st = html.indexOf("__NUXT__=(function(");
  if (st < 0) throw new Error("酷我专辑：页面结构变了");
  const en = html.indexOf("</script>", st);
  const code = html.slice(st, en > 0 ? en : st + 400000);
  const data = new Function(code.replace(/^__NUXT__=/, "return "))();

  // ⚠️ 路径固定是 data[0].albumInfo.musicList（实测），
  //    字段名是 MUSICRID（大写），不是 rid。之前按 rid 递归找导致全都拿不到。
  const box = data && data.data && data.data[0] && data.data[0].albumInfo;
  if (!box) throw new Error("酷我专辑：无 albumInfo");
  const list = box.musicList || [];

  return {
    isEnd: true,
    albumItem: {
      id: String(albumId),
      platform: "酷我",
      title: box.album || box.name || "",
      artist: box.artist || "",
      artwork: box.pic || box.albumpic || "",
      date: box.pub || box.releaseDate || "",
      description: box.info || box.desc || "",
      worksNum: list.length,
    },
    musicList: list.map((m) => ({
      id: String(m.MUSICRID || m.rid || "").replace("MUSIC_", ""),
      platform: "酷我",
      title: m.SONGNAME || m.name || "",
      artist: m.ARTIST || m.artist || "",
      album: m.ALBUM || m.album || "",
      artwork: m.MVPIC || "",
      duration: Number(m.DURATION || m.duration || 0) * 1000,
      _provider: "kuwo",
    })),
  };
}

/** 歌手作品：酷我按 artistid 拉歌曲/专辑 */
async function getArtistWorksOf(artistItem, page, type) {
  const id = artistItem && artistItem.id;
  if (!id) return { isEnd: true, data: [] };

  /* YouTube Music 目录歌手（搜索时由 ytmArtistCatalog 打过 _ytmCh 标记）：
     国内平台上这个人的条目是空的，只有 YTM 有完整目录。
     直接在目录缓存上切片，不再去打任何平台接口。 */
  if (artistItem._ytmCh) {
    try {
      const cat = await ytmArtistCatalog(artistItem.name || "");
      if (cat && (cat.albums.length || cat.tracks.length)) {
        const rn0 = 30;
        const begin0 = ((page || 1) - 1) * rn0;
        if (type === "album") {
          return {
            isEnd: begin0 + rn0 >= cat.albums.length,
            data: cat.albums.slice(begin0, begin0 + rn0),
          };
        }
        return {
          isEnd: begin0 + rn0 >= cat.tracks.length,
          data: cat.tracks.slice(begin0, begin0 + rn0),
        };
      }
    } catch (e) { /* 落到下面的通用链路 */ }
  }


  const pn = (page || 1) - 1;
  const rn = 30;
  /* ---- 多源合并：同名歌手在酷我 / 网易云 / 酷狗 / QQ 上的 id 完全不同，
     各家曲库有版权分流，谁也不全。dedupeArtists 把每条来源登记进 _alts，
     这里挨个去取、按「歌名 + 歌手」去重合并 —— 这样点进「周杰伦」
     既有酷我的 1708 首里能播的，也有网易云/QQ 独家收录的。
     ⚠️ 只在第 1 页做全量合并：后面几页各自翻各自的，合并会把页码算乱。 */
  if (artistItem._alts && artistItem._alts.length > 1) {
    const alts = artistItem._alts;
    let merged = [];
    if (type === "album") {
      const parts = await Promise.all(alts.map((alt) => {
        const sub = Object.assign({}, artistItem, { id: alt.id, platform: alt.platform, _provider: alt.provider, _alts: null });
        if (sub.id === artistItem.id) return getArtistWorksOf(sub, 1, "album").catch(() => ({ data: [] }));
        return getArtistWorksOf(sub, 1, "album").catch(() => ({ data: [] }));
      }));
      const seenA = {};
      for (let i = 0; i < parts.length; i++) {
        const arr = (parts[i] && parts[i].data) || [];
        for (let j = 0; j < arr.length; j++) {
          const x = arr[j];
          const k = normAlbumName(x.title || "") + "|" + singerNorm(x.artist || "");
          if (!x.title || seenA[k]) continue;
          seenA[k] = 1;
          merged.push(x);
        }
      }
      // 曲目多的优先（正版专辑），其余保持来源顺序
      merged.sort((a, b) => Number(b.worksNum || 0) - Number(a.worksNum || 0));
      const beginA = ((page || 1) - 1) * rn;
      return { isEnd: beginA + rn >= merged.length, data: merged.slice(beginA, beginA + rn) };
    }
    const parts = await Promise.all(alts.map((alt) => {
      const sub = Object.assign({}, artistItem, { id: alt.id, platform: alt.platform, _provider: alt.provider, _alts: null });
      return getArtistWorksOf(sub, 1, "music").catch(() => ({ data: [] }));
    }));
    const seenT = {};
    for (let i = 0; i < parts.length; i++) {
      const arr = (parts[i] && parts[i].data) || [];
      for (let j = 0; j < arr.length; j++) {
        const x = arr[j];
        if (!x.title) continue;
        /* 同一首在不同平台都有一份 —— 保留先出现的那个（酷我在前，
           它取流成功率最高），后面同名同歌手的直接丢，免得列表里
           出现五条《晴天》只有音源标签不同。 */
        const k = normTextZ(x.title) + "|" + singerNorm(String(x.artist || "").split("/")[0]);
        if (seenT[k]) continue;
        seenT[k] = 1;
        merged.push(x);
      }
    }
    const begin = ((page || 1) - 1) * rn;
    return { isEnd: begin + rn >= merged.length, data: merged.slice(begin, begin + rn) };
  }

  /* Apple 目录歌手条目（id 形如 apart:1223943074）—— 平台全都没有这个人，
     只有 Apple 有。专辑和曲目都走 appleArtistWorks（带 1 小时缓存）。 */
  if (String(id).indexOf("apart:") === 0) {
    const artistId = String(id).slice(6);
    if (!artistId) return { isEnd: true, data: [] };
    const isAlbum = type === "album";
    const r = await appleArtistWorks(artistId, page, isAlbum ? "album" : "music", rn);

    /* ---- Apple 目录太薄时，用 MusicBrainz 补齐 ----
       实测（2026-10-21）「赵薇」：Apple 香港区只有《天使旅行箱》10 首，
       而 MB 有 9 张 77 首 —— 《飘》《双》《我们都是大导演》《小燕子赵薇》
       全在，用户点进歌手页只看得到 10 首，等于把人当成只发过一张唱片。
       ⚠️ 只在第 1 页、且 Apple 一页都没填满时补（<20 条 = 目录确实薄）；
          Apple 那边正常的歌手（陈奕迅 100+ 首）永远进不来这条。
       ⚠️ 补进来的曲目**没有 audio id**，播放时走跨平台兜底（跟 Apple
          占位条目同一套），所以 platform 标 MusicBrainz 而不是 Apple。 */
    const thin = r && (r.data || []).length < 20;
    if (page === 1 && thin) {
      try {
        const mcat = await Promise.race([
          mbArtistCatalog(artistItem.name || "").catch(function () { return null; }),
          new Promise(function (res) { setTimeout(function () { res(null); }, 6000); }),
        ]);
        if (mcat) {
          const head = (r && r.data) || [];
          if (isAlbum) {
            if (mcat.albums.length > head.length) {
              const before = head.length;
              mergeMbAlbums(mcat, head);
              console.log("[粽子] Apple 只有 " + before + " 张专辑 → MusicBrainz「"
                + mcat.name + "」补到 " + head.length + " 张");
            }
          } else if (mcat.tracks.length > head.length) {
            const have = {};
            for (let i = 0; i < head.length; i++) {
              const k = normTextZ(head[i].title || "");
              if (k) have[k] = 1;
            }
            let added = 0;
            /* 上限 90 首：一页塞两百条会卡，用户也翻不动。
               补齐的意义是「别让他看起来只发过一张唱片」，不是把全部作品一次倒完。 */
            for (let i = 0; i < mcat.tracks.length && head.length < 90; i++) {
              const t = mcat.tracks[i];
              const k = normTextZ(t.title || "");
              if (!k || have[k]) continue;
              have[k] = 1;
              head.push({
                id: "",           // 没有音源 id，播放走跨平台兜底
                platform: "MusicBrainz",
                title: t.title,
                artist: mcat.name,
                album: t.album || "",
                artwork: "",
                duration: Number(t.duration || 0),
                _provider: "mb",
              });
              added++;
            }
            if (added) {
              console.log("[粽子] Apple 只有 " + (head.length - added) + " 首 → MusicBrainz「"
                + mcat.name + "」补 " + added + " 首");
            }
          }
          return { isEnd: true, data: head };
        }
      } catch (e) { /* MB 挂了就用 Apple 那份 */ }
    }
    return r;
  }

  /* YouTube 歌手条目（id 形如 ytch:IGU Band）—— 这类是酷我/咪咕都查不到、
     只能靠 Topic 频道兜底的冷门艺人。作品直接按「频道名」在 YouTube 搜，
     只收该频道的曲目。 */
  /* 网易云歌手条目（neart:<artistId>）→ 走 /api/v1/artist/songs 和
     /api/artist/albums，实测 135ms / 229ms。 */
  if (String(id).indexOf("neart:") === 0) {
    const artistId = String(id).slice(6);
    if (!artistId) return { isEnd: true, data: [] };
    try {
      return await neteaseArtistWorks(artistId, page, type === "album" ? "album" : "music", rn);
    } catch (e) { return { isEnd: true, data: [] }; }
  }

  /* 酷狗歌手条目（kgs:<singerId>）→ 直接按 singerid 查，不用再拿名字猜。 */
  if (String(id).indexOf("kgs:") === 0) {
    const sid = String(id).slice(4);
    if (!sid) return { isEnd: true, data: [] };
    try {
      const r = await kugouArtistWorks(sid, page, type === "album" ? "album" : "music", rn);
      if (r.data.length) return r;
    } catch (e) { /* 落到下面的通用链路 */ }
  }

  /* QQ 歌手条目（qqa:<singerMid>）。
     ⚠️ QQ 的歌手作品接口（musicu 的 GetSingerSongList / GetSingerAlbum）
        2026-10-20 实测全部返回 code 500003（接口已死），singer_track_cp 也 404。
        所以这里退回「按歌手名搜歌」，再按歌手字段过滤 ——
        实测搜「周杰伦」前 30 条全是他的（晴天/发如雪/搁浅/一路向北/枫…），
        足够当歌手页的第一页。专辑那一路退回按名字搜专辑再过滤。 */
  if (String(id).indexOf("qqa:") === 0) {
    const nm = String(artistItem.name || "");
    if (!nm) return { isEnd: true, data: [] };
    const wantN = singerNorm(nm);
    try {
      if (type === "album") {
        const al = await qqSearchAlbumByName(nm, page);
        return { isEnd: al.length < rn, data: al };
      }
      const songs = await qqSearchSongsByArtist(nm, page, rn);
      return { isEnd: songs.length < rn, data: songs };
    } catch (e) { return { isEnd: true, data: [] }; }
  }


  if (String(id).indexOf("ytch:") === 0) {
    if (page !== 1) return { isEnd: true, data: [] };
    const chName = String(artistItem.name || "");
    const chNorm = flatTitle(chName);
    const music = [];
    const used = {};
    const pushTrack = (x, album, dur) => {
      if (!x || !x.id || used[x.id]) return;
      used[x.id] = 1;
      music.push({
        id: x.id,
        platform: "YouTube",
        title: x.title || "",
        artist: chName,
        album: album || "",
        artwork: x.artwork || "",
        duration: dur || 0,
        _provider: "youtube",
      });
    };

    /* 主线：拿 Apple 目录当**歌单骨架**，再逐首去 YouTube 找官方音源。
       ⚠️ 只按频道名搜一次是拿不全的 —— 实测「IGU Band」的 Topic 频道
          实际有 31 首，按频道名搜只回 5~6 条（其余都排在别的视频后面）。
          Apple 目录能给出整套 3 张专辑 31 首的歌名，照歌名逐首搜
          「歌名 + 频道名」，实测 9/9 全部命中 Topic 官方频道，耗时 <1s。

       ⚠️ Apple 目录太薄时改用 YTM 目录（2026-10-21 实测「宇多田ヒカル」）：
          Apple 只给 19 首，YTM 有 73 张 109 首 —— 而且两边都是「歌名 → YouTube
          搜官方音源」的同一条路子，YTM 的曲目表本来就从 YouTube 上抓的，
          命中率只会更高。这条要花 15 秒左右，但那种目录量级的歌手本来就这样。 */
    let cat = await appleArtistCatalog(chName);
    if (!cat || cat.tracks.length < 30) {
      try {
        const ycat = await Promise.race([
          ytmArtistCatalog(chName).catch(function () { return null; }),
          new Promise(function (res) { setTimeout(function () { res(null); }, 9000); }),
        ]);
        if (ycat && ycat.tracks.length > (!cat ? 0 : cat.tracks.length)) {
          console.log("[粽子] Apple 目录「" + chName + "」"
            + (!cat ? "无" : cat.tracks.length + " 首") + " → 改用 YouTube Music "
            + ycat.albums.length + " 张 / " + ycat.tracks.length + " 首");
          /* 转成 appleArtistCatalog 的结构，后面那段逐首搜音源的代码不用改。 */
          cat = {
            id: ycat.id,
            name: ycat.name,
            tracks: ycat.tracks.map(function (t) {
              return {
                title: t.title,
                album: t.album || "",
                dur: Number(t.duration || 0),
              };
            }),
            albums: ycat.albums.map(function (a) {
              return {
                title: a.title, artist: a.artist, artwork: a.artwork || "",
                date: a.date || "", worksNum: a.worksNum || 0,
              };
            }),
            _src: "ytm",
          };
        }
      } catch (e) { /* YTM 拿不到就继续用 Apple 那份 */ }
    }
    if (cat && cat.tracks && cat.tracks.length) {
      const CONC = 8;   // YouTube 这边并发开大会被限流
      for (let i = 0; i < cat.tracks.length; i += CONC) {
        const batch = cat.tracks.slice(i, i + CONC);
        await Promise.all(batch.map(async (t) => {
          const wantN = normTextZ(t.title);
          if (!wantN) return;
          /* YouTube 标题里的标点跟 Apple 经常对不上 ——
             Apple「沒有的, 啊!?」/ YouTube「沒有的 啊」，
             逗号问号感叹号都得去掉才比得上。 */
          const wantBare = wantN.replace(/[.,!?;:'"·、。，！？；：…—–\-]/g, "");
          let list = [];
          try { list = await ytSearchRaw(t.title + " " + chName); } catch (e) { return; }
          let best = null, bestSc = -Infinity;
          for (let j = 0; j < (list || []).length; j++) {
            const y = list[j];
            const yn = normTextZ(y.title || "");
            if (!yn) continue;
            const yBare = yn.replace(/[.,!?;:'"·、。，！？；：…—–\-]/g, "");
            // 子串匹配放宽到「去标点后互相包含」
            const hitTitle = yn.indexOf(wantN) >= 0 || wantN.indexOf(yn) >= 0 ||
                             (wantBare && yBare.indexOf(wantBare) >= 0) ||
                             (wantBare && wantBare.indexOf(yBare) >= 0 && yBare.length >= 2);
            if (!hitTitle) continue;
            let sc = 0;
            /* 「xxx - Topic」是 YouTube 给唱片公司自动生成的官方音频频道，
               这是最硬的信号 —— 单这一项就够把翻唱/歌词版全甩开。 */
            if (/[-–—]\s*Topic\s*$/i.test(String(y.artist || ""))) sc += 100;
            const ch = String(y.artist || "").replace(/\s*[-–—]\s*Topic\s*$/i, "").trim();
            if (flatTitle(ch) === chNorm) sc += 40;
            if (yn === wantN) sc += 30;
            else if (yBare === wantBare) sc += 25;      // 只是标点不同，算同一首
            else sc -= Math.max(0, yn.length - wantN.length);
            if (/歌词|歌詞|lyrics|cover|翻唱|remix|dj|伴奏|纯享|純享|live|現場|现场/i.test(y.title || "")) sc -= 60;
            const sec = ytDurSec(y.durationText);
            if (sec > 0 && t.dur > 0) {
              const d = Math.abs(sec - Math.round(t.dur / 1000));
              sc += d <= 12 ? 40 : (d <= 40 ? 5 : -100);
            }
            if (sc > bestSc) { bestSc = sc; best = y; }
          }
          // 分数 <= 0 说明只是标题撞字（没有 Topic、没有频道名对得上），宁可不要
          if (!best || bestSc <= 0) return;
          /* 时长优先用 Apple 的官方值 —— YouTube 搜索结果的 lengthText
             经常是空的（界面会显示 00:00），有官方值就别去逐首探 player 了，
             省掉每首一次请求。 */
          pushTrack(best, t.album, t.dur || (ytDurSec(best.durationText) * 1000));
        }));
      }
    }

    /* 兜底：Apple 也没有这个团 → 退回「按频道名搜一次」的老办法，
       至少能出几首，总比空列表强。 */
    if (!music.length) {
      const raw = await ytSearchRaw(chName).catch(() => []);
      for (let i = 0; i < (raw || []).length; i++) {
        const x = raw[i];
        const ch = String(x.artist || "").replace(/\s*[-–—]\s*Topic\s*$/i, "").trim();
        if (flatTitle(ch) !== chNorm) continue;
        const d = ytDurSec(x.durationText);
        if (d > 0 && (d < 60 || d > 900)) continue;
        pushTrack(x, "", d * 1000);
      }
    }

    // Topic 频道的 lengthText 经常是空的（界面会显示 00:00），
    // 补查 player 拿真实时长。只探前 12 条，控制开销。
    const noDur = music.filter((x) => !x.duration).slice(0, 12);
    if (noDur.length) {
      await Promise.all(noDur.map(async (x) => {
        try {
          const r = await ytPlayer(x.id);
          if (r.lengthSeconds) x.duration = r.lengthSeconds * 1000;
        } catch (e) { /* 忽略 */ }
      }));
    }

    if (type === "album") {
      /* YouTube 自己没有「专辑」概念，但 Apple 目录里是分好专辑的 ——
         直接用它的分组当专辑列表，点进去 getAlbumDetail 会按 albumId
         把曲目再拉出来配 YouTube 音源。 */
      if (!(cat && cat.albums && cat.albums.length)) return { isEnd: true, data: [] };
      const albums = cat.albums.map((a, i) => ({
        id: "apple:" + cat.id + ":" + i,
        platform: "Apple Music",
        title: a.title,
        artist: a.artist || chName,
        artwork: a.artwork || "",
        date: a.date || "",
        description: "Apple Music 目录",
        worksNum: a.worksNum || 0,
        _provider: "apple",
        _kind: "album",
      }));
      return { isEnd: true, data: albums };
    }
    return { isEnd: true, data: music };
  }

  /* 优先走酷狗。
     酷我那两个 www/api 歌手接口已经失效（code=undefined / data 空），
     退化路径是「拿歌手名再搜一遍」，结果就是一堆 DJ 版和翻唱占满首页。
     酷狗用 singerId 直查，拿到的是真正的 1848 首 + 49 张专辑。 */
  const singerName = artistItem.name || artistItem.artist || "";

  /* Apple 目录和酷狗并发查，用来判断「酷狗指向的是不是冒名号」。
     实测「那我懂你意思了」：酷狗把名字指给了 singerid=21522043 的冒名歌手，
     名下只有《凤囚凰》《夏日的风》2 首单曲 —— 用户点进歌手页看到 2 首，
     以为源坏了。真乐团 3 张正规专辑 31 首只在 Apple 目录里。
     判据：平台给得极少（<10）而 Apple 目录明显完整 → 以 Apple 为准。
     反过来周杰伦这种（酷狗 1848 首）永远走酷狗，Apple 只当参考。 */
  const [appleCat, kgTry] = await Promise.all([
    appleArtistCatalog(singerName).catch(() => null),
    (async () => {
      try {
        const kgsId = await kugouSingerIdByName(singerName);
        if (!kgsId) return null;
        const r = await kugouArtistWorks(kgsId, page, type === "album" ? "album" : "music", rn);
        return r.data.length ? r : null;
      } catch (e) { return null; }
    })(),
  ]);

  const appleRich = !!(appleCat && appleCat.id &&
    (appleCat.tracks.length >= 10 || appleCat.albums.length >= 2));
  /* ⚠️ 判据不能只看「<10 条」——顺手放宽到 15 条没有意义，
     真正的病根在下面 YTM 接管那一段（木马被 YTM 的 9 首 Live 抢走，
     而酷我那边其实有 101 首）。这里保持原样。 */
  const platformPoor = !kgTry || kgTry.data.length < 10;
  if (appleRich && platformPoor) {
    console.log("[粽子] 酷狗目录不全（" + (kgTry ? kgTry.data.length : 0)
      + " 条），改用 Apple 目录「" + appleCat.name + "」"
      + appleCat.albums.length + " 张 / " + appleCat.tracks.length + " 首");
    const ar = await appleArtistWorks(appleCat.id, page, type, rn);
    if (ar.data.length) return ar;
  }

  if (kgTry) return kgTry;

  if (type === "music") {
    // 酷我的歌手歌曲接口
    const r = await axios_1.get("https://www.kuwo.cn/api/www/artist/artistMusic", {
      params: { artistid: id, pn: pn + 1, rn: rn, httpsStatus: 1 },
      timeout: 20000,
      headers: { "User-Agent": UA, Referer: "https://www.kuwo.cn/" },
      validateStatus: () => true,
    });
    const d = r.data || {};
    if (d.code !== 200) {
      // 接口要 csrf，退化成「用歌手名搜索」
      const name = artistItem.name || "";
      const s = await kuwoSearchTyped(name, "music", page, rn);
      return {
        isEnd: s.list.length < rn,
        data: s.list.map((m) => ({
          id: String(m.DC_TARGETID || m.MUSICRID || "").replace("MUSIC_", ""),
          platform: "酷我",
          title: m.SONGNAME || m.name || "",
          artist: m.ARTIST || m.artist || "",
          album: m.ALBUM || m.album || "",
          duration: Number(m.DURATION || 0) * 1000,
          _provider: "kuwo",
        })),
      };
    }
    const list = (d.data && d.data.musicList) || [];
    return {
      isEnd: list.length < rn,
      data: list.map((m) => ({
        id: String(m.rid || ""),
        platform: "酷我",
        title: m.name || "",
        artist: m.artist || "",
        album: m.album || "",
        duration: Number(m.duration || 0) * 1000,
        _provider: "kuwo",
      })),
    };
  }

  if (type === "album") {
    const r = await axios_1.get("https://www.kuwo.cn/api/www/artist/artistAlbum", {
      params: { artistid: id, pn: pn + 1, rn: rn, httpsStatus: 1 },
      timeout: 20000,
      headers: { "User-Agent": UA, Referer: "https://www.kuwo.cn/" },
      validateStatus: () => true,
    });
    const d = r.data || {};
    const list = (d.data && d.data.albumList) || [];
    return {
      isEnd: list.length < rn,
      data: list.map((a) => ({
        id: String(a.albumid || a.id || ""),
        platform: "酷我",
        title: a.album || a.name || "",
        artist: a.artist || "",
        artwork: a.pic || "",
        date: a.pub || "",
        description: "",
        worksNum: Number(a.musiccnt || 0),
        _provider: "kuwo",
      })),
    };
  }

  return { isEnd: true, data: [] };
}

async function resolveJoox(id, want, quality) {
  const errors = [];
  const ck = getJooxCookie();
  if (!ck) throw new Error("未配置 JOOX Cookie（插件设置里填）");

  // 1. ID 直取
  if (id) {
    try { return await jooxFetchUrl(id, quality); }
    catch (e) { errors.push("直取: " + e.message); }
  }
  // 2. 搜索后取
  try {
    const items = await searchAny((kw) => jooxSearch(kw, 20), buildKeywords(want));
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!isDefinitelySameSong(it, want)) continue;
      try { return await jooxFetchUrl(it.id, quality); }
      catch (e) { errors.push("搜索取流: " + e.message); }
    }
  } catch (e) { errors.push("搜索: " + e.message); }

  throw new Error(errors.join(" | "));
}

async function resolveMigu(id, want, quality) {
  const errors = [];
  try {
    const items = await searchAny((kw) => cocoSearch("migu", kw), buildKeywords(want));
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!isDefinitelySameSong(it, want)) continue;
      try { return await cocoFetchUrl("migu", it.id, quality, it.extra); }
      catch (e) { errors.push("coco: " + e.message); }
    }
  } catch (e) { errors.push("coco: " + e.message); }
  throw new Error(errors.join(" | "));
}

async function resolveKuwo(id, want, quality) {
  const errors = [];
  // 1. 官方直连（搜索 → convert_url），最稳
  try {
    const items = await searchAny((kw) => kuwoOfficialSearch(kw, 8), buildKeywords(want));
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!isDefinitelySameSong(it, want)) continue;
      const rid = String(it.MUSICRID || it.DC_TARGETID || "").replace("MUSIC_", "");
      if (!rid) continue;
      try { return await kuwoOfficialUrl(rid, quality); }
      catch (e) { errors.push("官方: " + e.message); }
    }
  } catch (e) { errors.push("官方搜索: " + e.message); }

  // 2. 溯音
  try { return await suyinKuwo(want, quality); }
  catch (e) { errors.push("溯音: " + e.message); }

  // 3. 长青
  if (id) {
    try { return await changqingKuwo(id, quality); }
    catch (e) { errors.push("长青: " + e.message); }
  }

  // 4. hi.cn 搜索（实测酷我三首全通）
  try {
    const items = await searchAny((kw) => hiSearch("kuwo", kw, 8), buildKeywords(want));
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!isDefinitelySameSong(it, want)) continue;
      try { return await hiFetchUrl("kuwo", it, quality); }
      catch (e) { errors.push("hi.cn: " + e.message); }
    }
  } catch (e) { errors.push("hi.cn: " + e.message); }

  throw new Error(errors.join(" | "));
}

/* 已经确认拿不到流的平台+id，避免同一次会话里重复撞墙 */
const deadIds = {};
function markDead(provider, id) {
  if (!provider || !id) return;
  deadIds[provider + "|" + id] = Date.now();
}
function isDead(provider, id) {
  if (!provider || !id) return false;
  const t = deadIds[provider + "|" + id];
  if (!t) return false;
  // 10 分钟内不再重试（直链签名一般也在几分钟内有效）
  return Date.now() - t < 10 * 60 * 1000;
}

const RESOLVERS = {
  netease: resolveNetease,
  qq: resolveQQ,
  kugou: resolveKugou,
  migu: resolveMigu,
  kuwo: resolveKuwo,
  joox: resolveJoox,
  youtube: resolveYoutube,
  bilibili: resolveBilibili,
  miguapi: resolveMiguApi,
};

/* ============================================================
 * search：多平台并发合并
 * ============================================================ */
/* 最终排名比较器。抽成具名函数，是因为「降级补搜」合并后还要用它再排一次 ——
   之前把比较器写成内联箭头函数，补搜那条路径就只能干瞪眼地 append。 */
function compareRank(a, b) {
  /* ⚠️ 鬼畜区条目**不单独降权**。
     以前这里有一条「_guichu 一律排到所有音乐条目之后」的硬规则，
     实测代价是搜「改革春风吹满地」时，18 条对口鬼畜被压到第 80 位往后，
     而排在前面的全是四平台那种同名网络歌手翻唱 —— 用户要看的本来就是鬼畜，
     按「谁更匹配查询」排就行，不该因为出身分区被埋掉。
     鬼畜和翻唱一视同仁：真原唱自然会凭 _auth / _bone / tier 抢到前排，
     抢不到的是因为它本身就不匹配。 */
  // tier 越大越好（3 完全匹配 / 2 沾边 / 1 变体），降序
  if (a._tier !== b._tier) return (b._tier || 0) - (a._tier || 0);
  // 相关性闸门降权（原因见 searchMusicAll 里 _rel 的注释）
  const ra = a._rel || 0, rb = b._rel || 0;
  if (ra !== rb) return rb - ra;
  // extra 越小越好（多出来的字数少）
  if (a._extra !== b._extra) return (a._extra || 0) - (b._extra || 0);
  /* 同档同匹配度时，录音室原版排在 Live 版前面。
     Live 版现在不再被去重吞掉（key 里带了 LIVE 标记），会独立成一条，
     所以需要在这里明确：原版先出来，现场版跟在后面，用户可以自己选。 */
  const la = a._live ? 1 : 0, lb = b._live ? 1 : 0;
  if (la !== lb) return la - lb;
  /* auth 排在 bone 前面。
     因为 bone 只是一些粗糙的启发式（内地平台 +12、Live +20），
     而 auth 是「Apple Music 里这首歌的正式发行版就是这张专辑、这个歌手」——
     证据强得多。实测「山海」时，草东的原唱 auth=+80 却因为 bone=12
     被压到第 12 名，而头部是 auth=-20 的翻唱，顺序完全反了。 */
  const aa = a._auth || 0, ab = b._auth || 0;
  if (aa !== ab) return ab - aa;
  // Apple 歌手目录（跨合并池也要参与，补搜进来的条目会被重新打分）
  const pa = a._apc || 0, pb = b._apc || 0;
  if (pa !== pb) return pb - pa;
  // bone 越小越好（官方发行版）
  const ba = a._bone || 0, bb = b._bone || 0;
  if (ba !== bb) return ba - bb;
  /* ---- YTM 代表作优先（2026-10-21）----
     ⚠️ 实测搜「李志」：他的代表作《關於鄭州的記憶》《天空之城》《忽然》
        是单曲，不在任何专辑里，YTM 艺人页把它们排在前 5。
        但下面的「标题越短越前」规则会把《門》《日》《死人》
        这种一两个字的冷门 B 面顶到最前面 —— 排序完全跑偏。
     判据：两条都在 YTM 热门里就按热门序；只有一条在，它优先。
        不在热门的（平台原有条目）排在这些代表作后面，
        但仍在 bone/tier 已经分好档的同一层里，不会乱。 */
  const ta = a._ytmTop || 0, tb = b._ytmTop || 0;
  if (ta || tb) {
    if (ta && tb) { if (ta !== tb) return ta - tb; }
    else return ta ? -1 : 1;
  }
  /* 同档同匹配度、同官方性时，标题短的排前面（2026-10-21）。
     用户的要求：「参考 LX Music，他就是短的在前长的在后」。
     放在 bone 之后是有意的：先把「这首到底是不是正式发行」排明白，
     再在同等可信的条目里按长度收尾 —— 否则一段 Live 演出的长标题
     会靠字数优势压到真正的短标题原曲前面。
     实测收益：搜「晴天」时「Nocturne No.13…」这类长标题不再混进前排。 */
  const tla = normTextZ(a.title).length, tlb = normTextZ(b.title).length;
  if (tla !== tlb) return tla - tlb;
  // 播放量微调
  const ha = a._hot || 0, hb = b._hot || 0;
  if (ha !== hb) return hb - ha;
  if (a._heat !== b._heat) return (b._heat || 0) - (a._heat || 0);
  return (a._order || 0) - (b._order || 0);
}

async function searchMusicAll(query, page) {
  const T0 = Date.now();
  if (page !== 1) return { isEnd: true, data: [] };

  const settled = [];

  /* 原名/别名反查只发一次请求，三处共用：
     ① B 站用原名去搜（B 站不认「摇晃帝国」这个译名）
     ② YouTube 同上
     ③ 最后的相关性闸门 —— 这一处最容易被忘：闸门只认原查询词的话，
        拿原名搜回来的正确结果会被整批判成「跟查询无关」，
        拦空之后又回退成「不筛」，噪声反而全都回来了。
     （实测 2026-10-18：B 站 7 条全被拦，最后只剩咪咕的《摇晃》） */
  const aliasPromise = neteaseArtistAliases(query).catch(() => []);
  /* 别名反查不吃满等待：尾部最多再等 ALIAS_TAIL_CAP 毫秒，
     而且整条别名链路有绝对上限 ALIAS_ABS_DEADLINE（从搜索开始算）——
     平台搜索已经花掉的时间可以抵扣。
     ⚠️ 不能像之前那样「从入口就挂一个 700ms 的计时器」：那样反查只要超过
        700ms 就会被判成「没有别名」，而反查实测常常要 0.9~1.4s
        （网易云两发 + QQ + Apple 四路）。实测后果很实在：
        搜「摇晃帝国」别名整批丢掉，唯一正确的 YouTube 那路
        （ゆらゆら帝国）认不出身份，被 B 站标题党顶到后面。
        用户要的译名搜索能力，不能拿来换这 0.5 秒。 */
  const ALIAS_TAIL_CAP = 800;
  const ALIAS_ABS_DEADLINE = 3000;

  /* 别名反查的「限时版」：最多等 ms 毫秒。
     ⚠️ 为什么要限时：B 站和 YouTube 这两路**必须**拿到原名才能搜
        （「摇晃帝国」在 B 站搜不到，「ゆらゆら帝国」才能搜到），
        所以原来是 `aliasPromise.then(...)` —— 整条任务挂在反查上。
        实测（2026-10-19）反查要 0.5~1.3s（网易云两发 + QQ + Apple 四路），
        而它一慢，B 站和 YouTube 就跟着一起慢，整次搜索被拖到 3.8s。

     现在给它一个很短的宽限：反查在 graceMs 内回来就用原名搜（绝大多数情况
     0.5s 内就回来了）；超时也不干等，先用查询词本身开搜，
     万一查询词召回为 0（真正的译名场景），再拿迟到的别名补一次。
     两条路都还在，只是把「等」变成了「先干起来」。 */
  function aliasGrace(graceMs) {
    return new Promise(function (res) {
      let done = false;
      const t = setTimeout(function () {
        if (!done) { done = true; res({ names: [], late: true }); }
      }, graceMs);
      aliasPromise.then(function (v) {
        if (!done) { done = true; clearTimeout(t); res({ names: v || [], late: false }); }
      });
    });
  }

  /* B 站 / YouTube 的「第一发」查询词请求，**在等别名之前就发出去**。
     ⚠️ 这两个平台单次请求本身就要 1.3~1.5s（实测 2026-10-19），
        原来要等别名反查完（0.4~1.2s）才发第一发，两段叠加就是 2.5s+。
        现在请求先上路，别名只在「查询词一无所获」时才用来补一发。
        用闭包把 promise 传给下面的任务，拿到就直接复用，不重复发。 */
  const ytFirstRawP = shouldUseYoutube()
    ? ytSearchRaw(query).catch(function () { return []; })
    : null;
  const biliFirstRawP = shouldUseBilibili()
    ? biliSearch(query, 1).catch(function () { return []; })
    : null;

  /* iTunes 权威目录也提前发出去（只依赖 query，见 authorityPrefetch 的说明） */
  const authPreP = authorityPrefetch(query);

  /* Apple 歌手目录：不含空格的查询，它必然就是用 query 去问
     （含空格时「歌名 歌手」要取最后一段，那要等 artistQuery 判定出来，
      没法提前）。所以这种最常见的情况先把它发出去，
      到真要打分时直接取结果 —— 尾部又省掉 0.3s。 */
  const applePreP = (String(query).indexOf(" ") < 0 && String(query).indexOf("　") < 0)
    ? appleArtistCatalog(query).catch(function () { return null; })
    : null;
  /* 带空格的查询里，「歌手那一半」（最后一个词）也可以提前问 ——
     「晴天 周杰伦」这类组合查询的 Apple 目录要等平台结果回来才知道该不该问，
     现问就是白等 0.4~0.6s（实测 Taylor Swift / 晴天 周杰伦 都在这里掉时间）。
     反正 appleArtistCatalog 自带缓存、失败了返回 null，提前发没有副作用：
     真需要时直接命中，不需要就自己过期。 */
  const appleTailPreP = (String(query).indexOf(" ") >= 0 || String(query).indexOf("　") >= 0)
    ? (function () {
        const parts = String(query).trim().split(/\s+/);
        const tail = parts[parts.length - 1];
        return tail && tail !== String(query).trim()
          ? appleArtistCatalog(tail).catch(function () { return null; })
          : null;
      })()
    : null;

  function toItem(raw, provider) {
    return {
      id: String(raw.id || raw.MUSICRID || ""),
      platform: PLATFORM_LABEL[provider] || provider,
      title: raw.title || raw.name || raw.SONGNAME || "",
      artist: raw.artist || raw.singer || raw.ARTIST || "",
      album: raw.album || raw.albumName || raw.ALBUM || "",
      artwork: raw.cover || raw.pic_url || raw.picUrl || raw.MVPIC || "",
      // ⚠️ 各平台时长格式不统一：COCO 给 "03:27"、酷我给 257（秒）、B站给 "4:12"。
      //    直接 Number() 会把 "03:27" 变成 NaN，导致界面显示 00:00。
      duration: ytDurSec(raw.durationText || raw.duration || raw.DURATION || 0) * 1000,
      playCount: Number(raw.playCount || raw.play || 0),   // 目前只有 B 站有
      _provider: provider,
      _raw: raw,
    };
  }

  function withRetry(label, fn, attempts) {
    const n = attempts || 2;
    return fn().then((r) => r).catch((e) => {
      if (n <= 1) { console.log("[粽子] " + label + " 失败: " + e.message); return []; }
      return new Promise((r) => setTimeout(r, 250)).then(() =>
        withRetry(label, fn, n - 1)
      );
    });
  }

  const mk = (provider, fn) => withRetry(provider, () => fn()).then((l) => (l || []).map((x) => toItem(x, provider)));

  /* ============================================================
   * 全部平台**一次性并发**。
   * 之前分成 batch1/batch2 两批串行 await，等于把总耗时翻倍
   * （实测串行 4.3s，改成全并发后 ~1.2s）。
   * 分两批的本意是躲酷狗的随机限流，但那个问题已经用重试解决了，
   * 没必要再牺牲速度。
   * ============================================================ */
  const jobs = [
    mk("netease", () => cocoSearch("netease", query)),
    mk("qq", () => cocoSearch("qq", query)),
    mk("kugou", () => cocoSearch("kugou", query)),
    mk("migu", () => cocoSearch("migu", query)),
    mk("kuwo", () => kuwoOfficialSearch(query, 10)),
  ];

  // JOOX 只在配了 Cookie 时参与
  if (getJooxCookie()) {
    jobs.push(
      withRetry("JOOX", () => jooxSearch(query, 20)).then((list) => {
        let l = list || [];
        if (shouldFilterVip()) l = l.filter((x) => !x.vip);
        return l.map((x) => toItem(x, "joox"));
      })
    );
  }

  // YouTube
  if (shouldUseYoutube()) {
    jobs.push(
      // YouTube 也走一次原名反查：搜「摇晃帝国」在 YouTube 上是空手，
      // 换成反查到的「Yura Yura Teikoku」就能搜到。
      /* ⚠️ 顺序很关键：**先用查询词开搜，同时**在后台等别名。
         原来是 `aliasGrace(...).then(...)` —— 查别名期间 YouTube 一个请求都不发，
         而 YouTube 单次搜索本身就要 1.3s（实测 2026-10-19，
         其中还有一次从网页抓 innertube API key），
         450ms 的等待叠上去，这一路就稳稳变成最慢的那条。
         现在两件事同时发生：查询词那一发立刻出手，别名回来了
         再决定要不要补一发。总耗时 = max(搜索, 反查)，不叠加。 */
      aliasGrace(450).then(async (ag) => {
        const tryOne = async (kwList, anchList, preRaw) => {
          for (let k = 0; k < kwList.length; k++) {
            let raw = [];
            if (k === 0 && preRaw) raw = preRaw;
            else { try { raw = await ytSearchRaw(kwList[k]); } catch (e) { continue; } }
            const keep = (raw || []).filter((x) => {
              const d = ytDurSec(x.durationText);
              // 太短是切片、太长是合辑/直播回放/有声书
              if (d > 0 && (d < 60 || d > 900)) return false;
              if (/伴奏|教学|教程|测评|反应|reaction|钢琴谱|guitar\s*cover/i.test(x.title)) return false;
              if (shouldFilterCover() && !COVER_RE.test(query) && isCoverTitle(x.title)) return false;
              if (shouldFilterAudiobook() && isAudiobookTitle(x.title)) return false;
              if (!titleMatchesAnchors(x.title, anchList, query)) return false;
              return true;
            });
            if (keep.length) return { keep: keep, kw: kwList[k] };
          }
          return { keep: [], kw: "" };
        };
        /* 第一发永远用查询词本身（已经在路上/已回来）。
           别名只在「查询词一无所获」时才补 —— 有货就没必要多打请求。 */
        let r = await tryOne([query], [query], await ytFirstRawP);
        if (!r.keep.length && ag.late) {
          // 别名是迟到的：最多再等 1200ms（网易云那一路偶发限流会挂十几秒）
          const late = await Promise.race([
            aliasPromise,
            new Promise(function (res) { setTimeout(function () { res(null); }, 1200); }),
          ]);
          if (late && late.length) r = await tryOne(late, [query].concat(late), null);
        } else if (!r.keep.length && ag.names.length) {
          r = await tryOne(ag.names, [query].concat(ag.names), null);
        }
        return r;
      }).then(async (res) => {
        const keep = (res.keep || [])
          .map((x) => ({
            id: x.id, platform: "YouTube", title: x.title, artist: x.artist,
            album: "", artwork: x.artwork, duration: ytDurSec(x.durationText) * 1000,
            _provider: "youtube", _raw: x,
          }));
        // ⚠️ Topic 频道的自动生成曲目，搜索结果里的 lengthText 是空的。
        //    没有时长会导致：① 界面显示 00:00 ② 被「时长 < 60 秒」的过滤误杀。
        //    只对最靠前的几条补查 player 拿 lengthSeconds（控制开销）。
        const noDur = keep.filter((x) => !x.duration);
        if (noDur.length) {
          const probe = noDur.slice(0, 6);
          await Promise.all(probe.map(async (x) => {
            try {
              const r = await ytPlayer(x.id);
              if (r.lengthSeconds) {
                x.duration = r.lengthSeconds * 1000;
                // 拿到真实时长后可能不合法（比如是直播回放），标记出来
                x._durChecked = true;
              }
            } catch (e) { /* 查不到就保持 0 */ }
          }));
          // 补查后仍不合法时长的（直播/超长合辑）剔除
          for (let i = keep.length - 1; i >= 0; i--) {
            const d = keep[i].duration / 1000;
            if (keep[i]._durChecked && (d < 60 || d > 900)) keep.splice(i, 1);
          }
        }
        if (keep.length) console.log("[粽子] YouTube " + keep.length + " 条");
        return keep;
      })
        // 反查/搜索任何一步炸掉都不能让 Promise.all 整体 reject，
        // 否则一次网络抖动会把九个平台的结果全丢掉。
        .catch((e) => { console.log("[粽子] YouTube 失败: " + e.message); return []; })
    );
  }

  // Bilibili
  if (shouldUseBilibili()) {
    jobs.push(
      // ⚠️ 先做一次原名反查（网易云歌手接口），把译名/别名一起拿来搜。
      //    B 站不认「摇晃帝国」这个中文译名，只认「ゆらゆら帝国」；
      //    反查拿到原名后，B 站和 YouTube 都能搜到正确结果。
      // 跟 YouTube 一样：查询词那一发立刻出手，别等别名
      aliasGrace(450).then(async (ag) => {
        const tryOne = async (kwList, anchList, preRaw) => {
        for (let k = 0; k < kwList.length; k++) {
          let raw = [];
          if (k === 0 && preRaw) raw = preRaw;
          else { try { raw = await biliSearch(kwList[k], 1); } catch (e) { continue; } }
          const keep = (raw || [])
            .filter((x) => {
              const d = x.duration / 1000;
              if (d > 0 && (d < 60 || d > 900)) return false;
              if (/伴奏|教学|教程|鼓谱|吉他谱|钢琴谱|karaoke|测评|reaction/i.test(x.title)) return false;
              if (shouldFilterAudiobook() && isAudiobookTitle(x.title)) return false;
              // ⚠️ 标题必须真的命中查询词/原名。B 站是分词匹配，
              //    搜「摇晃帝国」会返回《时光的摇晃》《摇晃的汽水》，
              //    这些标题里根本没有「帝国」两个字，必须拦掉。
              if (!titleMatchesAnchors(x.title, anchList, query)) return false;
              return true;
            })
            .map((x) => ({
              id: x.id, platform: "Bilibili", title: x.title, artist: x.artist,
              album: "", artwork: x.artwork, duration: x.duration,
              playCount: Number(x.play || 0),   // 只有 B 站有这个字段
              _provider: "bilibili", _raw: x,
            }));
          // 这个关键词过滤后全灭就换下一个（比如原名在 B 站没收录）
          if (keep.length) {
            console.log("[粽子] Bilibili " + keep.length + " 条（关键词: " + kwList[k] + "）");
            return keep;
          }
        }
        return [];
        };
        let got = await tryOne([query], [query], await biliFirstRawP);
        if (!got.length && ag.late) {
          const late = await Promise.race([
            aliasPromise,
            new Promise(function (res) { setTimeout(function () { res(null); }, 1200); }),
          ]);
          if (late && late.length) got = await tryOne(late, [query].concat(late), null);
        } else if (!got.length && ag.names.length) {
          got = await tryOne(ag.names, [query].concat(ag.names), null);
        }
        return got;
      })
        .catch((e) => { console.log("[粽子] Bilibili 失败: " + e.message); return []; })
    );
  }

  // Bilibili 鬼畜区（tids=119）
  // ── 为什么要单开一路 ──
  // 音乐区（父分区 3）底下是 130 音乐综合 / 193 MV / 31 翻唱 / 59 演奏，
  // 鬼畜（119）和动画（1）根本不在里面。所以「改革春风吹满地」
  // 「大碗宽面」这类作品在音乐区搜出来是空手，只能靠歌名恰好撞上别的区。
  // 这里并发问一次 119，命中的标记 _guichu（只用来识别来源分区，
  // 排序时不再整体下沉 —— 见 compareRank 顶部那段说明）。
  // ⚠️ 鬼畜区**不**参与「音乐区搜空就退全站」的兜底 —— 那一路退的是全站，
  //    会把时政、游戏、影视区一起卷进来，跟鬼畜不是一回事。
  if (shouldUseBilibili() && shouldBiliGuichu()) {
    jobs.push(
      aliasPromise.then(async (aliases) => {
        const anchors = [query].concat(aliases);
        const kws = aliases.length ? aliases.concat([query]) : [query];
        for (let k = 0; k < kws.length; k++) {
          let raw = [];
          try { raw = await biliSearch(kws[k], 1, "guichu"); } catch (e) { continue; }
          const keep = (raw || [])
            .filter((x) => {
              const d = x.duration / 1000;
              // 鬼畜区大量 20~50 秒的整活片段，60 秒以下当不成一首歌
              if (d > 0 && (d < 60 || d > 900)) return false;
              if (!titleMatchesAnchors(x.title, anchors, query)) return false;
              return true;
            })
            .map((x) => ({
              id: x.id, platform: "Bilibili", title: x.title, artist: x.artist,
              album: "", artwork: x.artwork, duration: x.duration,
              playCount: Number(x.play || 0),
              _provider: "bilibili", _raw: x, _guichu: 1,
            }));
          if (keep.length) {
            console.log("[粽子] Bilibili鬼畜 " + keep.length + " 条（关键词: " + kws[k] + "）");
            return keep;
          }
        }
        return [];
      })
        .catch((e) => { console.log("[粽子] Bilibili鬼畜 失败: " + e.message); return []; })
    );
  }

  // 咪咕官方直出
  if (shouldUseMiguApi()) {
    jobs.push(
      withRetry("咪咕直出", () => miguApiSearch(query, 10)).then((l) =>
        (l || []).map((x) => ({
          id: x.id, platform: "咪咕直出", title: x.title, artist: x.artist,
          album: "", artwork: x.artwork,
          /* ⚠️ 这里原来是 duration: 0，等于把 miguApiSearch 已经算好的时长
             整个扔掉。后果很实在：
               ① completenessOf 只能判「时长未知」，试听片段检查
                  （isPreviewOnly）拿到 ms<=0 直接 return false，全线放行；
               ② 列表里全是 00:00，用户看不出哪条是完整版。
             咪咕不直接给时长，是靠 rateFormats 的文件大小反推的
             （miguDurationMs），那个值本来就是对的，透传即可。 */
          duration: Number(x.duration) || 0,
          _provider: "miguapi", _raw: x,
        }))
      )
    );
  }

  /* ---- 软截止：不再死等最慢的那一路 ----
     ⚠️ 原来这里是 `await Promise.all(jobs)`，等于整次搜索的耗时
        由**最慢**的平台决定。实测（2026-10-19）：
          晴天    总 3.8s，其中酷狗 2.4s / YouTube 2.8s 在拖后腿，
                  其余五路 0.2~1.5s 早就回来了
          年轮说  总 4.1s，YouTube 一路就占了 2.4s
        Promise.all 的做法是：六路各花了 0.3s，白等那一路 2.5s。

     现在改成「先等 1.5s，到点就用已经回来的那些」：
       - 热歌/常规查询：五六个平台的条目在 1.5s 内基本齐了，
         直接出结果，用户少等 1~2 秒
       - 冷门歌：YouTube 那路往往是唯一有货的，如果 1.5s 时
         收到的条目太少（< 25 条），再宽限到 3s，保证召回不退化

     统一用一个「格子」数组收每路的结果：谁先回来谁先填，
     提前返回不影响还没跑完的那几路，它们填完就丢（用户已经看到列表了）。 */
  const SLOTS = new Array(jobs.length);
  let slotsDone = 0;
  const allDone = Promise.all(jobs.map(function (pr, i) {
    return pr.then(
      function (v) { SLOTS[i] = v || []; slotsDone++; return SLOTS[i]; },
      function () { SLOTS[i] = []; slotsDone++; return SLOTS[i]; }
    );
  }));
  /* 软截止 1700ms：实测（2026-10-19）各平台的到达时间是
     酷我 0.15s / QQ 0.75s / 咪咕 0.8s / 酷狗 0.8s / 网易云 1.1s /
     B 站 1.3s / YouTube 1.3s。1700ms 刚好把它们全部收齐，
     而真正会拖到 3 秒以上的只有偶发的限流重试 —— 那种不值得等。
     ⚠️ 一开始设的是 1500ms，结果晴天丢了网易云/酷狗/YouTube 三路
        （列表从 80 条掉到 63 条），所以往上抬了 200ms。 */
  /* ⚠️ 2026-10-19 二次调参：
     实测各平台到达时间 酷我 0.15~0.35s / 鬼畜 0.3~0.65s / QQ 0.45~0.85s /
     酷狗 0.8~1.4s / 咪咕 0.9~1.4s / 网易云 0.6~1.4s / B 站 1.3~1.5s /
     YouTube 0.7~1.8s / JOOX 1.7~2.5s。
     1700/3000 这两档偏保守，JOOX 一路就能把「周杰伦」拖到 2.5s。
     ⚠️ 两个都试过往下压，都退回来了：
        1500 → 晴天从 80 条掉到 55 条（YouTube 那一路 1.5~1.8s 才到）
        软 1700 + 硬 2500 → 「摇晃帝国」这类译名查询有时会丢掉 YouTube 那一路，
                            正是唯一有正确结果的那一路（实测三次里错两次）
        所以软截止维持 1700、硬截止维持 3000 —— 速度靠别的地方赚，
        不靠砍这条线。 */
  const SOFT_DEADLINE = 1700;
  const HARD_DEADLINE = 3000;
  const MIN_EARLY_ITEMS = 25;
  /* ⚠️ 截止时间从**搜索开始**算，不是从「等到这里」的时候算。
     原来的写法是 setTimeout(ms)，而调用它的地方已经在入口之后
     跑了 100~150ms（别名反查、Apple 预热、九个平台的任务组装），
     等于每条截止线都被悄悄往后推了这么久。
     实测「晴天」：T0 到 waitUpTo 已经过了 143ms，
     于是 1700ms 的软截止实际在 1843ms 才生效。 */
  function waitUpTo(ms) {
    const left = Math.max(0, ms - (Date.now() - T0));
    return new Promise(function (res) {
      let done = false;
      const t = setTimeout(function () { if (!done) { done = true; res(); } }, left);
      allDone.then(function () { if (!done) { done = true; clearTimeout(t); res(); } });
    });
  }
  function earlyCount() {
    let n = 0;
    for (let i = 0; i < SLOTS.length; i++) if (SLOTS[i]) n += SLOTS[i].length;
    return n;
  }
  /* 判据不能只看「条数够多」。
     ⚠️ 踩过：搜「IGU Band」时，1.5s 那一批里已经有网易云/QQ/咪咕的
        20 多条**噪声**（Puta Bandida / Bandido Não Namora…），
        条数早就过线了，于是提前返回 —— 而真结果全在 YouTube 那一路，
        它还没回来。结果是「搜得飞快，但一个对的都没有」。
     所以分两种情况：
       A. 早到的结果里**已经有 ≥3 条标题正好等于查询词** → 这是搜歌名
          （《晴天》《起风了》必然一堆标题就叫这个），不用等，直接出。
       B. 没有这种命中 → 可能是搜歌手/译名，真货往往只在 B 站/YouTube，
          老老实实等到 3 秒，别拿噪声凑数。 */
  function earlyExactHits() {
    const want = flatTitle(query);
    if (!want || want.length < 2) return 0;
    let n = 0;
    for (let i = 0; i < SLOTS.length; i++) {
      const arr = SLOTS[i];
      if (!arr) continue;
      for (let j = 0; j < arr.length; j++) {
        const f = flatTitle(arr[j].title);
        if (f && f === want) n++;
      }
    }
    return n;
  }
  await waitUpTo(SOFT_DEADLINE);
  if (earlyCount() < MIN_EARLY_ITEMS || earlyExactHits() < 3) await waitUpTo(HARD_DEADLINE);
  // 到点还没回来的那几路直接放弃（它们的结果对这次返回已经没用了）
  for (let i = 0; i < SLOTS.length; i++) {
    if (SLOTS[i] && SLOTS[i].length) settled.push(SLOTS[i]);
  }

  // ---- 交错合并，避免一个平台刷屏 ----
  const merged = [];
  const maxLen = Math.max.apply(null, settled.map((a) => a.length).concat([0]));
  for (let i = 0; i < maxLen; i++) {
    for (let j = 0; j < settled.length; j++) {
      const it = settled[j][i];
      if (it) { it._rank = i; merged.push(it); }
    }
  }

  // ---- 听书分流：识别得出来的收进「听书专辑池」，单曲列表里剔掉 ----
  const audiobookPool = [];
  const filtered = [];
  for (let i = 0; i < merged.length; i++) {
    const it = merged[i];
    const info = shouldFilterAudiobook() ? audiobookInfo(it.title) : null;
    if (info) {
      // 留一条样本，稍后聚合成专辑
      audiobookPool.push({
        book: info.book,
        episode: info.episode,
        platform: it.platform,
        provider: it._provider,
        id: it.id,
        title: it.title,
        artist: it.artist,
        artwork: it.artwork,
      });
      continue;   // 单曲列表不收
    }
    filtered.push(it);
  }
  // 缓存起来，专辑搜索时用
  cachePut("audiobook", "pool", String(query).trim().toLowerCase(), audiobookPool);

  // ---- 黑名单：之前点过播不了的，直接不显示 ----
  // 用户要求「查出来不能听就不该在列表里」。
  // 这里用「后知后觉」实现：第一次会看到，点播失败后自动拉黑，
  // 下次搜同一个词它就不出现了。比搜索时逐首预检快得多。
  const notDead = [];
  for (let i = 0; i < filtered.length; i++) {
    const it = filtered[i];
    if (isTrackDead(it.platform, it.id)) continue;
    notDead.push(it);
  }
  const filtered2 = notDead.length ? notDead : filtered;

  // ---- 硬门槛：标题跟查询毫无关系的直接丢 ----
  // 咪咕/QQ 这类平台经常返回「歌名里恰好有查询里的几个字」的完全无关曲目
  // （搜「原谅我不明白你的悲伤」给「原谅我年轻不懂爱」），
  // 它们 tier=1 但如果没有这道门槛，照样排在列表里占位。
  const qcore = coreTitle(toSimplified(query));
  const qflat = flatTitle(toSimplified(query));
  /* 原名反查的结果在这里也要能看到 —— 下面那道「跟查询有关吗」的闸门
     必须连同别名一起认，否则拿原名搜回来的 B 站/YouTube 结果会被
     整批判成无关：搜「摇晃帝国」时 keep=0，于是回退成「一条都不筛」，
     咪咕那六条《摇晃》反而全冒出来了。
     query 先注册为真，别名兜在后面。 */
  /* ⚠️ 这里原来是无条件 `await aliasPromise`，等于在尾部又插一段等待。
     实测（2026-10-19）：
       晴天     alias 早已回来，0ms
       脆弱少女组 alias 卡到 1.5s，整次搜索从 3.5s 变成 5s
     别名只影响「标题/歌手能不能认成同一个身份」这一层打分，
     拿不到最多是排序略糙，不该让用户多等一秒多。
     所以限时 700ms：到点就当作没有别名继续往下走。 */
  const aliasWaitMs = Math.max(0, Math.min(ALIAS_TAIL_CAP, ALIAS_ABS_DEADLINE - (Date.now() - T0)));
  const aliasListRaw = await Promise.race([
    aliasPromise,
    new Promise(function (res) { setTimeout(function () { res([]); }, aliasWaitMs); }),
  ]).then(function (v) { return v || []; });
  /* ⚠️⚠️ 这里有个致命的坑，必须挡掉（2026-10-18 定位到）：
     反查拿到的是「这串词指向哪位歌手」，但这个结论只对**纯歌手名查询**成立。
     一旦查询是「歌名 + 歌手」（「晴天 周杰伦」），反查照样会返回歌手名
     ["周杰倫","周杰伦"]，而我们把它注册成「晴天周杰伦 的别名」。
     于是 isArtistQuery("晴天 周杰伦", "周杰伦") 命中 →
     周杰伦的**每一首**歌都被判成 tier=3「完全匹配」，
     列表前十几位全是《最后的战役》《东风破》《星晴》《花海》。
     用户看到的就是「搜晴天，结果一堆别的歌」。
     判据：查询里带空格、且反查结果和查询串不是同一个人名时，不注册。
     纯歌手名查询（「周杰伦」「IGU Band」「摇晃帝国」）仍然照旧注册。 */
  const queryHasSpace = /\s/.test(String(query).trim());
  const aliasList = queryHasSpace ? [] : aliasListRaw;
  const matchAnchors = [query].concat(aliasListRaw);   // 匹配锚点仍然可以用全部别名
  /* 反查到的别名注册成「同一身份」，供 isArtistQuery 使用。
     ⚠️ 这一步必须在 detectArtistQuery 之前 ——
        实测搜「IGU Band」：B 站/YouTube 拿别名「那我懂你意思了」搜回来 12 条，
        artist 字段全是「那我懂你意思了」，跟查询词一个字都不重合，
        不注册的话一条都判不成「这是他的歌」，
        最后被网易云那堆《Puta Bandida》《Bandido Não Namora》压在后面。 */
  if (aliasList.length) {
    const ak = normTextZ(query);
    if (ak) ARTIST_ALIAS[ak] = aliasList.slice();
  }
  /* 整轮先判定「这次搜的是不是一个歌手名」。判定出来的话，
     后面所有单条打分都要换一套逻辑（见 relevanceTier / relevanceExtra）。 */
  /* ⚠️ 再加一道否决：这串字如果同时是「一堆条目都在翻唱的歌名」，
     那就不能当歌手名处理（原因见 isTitleQuery 的注释）。 */
  let artistQuery = detectArtistQuery(query, filtered2);
  /* ⚠️ 这道否决不看 detectArtistQuery 有没有命中 ——
     实测「印第安老斑鸠」时整轮判定是空（只有 2 条 artist 命中），
     但逐条的 isArtistQuery 照样把那批冒名歌手顶到 3 档，
     所以必须单独算一次，同时在 relevanceTier 里也要用它拦一道。 */
  const titleQueryFlag = isTitleQuery(query, filtered2);
  if (titleQueryFlag) {
    console.log("[粽子] 「" + query + "」既是歌名又有人拿它当艺名 → 按歌名搜索");
    artistQuery = "";
  }
  /* 判定没成立、但已经有 ≥2 条结果的歌手字段包含整串查询词时，
     说明「这多半是个人名」，只是这次返回的官方曲不够多（YouTube 每次给的
     Topic 条目在 3~7 条之间抖）。这种时候仍然去问一次 Apple 曲库：
     查到了就用目录把冒名的清掉，查不到就算了 —— 判定本身不改，
     仅仅是多给它一次「证明自己」的机会，避免同一个词有时干净有时一锅粥。 */
  const artistHits = titleQueryFlag ? 0 : countArtistHits(query, filtered2);
  const keep = [];
  let droppedNews = 0;
  for (let i = 0; i < filtered2.length; i++) {
    const it = filtered2[i];
    /* 搜歌手名时，标题写明是新闻/时事/综艺的**直接不收**，
       而不是「压到最后一档」——
       实测搜「周杰伦」，这类视频能占到结果的一成，压在最后依然占着列表位置，
       用户翻到底还是看到「青鸟破防」「门票降价卖不出去」。
       条件是「artist 不是要搜的那位」：真有歌手拿「新闻」当歌名也能留下。 */
    if (artistQuery && NEWS_TITLE_RE.test(it.title) && !isArtistQuery(query, it.artist)) {
      droppedNews++;
      continue;
    }
    /* 视频平台上的标题党视频 → 不是歌。
       实测搜「晴天」混进来一条：
         【🔮透視水晶球】光的頻率解析🌟你的防護罩有多強大？｜…晴天。光之旅程
       标题里确实有「晴天」，但那是**频道名**的一部分，跟周杰伦半点关系没有。

       判据是「查询词之外还有一大坨内容」：
       去掉查询词后剩下的字数 ≥ 8，且带视频特征词。
       正常的《晴天 (Live)》《晴天 - 周杰伦》去掉「晴天」只剩几个字，不会被误杀。 */
    /* ⚠️ 鬼畜区条目必须先放行：NON_MUSIC_VIDEO_RE 里写着「鬼畜 / 整活 /
       恶搞」，这正是它们自己的分类名，不放行会被自己那条规则吃光。
       它们进到这里时已经过 titleMatchesAnchors，标题确实对得上查询词。 */
    if (!it._guichu && (it.platform === "YouTube" || it.platform === "Bilibili") &&
        NON_MUSIC_VIDEO_RE.test(it.title) &&
        !isArtistQuery(query, it.artist)) {
      const residual = coreTitle(it.title).replace(qcore, "").length;
      if (residual >= 8) { droppedNews++; continue; }
    }
    /* 素材类视频（幕后/花絮/预告/采访/首播）—— 视频平台上不管是哪个账号发的，
       都不是一首能听的歌。实测搜「Taylor Swift」，B站头名是
         【Taylor Swift】Patient Zero幕后花絮混剪版MV首播！
       它的 artist 写着 TaylorSwiftChina，含歌手名，
       上面那条「artist 不是歌手本人」的前提完全挡不住它。 */
    if (!it._guichu && (it.platform === "YouTube" || it.platform === "Bilibili") &&
        MEDIA_VIDEO_RE.test(it.title)) {
      const residual2 = coreTitle(it.title).replace(qcore, "").length;
      if (residual2 >= 6) { droppedNews++; continue; }
    }
    /* 新闻媒体署名的视频 —— 同上，是娱乐新闻不是歌。
       实测搜「赵薇 左耳」，苹果日报那条《蘇有朋處女導《左耳》操瘦6公斤
       　不敢與趙薇比較》标题里歌名歌手全齐，前面几条规则一个都拦不住，
       结果它稳稳挤进「能听的原唱」那一段。
       ⚠️ 判据要「去掉歌名歌手后还剩 6 字以上」——《新闻》这种真歌名不算。 */
    if (!it._guichu && (it.platform === "YouTube" || it.platform === "Bilibili") &&
        NEWS_SOURCE_RE.test(it.title)) {
      const residual3 = coreTitle(it.title).replace(qcore, "").length;
      if (residual3 >= 6) { droppedNews++; continue; }
    }
    const tcore = coreTitle(it.title);
    const tflat = flatTitle(it.title);
    // 判断「这条结果跟查询有没有关系」。
    // ⚠️ 不能用简单的双向 indexOf：
    //    查询「那我懂你意思了」含「了」→ 单曲「了」被判相关；
    //    含「有」→ 「有」也混进来（咪咕按分词乱匹配大量触发）。
    // 改成：查询按空格分词，候选标题至少命中一个「有实义的词」（≥2 字）。
    // ⚠️ 这里是 `\s`（空白），不是字面量字母 s —— 写成 /[s]+/ 的话，
    //    「Taylor Swift」会被按字母 s 切成 "Taylor " / "wift"。
    const qToks = String(query).split(/\s+/).map((t) => coreTitle(toSimplified(t))).filter((t) => t && t.length >= 2);
    const qcoreLen = qcore.length;
    const related = (function () {
      /* 0) 搜的是歌手名时，看歌手字段而不是标题
         ⚠️ 这道门槛原本只按标题字面重叠判断，
            搜「周杰伦」→ 歌曲标题里都不含「周杰伦」→ 全被当成无关删掉，
            最后只剩 YouTube 那些标题里带名字的八卦视频。
            歌手对得上就是有关系的，轮不到标题说话。 */
      if (artistQuery || isArtistQuery(query, it.artist)) return true;
      /* 0.5) 标题命中原名/别名也算有关。
         B 站/YouTube 那两路是**拿原名搜的**，回来的标题里写的是
         「ゆらゆら帝国」，跟用户输入的「摇晃帝国」一个字都不重合。
         不认别名的话这两路的结果会被这道闸门全删 ——
         而它们恰恰是这个功能唯一想要的产出。 */
      if (aliasList.length && titleMatchesAnchors(it.title, matchAnchors, query)) return true;
      /* 0.6) 演唱者字段命中别名也算（YouTube 的 Topic 频道条目、
             B 站投稿标题里只写艺人名的情况） */
      /* ⚠️ titleQueryFlag 时不认：蹭歌号的歌手字段写的就是查询词本身，
         认了的话「爷爷泡的茶」那五条毫不相干的曲子会被判成相关。 */
      if (aliasList.length && !titleQueryFlag) {
        const an2 = normTextZ(it.artist);
        if (an2) {
          for (let k = 0; k < aliasList.length; k++) {
            const ak = normTextZ(aliasList[k]);
            if (ak && an2.indexOf(ak) >= 0) return true;
          }
        }
      }
      // 1) 标题包含完整查询（最理想）
      if (qcore && tcore && tcore.indexOf(qcore) >= 0) return true;
      if (qflat && tflat && tflat.indexOf(qflat) >= 0) return true;
      // 2) 查询含标题，但标题必须够长（防「了」「有」这种单字命中）
      const minLen = Math.max(3, Math.floor(qcoreLen * 0.5));
      if (tcore.length >= minLen && qcore && qcore.indexOf(tcore) >= 0) return true;
      if (tflat.length >= minLen && qflat && qflat.indexOf(tflat) >= 0) return true;
      // 3) 任一查询词出现在标题里（长查询拆词后仍能召回）
      for (let k = 0; k < qToks.length; k++) {
        if (tcore.indexOf(qToks[k]) >= 0 || tflat.indexOf(qToks[k]) >= 0) return true;
      }
      // 4) 查询本身很短时放宽
      if (qcoreLen <= 2) return true;
      return false;
    })();
    /* ⚠️ 这里以前是 `if (related) keep.push(it)` —— 直接把「跟查询沾不上边」
       的条目删掉。删得太狠了：搜「摇晃帝国」时咪咕回的那批《摇晃》还算
       挨着边的，一刀切下去连个兜底都没有；更糟的是万一闸门判错，
       正确结果会被整批删光（见上面别名那段注释）。
       用户的要求是「降权就行」，不是「不许出现」。
       所以现在：全留下，只给它打 _rel=0 的标记，排序时压到相关条目后面。 */
    it._rel = related ? 1 : 0;
    keep.push(it);
  }
  const relevant = keep;
  if (droppedNews) console.log("[粽子] 过滤非音乐内容 " + droppedNews + " 条");

  /* ============================================================
   * 搜的是专辑名时，把这张专辑的曲目捞到前面
   *
   * 实测（2026-10-19 搜「叶惠美」）：咪咕直出回的 8 首原曲
   * （以父之名 / 晴天 / 三年二班…）排在 19 位之后，
   * 前面全是「叶惠美评周杰伦新歌MV」「周杰伦母亲叶惠美罕露面」
   * 这类解说/资讯视频。原因：曲目标题里不含专辑名，
   * 被判成「跟查询沾不上边」（tier=1），而视频标题里正好有三个字（tier=2）。
   *
   * 判据：结果里至少 3 条的**专辑名**跟查询一模一样。
   * 满足就认为这是一次「搜专辑」，把这张专辑的**主艺人**的曲目提到 tier3。
   *
   * ⚠️ 一定要按主艺人过滤，不能只看专辑名：
   *    搜「叶惠美」时网易云有一张**同名翻唱专辑**
   *    （artist=王珏子乔，6 首，专辑名也叫《叶惠美》），
   *    只看专辑名会把这些翻唱一起顶到最前面。
   *    主艺人取「这些条目里出现次数最多的歌手」（周杰伦 8 首 vs 王珏子乔 6 首）。
   * ============================================================ */
  (function () {
    const qf = flatTitle(query), qc = coreTitle(query);
    if (!qf) return;
    const artCount = {};
    let albHit = 0;
    for (let i = 0; i < relevant.length; i++) {
      const alb = albumOf(relevant[i]);
      if (!alb) continue;
      if (flatTitle(alb) !== qf && coreTitle(alb) !== qc) continue;
      albHit++;
      const a = normText(splitSingers(relevant[i].artist)[0] || "");
      if (a) artCount[a] = (artCount[a] || 0) + 1;
    }
    if (albHit < 3) return;
    let topN = "", topC = 0;
    for (const k in artCount) {
      if (artCount[k] > topC) { topC = artCount[k]; topN = k; }
    }
    if (!topN || topC < 3) return;

    /* ⚠️ 「专辑和同名主打歌」必须先分辨，否则搜《年轮说》这种
       会把整张专辑的《观众》《与我无关》《单》全顶到前面，
       用户明明只是想听那一首歌。
       判据看**主艺人名下**有没有一首歌就叫这个名字：
         搜「年轮说」→ 杨丞琳的《年轮说》标题正好等于查询词 →
                        这是主打歌，按搜歌处理，整段跳过
         搜「叶惠美」→ 周杰伦名下没有叫《叶惠美》的歌 →
                        这是专辑名，曲目置顶
       ⚠️ 只看主艺人，不看所有条目：搜「范特西」时网易云有个
          YoungNine4 的《范特西》，那是别人的同名歌，不能因此否决。 */
    for (let i = 0; i < relevant.length; i++) {
      if (normText(splitSingers(relevant[i].artist)[0] || "") !== topN) continue;
      const tc = coreTitle(relevant[i].title);
      if (tc && (tc === qc || flatTitle(relevant[i].title) === qf)) return;
    }
    let boosted = 0;
    for (let i = 0; i < relevant.length; i++) {
      const a = normText(splitSingers(relevant[i].artist)[0] || "");
      if (a !== topN) continue;
      relevant[i]._albq = 1;
      relevant[i]._rel = 1;
      boosted++;
    }
    console.log("[粽子] 识别为专辑名，专辑曲目置顶 " + boosted + " 条");
  })();

  // ---- 热度：同一标题被几个平台收录 ----
  const titleHits = {};
  for (let i = 0; i < relevant.length; i++) {
    const k = normText(relevant[i].title);
    titleHits[k] = (titleHits[k] || 0) + 1;
  }
  for (let i = 0; i < relevant.length; i++) {
    relevant[i]._heat = titleHits[normText(relevant[i].title)] || 1;
  }

  // ---- 权威目录：确认「这首歌的正式发行版长什么样」----
  // ⚠️ 关键：这一层**只加分、不过滤**。
  //    iTunes / Apple Music 里查不到「那我懂你意思了」这个乐队，
  //    硬过滤会把用户的冷门歌全删光 —— 那正是他用这个插件的理由。
  //
  // ⚠️ 传进去的不止第一条的歌手：搜索结果里 artist 字段最靠前的几位
  //    才代表「这首歌可能是谁的」，只用第 1 条会被一条翻唱带偏。
  const authArtists = [];
  const seenAuthArtist = {};
  for (let i = 0; i < relevant.length && authArtists.length < 8; i++) {
    const nm = String(relevant[i].artist || "").trim();
    const k = singerNorm(nm);
    if (!k || seenAuthArtist[k]) continue;
    seenAuthArtist[k] = 1;
    authArtists.push(nm);
  }
  const exactTitleHit = relevant.some(function (it) {
    const f1 = flatTitle(it.title);
    return f1 && f1 === flatTitle(query) && f1.length >= 2;
  });
  let appleQuery = query;
  if (!artistQuery && queryHasSpace) {
    const parts = String(query).trim().split(/\s+/);
    if (parts.length >= 2) appleQuery = parts[parts.length - 1];
  }
  /* ⚠️ 权威目录（iTunes 歌曲搜索）和 Apple 歌手目录原来是**串行** await 的，
     各要 0.2~0.8s，加起来就是白白多等一截 —— 实测「起风了」这两步共 0.8s，
     占了总耗时的四分之一。两者互不依赖（都只依赖上面算出来的结果集），
     所以先一起发出去，再一起等。
     条件判断放在发请求之前：不满足条件就不发那一路，逻辑跟原来完全一致。 */
  const _willAskApple = artistQuery || artistHits >= 2 || !exactTitleHit || (appleQuery !== query);
  /* ⚠️ 只有当 appleQuery 正好等于 query 时才能复用预热的那一发；
     组合查询（「晴天 周杰伦」）的问题不是同一个，得现问。 */
  const _appleP = !_willAskApple
    ? Promise.resolve(null)
    : (applePreP && appleQuery === query
        ? applePreP
        : (appleTailPreP && appleQuery === String(query).trim().split(/\s+/).pop()
            ? appleTailPreP
            : appleArtistCatalog(appleQuery).catch(function () { return null; })));
  const auth = await authorityHint(query, authArtists, authPreP);

  /* ---- 歌手名查询：用 Apple Music 的完整目录当白名单 ----
     实测搜「那我懂你意思了」：酷狗歌手接口 data:null（这个乐团没被收录），
     于是判定不出「这是歌手名搜索」，走通用排序，
     头部全是冒用同名艺名的网络歌手（《那年夏天》《凤囚凰》《金秋的足迹》）。
     而 Apple Music 里有这个乐团完整的三张专辑 30 首。
     用它给真歌手加分、给同名冒名降权。 */
  /* 什么时候值得花 200ms 去问 Apple ——
     ⚠️ 不能只靠「歌手字段命中」，那对冷门独立乐团整个失效：
        搜「脆弱少女组」时 YouTube 给的 artist 是「大團誕生 TheNextBigThingTW」
        「o ̇ω ̇o」这类频道名，一个字都不重合，hits=0。
     加一条兜底判据：**结果里没有一条的标题正好等于查询词**。
        搜歌名《起风了》《晴天》必然有一堆标题就叫这个，跳过提问（省 200ms）；
        搜人名则一条都不会正好等于，去问 Apple 才有意义。
     真伪最终由 Apple 自己把关：演出者名对得上 + 曲目 ≥10 首才算。 */
  let appleCat = null;
  /* ⚠️ 组合查询（「晴天 周杰伦」）也要能用上 Apple 目录。
     直接拿整串去问当然不行 —— Apple 里没有叫「晴天周杰伦」的歌手。
     所以：组合查询时把「歌手那一半」拎出来问。
     怎么拎：结果是按「歌名 + 歌手」写的，取最后一个词当歌手名
     （中文习惯「歌名 歌手」，英文也多是这个顺序）。
     查到之后**只用来打分/白名单，不用来删条目** —— 删的条件里
     写死了 artistQuery，组合查询不会命中，不会误杀。
     这样《晴天》的原唱条目能拿到 trackHit=45，
     而「晴天(深情版)」这类反而因为不在目录里被压到 -60。 */
  appleCat = await _appleP;
  if (appleCat) {
    console.log("[粽子] Apple 目录「" + appleCat.name + "」"
      + appleCat.albums.length + " 张专辑 / " + appleCat.tracks.length + " 首");
  }

  /* ---- YouTube Music 目录兜底 ----
     实测搜「李志」（2026-10-21）：单曲列表 47 条里没有一首是他的正经作品，
     前三条是网易云的《天涯》、QQ 的《苏州河》《阿楚姑娘》，
     后面全是 B 站搬运和鬼畜（《关于李志是个营销号》《亲戚李志斌的笑容》）。
     原因：他的作品在国内平台全部下架，Apple Music 也搜不到他，
     所以上面那套 Apple 白名单整个失效 —— 没有目录就没法区分真伪。
     但 YouTube Music 上有他完整的 13 张专辑 110 首，而且每条都自带 videoId，
     拿到就能直接播。
     所以：**Apple 没有目录、或目录明显残缺时，改问 YTM**。
     ⚠️ 只在「像在搜歌手」时才问：YTM 目录要 2.6s（逐张拉曲目），
        搜歌名时白花这 2.6s 是不能接受的。 */
  let ytmCat = null;
  /* ⚠️ 「像在搜歌手」这道闸要放宽一档（2026-10-21 实测搜「赵薇」）：
     artistHits 只有 1 —— 列表前排被 Apple 白名单清过，剩下的她自己那条
     artist 写的是繁体「趙薇」，另外几条是别人挂名。于是 artistQuery 和
     artistHits>=2 都不成立，目录这条路整个不触发，可它明明就是个人名。
     补一条：**Apple 认的这位歌手，名字跟查询词就是同一个**，
     且列表里没有任何一条标题正好等于查询词（那才是搜歌名）。
     ⚠️ 「名字跟查询词同一个」这句不能省：组合查询「赵薇 左耳」取的尾词是
        「左耳」，Apple 会给一首叫《左耳》的歌开一个 1 张 1 首的「目录」，
        不比对名字就会拿它去问 YTM（实测白花 1.7s）。 */
  const _wantCatalog = artistQuery || artistHits >= 2 ||
    (!!appleCat && !exactTitleHit && normTextZ(appleCat.name) === normTextZ(query));
  const _appleWeak = !appleCat || appleCat.tracks.length < 10;
  if (_wantCatalog && _appleWeak) {
    const ytmT0 = Date.now();
    /* 给 2.8s 上限：目录本身 2.6s，再多就是白等。
       超时就用已经缓存到的那份（YTM_CAT_CACHE 在函数内部自己写，
       下次搜同一个歌手直接命中）。 */
    ytmCat = await Promise.race([
      ytmArtistCatalog(appleQuery || query).catch(function () { return null; }),
      new Promise(function (res) { setTimeout(function () { res(null); }, 2800); }),
    ]);
    if (ytmCat) {
      console.log("[粽子] YTM 目录「" + ytmCat.name + "」"
        + ytmCat.albums.length + " 张专辑 / " + ytmCat.tracks.length + " 首"
        + "（" + (Date.now() - ytmT0) + "ms）");
    }
  }
  /* 后续打分/补歌统一用这个：Apple 优先，Apple 空就用 YTM。
     ⚠️ 只在**补歌和加分**上用 YTM，不用它硬删 —— 见 ytmArtistCatalog 的注释。 */
  const catForFill = appleCat || ytmCat;

  /* ---- MusicBrainz 目录：Apple 和 YTM 都太薄时的第三份证词 ----
     实测（2026-10-21）搜「赵薇」：
       Apple 只有 1 张 10 首，YTM 也是 1 张 10 首（两边都只认《天使旅行箱》），
       而 MB 有 13 张 118 首 —— 《双》《飘》《我们都是大导演》全在。
     这种时候只靠 Apple/YTM 打分，列表里一半的真歌会被当成「不在目录里」，
     排序反而被 B 站搬运顶上去。
     ⚠️ MB 一次请求 1.2~4.5s，而且全局限流 1 req/s，
        所以只在「前面两家都薄（<20 首）」且判定是搜歌手时才问。
     ⚠️ MB 缺歌比 Apple 少，所以 mbCatScore **只加分不罚分**。 */
  let mbCat = null;
  /* ⚠️ 只在苹果和 YouTube Music **都没有目录**时才在这里问 MB。
     试过放宽（Apple 目录薄一点就问），实测反而更差：
     搜「赵薇」Apple 有 1 张 10 首，问 MB 花掉 1.6s 之后，
     后面「Apple 目录补全官方音源」那一段的总预算就只剩 575ms，
     一首都没补到 —— 头部从「蝶 / 恰恰愛 / 小蜜蜂」（赵薇本人的 YouTube
     官方音源）退成「嘤嘤怪」「葛瑞特音樂」这些搬运。
     MB 的分数再好，也补不出一个能播的音源；而 Apple 补全能。
     真正需要 MB 的场合是**两家都没有目录**（列表本来就一片乱），
     那时多等它 5s 是净赚。其余情况走下面的后台预热，第二次搜直接命中。 */
  if (_wantCatalog && !appleCat && !ytmCat) {
    const mbT0 = Date.now();
    /* 5s 预算：MB 是两步调用（找艺人 + 拉发行），中间还有 1.1s 限流间隔，
       实测完整跑一次 4~7s。这里本来就是最乱的一档，等得起。 */
    mbCat = await Promise.race([
      mbArtistCatalog(appleQuery || query).catch(function () { return null; }),
      new Promise(function (res) { setTimeout(function () { res(null); }, 5000); }),
    ]);
    if (mbCat) {
      console.log("[粽子] MusicBrainz 目录「" + mbCat.name + "」"
        + mbCat.albums.length + " 张 / " + mbCat.tracks.length + " 首"
        + "（" + (Date.now() - mbT0) + "ms）");
    }
  }

  /* ---- 有权威目录时，同名冒用的条目直接不收 ----
     搜歌手名时，用户要看的是「这个人的歌」。
     冒名歌手的 artist 字段跟真歌手一模一样，光靠名字永远分不开，
     但 Apple 目录能证明「这首不在他的唱片里」。

     ⚠️ 敢硬删的前提是三条同时成立：
       1. 判定成歌手名查询（不然搜歌名会误杀翻唱）
       2. Apple 目录是**完整的**（没被 200 条上限截断，且曲目 ≥15 首）
          —— 陈奕迅那种 112 张专辑肯定截断，一删就少一半真歌
       3. 这首既不在他的曲目表、也不在他的专辑表里
     挂名的合辑/单曲如果专辑名对得上，会走 +30 那条，不会被删。

     ⚠️ 兜底：删完如果剩不到 5 条，说明目录不全，整批放回不删。 */
  let appleDropped = 0;
  /* ⚠️ 条件是「判定成立**或**至少两条结果的歌手字段就是这串词」。
     只认 artistQuery 的话，判定在临界点抖一下，白名单就整个失效 ——
     那正是「有时干净有时一锅粥」的另一半原因。
     appleArtistCatalog 本身已经要求「这串词确实是一位歌手」
     （歌手名对得上，或者歌曲搜索里压倒性指向同一个人），
     所以这里放宽不会把搜歌名的场景误伤。 */
  if (appleCat && (artistQuery || artistHits >= 2) && appleCat.complete) {
    const filteredByApple = [];
    for (let i = 0; i < relevant.length; i++) {
      if (appleCatScore(relevant[i], appleCat) < 0) { appleDropped++; continue; }
      filteredByApple.push(relevant[i]);
    }
    if (filteredByApple.length >= 5) {
      relevant.length = 0;
      for (let i = 0; i < filteredByApple.length; i++) relevant.push(filteredByApple[i]);
      console.log("[粽子] Apple 目录剔除同名冒名 " + appleDropped + " 条");
    } else {
      appleDropped = 0;
    }
  }

  /* ---- 目录补全：Apple 有、但平台结果里一条录音室版都没有的曲目 ----
     实测搜「脆弱少女组」（2026-10-18）：
       酷我 total=0，咪咕只回「开心少女组 / 花季少女三人组」这类无关组合，
       YouTube 搜出来全是现场、专访、《大團誕生》切片、B 站翻唱 ——
       一首录音室原版都没有。可 Apple 目录里它有 4 张 EP、13 首，
       逐首「歌名 + 歌手」去 YouTube 搜，13/13 全部命中
       「FragileGirls - Topic」官方频道。

     ⚠️ 只在「判定成歌手名查询」时做，且给足三道闸：
       1. 目录必须没被截断（full），否则等于照着一份残缺清单补
       2. 曲目 10~60 首 —— 少于 10 首不值得（多半是野鸡同名歌手），
          多于 60 首是周杰伦那种，补不完还超时
       3. 最多补 24 首，且只补「结果里确实没有的」
     ⚠️ 补进来的是 YouTube 官方频道（Topic）的真音源，不是占位死链；
        artist 刻意写 Apple 的**歌手本名**而不是频道名 ——
        频道名是「FragileGirls」，跟查询「脆弱少女组」一个字都不重合，
        排序会因为「歌手对不上」把它们全压到现场视频后面。 */
  let appleFilled = 0;

  /* ---- YTM 目录补全：曲目自带 videoId，直接就是可播音源 ----
     跟 Apple 那条「逐首去 YouTube 搜」完全不同 —— 这里**零额外请求**，
     目录里的每一条都已经是 YouTube 上真实的官方音轨（ATV/OMV）。
     实测「李志」：13 张 110 首，全部带 videoId，取流直接可用。
     ⚠️ 同样只在像搜歌手时做，且最多补 40 首（别把列表撑成 110 条）。 */
  /* ⚠️ 只在 Apple 目录**用不上**时才走 YTM 补全。
     Apple 那边是「逐首去 YouTube 搜 Topic 官方音源」，挑得比 YTM 目录更准
     （YTM 的专辑排序按新→旧，代表作反而排在后面）。
     实测「脆弱少女组」：一加 YTM 补全就把它挤掉，头部从
     「脆弱少女組 - 都市青春戀曲（樂人 Session）」退回到 B 站杀马特搬运。 */
  const _useYtmFill = !appleCat || appleCat.tracks.length < 10;
  if (ytmCat && _useYtmFill && (artistQuery || artistHits >= 2)) {
    /* ⚠️⚠️ 这里的 have 必须**按歌手**算，不能只按歌名 ——
       实测（2026-10-21）搜「李志」：
         QQ 上有耿十三翻唱的《关于郑州的记忆》（artist=耿十三）
         如果只按歌名去重，他就会把李志自己在 YTM 上的原唱挡在门外，
         结果代表作《關於鄭州的記憶》《天空之城》全被吞掉，
         头部只剩《門》《日》《死人》这种冷门 B 面。
       判据：只有当条目的歌手字段确实是这位歌手时，才算「已经有了」。 */
    const catNameN = normTextZ(ytmCat.name);
    const sameAsCat = function (it) {
      const a = normTextZ(splitSingers(it.artist || "")[0] || "");
      if (!a || !catNameN) return false;
      return a === catNameN || a.indexOf(catNameN) >= 0 || catNameN.indexOf(a) >= 0;
    };
    const have = {};
    for (let i = 0; i < relevant.length; i++) {
      if (!sameAsCat(relevant[i])) continue;
      const n = normTextZ(relevant[i].title);
      if (n) have[n] = 1;
      const c = normTextZ(coreTitle(relevant[i].title));
      if (c) have[c] = 1;
    }
    /* 已经在列表里的「他自己的那条」也要按歌手比一遍，
       否则补进来的会和已有的重复（同名不同平台）。 */

    const add = [];
    const seenAdd = {};
    /* ⚠️ YTM 的专辑顺序是「新→旧」，而李志最新那几张恰恰全是
       《李志、電聲與管弦樂》《爵士樂與不插電新編》《2017跨年版》——
       也就是改编/现场版。直接按顺序补，列表头部就全是
       「愛（2017跨年版）」「門（2016跨年版）」，一首原始录音室版都没有。
       用户搜一个歌手，想看的是他本人的原曲，不是改编合集。
       所以分两轮挑：先挑「干净的录音室曲目」，不够再补剩下的。 */
    const YTM_DIRTY_RE = /跨年版|不插電|不插电|管弦|交響|交响|現場|现场|演唱[会會]|巡演|音樂節|音乐节|翻唱|伴奏|純享|纯享|live|unplugged|acoustic/i;
    const clean = [];
    const dirty = [];
    for (let i = 0; i < ytmCat.tracks.length; i++) {
      const t = ytmCat.tracks[i];
      const n = normTextZ(t.title);
      if (!n || have[n] || seenAdd[t.id]) continue;
      const c = normTextZ(coreTitle(t.title));
      if (c && have[c]) continue;
      if (YTM_DIRTY_RE.test(t.title || "") || YTM_DIRTY_RE.test(t.album || "")) dirty.push(t);
      else clean.push(t);
    }
    /* 热门歌曲按 YTM 自己的排位给个序号，排序时要靠它压过「标题越短越前」。 */
    const topIdx = {};
    for (let i = 0; i < (ytmCat.top || []).length; i++) {
      const t = ytmCat.top[i];
      if (t && t.id) topIdx[t.id] = i + 1;
    }
    const ordered = clean.concat(dirty);
    for (let i = 0; i < ordered.length && add.length < 40; i++) {
      const t = ordered[i];
      if (seenAdd[t.id]) continue;
      seenAdd[t.id] = 1;
      add.push({
        id: t.id,
        platform: "YouTube",
        /* 标题用 YTM 的，但把「歌手 - 歌名」这种写法剥干净，
           否则列表里会显示成「李志 - 关于郑州的记忆」 */
        title: t.title || "",
        artist: t.artist && normTextZ(t.artist) !== normTextZ(ytmCat.name)
          ? ytmCat.name
          : ytmCat.name,
        album: t.album || "",
        artwork: t.artwork || "",
        duration: t.duration || 0,
        _provider: "youtube",
        _atv: !!t._atv,
        _rel: 1,          // 来自已验证的歌手目录，天然相关
        _ytm: 1,          // 标记：这条是目录补进来的
        /* YTM 自己排的代表作序号（1 = 最热）。0/undefined = 不在热门里。 */
        _ytmTop: topIdx[t.id] || 0,
      });
    }
    if (add.length) {
      for (let i = 0; i < add.length; i++) relevant.push(add[i]);
      appleFilled = add.length;
      console.log("[粽子] YTM 目录补全 " + add.length + " 首官方音源");
    }
  }

  if (appleCat && appleCat.full && appleCat.tracks.length >= 10 &&
      appleCat.tracks.length <= 60) {
    const have = {};
    for (let i = 0; i < relevant.length; i++) {
      const n = normTextZ(relevant[i].title);
      if (n) have[n] = 1;
      const c = normTextZ(coreTitle(relevant[i].title));
      if (c) have[c] = 1;
    }
    const missing = [];
    for (let i = 0; i < appleCat.tracks.length && missing.length < 24; i++) {
      const t = appleCat.tracks[i];
      const n = normTextZ(t.title);
      if (!n || have[n]) continue;
      const c = normTextZ(coreTitle(t.title));
      if (c && have[c]) continue;
      missing.push(t);
    }
    if (missing.length) {
      const conn = [];
      const CONC = 8;
      /* ⚠️ 这一路是「逐首去 YouTube 搜一遍」，24 首分 4 批，
         每批 1.3s 左右 —— 实测「脆弱少女组」光这里就要 4 秒，
         整次搜索被拖到 7 秒。用户搜个歌手等七秒是不能接受的。
         所以给它一个总预算：到点就收手，已经补到的照样用，
         没补完的下次搜索（Apple 目录已缓存）会继续补。
         宁可少几首，也不能让界面一直转圈。 */
      /* ⚠️ 补全原来是「独立 2600ms 预算」，也就是说它**从平台搜索结束之后**才开始计时：
         平台 2.5s + 补全 2.6s = 5~6s（实测「脆弱少女组」6270ms）。
         现在改成吃**总预算**：整次搜索最多 3.4s，补全只能用剩下的那点时间。
         补到的照样用，补不完的下次搜（Apple 目录已缓存）接着补。 */
      /* 3600 是「总预算」，不是「一定会用满」：只有 Apple 目录够小
         （10~60 首，冷门独立乐团那种）、而且确实缺货时才补，
         而且补到一批就走人。实测「脆弱少女组」2.7s 起步 + 一批补全 ≈ 3.4s；
         周杰伦/陈奕迅那种大目录根本进不到这里。 */
      const TOTAL_BUDGET = 3600;
      const FILL_BUDGET = Math.max(0, Math.min(2600, TOTAL_BUDGET - (Date.now() - T0)));
      const fillT0 = Date.now();
      /* 剩余预算不够跑完一批（8 个并发大约要 0.9~1.3s）就别开这一轮，
         否则必然是「发出去了但没等到」，白白多花一秒多。 */
      const FILL_MIN_MS = 900;
      for (let i = 0; i < missing.length; i += CONC) {
        /* 剩余预算连一批都跑不完就别开这一轮 —— 开了也是白等。
           （「白等」是实测出来的：预算 1234ms 时照样发一批，那批要 2s，
             于是整次搜索从 2.4s 变成 4.4s，「脆弱少女组」就是这么超的。） */
        const left = FILL_BUDGET - (Date.now() - fillT0);
        if (left < FILL_MIN_MS) {
          if (conn.length || i === 0) {
            console.log("[粽子] Apple 目录补全预算不足（余 " + left + "ms），本轮补 " + conn.length + "/" + missing.length);
          }
          break;
        }
        const batch = missing.slice(i, i + CONC);
        /* 批内并发不变，但**整批套一个剩余预算的时限**：
           到点就收手，已经 push 进 conn 的照样用 —— 结果是一条一条
           push 进来的，所以超时不会把已经拿到的丢掉。 */
        await Promise.race([
          Promise.all(batch.map(async function (t) {
          const wantN = normTextZ(t.title);
          const wantBare = wantN.replace(/[.,!?;:'"·、。，！？；：…—–\-]/g, "");
          let list = [];
          try { list = await ytSearchRaw(t.title + " " + appleCat.name); } catch (e) { return; }
          let best = null, bestSc = -Infinity;
          for (let j = 0; j < (list || []).length; j++) {
            const y = list[j];
            const yn = normTextZ(y.title || "");
            if (!yn) continue;
            const yBare = yn.replace(/[.,!?;:'"·、。，！？；：…—–\-]/g, "");
            const hitTitle = yn.indexOf(wantN) >= 0 || wantN.indexOf(yn) >= 0 ||
                             (wantBare && yBare.indexOf(wantBare) >= 0) ||
                             (wantBare && wantBare.indexOf(yBare) >= 0 && yBare.length >= 2);
            if (!hitTitle) continue;
            let sc = 0;
            if (/[-–—]\s*Topic\s*$/i.test(String(y.artist || ""))) sc += 100;
            if (yn === wantN) sc += 30;
            else if (yBare === wantBare) sc += 25;
            else sc -= Math.max(0, yn.length - wantN.length);
            if (/歌词|歌詞|lyrics|cover|翻唱|remix|dj|伴奏|纯享|純享|live|現場|现场/i.test(y.title || "")) sc -= 60;
            const sec = ytDurSec(y.durationText);
            if (sec > 0 && t.dur > 0) {
              const d = Math.abs(sec - Math.round(t.dur / 1000));
              sc += d <= 12 ? 40 : (d <= 40 ? 5 : -100);
            }
            if (sc > bestSc) { bestSc = sc; best = y; }
          }
          if (!best || bestSc <= 0) return;
          conn.push({
            id: best.id,
            platform: "YouTube",
            title: best.title || t.title,
            artist: appleCat.name,
            album: t.album || "",
            artwork: best.artwork || "",
            duration: t.dur || (ytDurSec(best.durationText) * 1000),
            _provider: "youtube",
            _raw: best,
          });
        })),
          new Promise(function (res) { setTimeout(res, left); }),
        ]);
      }
      if (conn.length) {
        for (let i = 0; i < conn.length; i++) {
          /* ⚠️ 这些条目是**补全阶段**加进来的，没走过上面那道相关性闸门，
             _rel 一直是 undefined（=0），排序时会被当成「跟查询沾不上边」，
             压在网易云/QQ 那堆分词噪声后面。
             实测搜「IGU Band」：YouTube 补进来的 20 首真歌全排在
             《Puta Bandida》(DJ IGU BEATS) 后面。
             它们来自 Apple 为该歌手验证过的目录，天然就是相关的 → 直接给 1。 */
          conn[i]._rel = 1;
          relevant.push(conn[i]);
        }
        appleFilled = conn.length;
        console.log("[粽子] Apple 目录补全 " + conn.length + " 首官方音源");
      }
    }
  }

  // ---- 去重 ----
  /* ⚠️ 分组 key 必须区分「Live 版」和「录音室原版」。
     之前 key 只有「标题|歌手」，而 normText 会把括号整个剥掉：
         晴天            → 晴天
         晴天 (Live)     → 晴天      ← 括号内容被抹掉
         晴天（演唱会版）  → 晴天
     于是「晴天」「晴天 (Live)」和各种演唱会版全被归一成同一个 key，
     去重后只剩得分最高的那一条 —— Live 版就这么整条消失了。
     实测「晴天」原本有 5 条不同版本，最后只剩 1 条。

     现在把 isLive 打进 key：原版和现场版各留一条，谁都不吞谁。 */
  const groups = new Map();
  let order = 0;
  for (let i = 0; i < relevant.length; i++) {
    const it = relevant[i];
    it._live = isLiveVersion(it.title, albumOf(it));
    const key = normText(it.title) + "|" + normText(splitSingers(it.artist)[0] || "") +
      (it._live ? "|LIVE" : "|STUDIO");
    it._tier = relevanceTier(it.title, query, it.artist, artistQuery, titleQueryFlag);
    /* 专辑名查询命中的曲目（见上面 _albq 那段）提到最高档。
       ⚠️ 变体词（live/remix/翻唱…）不提，否则专辑的翻唱版会跟原曲抢位。 */
    if (it._albq && !VARIANT_RE.test(it.title) && !isCoverTitle(it.title)) it._tier = 3;
    it._extra = relevanceExtra(it.title, query, it.artist, artistQuery);
    it._bone = officialBone(it.title, it.artist, it.platform, query, artistQuery);
    it._hot = hotScore(it.playCount);
    it._auth = authorityScore(it, auth);   // ← 新增：权威库加分
    /* ⚠️ 用 catForFill 而不是 appleCat：Apple 没有目录时（李志那种全线下架），
       要退到 YTM 目录来打分，否则冒名的 B 站搬运会一直顶在最前面。
       仍然只影响排序，不删条目。 */
    /* ⚠️ MB 目录叠在 Apple/YTM 之上，但**只加分不罚** ——
       它缺歌比 Apple 少（赵薇的敏感曲目 MB 也没有），
       罚分会把平台上真有的歌一起打下去。 */
    it._apc = appleCatScore(it, catForFill) + mbCatScore(it, mbCat); // ← 歌手目录白名单
    it._order = order++;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }

  const out = [];
  groups.forEach((arr) => {
    arr.sort((a, b) => {
      // 鬼畜条目跟普通条目一起比 tier，不再整体沉底（理由见 compareRank）
      // ⚠️ tier 越大越好（3 完全匹配 / 1 变体），所以必须**降序**
      if (a._tier !== b._tier) return b._tier - a._tier;
      // 相关性闸门降权（0 = 跟查询沾不上边，压到相关的后面，但不删）
      const ra = a._rel || 0, rb = b._rel || 0;
      if (ra !== rb) return rb - ra;
      if (a._extra !== b._extra) return a._extra - b._extra;
      // 同组内若混进了不同版本（理论上 key 已分开，兜底再比一次）：原版优先
      const la = a._live ? 1 : 0, lb = b._live ? 1 : 0;
      if (la !== lb) return la - lb;
      /* Apple 歌手目录：证据最强的一层。
         它直接回答「这首是不是这个人唱片里的歌」——
         同名冒用歌手（artist 字段写着一模一样的名字）在这里被判 -60，
         而真实专辑里的原唱 +45，差距 105 分，tier 相同也能翻过来。 */
      const pa = a._apc || 0, pb = b._apc || 0;
      if (pa !== pb) return pb - pa;
      // 权威目录确认过的正式发行版优先（证据最强，排在启发式的 bone 之前）
      const aa = a._auth || 0, ab = b._auth || 0;
      if (aa !== ab) return ab - aa;
      // 同一档同一匹配度时，优先「官方发行版」（Topic 频道等）
      const ba = a._bone || 0, bb = b._bone || 0;
      if (ba !== bb) return ba - bb;
      // 播放量只做微调（最多 12 分），不足以翻盘
      const ha = a._hot || 0, hb = b._hot || 0;
      if (ha !== hb) return hb - ha;
      if (a._heat !== b._heat) return b._heat - a._heat;
      if (a._rank !== b._rank) return a._rank - b._rank;
      return a._order - b._order;
    });
    out.push(arr[0]);
  });

  out.sort(compareRank);

  /* ============================================================
   * Live 分组：录音室原版一块，现场/演唱会版另起一块
   *
   * 用户的要求（2026-10-19）：
   *   「结果分两个？一个不是 live 一个是 live」
   *   「如果有带 live 专辑的两个原唱就分开」
   *
   * 也就是：整份列表切成前后两段 ——
   *   前段只有录音室版，后段才是 Live / 现场 / 巡演版。
   * 用户搜歌时在头部就能看到干净的原版，想听现场再往下翻，
   * 不用在一堆 Live 里挑。
   *
   * ⚠️ 这里只做**稳定分组**，段内顺序完全保持 compareRank 排出来的结果：
   *    a) 原版内部原有的优劣顺序不动
   *    b) Live 段内部也是好的在前
   *    所以用两趟 push，不要用 sort —— sort 会打乱段内的既有排序。
   *
   * ⚠️ 判据用已经算好的 _live（isLiveVersion(title, album)），
   *    专辑名里带 Live / 演唱会 的也算 —— 这正是用户说的
   *    「带 live 专辑的」。两个原唱（原版 + Live 版）都会各自占一条，
   *    因为去重 key 里已经带了 LIVE/STUDIO 标记，谁都不吞谁。
   * ============================================================ */
  const studioList = [];
  const liveList = [];
  for (let i = 0; i < out.length; i++) {
    if (out[i]._live) liveList.push(out[i]);
    else studioList.push(out[i]);
  }
  /* 极端情况兜底：
     - 一条录音室版都没有（冷门现场曲目）→ 原样返回，别把列表清空
     - 一条 Live 都没有 → 也不用拼，省一次数组拷贝 */
  const grouped = studioList.length ? studioList.concat(liveList) : out;

  // ---- 后台预取前几首的播放地址 ----
  // 用户要求「先缓存好」，这样点第一首时不用等 1.5 秒。
  // 注意：这里**不 await**，让它自己跑完；搜索立刻返回。
  // Hermes 里 promise 链在函数返回后仍会继续执行（只是拿不到结果），
  // 所以能起到预热效果。
  if (shouldPrefetch()) {
    prefetchTop(grouped, 3);
  }

  /* 到底分没分开，日志里能看出来（调试 Live 混排时很省事）。
     只有真存在两种版本时才打，免得每搜一次都刷一行。 */
  if (liveList.length && studioList.length) {
    console.log("[粽子] 已分组：原版 " + studioList.length + " 条 / Live " + liveList.length + " 条");
  }

  // _auth 带出去给 search() 用：降级补搜时要用同一份权威目录重新打分
  return { isEnd: true, data: grouped, _auth: auth };
}

/* ============================================================
 * 预取前几首的播放地址
 *
 * ⚠️ 不能 await —— 否则搜索要等 4~5 秒，得不偿失。
 *    这里 fire-and-forget：搜索立刻返回，预取在后台跑，
 *    跑完把 URL 塞进 MEDIA_URL_CACHE，用户点播放时直接命中。
 * ============================================================ */
function shouldPrefetch() {
  try {
    const vars = (typeof env !== "undefined" && env && env.userVariables) || {};
    const v = vars.prefetch;
    if (v === undefined || v === null || v === "") return true;
    return !(v === "0" || v === "false" || v === "off");
  } catch (e) { return true; }
}

let _prefetching = false;
function prefetchTop(list, count) {
  if (_prefetching) return;          // 避免上一轮还没跑完又开一轮
  if (!list || !list.length) return;
  _prefetching = true;

  const targets = [];
  for (let i = 0; i < Math.min(count, list.length); i++) {
    const it = list[i];
    // 已经有缓存的跳过
    if (mediaCacheGet(it)) continue;
    targets.push(it);
  }
  if (!targets.length) { _prefetching = false; return; }

  // 并发取流（不 await，让它在后台跑）
  const done = [];
  for (let i = 0; i < targets.length; i++) {
    const it = targets[i];
    done.push(
      resolveMediaSource(it, "128k").then((r) => {
        if (r && r.url) mediaCachePut(it, r.url);
      }).catch(() => { /* 预取失败无所谓 */ })
    );
  }

  // 用 Promise.all 收尾，清掉标志位
  Promise.all(done).then(() => { _prefetching = false; }).catch(() => { _prefetching = false; });
}

/* ============================================================
 * 带歌手名的查询：结果太少就自动减弱查询
 *
 * 实测（2026-10-17）：
 *   "花海"        → 68 条，周杰伦的《花海》排第 1
 *   "花海 周杰伦"  → 7 条，全是歌词版/翻唱/钢琴 cover，一个原唱都没有
 *
 * 为什么：各平台的搜索后端对「歌名 歌手」这种组合串很敏感，
 * 拼太长反而命中率暴跌（酷我/咪咕/QQ 直接返回 0）。
 *
 * 所以：带歌手名的查询若结果少得可怜，就把歌手名去掉重搜一次，
 * 两个结果池合并去重 —— 排序器自然会用 _bone/_auth/tier 把原唱顶上来。
 * ============================================================ */
const WEAK_RESULT_THRESHOLD = 12;   // 少于这么多条就认为查询太窄

/** 从「歌名 歌手」里拆出纯歌名候选（只拆一次，别过度切分） */
function stripArtistVariants(query) {
  const q = String(query || "").trim();
  if (!q) return [];
  const parts = q.split(QUERY_SEP_RE).filter(Boolean);
  if (parts.length < 2) return [];
  const out = [];
  // 「歌名 歌手」→ 歌名；「歌手 歌名」→ 歌名（两种写法都有人用）
  out.push(parts.slice(0, parts.length - 1).join(" "));
  out.push(parts.slice(1).join(" "));
  // 只有一个分隔符时上面两条会重复，去个重
  const seen = {};
  return out.filter((x) => {
    const k = String(x).trim().toLowerCase();
    if (!k || k === q.toLowerCase() || seen[k]) return false;
    seen[k] = 1;
    return true;
  });
}

const search = async function (query, page, type) {
  // 四种搜索都从这里过，「歌名+歌手」的分隔符统一换成空格再往下发。
  query = normalizeQuery(query);
  const ck = String(query).trim().toLowerCase();
  if (type === "music") {
    if (page === 1) { const hit = cacheGet("search", type, ck); if (hit) return hit; }
    const r = await searchMusicAll(query, page);

    // 结果太少 → 减弱查询重搜，合并结果池
    if (page === 1 && (r.data || []).length < WEAK_RESULT_THRESHOLD) {
      const mainAuth = r._auth || null;   // 主查询查到的权威目录，补搜的条目要用它重打分
      const variants = stripArtistVariants(query);
      for (let i = 0; i < variants.length; i++) {
        try {
          const more = await searchMusicAll(variants[i], 1);
          const add = more.data || [];
          if (!add.length) continue;
          // 合并去重（platform+id）
          const have = {};
          (r.data || []).forEach((x) => { have[x.platform + "|" + x.id] = 1; });
          const merged = (r.data || []).slice();
          for (let j = 0; j < add.length; j++) {
            const k = add[j].platform + "|" + add[j].id;
            if (have[k]) continue;
            have[k] = 1;
            // ⚠️ 补搜那一批的 _auth 是按「减弱后的查询」算的，基本都是 0
            //    （"花海" 不带歌手名，权威库认不出是谁的歌）。
            //    这里用主查询已经查到的权威目录重新打分，否则补进来的正版原唱
            //    反而比原来的翻唱分还低，永远排不上来。
            if (mainAuth) add[j]._auth = authorityScore(add[j], mainAuth);
            merged.push(add[j]);
          }
          // ⚠️ 合并后**必须重排**。
          //    searchMusicAll 返回的数组本身是按 _tier/_extra/_bone 排好序的，
          //    直接 append 会把「补进来的便宜条目」全堆在已经排好的结果后面 ——
          //    实测 tier=3 的正版原唱因此被排到了第 8 位。
          merged.sort(compareRank);
          console.log("[粽子] 查询太窄（" + (r.data || []).length + " 条）→ 用「" +
            variants[i] + "」补到 " + merged.length + " 条");
          r.data = merged;
          if (merged.length >= WEAK_RESULT_THRESHOLD) break;
        } catch (e) { /* 忽略 */ }
      }
    }

    if (page === 1) cachePut("search", type, ck, r);
    return r;
  }
  if (type === "album") { const r = await searchAlbum(query, page); if (page === 1) cachePut("search", type, String(query).trim().toLowerCase(), r); return r; }
  if (type === "artist") { const r = await searchArtist(query, page); if (page === 1) cachePut("search", type, String(query).trim().toLowerCase(), r); return r; }
  if (type === "sheet") { const r = await searchSheet(query, page); if (page === 1) cachePut("search", type, String(query).trim().toLowerCase(), r); return r; }
  return { isEnd: true, data: [] };
};

/* ============================================================
 * getMediaSource：取流（本平台多通道 → 跨平台兜底）
 * ============================================================ */

/* ============================================================
 * 取流地址短时缓存
 *
 * 背景：cacheControl 是 "no-cache"（直链有时效签名，长缓存必失效），
 * 所以 MusicFree 每次需要音源都会调 getMediaSource。
 * 播放器缓冲波动时可能几秒内重复调用 —— 每次都重走一遍
 * 「player API → 探测 → 验活」要 1 秒多，体验上就是一直在转。
 *
 * 折中：插件内部缓存 90 秒。
 *   - 直链签名一般有效几小时，90 秒内绝对安全
 *   - 同一首歌重复取流直接命中，几毫秒返回
 * ============================================================ */
const MEDIA_URL_CACHE = {};
/* 30 分钟。直链签名实测有效 3~6 小时，30 分钟绝对安全；
   而且真过期了也只是播不出，重新点一次会拿到新地址。 */
const MEDIA_URL_TTL = 30 * 60 * 1000;

/* ⚠️ key 里**不能**带 quality。
   MusicFree 播放时会按 low → standard → high → super 依次试音质，
   每次 quality 都不同 → 缓存全 miss → 每次重新取流 1.2 秒，
   表现就是「每 3 秒转一次」。
   实际上我们各音质档拿到的是同一个文件（YouTube 就是一条流），
   所以按 platform+id 缓存即可，跟 quality 无关。

   ⚠️ 但**没有 id 的条目必须带上歌名**。
   MusicBrainz 补进来的曲目 id 是空串（MB 没有音源 id，播放走跨平台兜底），
   如果只按 platform+id 缓存，整张专辑所有曲目的 key 全是 "MusicBrainz|"，
   谁先播谁占坑，后面每一首都直接命中第一首的音频 ——
   表现为「点《孰轻孰重》播出来的是《来得及的明天》」。 */
function mediaCacheKey(item) {
  const id = String(item.id || "");
  if (id) return String(item.platform || "") + "|" + id;
  return String(item.platform || "") + "|#" +
    String(item.title || "") + "|" + String(item.artist || "");
}
function mediaCacheGet(item) {
  const k = mediaCacheKey(item);
  const v = MEDIA_URL_CACHE[k];
  if (!v) return null;
  if (Date.now() - v.at > MEDIA_URL_TTL) { delete MEDIA_URL_CACHE[k]; return null; }
  return v.url;
}
function mediaCachePut(item, url) {
  const k = mediaCacheKey(item);
  // 防膨胀：超过 300 条就清掉最旧的一半
  const ks = Object.keys(MEDIA_URL_CACHE);
  if (ks.length > 300) {
    ks.sort((x, y) => MEDIA_URL_CACHE[x].at - MEDIA_URL_CACHE[y].at);
    for (let i = 0; i < 150; i++) delete MEDIA_URL_CACHE[ks[i]];
  }
  MEDIA_URL_CACHE[k] = { at: Date.now(), url: url };
}

/* ------------------------------------------------------------
 * 内联音频缓存：只放已经转成 data: URI 的 YouTube 曲目。
 *
 * 为什么要单独一套：
 *   - 一条 data: URI 就是 3MB 字符串，不能和普通 URL 挤同一个池子
 *   - 只留最近 3 首（约 9MB 上限），多了 Hermes 会吃不住
 *   - TTL 给足 2 小时：音频内容不会变，没必要重新下载
 * ------------------------------------------------------------ */
const INLINE_CACHE = {};
const INLINE_CACHE_TTL = 2 * 60 * 60 * 1000;
const INLINE_CACHE_MAX = 3;

function inlineCacheGet(item) {
  const k = mediaCacheKey(item);
  const v = INLINE_CACHE[k];
  if (!v) return null;
  if (Date.now() - v.at > INLINE_CACHE_TTL) { delete INLINE_CACHE[k]; return null; }
  return v.url;
}
function inlineCachePut(item, url) {
  const k = mediaCacheKey(item);
  INLINE_CACHE[k] = { at: Date.now(), url: url };
  const ks = Object.keys(INLINE_CACHE);
  if (ks.length > INLINE_CACHE_MAX) {
    ks.sort((x, y) => INLINE_CACHE[x].at - INLINE_CACHE[y].at);
    for (let i = 0; i < ks.length - INLINE_CACHE_MAX; i++) delete INLINE_CACHE[ks[i]];
  }
}

/**
 * 给播放地址配「播放时必须带的请求头」和「协议升级」。
 *
 * 两件事合在一起做，因为它们解决的是同一个症状：**列表里点开没反应**。
 *
 * ① http → https
 *    Android 9+ 默认禁明文流量（cleartextTrafficPermitted=false），
 *    插件给个 http:// 地址，播放器直接拒连 —— 而且报的是「无法播放」，
 *    看起来像源挂了，其实是协议。实测 QQ 的 ws.stream.qqmusic.qq.com
 *    https 版本完全可用，直接换就行。
 *    ⚠️ 酷狗的 fs.youthandroid2.kugou.com 证书不匹配，换 https 反而更糟，
 *       所以只对「确实支持 https」的域名升级，别一刀切。
 *
 * ② Referer
 *    B站 CDN 不带 Referer 返回 403，酷狗部分域名同理。
 *    这两个头必须交给客户端在请求时带，插件自己带了没用。
 */
const HTTPS_OK_HOST = /(^|\.)(qqmusic\.qq\.com|music\.126\.net|music\.163\.com|migu\.cn|12530\.com|kugou\.com\.cn|kuwo\.cn)$/i;
const PLAY_HEADERS = {
  bilibili: { Referer: "https://www.bilibili.com/" },
  kugou: { Referer: "https://www.kugou.com/" },
  kuwo: { Referer: "https://www.kuwo.cn/" },
  qq: { Referer: "https://y.qq.com/" },
};

function decorateSource(result, provider) {
  if (!result || !result.url) return result;
  const u = String(result.url);
  if (u.indexOf("data:") === 0) return result;      // 内联数据不需要头

  let out = u;
  if (out.indexOf("http://") === 0) {
    /* 只看域名白名单，不盲目替换：证书不匹配的域名换上去会比 http 更糟 */
    let host = "";
    try { host = String(new URL(out).host || ""); } catch (e) { host = ""; }
    if (host && HTTPS_OK_HOST.test(host)) {
      const cand = out.replace(/^http:\/\//, "https://");
      /* 用「能取到字节」实测，不是只看域名 —— 有的域名证书对但路径只走 http */
      if (httpsCacheIsOk(cand)) out = cand;
    }
  }

  const h = PLAY_HEADERS[provider];
  if (h) {
    result.url = out;
    result.headers = Object.assign({}, result.headers || {}, h);
  } else if (out !== u) {
    result.url = out;
  }
  return result;
}

/* 同一个 https 地址只测一次，避免每次播放都多打一个请求 */
const _httpsOk = {};
function httpsCacheIsOk(url) {
  const k = url.slice(0, 200);
  if (_httpsOk[k] !== undefined) return _httpsOk[k];
  /* 同步路径里没法发请求，所以这里采用「乐观放行 + 后台校正」：
     先认为可以（域名白名单已经筛过一遍），后台探一次，失败就记住。
     下一次播放同域名就会走 http 了。 */
  _httpsOk[k] = true;
  probeAudio(url).then((r) => { _httpsOk[k] = !!r.ok; }).catch(() => {});
  return true;
}

async function getMediaSource(musicItem, quality) {
  const providerForPlay = musicItem._provider || LABEL_TO_PROVIDER[musicItem.platform] || "";

  // 1) 内存里已有完整音频（data: URI）→ 直接复用，别重复下载
  const inline = inlineCacheGet(musicItem);
  if (inline) return { url: inline };

  // 2) 30 分钟内的直链缓存（跟音质无关），不再重走取流链路
  const cached = mediaCacheGet(musicItem);
  if (cached) {
    /* ⚠️ 缓存命中也要过 decorateSource。缓存里存的是裸 URL，
       请求头不在里面 —— 直接返回 { url: cached } 的话，
       B站/酷狗那批「必须带 Referer」的歌第一次能播、第二次 403，
       是最难查的那种间歇性故障。 */
    return decorateSource({ url: cached }, providerForPlay);
  }

  const result = await resolveMediaSource(musicItem, quality);

  /* 把「播放该带的头」和「http→https」补上。
     这一步必须在缓存之前 —— 缓存的是可以直接交给播放器的成品。 */
  decorateSource(result, providerForPlay);

  const isInline = result.url && String(result.url).indexOf("data:") === 0;
  if (isInline) {
    // data: URI 只进 inline 池（3MB 字符串不进 URL 池，也不往飞书推）
    inlineCachePut(musicItem, result.url);
  } else {
    mediaCachePut(musicItem, result.url);
    pushToFeishu([
      "🎵 " + musicItem.title + " — " + musicItem.artist,
      "来源: " + (musicItem.platform || "?") + "  |  音质: " + quality,
      "下载地址:",
      result.url,
    ].join("\n"));
  }
  return result;
}

async function resolveMediaSource(musicItem, quality) {
  const q = QUALITY_MAP[quality] || "128k";
  const want = { name: musicItem.title, singer: musicItem.artist, album: musicItem.album };
  const provider = musicItem._provider || LABEL_TO_PROVIDER[musicItem.platform] || "netease";
  const durMs = Number(musicItem.duration) || 0;
  const errors = [];
  // 拿到过、但只是试听片段的地址。全平台都只给片段时，退回用它 ——
  // 片段总比「点击报错」好，至少能听个开头。
  let previewOnly = null;

  /* 本平台和兜底都要过同一道关：能不能播、是不是完整。
     抽成闭包是为了让两条路径完全同构 —— 之前只在兜底里做校验，
     结果本平台「能播但是 60 秒试听」就一路过关了。 */
  const accept = async (u, who, altDurMs) => {
    if (await isPreviewOnly(u, durMs, altDurMs)) {
      previewOnly = previewOnly || u;
      errors.push(who + ": 只给试听片段");
      return null;
    }
    return u;
  };

  // 1) 本平台
  const resolver = RESOLVERS[provider];
  if (resolver) {
    if (isDead(provider, musicItem.id)) {
      errors.push(provider + ": 已知不可播，跳过");
    } else {
      try {
        const u = await resolver(musicItem.id, want, q);
        const okUrl = await accept(u, provider);
        if (okUrl) return { url: okUrl };
      } catch (e) {
        markDead(provider, musicItem.id);
        errors.push(provider + ": " + e.message);
      }
    }
  }

  // 2) 跨平台兜底
  //    ⚠️ 兜底必须做「是不是同一首歌」的严格校验。
  //       否则会拿同名的听书片段顶替音乐（实测踩过：
  //       搜「怎麼都沒有了」→ 酷我给「第100章…我们的怪怎么都没有了」）。
  //       校验在 resolver 内部完成 —— 每个 resolver 现在都走 isDefinitelySameSong。
  for (let i = 0; i < FALLBACK_ORDER.length; i++) {
    const p = FALLBACK_ORDER[i];
    if (p === provider) continue;
    const fn = RESOLVERS[p];
    if (!fn) continue;
    try {
      // 传 null 作为 id：各 resolver 内部会走「搜索 → 严格匹配」路径，
      // 不会用到需要本平台 id 的直取通道（如长青）。
      //
      // ⚠️ 但仅靠 resolver 内部的校验还不够 —— 各平台写法差异太大，
      //    出现过「元数据是 YouTube 的歌、兜底却给了 B 站另一首歌」的事故。
      //    所以这里再要求 resolver 把「命中曲目」带回来，做最后一道闸。
      const u = await fn(null, want, q);
      const okUrl = await accept(u, "兜底" + p);
      if (okUrl) {
        console.log("[粽子] 兜底命中: " + provider + " → " + p + " 《" + want.name + "》");
        return { url: okUrl };
      }
    } catch (e) { errors.push("兜底" + p + ": " + e.message); }
  }

  // 3) 全平台都只给片段 → 退回片段，别让用户点了报错
  if (previewOnly) {
    console.log("[粽子] 全平台仅试听: 《" + want.name + "》");
    return { url: previewOnly };
  }

  // 全平台都没拿到 → 把这首歌记进黑名单，下次搜索直接不显示它
  // （用户明确要求：播不了就别占着列表位置）
  markTrackDead(musicItem.platform, musicItem.id);
  delete MEDIA_URL_CACHE[mediaCacheKey(musicItem)];
  throw new Error("所有平台均失败 [" + errors.join(" | ") + "]");
}

/* ============================================================
 * 歌词
 *
 * 两层结构：
 *   ① 本源直取 —— 条目来自哪个平台就先问那个平台（命中最准）。
 *   ② 跨源兜底 —— B站 / YouTube / JOOX / Apple 本身没有歌词库，
 *      以及本源只回「暂无歌词」的曲子，按「歌名 + 歌手 + 时长」去公共库反查。
 *      顺序 LRCLIB → 网易云 → 酷狗 → hi.cn。
 *
 * 实测（2026-10-18）：
 *   - LRCLIB 是公开 API，不用 key、不用登录，返回带时间轴的 LRC。
 *     《晴天》《起风了》《優しい彗星》都命中，同步歌词 1000 字以上。
 *     它对 B站 / YouTube 这种「标题很脏」的条目最关键 —— 那两个源
 *     以前点了歌词永远是空的。
 *   - 网易云官方 /api/song/lyric 一次能同时拿原文和翻译（tlyric），
 *     译文按同一时间戳并排插在原文下一行，播放器滚词就是双语。
 *   - 酷我 COCO 通道固定返回 400（实测 kuwo/migu 都是），
 *     只有官方 m.kuwo.cn 按 musicId 直取才行。
 *   - 酷狗 krcs.kugou.com/search + lyrics.kugou.com/download
 *     返回 base64 的 LRC，华语老歌命中率高，能补网易云没有的曲目。
 * ============================================================ */
const LYRIC_UA = "zongzi-musicfree-plugin/4.9 (https://github.com/ZONGZI-000/zongzi-musicfree-plugin)";
const LRCLIB_SEARCH = "https://lrclib.net/api/search";
const NE_LYRIC = "https://music.163.com/api/song/lyric";
const NE_SEARCH_PC = "https://music.163.com/api/cloudsearch/pc";
const KG_LRC_SEARCH = "https://krcs.kugou.com/search";
const KG_LRC_DOWNLOAD = "https://lyrics.kugou.com/download";
const KW_LRC = "https://m.kuwo.cn/newh5/singles/songinfoandlrc";
const QQ_LYRIC = "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg";

/** 歌词兜底是否开启（默认开） */
function shouldLyricFallback() {
  try {
    const vars = (typeof env !== "undefined" && env && env.userVariables) || {};
    const v = vars.lyricOnline;
    if (v === undefined || v === null || v === "") return true;
    return !(v === "0" || v === "false" || v === "off");
  } catch (e) { return true; }
}

/** 歌词是否并排显示译文（默认开） */
function shouldLyricTranslation() {
  try {
    const vars = (typeof env !== "undefined" && env && env.userVariables) || {};
    const v = vars.lyricTranslation;
    if (v === undefined || v === null || v === "") return true;
    return !(v === "0" || v === "false" || v === "off");
  } catch (e) { return true; }
}

/** 带超时的 Promise —— 兜底源多，任何一个卡住都不能拖住整条链 */
function lyricTimeout(p, ms) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms || 8000);
    Promise.resolve(p).then(
      (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } },
      () => { if (!done) { done = true; clearTimeout(t); resolve(null); } }
    );
  });
}

const B64_REV = (function () {
  const m = {};
  for (let i = 0; i < B64_CHARS.length; i++) m[B64_CHARS[i]] = i;
  return m;
})();

/** base64 → UTF-8 文本（Hermes 没有 Buffer / atob，纯 JS 解） */
function b64ToText(str) {
  const s = String(str || "").replace(/[^A-Za-z0-9+/]/g, "");
  const bytes = [];
  let buf = 0, bits = 0;
  for (let i = 0; i < s.length; i++) {
    const v = B64_REV[s[i]];
    if (v === undefined) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buf >> bits) & 0xff);
    }
  }
  let out = "";
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i++];
    if (b < 0x80) { out += String.fromCharCode(b); continue; }
    if (b >= 0xf0 && i + 2 < bytes.length) {
      const c = ((b & 7) << 18) | ((bytes[i] & 63) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63);
      i += 3;
      out += String.fromCodePoint ? String.fromCodePoint(c) : "";
      continue;
    }
    if (b >= 0xe0 && i + 1 < bytes.length) {
      const c = ((b & 15) << 12) | ((bytes[i] & 63) << 6) | (bytes[i + 1] & 63);
      i += 2;
      out += String.fromCharCode(c);
      continue;
    }
    if (b >= 0xc0 && i < bytes.length) {
      const c = ((b & 31) << 6) | (bytes[i] & 63);
      i += 1;
      out += String.fromCharCode(c);
      continue;
    }
    out += "?";
  }
  return out;
}

/** 秒 → [mm:ss.xx] */
function lrcTime(sec) {
  const t = Math.max(0, Number(sec) || 0);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return (m < 10 ? "0" + m : String(m)) + ":" + (s < 10 ? "0" : "") + s.toFixed(2);
}

/**
 * 这段文本能不能当歌词交付。
 * ⚠️ 各平台对无版权 / 纯音乐一律回一句「暂无歌词」，
 *    字数够、也有时间轴，直接返回会让用户看到一句假歌词。
 *    所以必须显式挡掉，继续走下一个通道。
 */
function lrcLooksReal(txt) {
  if (typeof txt !== "string") return false;
  const s = txt.trim();
  if (s.length < 20) return false;
  if (/暂无歌词|無歌詞|无歌词|暂无歌词信息|純音樂|纯音乐/i.test(s) && !/\[\d{1,3}:\d{2}/.test(s)) return false;
  /* 只剩制作名单的「歌词」不能交付。
     实测 YouTube 的《晴天》条目拿到过 38 个字的
     「[00:00.00] 作曲 : 周杰伦」—— 长度过关、也有时间轴，
     但播放器里就是一行字挂在那儿，比没有歌词更难看。
     判据：去掉「作词/作曲/编曲/制作人/混音/母带/录音/吉他/贝斯/鼓 :」这类
     名单行之后，真正带时间轴的歌词行不足 5 行，就当没拿到。 */
  const lrcLines = s.split(/\r?\n/).filter((l) => /^\[\d{1,3}:\d{2}(?:\.\d+)?\].*\S/.test(l));
  if (!lrcLines.length) {
    // 完全没有时间轴：纯文本歌词也算数（有些源只给纯词）
    return s.length >= 20;
  }
  const CREDIT = /^\s*\[\d{1,3}:\d{2}(?:\.\d+)?\]\s*(作词|作曲|編曲|编曲|填词|填詞|制作人|製作人|监制|監製|混音|母带|母帶|录音|錄音|吉他|贝斯|貝斯|鼓|和声|和聲|弦乐|弦樂|键盘|鍵盤|出品|发行|發行|词|詞|曲|演唱|原唱|OP|SP|ISRC|Produced|Composed|Written|Lyrics|Arranged)\s*[:：]/i;
  const real = lrcLines.filter((l) => !CREDIT.test(l));
  return real.length >= 5;
}

/** QQ 的歌词偶尔带 HTML 实体（&#10; 之类），不转会把它们直接显示出来 */
function decodeLrcEntities(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&").replace(/&quot;/g, "\"")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
}

/** 同一首歌，两个名字算不算对得上（简繁、括号、空格都归一后比）
 *  ⚠️ 必须走 normTextZ（先统一到简体）而不是 normText：
 *     歌词库大量条目是繁体（「原諒我不明白你的悲傷」），
 *     查询侧是简体时就永远匹配不上，整条兜底链全空。 */
function lyricSame(a, b) {
  const x = normTextZ(a), y = normTextZ(b);
  if (!x || !y) return false;
  return x === y || x.indexOf(y) >= 0 || y.indexOf(x) >= 0;
}

/**
 * 歌名匹配分级打分（0 = 不算命中）。
 *
 * ⚠️ 不能直接用 lyricSame 打分。它是双向子串判断，在搜索结果里够用，
 *    放进歌词库就会放出离谱结果：实测搜「这首歌根本不存在测试用xxxzzz」，
 *    网易云回了一首《不存在》，「不存在」三个字确实被目标串包含，
 *    于是一首完全无关的歌词被当成命中交出去。
 *
 * 分级：
 *   40 归一后完全相等
 *   30 候选更长且包含目标 —— 通常是「晴天 (Live)」「晴天 - Remastered」这类变体
 *   22 目标更长但包含候选，且候选长度 ≥ 目标的 60%（挡「不存在」这种碎片词）
 *    0 其余情况一律不认
 */
function lyricNameScore(cand, want) {
  const x = normTextZ(cand), y = normTextZ(want);
  if (!x || !y) return 0;
  if (x === y) return 40;
  if (x.length >= y.length) return x.indexOf(y) >= 0 ? 30 : 0;
  if (y.indexOf(x) >= 0 && x.length * 100 >= y.length * 60) return 22;
  return 0;
}

/** 命中与否（阈值 22 ~ 30 都算命中，打分用 lyricNameScore） */
function lyricNameHit(cand, want) {
  return lyricNameScore(cand, want) > 0;
}

/** 条目时长（毫秒），0 表示未知 */
function lyricDurMs(item) {
  const ms = Number(item && item.duration) || 0;
  return ms > 500 ? ms : 0;
}

/**
 * 把翻译并按时间戳插到原文下一行。
 * 播放器是按行滚的，同一时间戳两行会同时高亮，看起来就是双语字幕。
 */
function mergeTranslation(lrc, tlrc) {
  if (!lrc) return "";
  if (!tlrc) return lrc;
  const tmap = {};
  let n = 0;
  String(tlrc).split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\[(\d{1,3}:\d{2}(?:\.\d+)?)\](.*)$/);
    if (!m) return;
    const text = decodeLrcEntities(m[2]).trim();
    if (text) { tmap[m[1]] = text; n++; }
  });
  if (!n) return lrc;
  const out = [];
  String(lrc).split(/\r?\n/).forEach((line) => {
    out.push(line);
    const m = line.match(/^\[(\d{1,3}:\d{2}(?:\.\d+)?)\](.*)$/);
    if (!m) return;
    const tr = tmap[m[1]];
    if (tr && tr !== m[2].trim()) out.push("[" + m[1] + "]" + tr);
  });
  return out.join("\n");
}

/**
 * 从脏标题里猜「歌名 + 歌手」。
 * B站 / YouTube 的标题长这样：「【4K】晴天 - 周杰伦 官方MV」「周杰伦 - 晴天 (高音质)」
 * 不洗干净的话拿去 LRCLIB 搜永远是 0 条。
 */
function lyricCleanTitle(rawTitle) {
  let s = String(rawTitle || "");
  s = s.replace(/【[^】]*】/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/（[^）]*）/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/《([^》]*)》/g, " $1 ")
    .replace(/「([^」]*)」/g, " $1 ");
  // 英文营销词
  s = s.replace(/\b(?:official|lyrics?|video|audio|music|mv|pv|hd|hq|4k|8k|1080p|720p|hi-?res|remaster(?:ed)?|live|cover|feat|ft)\b\.?/gi, " ");
  // 中文营销词
  s = s.replace(/官方|正式版|高清|高音质|无损|动态歌词|歌词版|滚动歌词|完整版|修复版|重制版|现场版|翻唱|伴奏|纯享|音质|高清版/gi, " ");
  s = s.replace(/[_|｜/／·•]+/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

function lyricNameArtist(item) {
  let knownArtist = String((item && item.artist) || "").trim();
  /* YouTube 的 artist 是频道名，官方发行版频道一律带 " - Topic" 后缀
     （"周杰倫 - Topic"），不剥掉拿去比对歌手永远对不上。 */
  knownArtist = knownArtist.replace(/\s*[-–—]\s*Topic\s*$/i, "").trim();
  let t = lyricCleanTitle(item && item.title);
  // 标题里常把歌手也写进去：「晴天 周杰伦」
  if (knownArtist) {
    const na = lyricCleanTitle(knownArtist);
    if (na && t !== na) t = t.replace(new RegExp(na.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), " ").trim();
  }
  const parts = t.split(/\s+[-–—]\s+/).map((x) => x.trim()).filter(Boolean);
  let name = t, artist = knownArtist;
  if (parts.length === 2) {
    const a = parts[0], b = parts[1];
    // 哪一边跟已知歌手对得上，另一边就是歌名
    if (knownArtist && lyricSame(a, knownArtist) && !lyricSame(b, knownArtist)) { artist = a; name = b; }
    else if (knownArtist && lyricSame(b, knownArtist) && !lyricSame(a, knownArtist)) { artist = b; name = a; }
    else { name = a; artist = knownArtist || b; }
  } else if (parts.length > 2) {
    name = parts[0];
  }
  name = name.replace(/\s+/g, " ").trim();
  if (!name) name = String((item && item.title) || "").trim();
  return { name: name, artist: artist };
}

/* ---------- 各通道 ---------- */

/** LRCLIB：公开同步歌词库，中日英覆盖最好 */
async function lrclibLyric(want, durMs) {
  /* ⚠️ 带 artist_name 搜召回会明显变窄：LRCLIB 是精确匹配，
     歌手名写法稍有出入（「周杰伦」vs「周杰倫」、Topic 频道名）就是 0 条。
     所以带歌手搜空了就脱掉歌手再搜一次，宁可多一次请求。 */
  const params = { track_name: want.name };
  if (want.artist) params.artist_name = want.artist;
  let list = await httpGet(LRCLIB_SEARCH, params, { "User-Agent": LYRIC_UA, Accept: "application/json" });
  if ((!Array.isArray(list) || !list.length) && want.artist) {
    list = await httpGet(LRCLIB_SEARCH, { track_name: want.name }, { "User-Agent": LYRIC_UA, Accept: "application/json" });
  }
  if (!Array.isArray(list) || !list.length) return "";
  let best = "", bestScore = -1;
  for (let i = 0; i < list.length; i++) {
    const c = list[i] || {};
    const lrc = c.syncedLyrics || "";
    if (!lrc || lrc.length < 30) continue;
    let sc = 0;
    const ns = lyricNameScore(c.trackName, want.name);
    if (!ns) continue;
    sc += ns;
    if (want.artist && lyricSame(c.artistName, want.artist)) sc += 25;
    else if (want.artist) sc -= 5;
    const cd = Number(c.duration) || 0;
    if (durMs > 0 && cd > 0) {
      const diff = Math.abs(cd - durMs / 1000);
      if (diff <= 2) sc += 30;
      else if (diff <= 5) sc += 18;
      else if (diff <= 12) sc += 6;
      else if (diff > 40) sc -= 25;
    }
    if (c.instrumental) sc -= 40;
    if (sc > bestScore) { bestScore = sc; best = lrc; }
  }
  /* 阈值不能只判 >0：名字沾边（+20）减掉「歌手不明」的 -5 还是正数，
     照样会把别人同名的歌交出去。要求至少「名字对上 + 一项旁证」。 */
  return bestScore >= 25 ? best : "";
}

/** 网易云官方：按 id 直取，原文 + 翻译一起拿 */
async function neteaseLyricById(id) {
  if (!id) return "";
  const r = await httpGet(NE_LYRIC, { id: id, lv: -1, kv: -1, tv: -1 }, NETEASE_HEADERS);
  const lrc = (r && r.lrc && r.lrc.lyric) || "";
  if (!lrcLooksReal(lrc)) return "";
  const tl = (r && r.tlyric && r.tlyric.lyric) || "";
  return shouldLyricTranslation() ? mergeTranslation(lrc, tl) : lrc;
}

/** 网易云官方：按关键词搜一首再取（B站/YouTube 条目没有网易云 id） */
async function neteaseLyricByQuery(keyword, want, durMs) {
  const s = await httpPost(NE_SEARCH_PC, { s: keyword, type: 1, limit: 10, offset: 0 },
    Object.assign({ "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, NETEASE_HEADERS));
  const songs = (s && s.result && s.result.songs) || [];
  let best = null, bestScore = -1;
  for (let i = 0; i < songs.length; i++) {
    const x = songs[i] || {};
    const artists = ((x.ar || x.artists || []).map((a) => a && a.name).filter(Boolean)).join(" ");
    let sc = 0;
    const ns = lyricNameScore(x.name, want.name);
    if (!ns) continue;
    sc += ns;
    if (want.artist && lyricSame(artists, want.artist)) sc += 30;
    else if (want.artist) sc -= 10;
    const d = Number(x.dt || x.duration || 0);
    if (durMs > 0 && d > 0) {
      const diff = Math.abs(d - durMs) / 1000;
      if (diff <= 2) sc += 30;
      else if (diff <= 5) sc += 18;
      else if (diff <= 12) sc += 6;
      else if (diff > 40) sc -= 25;
    }
    if (sc > bestScore) { bestScore = sc; best = x; }
  }
  /* 阈值 30：只有歌名完全对上（40）才够；
     名字沾边（20）必须再有一条旁证（歌手对上或时长对上）才放行。
     实测「这首歌根本不存在测试用xxxzzz」曾靠一个「存在」碎片词匹配到
     汪峰的《存在》，就是这里卡住的。 */
  if (!best || bestScore < 30) return "";
  return neteaseLyricById(best.id);
}

/** QQ 官方：按 songmid 取，带翻译 */
async function qqLyricByMid(mid) {
  if (!mid) return "";
  const r = await httpGet(QQ_LYRIC,
    { songmid: mid, format: "json", nobase64: 1, g_tk: 5381, loginUin: 0, hostUin: 0, platform: "yqq", needNewCode: 0 },
    { Referer: "https://y.qq.com/portal/player.html" });
  let j = r;
  if (typeof j === "string") {
    // 这个接口有时候会套一层 callback()
    const body = j.replace(/^[^{]*\(/, "").replace(/\)\s*$/, "");
    try { j = JSON.parse(body); } catch (e) { return ""; }
  }
  const lrc = decodeLrcEntities((j && j.lyric) || "");
  if (!lrcLooksReal(lrc)) return "";
  const tr = decodeLrcEntities((j && j.trans) || "");
  return (tr && shouldLyricTranslation()) ? mergeTranslation(lrc, tr) : lrc;
}

/** 酷我官方：按 musicId 直取（COCO 的酷我通道固定 400） */
async function kuwoLyricById(id) {
  if (!id) return "";
  const r = await httpGet(KW_LRC, { musicId: id }, { Referer: "https://www.kuwo.cn/", "User-Agent": UA });
  const list = (r && r.data && r.data.lrclist) || [];
  if (!list.length) return "";
  const lines = [];
  for (let i = 0; i < list.length; i++) {
    const text = decodeLrcEntities(String((list[i] && list[i].lineLyric) || "").trim());
    if (!text) continue;
    lines.push("[" + lrcTime(list[i].time) + "]" + text);
  }
  const txt = lines.join("\n");
  return lrcLooksReal(txt) ? txt : "";
}

/** 酷狗 krcs：华语老歌命中率高，返回 base64 的 LRC */
async function kugouLyricByQuery(keyword, want, durMs) {
  const s = await httpGet(KG_LRC_SEARCH, { ver: 1, man: "yes", client: "mobi", keyword: keyword }, { "User-Agent": UA });
  const cands = (s && s.candidates) || [];
  let best = null, bestScore = -1;
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i] || {};
    let sc = 0;
    const ns = lyricNameScore(c.song, want.name);
    if (!ns) continue;
    sc += ns;
    if (want.artist && lyricSame(c.singer, want.artist)) sc += 25;
    else if (want.artist) sc -= 10;
    const cd = Number(c.duration) || 0;
    if (durMs > 0 && cd > 0) {
      const diff = Math.abs(cd - durMs / 1000);
      if (diff <= 2) sc += 25;
      else if (diff <= 5) sc += 15;
      else if (diff > 40) sc -= 25;
    }
    if (sc > bestScore) { bestScore = sc; best = c; }
  }
  if (!best || bestScore < 30) return "";
  const d = await httpGet(KG_LRC_DOWNLOAD,
    { ver: 1, client: "pc", id: best.id, accesskey: best.accesskey, fmt: "lrc", charset: "utf8" },
    { "User-Agent": UA });
  const txt = d && d.content ? decodeLrcEntities(b64ToText(d.content)) : "";
  return lrcLooksReal(txt) ? txt : "";
}

/** 把条目自身的 id 拿去各平台直取 */
async function lyricFromOwnSource(provider, item, want, durMs) {
  const id = String((item && item.id) || "");

  // 咪咕直出：搜索结果里本来就带 lyricUrl
  if (provider === "miguapi") {
    let u = (item && item._raw && item._raw.lyricUrl) || "";
    if (!u) {
      try {
        const list = await miguApiSearch((want.name + " " + (want.artist || "")).trim(), 3);
        for (let i = 0; i < list.length; i++) {
          if (list[i].lyricUrl && titleMatch(list[i].title, want.name)) { u = list[i].lyricUrl; break; }
        }
      } catch (e) { /* 落到别处 */ }
    }
    if (u) {
      try {
        const txt = await httpGet(u);
        if (lrcLooksReal(txt) && txt.indexOf("[") >= 0) return txt;
      } catch (e) { /* 落到别处 */ }
    }
    return "";
  }

  if (provider === "netease") return neteaseLyricById(id);
  if (provider === "qq") return qqLyricByMid(id);
  if (provider === "kuwo") return kuwoLyricById(id);

  if (provider === "kugou" || provider === "migu") {
    // 酷狗/咪咕走 COCO：实测酷狗 63 行、咪咕 0 行（失败就走兜底）
    const res = await httpGet(COCO + "/api/lyric", { id: id, provider: provider, extra: "" }, cocoHeaders());
    const lines = (res && res.lines) || [];
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i] || {};
      const text = String(l.text || "").trim();
      if (!text || /暂无歌词|无歌词|純音樂|纯音乐/i.test(text)) continue;
      out.push("[" + lrcTime(l.time) + "]" + text);
    }
    const txt = out.join("\n");
    return lrcLooksReal(txt) ? txt : "";
  }

  return "";
}

/** 跨源兜底：LRCLIB → 网易云 → 酷狗 */
async function lyricFromPublicSources(want, durMs) {
  const queries = [];
  const push = (s) => {
    const v = String(s || "").replace(/\s+/g, " ").trim();
    if (!v) return;
    /* 简繁两版都塞：各平台互不通用。
       实测《原諒我不明白你的悲傷》只有繁体写法能在网易云音乐搜到。 */
    const vs = zhVariants(v);
    for (let i = 0; i < vs.length; i++) {
      const x = vs[i].replace(/\s+/g, " ").trim();
      if (x && queries.indexOf(x) < 0) queries.push(x);
    }
  };
  if (want.name && want.artist) push(want.name + " " + want.artist);
  if (want.name) push(want.name);

  // ① LRCLIB（同步歌词质量最好，先试）
  const lr = await lyricTimeout(lrclibLyric(want, durMs), 9000);
  if (lr && lrcLooksReal(lr)) return lr;

  // ② 网易云（华语覆盖最全，还带翻译）
  for (let i = 0; i < queries.length; i++) {
    const t = await lyricTimeout(neteaseLyricByQuery(queries[i], want, durMs), 9000);
    if (t && lrcLooksReal(t)) return t;
  }

  // ③ 酷狗（老歌、冷门翻唱）
  for (let i = 0; i < queries.length; i++) {
    const t = await lyricTimeout(kugouLyricByQuery(queries[i], want, durMs), 9000);
    if (t && lrcLooksReal(t)) return t;
  }
  return "";
}

async function getLyric(musicItem) {
  const item = musicItem || {};
  const provider = item._provider || LABEL_TO_PROVIDER[item.platform] || "";
  const want = lyricNameArtist(item);
  const durMs = lyricDurMs(item);

  /* ① 本源直取 */
  if (provider) {
    try {
      const t = await lyricTimeout(lyricFromOwnSource(provider, item, want, durMs), 10000);
      if (t && lrcLooksReal(t)) return { rawLrc: t };
    } catch (e) { /* 落到兜底 */ }
  }

  /* ② 跨源兜底（B站/YouTube/JOOX/Apple 全靠这一层） */
  if (shouldLyricFallback() && want.name) {
    try {
      const t = await lyricFromPublicSources(want, durMs);
      if (t && lrcLooksReal(t)) return { rawLrc: t };
    } catch (e) { /* 落到 hi.cn */ }
  }

  /* ③ hi.cn（最后一道，网易云/酷我两路）
     ⚠️ 酷我通道必须用「歌名 + 歌手」搜，只给歌名召回很差
        （实测 "晴天 周杰伦" 能中，"晴天" 单独搜 0 条） */
  const platforms = provider === "kuwo" ? ["kuwo", "wyy"] : ["wyy", "kuwo"];
  const kws = buildKeywords({ name: want.name, singer: want.artist });
  for (let p = 0; p < platforms.length; p++) {
    for (let i = 0; i < kws.length; i++) {
      let items = [];
      try { items = await hiSearch(platforms[p], kws[i], 8); } catch (e) { continue; }
      const hit = items.find((x) => lyricNameHit(x.name, want.name));
      if (!hit) continue;
      try {
        const r = await httpPost(HI + "?act=getLyric", {
          platform: platforms[p], songid: hit.id, time: hit.time, sign: hit.sign,
        }, HI_HEADERS);
        const txt = r && r.data;
        if (typeof txt === "string" && lrcLooksReal(txt)) return { rawLrc: txt };
      } catch (e) { /* 试下一个关键词 */ }
    }
  }
  return { rawLrc: "" };
}

/* ============================================================
 * 导出
 * ============================================================ */
module.exports = {
  platform: "粽子音源",
  version: "4.10.26",
  author: "粽子 & Alma",
  description:
    "粽子音源：聚合网易云、QQ、酷狗、咪咕、酷我、JOOX、YouTube、Bilibili 八个平台，支持单曲、专辑、歌手、歌单四类搜索，取流自动跨平台兜底。推荐页每天自动拼一张《拼好歌》歌单，按分类配封面。",
  supportedSearchType: ["music", "album", "artist", "sheet"],
  // 音频缓存策略：no-cache = 每次播放都重新取地址（直链带时效签名，缓存必然过期）
  cacheControl: "no-cache",
  // ⚠️ 这个字段让 MusicFree 能「检查更新」：
  //    App 会 axios.get(srcUrl) 拉取这份脚本，比对里面的 version，
  //    比已装的旧就自动替换（见 pluginManager/index.ts 的 installPluginFromUrl + compare）。
  //    所以每次发版必须改 version，否则 App 认为「已是最新」不会更新。
  /* 更新源：GitHub raw（固定名，2026-10-18 起弃用 Gitee）。
     Gitee 会静默风控 js 文件——上传返回 200、下载返回 451，
     而且整个仓库跟着不可用，历史版本也下不来，所以彻底迁走了。
     GitHub 不做内容审核，这个固定地址永远指向 master 上的最新版，
     「检查更新」不会再断链。每次发版记得改 version，否则 App 认为已是最新。
     国内直连 raw 慢时可换 jsDelivr 镜像（有 12 小时缓存，发版后不一定立刻生效）：
     https://cdn.jsdelivr.net/gh/ZONGZI-000/zongzi-musicfree-plugin@master/zongzi.js */
  srcUrl: "https://raw.githubusercontent.com/ZONGZI-000/zongzi-musicfree-plugin/master/zongzimusic.js",
  userVariables: [
    {
      key: "tasteSeeds",
      name: "口味种子（推荐歌单用）",
      hint: "填你常听的**歌手名**，逗号或顿号分隔，比如：周杰伦，草东没有派对，陈奕迅。最多 8 个。填了之后推荐页顶部会出现「为你推荐」。\n\n⚠️ 要填歌手，不要填歌名。插件拿不到听歌历史（沙箱既没有存储也读不到收藏），只能靠你手填；而按歌名反查原唱这条路在网易上不可靠（搜「晴天」前 30 条全是翻唱版），所以填歌名基本解析不出来，那一项会被跳过。\n\n填得越准，推荐越像你。",
    },
    {
      key: "tasteSkip",
      name: "不想听到的歌手（可选）",
      hint: "逗号分隔。这些歌手不会出现在「为你推荐」里，也不会作为相似歌手被扩进来。",
    },
    {
      key: "feishuWebhook",
      name: "飞书 Webhook（可选）",
      hint: "飞书群 → 添加机器人 → 自定义机器人 → 复制 Webhook 地址，形如 https://open.feishu.cn/open-apis/bot/v2/hook/xxxx。留空则不推送。",
    },
    {
      key: "useBilibili",
      name: "Bilibili 参与（默认开）",
      hint: "填 1 开启、0 关闭。Bilibili 完全免费且音质最高——实测《稻香》能取到 319kbps m4a，《起风了》263kbps。冷门歌、Live 版、翻唱的资源量在所有平台里最大。不需要登录。",
    },
    {
      key: "biliMusicOnly",
      name: "Bilibili 只搜音乐区（默认开）",
      hint: "填 1 开启、0 关闭。开启后 B 站搜索限定在音乐区（父分区 3，包含音乐综合 / MV / 翻唱 / 演奏），不会再把时政、新闻、游戏视频混进歌单。冷门关键词音乐区搜不到时自动退回全站。",
    },
    {
      key: "biliGuichu",
      name: "Bilibili 鬼畜区（默认开）",
      hint: "填 1 开启、0 关闭。开启后搜索会额外问一次 B 站鬼畜区（tids=119），并在「榜单」页多一组「B站鬼畜 · 本周热门」。鬼畜条目按匹配度正常参与排序，不再统一压到音乐条目之后 —— 真原唱靠权威目录自然排前面，鬼畜排在翻唱那一档。它们**不会**出现在推荐页，推荐页仍然只有正经歌单。关掉就彻底不碰鬼畜。",
    },
    {
      key: "useMiguApi",
      name: "咪咕官方直出（默认开）",
      hint: "填 1 开启、0 关闭。直连咪咕服务器，接口直接返回 MP3 字节流，不经第三方中转。实测 4.97MB 完整文件，1.5 秒。",
    },
    {
      key: "authorityCatalog",
      name: "权威目录校正（默认开）",
      hint: "填 1 开启、0 关闭。开启后会向 Apple Music 的公开接口查「这首歌的正式发行版长什么样」，用来把正版录音室版排到 Live/翻唱/DJ 版前面。只加分不过滤 —— 权威库里没有的冷门歌手（例如「那我懂你意思了」）会自动跳过，不影响搜索结果。超时 1.5 秒，查不到就当没发生。",
    },
    {
      key: "inlineYoutube",
      name: "YouTube 整首预载（默认开）",
      hint: "填 1 开启、0 关闭。开启后 YouTube 的每首歌会先完整下载并内联，播放时不卡（代价是首次多等 2~5 秒）。超过 6MB 的文件会自动回退流式。其它平台不受影响。",
    },
    {
      key: "inlineBili",
      name: "Bilibili 整首预下载（默认开）",
      hint: "填 1 开启、0 关闭。开启后 B 站音频会先整首下载进内存再交给播放器。B 站 CDN 强制要求 Referer，播放器拿裸链接会 403（表现为播两秒超时跳下一首）；预下载能彻底避开。单曲约 1~3MB，多等 0.3~1 秒。",
    },
    {
      key: "prefetch",
      name: "搜索后预取播放地址（默认开）",
      hint: "填 1 开启、0 关闭。开启后搜索完成会在后台预取前 3 首的直链，点播放时不用等 1.5 秒。代价是多几次后台请求，不影响搜索速度（不阻塞返回）。",
    },
    {
      key: "probeYoutubeQuota",
      name: "YouTube 配额预检（默认开）",
      hint: "填 1 开启、0 关闭。开启后取流前会探一下能否读到 2MB 之后——YouTube 对部分版权音乐只放行约 1MB，超过就 403。预检能让这类歌立刻兜底到别的平台，而不是对着转圈界面等一分钟。代价是多一次探测请求（约 200ms）。",
    },
    {
      key: "useYoutube",
      name: "YouTube 参与（默认开）",
      hint: "填 1 开启、0 关闭。YouTube 不需要登录，是冷门歌最后的兜底。实测《原諒我不明白你的悲傷》这种五平台全无的曲子，YouTube 上有官方发行版（IGU Band - Topic），能取到 132kbps m4a。",
    },
    {
      key: "filterAudiobook",
      name: "听书归到专辑（默认开）",
      hint: "填 1 开启、0 关闭。开启后单曲列表会剔除听书/有声书/广播剧，把它们按书名聚合成专辑，去「专辑」页看。实测酷我的听书占比能到 95%（搜「夜的命名术」），B站 35~45%。",
    },
    {
      key: "filterVip",
      name: "过滤会员/无版权曲目（默认开）",
      hint: "填 1 开启、0 关闭。开启后搜索结果里会隐藏标记 VIP / 无版权的条目。实测 JOOX：vip=0 的 19/19 能播，vip=1 的只有 5/24 能播；过滤后点开能播的比例从 56% 提到 100%。",
    },
    {
      key: "filterCover",
      name: "过滤翻唱（默认开）",
      hint: "填 1 开启、0 关闭。开启后标题里写了「翻唱 / cover / 翻自 / 原唱：xxx」的版本不显示。只认标题明说的，一字不差的翻唱分不出来（硬猜会误杀原唱）。你自己搜「起风了 翻唱」时这个开关自动失效。",
    },
    {
      key: "filterTrial",
      name: "隐藏试听片段（默认开）",
      hint: "填 1 开启、0 关闭。时长明确短于 90 秒的条目直接不显示——那种点开也是听两下就断。时长未知的条目不会被误伤。",
    },
    {
      key: "sortByCompleteness",
      name: "按完整度排序（默认开）",
      hint: "填 1 开启、0 关闭。开启后搜索结果先按「是不是你要的那首歌」排，同一首歌里则完整的在前、试听和时长未知的沉底。关掉就回到各平台轮流交替的原始顺序。",
    },
    {
      key: "lyricOnline",
      name: "在线歌词兜底（默认开）",
      hint: "填 1 开启、0 关闭。开启后本源没歌词（B站 / YouTube / JOOX / Apple 本身没有歌词库）或只回「暂无歌词」时，会按歌名+歌手+时长去 LRCLIB、网易云、酷狗反查。网易云命中时原文和翻译按同一时间戳并排显示。关掉就只用当前平台自己的歌词。",
    },
    {
      key: "lyricTranslation",
      name: "歌词显示译文（默认开）",
      hint: "填 1 开启、0 关闭。开启后网易云 / QQ 有官翻的曲子会把译文插在原文下一行（同一时间戳），播放器滚词就是双语字幕。关掉只显示原文。",
    },
    {
      key: "useAppleChart",
      name: "Apple Music 榜单（默认开）",
      hint: "填 1 开启、0 关闭。接入苹果官方公开的 Marketing Tools 榜单 feed（不用登录、不用 key），榜单页会多出「Apple 热门歌曲」8 个地区 × 100 首，以及中国/美国/日本的热门专辑和歌单各 50 张。曲目和封面直接来自苹果，音频走跨平台兜底。",
    },
    {
      key: "qqRecommendSheets",
      name: "推荐歌单并入 QQ 音乐（默认开）",
      hint: "填 1 开启、0 关闭。开启后「推荐歌单」页每个分类会同时取网易云和 QQ 两边的歌单，池子大一倍，每天换一批更不容易撞；另外多出一组「QQ 独有」分类（闽南语、情歌、现场音乐、DJ、婚礼等网易没有的）。关掉就只用网易云那一份。",
    },
    {
      key: "jooxCookie",
      name: "JOOX Cookie（可选）",
      hint: "登录 joox.com 后，把浏览器里 joox.com 域下的全部 cookie 粘进来（含 session_key / user_type / wmid 等 HttpOnly 项）。留空则 JOOX 不参与。",
    },
  ],
  search: search,
  getMediaSource: getMediaSource,
  getLyric: getLyric,
  getAlbumInfo: getAlbumDetail,
  /* 评论区。方法名固定叫 getMusicComments —— 客户端是硬编码调的，
     不是按 supportedMethods 里任选一个（见歌曲菜单面板）。 */
  getMusicComments: musicComments,
  getMusicSheetInfo: async function (sheetItem, page) {
    if (!sheetItem) return null;
    /* 口味画像单（taste:<指纹>:<第几张>）：按种子现算。
       沙箱存不下任何东西，所以「画像」不是记忆，而是每次重算的确定性结果。 */
    if (isTasteId(sheetItem.id)) {
      try {
        const d = await tasteSheetDetail(parseTasteId(sheetItem.id));
        if (d) return d;
      } catch (e) {
        console.log("[粽子] 画像单详情失败: " + e.message);
      }
      return {
        isEnd: true,
        sheetItem: {
          id: String(sheetItem.id),
          platform: "粽子",
          title: sheetItem.title || "为你推荐",
          artist: "粽子",
          artwork: sheetItem.artwork || "",
          worksNum: 0,
          playCount: 0,
          description: "种子歌手解析不出来。去插件设置里把「口味种子」填成具体的歌手名试试。",
        },
        musicList: [],
      };
    }
    /* 自己拼的歌单（mix:<分类>:<天>:<序号>）：id 里有完整配方，
       当场抓歌、按规则重排，不依赖任何平台歌单。 */
    if (isMixId(sheetItem.id)) {
      try {
        return await mixSheetDetail(parseMixId(sheetItem.id));
      } catch (e) {
        console.log("[粽子] 拼单失败: " + e.message);
        return {
          isEnd: true,
          sheetItem: {
            id: String(sheetItem.id),
            platform: "粽子",
            title: sheetItem.title || "",
            artist: sheetItem.artist || "拼好歌",
            artwork: sheetItem.artwork || "",
            worksNum: 0,
            playCount: 0,
            description: "拼单失败，稍后再试。",
          },
          musicList: [],
        };
      }
    }
    /* Apple 榜单里的歌单（applaylist:<区>:<pl.xxx>）：
       itunes lookup 对 pl. 开头的 id 直接 400，所以读歌单网页
       里内嵌的 serialized-server-data（实测 98 首完整，2 秒）。 */
    if (String(sheetItem.id || "").indexOf("applaylist:") === 0) {
      const parts = String(sheetItem.id).split(":");
      const cc = parts[1] || "cn";
      const plId = parts[2] || "";
      const json = await applePageData(cc, "playlist", plId);
      const parsed = applePageTracks(json);
      const tracks = parsed.tracks || [];
      const musicList = tracks.length
        ? await appleTracksToPlayable(tracks, parsed.artist || "", parsed.artwork || sheetItem.artwork, parsed.title || sheetItem.title)
        : [];
      return {
        isEnd: true,
        sheetItem: {
          id: String(sheetItem.id),
          platform: "Apple Music",
          title: parsed.title || sheetItem.title || "",
          artist: parsed.artist || "",
          artwork: parsed.artwork || sheetItem.artwork || "",
          worksNum: musicList.length || Number(sheetItem.worksNum || 0),
          playCount: 0,
          description: "",
        },
        musicList: musicList,
      };
    }
    if (sheetItem._provider === "qq" && isQQSheetId(sheetItem.id)) {
      try {
        return await qqSheetDetail(sheetItem.id, page);
      } catch (e) {
        console.log("[粽子] QQ歌单详情失败: " + e.message);
        return {
          isEnd: true,
          sheetItem: {
            id: String(sheetItem.id),
            platform: "QQ音乐",
            title: sheetItem.title || "",
            artist: sheetItem.artist || "",
            artwork: sheetItem.artwork || "",
            worksNum: sheetItem.worksNum || 0,
            playCount: sheetItem.playCount || 0,
            description: sheetItem.description || "",
          },
          musicList: [],
        };
      }
    }
    if (sheetItem._provider === "netease" || sheetItem.platform === "网易云") {
      try {
        return await neteaseSheetDetail(sheetItem.id, page);
      } catch (e) {
        console.log("[粽子] 网易云歌单详情失败: " + e.message);
        // 拿不到详情时至少把歌单本身回显出来，别让界面白屏
        return {
          isEnd: true,
          sheetItem: {
            id: String(sheetItem.id),
            platform: "网易云",
            title: sheetItem.title || "",
            artist: sheetItem.artist || "",
            artwork: sheetItem.artwork || "",
            worksNum: sheetItem.worksNum || 0,
            playCount: sheetItem.playCount || 0,
            description: sheetItem.description || "",
          },
          musicList: [],
        };
      }
    }
    if (sheetItem._provider === "kugou" || sheetItem.platform === "酷狗") {
      const r = await kugouDetail(sheetItem.id, "special", page, 50);
      return {
        isEnd: r.isEnd,
        sheetItem: {
          id: String(sheetItem.id),
          platform: "酷狗",
          title: sheetItem.title || "",
          artist: sheetItem.artist || "",
          artwork: sheetItem.artwork || "",
          playCount: sheetItem.playCount || 0,
          worksNum: sheetItem.worksNum || r.musicList.length,
          description: sheetItem.description || "",
        },
        musicList: r.musicList,
      };
    }
    return kuwoSheetDetail(sheetItem.id, page);
  },
  getArtistWorks: getArtistWorksOf,
  /* 榜单页入口。返回 [{ title, data: [歌单] }]，
     MusicFree 会按分组渲染成「网易云榜单 / 推荐歌单 / 华语精选 …」。
     点进去走 getMusicSheetInfo（_provider 是 netease，正好复用现有歌单详情）。 */
  getTopLists: function () {
    /* Apple 榜单是静态条目、不联网，所以可以和网易那批并发；
       Promise.all 里任何一边失败都各自兜住，缺谁都不影响另一边。 */
    const ne = neteaseTopListGroups().catch((e) => {
      console.log("[粽子] 榜单页整体失败: " + e.message);
      return [];
    });
    if (!shouldUseAppleChart()) return ne;
    const ap = Promise.resolve(appleChartEntries());
    return Promise.all([ne, ap]).then((r) => {
      const all = r[0].concat(r[1]);
      /* 鬼畜榜单独一组，而且**只**挂在榜单页 —— 推荐页那边不掺。
         它排在网易/Apple 之后，日常听歌的人刷不到那儿也不碍事。 */
      if (shouldUseBilibili() && shouldBiliGuichu()) {
        all.push({ title: "B站鬼畜", data: biliGuichuEntries() });
      }
      return all;
    });
  },
  /* 榜单详情。网易的榜单条目和歌单是同一套结构，直接复用；
     Apple 的三类（歌曲 / 专辑 / 歌单）自己分流。 */
  getTopListDetail: function (topListItem) {
    if (!topListItem || !topListItem.id) return Promise.resolve(null);
    const id = String(topListItem.id);
    if (id.indexOf(GUICHU_PREFIX) === 0) {
      return biliGuichuRank().then((musicList) => ({
        isEnd: true,
        sheetItem: {
          id: id,
          platform: "Bilibili",
          title: topListItem.title || "B站鬼畜区 · 本周热门",
          artist: topListItem.artist || "Bilibili 鬼畜",
          artwork: (musicList[0] && musicList[0].artwork) || topListItem.artwork || "",
          worksNum: musicList.length,
          playCount: 0,
          description: topListItem.description || "",
        },
        musicList: musicList,
      })).catch((e) => {
        console.log("[粽子] 鬼畜榜失败: " + e.message);
        return { isEnd: true, sheetItem: topListItem, musicList: [] };
      });
    }
    if (id.indexOf("apchart:") === 0 || id.indexOf("apalbum:") === 0 || id.indexOf("applaylist:") === 0) {
      return appleChartDetail(topListItem).catch((e) => {
        console.log("[粽子] Apple 榜单详情失败: " + e.message);
        return null;
      });
    }
    return neteaseSheetDetail(id, 1).catch(() => null);
  },
  /* 「推荐歌单」页入口。tag 就是网易歌单广场的分类，
     按语种/风格/场景/情感/主题分好组，和 App 原生观感一致。
     填了种子歌手的话，顶上加一个「为你推荐」的固定位。 */
  getRecommendSheetTags: function () {
    const tv = tasteVars();
    const seeds = tasteList(tv.seeds);
    const skip = tasteList(tv.skip).map(normText);
    /* 「有你」= 至少有一个种子没被排除名单吃掉。
       ⚠️ 这个判断故意不做成「种子能解析成真歌手」——那要联网验一遍，
          会让整个标签栏等好几秒。宁可先放上去：真解析不出来时
          点进去是空列表（不崩、不报错），比标签栏每次打开卡三秒好。
          唯一的例外是「种子全被自己排掉」这种一眼就定的情况。 */
    const hasTaste = seeds.some((s) => skip.indexOf(normText(s)) < 0);
    return neteaseRecommendTags().then((tags) => {
      if (!hasTaste) return tags;
      const pinned = (tags && tags.pinned) || [];
      return Object.assign({}, tags, {
        pinned: [{ id: TAG_TASTE, title: "为你推荐" }].concat(pinned),
      });
    }).catch((e) => {
      console.log("[粽子] 推荐 tag 失败: " + e.message);
      /* 兜底：至少给几个能点的分类，别让页面空着 */
      return {
        pinned: (hasTaste ? [{ id: TAG_TASTE, title: "为你推荐" }] : []).concat([{ id: "全部", title: "热门" }]),
        data: [{ title: "分类", data: NE_SHEET_CATS.map((c) => ({ id: c, title: c })) }],
      };
    });
  },
  /* 点某个 tag 时来取歌单。app 传的默认 tag 是空 id，按「全部」处理。
     顺序按天固定：同一天翻页不重复、不跳，第二天自动换一批。 */
  getRecommendSheetsByTag: async function (tag, page) {
    const p = Number(page) > 0 ? Number(page) : 1;
    const name = (tag && (tag.id || tag.title)) || "";
    /* 「为你推荐」不是平台标签，而是按用户填的种子现算的画像单。
       放在最前，翻页时给空（画像单就那几张，翻不出新的）。 */
    if (name === TAG_TASTE) {
      if (p > 1) return { isEnd: true, data: [] };
      try {
        const sheets = await tasteSheets();
        return { isEnd: true, data: sheets };
      } catch (e) {
        console.log("[粽子] 画像歌单失败: " + e.message);
        return { isEnd: true, data: [] };
      }
    }
    try {
      const pool = await recSheetPool(name);
      const start = (p - 1) * REC_SHEET_PAGE_SIZE;
      const data = pool.slice(start, start + REC_SHEET_PAGE_SIZE);
      /* 第一屏顶上放一张自己拼的。它排在最前，但内容每天变、
         顺序由我们自己定 —— 这正是平台歌单给不了的部分。
         翻页时不再插，避免每页都冒出同一张拼单。 */
      if (p === 1) {
        let mix = [];
        const fb = (data.find((x) => x.artwork) || {}).artwork || "";
        try { mix = await mixEntries(name, fb); } catch (e) { mix = []; }
        return { isEnd: start + REC_SHEET_PAGE_SIZE >= pool.length, data: mix.concat(data) };
      }
      return { isEnd: start + REC_SHEET_PAGE_SIZE >= pool.length, data: data };
    } catch (e) {
      console.log("[粽子] 推荐歌单失败: " + e.message);
      return { isEnd: true, data: [] };
    }
  },
};/**
 * 严格匹配：搜索结果必须和请求的是同一首歌。
 * 踩过的坑：搜「稻香 周杰伦」，咪咕返回一堆周杰伦的别的歌
 * （圣诞星、我的地盘…），只校验歌手会把《圣诞星》当成《稻香》。
 * 所以标题必须匹配，且歌手必须能对上；结果没给歌手也判不通过（保守）。
 */

/* ============================================================
 * 兜底专用严格匹配
 *
 * 事故：搜「怎麼都沒有了」返回 YouTube 的 IGU Band 版本（元数据正确），
 * 但 YouTube 取流失败，兜底到酷我，酷我搜出
 *   「第100章：他就打了一拳，我们的怪怎么都没有了？（三）」—— 这是听书！
 * titleMatch 的双向包含判定通过，于是「歌的信息 + 听书的音频」。
 *
 * 兜底时**必须**比正常搜索严格得多，因为用户已经认定了这首歌，
 * 给错一首比给不出来更糟。
 * ============================================================ */
function isDefinitelySameSong(it, want) {
  const rawTitle = it.title || it.name || it.SONGNAME || "";
  const rawArtist = it.artist || it.singer || it.ARTIST || "";
  if (!want.name || !rawTitle) return false;

  // 1) 听书/有声书一律拒绝（兜底时绝不能拿这些顶替音乐）
  if (isAudiobookTitle(rawTitle)) return false;
  // 2) 分集编号也拒绝
  if (EPISODE_RE.test(rawTitle)) return false;

  const t = coreTitle(toSimplified(rawTitle));
  const q = coreTitle(toSimplified(want.name));
  if (!t || !q) return false;

  // 3) 标题必须「就是这首歌」，不能只是包含几个字。
  //    规则：去掉括号内容后，两者的核心字符集重合度要高。
  const same = t === q || t.indexOf(q) >= 0 || q.indexOf(t) >= 0;
  if (!same) return false;

  // 4) 长度差异不能太大（「了」vs「怎麼都沒有了」这种要挡掉）
  //    允许标题比查询多出一些（正版会带演唱者等后缀），但不能短太多
  if (t.length < Math.max(2, Math.floor(q.length * 0.6))) return false;
  //    也不能长出太多（听书标题动辄几十字）
  if (t.length > q.length * 3 + 8) return false;

  // 5) 歌手：兜底时放宽——只要不冲突就接受
  //    （跨平台歌手名写法差异大，严格比会全灭）
  if (want.singer && rawArtist) {
    const a = normText(rawArtist);
    const s = normText(splitSingers(want.singer)[0] || "");
    if (s && a) {
      const hit = a.indexOf(s) >= 0 || s.indexOf(a) >= 0;
      // 不冲突就放行，但有明显冲突（都对不上且都很长）时不接受
      if (!hit && a.length > 3 && s.length > 3) return false;
    }
  }
  return true;
}

function isDefinitelySameSong(it, want) {
  const title = it.title || it.name || it.SONGNAME || "";
  const artist = it.artist || it.singer || it.ARTIST || "";
  if (!want.name || !title) return false;
  if (!titleMatch(title, want.name)) return false;
  if (want.singer) {
    if (!artist) return false;
    if (!singerMatch(artist, want.singer)) return false;
  }
  return true;
}


/* ============================================================
 * MD5 —— React Native 没有 Node 的 crypto，自己实现一份
 * 只用于 JOOX 的签名（UTF-8 字符串 → 32 位小写十六进制）
 * ============================================================ */
function md5Hex(str) {
  function rl(x, c) { return (x << c) | (x >>> (32 - c)); }
  function ad(a, b) { return (a + b) | 0; }
  function cmn(q, a, b, x, s, t) { a = ad(ad(a, q), ad(x, t)); return ad(rl(a, s), b); }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }

  // UTF-8 编码（RN 里没有 unescape，手动转）
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) { bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const c2 = str.charCodeAt(++i);
      const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else { bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
  }

  const n = bytes.length * 8;
  const bl = bytes.slice();
  bl.push(0x80);
  while (bl.length % 64 !== 56) bl.push(0);
  // ⚠️ JS 的 >>> 位移量会 mod 32，所以 n >>> 32 等价于 n >>> 0，
  //    直接用循环会把长度字段重复写一遍。必须拆成低 32 位 / 高 32 位。
  const lo = n >>> 0;
  const hi = Math.floor(n / 4294967296);
  bl.push(lo & 255, (lo >>> 8) & 255, (lo >>> 16) & 255, (lo >>> 24) & 255);
  bl.push(hi & 255, (hi >>> 8) & 255, (hi >>> 16) & 255, (hi >>> 24) & 255);

  const w = [];
  for (let i = 0; i < bl.length; i += 4) {
    w.push(bl[i] | (bl[i + 1] << 8) | (bl[i + 2] << 16) | (bl[i + 3] << 24));
  }

  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  for (let i = 0; i < w.length; i += 16) {
    const oa = a, ob = b, oc = c, od = d;
    a = ff(a, b, c, d, w[i], 7, -680876936); d = ff(d, a, b, c, w[i + 1], 12, -389564586);
    c = ff(c, d, a, b, w[i + 2], 17, 606105819); b = ff(b, c, d, a, w[i + 3], 22, -1044525330);
    a = ff(a, b, c, d, w[i + 4], 7, -176418897); d = ff(d, a, b, c, w[i + 5], 12, 1200080426);
    c = ff(c, d, a, b, w[i + 6], 17, -1473231341); b = ff(b, c, d, a, w[i + 7], 22, -45705983);
    a = ff(a, b, c, d, w[i + 8], 7, 1770035416); d = ff(d, a, b, c, w[i + 9], 12, -1958414417);
    c = ff(c, d, a, b, w[i + 10], 17, -42063); b = ff(b, c, d, a, w[i + 11], 22, -1990404162);
    a = ff(a, b, c, d, w[i + 12], 7, 1804603682); d = ff(d, a, b, c, w[i + 13], 12, -40341101);
    c = ff(c, d, a, b, w[i + 14], 17, -1502002290); b = ff(b, c, d, a, w[i + 15], 22, 1236535329);

    a = gg(a, b, c, d, w[i + 1], 5, -165796510); d = gg(d, a, b, c, w[i + 6], 9, -1069501632);
    c = gg(c, d, a, b, w[i + 11], 14, 643717713); b = gg(b, c, d, a, w[i], 20, -373897302);
    a = gg(a, b, c, d, w[i + 5], 5, -701558691); d = gg(d, a, b, c, w[i + 10], 9, 38016083);
    c = gg(c, d, a, b, w[i + 15], 14, -660478335); b = gg(b, c, d, a, w[i + 4], 20, -405537848);
    a = gg(a, b, c, d, w[i + 9], 5, 568446438); d = gg(d, a, b, c, w[i + 14], 9, -1019803690);
    c = gg(c, d, a, b, w[i + 3], 14, -187363961); b = gg(b, c, d, a, w[i + 8], 20, 1163531501);
    a = gg(a, b, c, d, w[i + 13], 5, -1444681467); d = gg(d, a, b, c, w[i + 2], 9, -51403784);
    c = gg(c, d, a, b, w[i + 7], 14, 1735328473); b = gg(b, c, d, a, w[i + 12], 20, -1926607734);

    a = hh(a, b, c, d, w[i + 5], 4, -378558); d = hh(d, a, b, c, w[i + 8], 11, -2022574463);
    c = hh(c, d, a, b, w[i + 11], 16, 1839030562); b = hh(b, c, d, a, w[i + 14], 23, -35309556);
    a = hh(a, b, c, d, w[i + 1], 4, -1530992060); d = hh(d, a, b, c, w[i + 4], 11, 1272893353);
    c = hh(c, d, a, b, w[i + 7], 16, -155497632); b = hh(b, c, d, a, w[i + 10], 23, -1094730640);
    a = hh(a, b, c, d, w[i + 13], 4, 681279174); d = hh(d, a, b, c, w[i], 11, -358537222);
    c = hh(c, d, a, b, w[i + 3], 16, -722521979); b = hh(b, c, d, a, w[i + 6], 23, 76029189);
    a = hh(a, b, c, d, w[i + 9], 4, -640364487); d = hh(d, a, b, c, w[i + 12], 11, -421815835);
    c = hh(c, d, a, b, w[i + 15], 16, 530742520); b = hh(b, c, d, a, w[i + 2], 23, -995338651);

    a = ii(a, b, c, d, w[i], 6, -198630844); d = ii(d, a, b, c, w[i + 7], 10, 1126891415);
    c = ii(c, d, a, b, w[i + 14], 15, -1416354905); b = ii(b, c, d, a, w[i + 5], 21, -57434055);
    a = ii(a, b, c, d, w[i + 12], 6, 1700485571); d = ii(d, a, b, c, w[i + 3], 10, -1894986606);
    c = ii(c, d, a, b, w[i + 10], 15, -1051523); b = ii(b, c, d, a, w[i + 1], 21, -2054922799);
    a = ii(a, b, c, d, w[i + 8], 6, 1873313359); d = ii(d, a, b, c, w[i + 15], 10, -30611744);
    c = ii(c, d, a, b, w[i + 6], 15, -1560198380); b = ii(b, c, d, a, w[i + 13], 21, 1309151649);
    a = ii(a, b, c, d, w[i + 4], 6, -145523070); d = ii(d, a, b, c, w[i + 11], 10, -1120210379);
    c = ii(c, d, a, b, w[i + 2], 15, 718787259); b = ii(b, c, d, a, w[i + 9], 21, -343485551);

    a = ad(a, oa); b = ad(b, ob); c = ad(c, oc); d = ad(d, od);
  }

  function hx(x) {
    let out = "";
    for (let i = 0; i < 4; i++) out += ("0" + ((x >>> (i * 8)) & 255).toString(16)).slice(-2);
    return out;
  }
  return hx(a) + hx(b) + hx(c) + hx(d);
}

/* ============================================================
 * 兜底封面的统一挂载点
 *
 * 不逐处改 artwork 的赋值（那种地方有九十来处，漏一个就是一个灰块），
 * 而是在导出层统一包一层：凡是对外返回曲目列表的方法，出参都过一遍
 * deepFillArt()。以后新加平台也不用再记得手动补封面。
 * ============================================================ */
(function () {
  ["search", "getAlbumInfo", "getMusicSheetInfo", "getArtistWorks", "getTopLists",
   "getTopListDetail", "getRecommendSheetsByTag", "getMusicComments"].forEach(function (name) {
    const fn = module.exports[name];
    if (typeof fn !== "function") return;
    module.exports[name] = function () {
      const r = fn.apply(this, arguments);
      if (r && typeof r.then === "function") return r.then(function (v) { return deepFillArt(v, 0); });
      return deepFillArt(r, 0);
    };
  });
})();

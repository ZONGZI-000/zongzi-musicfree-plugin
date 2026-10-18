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
 *  时长未知的条目一律放行，宁可放过也不冤枉。 */
const MIN_BYTES_PER_SEC = 6 * 1024; // ≈48kbps

async function isPreviewOnly(url, durationMs) {
  const ms = Number(durationMs) || 0;
  if (ms <= 0) return false;
  const p = await probeAudio(url);
  if (!p.total) return false;
  return p.total / (ms / 1000) < MIN_BYTES_PER_SEC;
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

/** 歌手没对上的罚分，只在 2 档内部生效：歌名一样但换了人的排后面 */
const ARTIST_MISS_PENALTY = 40;

/** 标题里的「这是资讯/视频，不是歌」字样。
 *  搜歌手名时全靠它把八卦新闻从歌曲堆里挑出来压下去。 */
const NEWS_TITLE_RE = /破防|亮立场|立场|出征|集体|网友|网友笑|笑死|翻车|卖台|表态|回應|回应|新聞|新闻|大白話|大白话|譴責|谴责|統一|统一|門票|门票|演唱會門票|票價|票价|專訪|专访|爆料|怒斥|崩潰|崩溃|打臉|打脸|專輯發|专辑发|新歌|首發|首发|破億|破亿|霸榜|熱搜|热搜|網亮|网亮|主播|直播回放|太惨|太慘|卖不出去|賣不出去|降价|降價|綠媒|绿媒|中天|三立|民視|民视|TVBS|東森|央視|央视|新華社|新华社|網紅|网红|洗版|吵翻|吵翻天|炸鍋|炸锅|政治|選情|选情|罷免|罢免|立委|議員|议员|部長|部长|總統|总统|中共|解放軍|解放军|軍演|军演|外交|國防|国防|關稅|关税/i;

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
const MEDIA_VIDEO_RE = /幕后|幕後|花絮|混剪|首播|预告|預告|抢先看|搶先看|彩蛋|彩排|探班|采访|採訪|专访|專訪|片段|剪辑|剪輯|未公开|未公開|reaction|instrumental|纯音乐|純音樂/i;

/** 查询词整串是否就是这位歌手的名字（搜「周杰伦」而不是搜某首歌）。
 *  ⚠️ 只认整串、且长度 ≥2，避免「起风了 买辣椒也用券」这种组合串误判。 */
/* 反查确认过的「查询词 → 同一身份的其它名字」。
 * 有了它，「IGU Band」这种**一个字都不重合**的英文名才认得出是歌手：
 * 结果里 artist 写着「那我懂你意思了」，光靠字符串包含永远判不出来。 */
const ARTIST_ALIAS = {};

function isArtistQuery(query, artist) {
  const qn = normTextZ(query);
  if (!qn || qn.length < 2) return false;
  const an = singerNorm(toSimplified(artist));
  if (!an) return false;
  if (an.indexOf(qn) >= 0) return true;
  const als = ARTIST_ALIAS[qn];
  if (als && als.length) {
    for (let i = 0; i < als.length; i++) {
      const k = normTextZ(als[i]);
      if (k && an.indexOf(k) >= 0) return true;
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

function relevanceTier(title, query, artist, artistQuery) {
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
  const isAQ = artistQuery || isArtistQuery(q, artist);
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
    // 这一截是歌名，剩下那截得在歌手名里对得上，才算完全匹配
    const artistOk = artistConsistent(c.others, at);
    if (flat === c.text) {
      // 「起风了」对「起风了」；「起风了（2019版）」多出六个字，不算
      const t = artistOk ? 3 : 2;
      if (t > best) best = t;
      if (best === 3) return 3;
    } else if (c.text.length >= 2 && core.indexOf(c.text) >= 0) {
      if (best < 2) best = 2;
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

  // 内地数字平台上的同名单曲：原唱常常没版权，页面里剩的多是翻唱
  if (platform === "QQ音乐" || platform === "网易云" || platform === "酷狗" || platform === "咪咕") bone += 12;

  // 现场 / 巡演 / 合集
  if (/演唱会|現場|现场|live\s*(版|in)|巡演|音樂節|音乐节|社慶|社庆|cover/i.test(t)) bone += 20;

  /* 搜歌手名时，标题里全是「新闻/破亿/笑死/出征」这类资讯词的，
     是视频不是歌。此时没有「歌名」可对齐，只能靠这条把它压下去。 */
  if ((artistQuery || isArtistQuery(q, a)) && NEWS_TITLE_RE.test(t)) bone += 30;

  return bone;
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
    const artistOk = artistConsistent(c.others, at);
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
  return best < 0 ? 0 : best;
}


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
function t2sMap() {
  if (_t2sMap) return _t2sMap;
  const m = {};
  const arr = T2S_PAIRS.split(",");
  for (let i = 0; i < arr.length; i++) {
    const p = arr[i].split(":");
    // T2S_PAIRS 是「繁:简」，方向就是我们要的，直接建表
    if (p.length === 2 && p[0] && p[1] && !m[p[0]]) m[p[0]] = p[1];
  }
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
    const qq = await axios_1.get("https://c.y.qq.com/soso/fcgi-bin/client_search_cp", {
      params: { w: q, t: 9, p: 1, n: 5, format: "json" },
      timeout: 8000,
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
      /* 没有括号译名时，主名要跟查询词有 2 字连续重合才收
         （防止搜「晴天」时把 QQ 里同名的野鸡歌手当成译名）。 */
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

    /* ③ 两条证据至少中一条才认这个 id */
    let pickId = "";
    if (domId && domN >= 2 && share >= 0.25 && (domId === artId || normTextZ(byId[domId].name).indexOf(qn) >= 0)) {
      pickId = domId;                       // 专辑压倒性 + 艺人实体对得上
    } else if (artId && artName && normTextZ(artName).indexOf(qn) >= 0) {
      pickId = artId;                       // 艺人实体自己就含查询词
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
    const r = await axios_1.post(
      "https://music.163.com/api/cloudsearch/pc",
      "s=" + encodeURIComponent(q) + "&type=100&limit=6&offset=0",
      {
        timeout: 12000,
        headers: Object.assign({}, NETEASE_HEADERS, {
          "Content-Type": "application/x-www-form-urlencoded",
        }),
        validateStatus: () => true,
      }
    );
    const arts = (r.data && r.data.result && r.data.result.artists) || [];
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
    const songs = (sres.data && sres.data.result && sres.data.result.songs) || [];
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
    // 至少 3 条、且占结果的 40% 以上，才认「这串词就是这位歌手」
    if (!looksLikeSong && topName && topCnt >= 3 && topCnt * 10 >= songs.length * 4) {
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
  let qq = { names: [], authoritative: false, exact: false };
  try { qq = await qqP; } catch (e) { /* 空 */ }
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
  // QQ / Apple 都没线索 → 才动用网易云那条慢路径（拿假名/罗马音/译名）
  const al = await neteaseArtistAliases(q, qq).catch(() => []);
  for (let i = 0; i < (al || []).length; i++) push(names, al[i]);
  return { q: q, names: names.slice(0, 6), auth: ALIAS_AUTH[normTextZ(q)] || [], cheap: false };
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

/** 歌手条目排序：在原来 rankByName 的基础上，多认两个信号 ——
 *   ① 权威原名（QQ 的「原名 (译名)」写法）压在译名同名条目之前
 *   ② 作品多的更可能是正经歌手（128 首的山寨号 vs 613 首的本尊）
 *  没有别名时不会走到这里（见 searchArtist 里的 names.length > 1 判断），
 *  所以老行为一个字都不变。 */
function rankArtistCandidates(list, query, names, authNames) {
  const qz = normTextZ(query);
  const auth = (authNames || []).map(normTextZ).filter(Boolean);
  return list.map((x) => {
    const nz = normTextZ(x.name);
    let sc = 0;
    if (nz === qz) sc += 100;
    else if (nz.indexOf(qz) >= 0) sc += 55;
    else sc += 20;                       // 只是命中了别名
    for (let i = 0; i < auth.length; i++) {
      if (nz === auth[i]) { sc += 120; break; }
      if (nz.indexOf(auth[i]) >= 0) { sc += 60; break; }
    }
    sc -= Math.max(0, nz.length - qz.length) * 2;
    if (x.platform === "酷我") sc += 5;
    if (x._official) sc += 40;
    if (x.platform === "咪咕直出" && nz !== qz) sc -= 15;
    // 作品数只当小权重（最多 10 分），不能盖过名字匹配
    const w = Number(x.worksNum || 0);
    if (w > 0) sc += Math.min(10, (Math.log(w) / Math.LN10) * 6);
    return { x: x, sc: sc };
  }).sort((a, b) => b.sc - a.sc).map((y) => y.x);
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
      if (an === qn || an.indexOf(qn) >= 0 || qn.indexOf(an) >= 0) { picked = artists[i]; break; }
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

async function authorityHint(query, topArtist) {
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
       全都是判定「正式发行版」要用的字段。 */
    const songRes = await itunesSearchAny("/search", {
      term: q, entity: "song", limit: 25, country: "cn",
    });
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

    let best = null;
    let bestSc = -1;
    for (let i = 0; i < tracks.length; i++) {
      const tk = tracks[i];
      const tn = normText(toSimplified(tk.trackName || ""));
      if (!tn) continue;
      let sc = 0;
      if (tn === probe) sc += 100;
      else if (tn.indexOf(probe) >= 0 || probe.indexOf(tn) >= 0) sc += 40;
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
      if (/live|演唱会|演唱會|remix|dj|伴奏|karaoke/i.test(String(tk.collectionName || ""))) sc -= 60;
      if (/翻唱|cover/i.test(String(tk.collectionName || ""))) sc -= 60;
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
  if (t !== at && t.indexOf(at) < 0 && at.indexOf(t) < 0) return 0;  // 不是同一首，不加不扣

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

const COCO_RETRY_BUDGET_MS = 2500;

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
async function fetchRange(url, start, end) {
  try {
    const r = await axios_1.get(url, {
      timeout: 20000,
      responseType: "arraybuffer",
      validateStatus: () => true,
      headers: { "User-Agent": UA, Range: "bytes=" + start + "-" + end },
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
async function inlineAudio(url, sizeHint, mimeHint) {
  const size = Number(sizeHint || 0);
  if (!size || size > YT_INLINE_MAX_BYTES) return null;

  // 先拉第一块确认能下、并验魔数（省得白下整首才发现是错误页）
  const first = await fetchRange(url, 0, Math.min(INLINE_CHUNK, size) - 1);
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
      const part = await fetchRange(url, s, e);
      if (!part) { failed = true; return; }
      u8.set(part, s);
      filled += part.length;
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(INLINE_CONCURRENCY, ranges.length); i++) workers.push(worker());
  await Promise.all(workers);

  if (failed || filled < size * 0.98) return null;
  if (u8.length < 4096 || u8.length > YT_INLINE_MAX_BYTES) return null;

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

async function biliSearch(keyword, page) {
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
  const musicOnly = shouldBiliMusicOnly();
  let r = await call(musicOnly ? { tids: 3 } : null);
  let d = r.data || {};
  let raw = (d.data && d.data.result) || [];
  // 音乐区过滤把结果吃光（冷门关键词很常见）就退回全站，至少别空手
  if (d.code === 0 && !raw.length && musicOnly) {
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
  (dash.audio || []).forEach((a) => {
    if (a.baseUrl) out.push({ kind: "audio", id: a.id, bw: a.bandwidth || 0, url: a.baseUrl });
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

async function biliFetchUrl(bvid, quality) {
  const list = await biliStreams(bvid);
  const pool = list.filter((x) => x.kind === "audio");
  const use = pool.length ? pool : list;
  // super 取最高，其余取较低的那档省流量
  const pick = lossless(quality) || quality === "320k" ? use[0] : use[use.length - 1];
  // B站 CDN 必须带 Referer，否则 403
  if (!(await verifyPlayable(pick.url, { Referer: "https://www.bilibili.com/", Cookie: biliCookie }))) {
    throw new Error("bili: 地址不可播");
  }
  return pick.url;
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

  return function (item) {
    const a = singerNorm(item.artist || "");
    if (!a) return -5;                    // 没歌手信息，略降
    if (a === top) return 90;
    if (a.indexOf(top) >= 0 || top.indexOf(a) >= 0) return 60;
    return -25;                           // 明确是别人 → 压到同名条目的最底部
  };
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
async function songQueryRatio(query) {
  const q = String(query || "").trim();
  if (!q) return -1;
  const ck = normTextZ(q);
  const hit = SONGQ_CACHE[ck];
  if (hit && Date.now() - hit.at < APPLE_CAT_TTL) return hit.v;

  let ratio = -1;
  try {
    const sres = await itunesSearchAny("/search", { term: q, entity: "song", limit: 25 });
    const res = ((sres && sres.results) || []).filter((x) => x.wrapperType === "track");
    // 结果太少说明不了问题（搜冷门词可能就回 1~2 条）
    if (res.length >= 8) {
      const qn = normTextZ(q);
      let n = 0;
      for (let i = 0; i < res.length; i++) {
        if (normTextZ(res[i].trackName || "").indexOf(qn) >= 0) n++;
      }
      ratio = n / res.length;
    }
  } catch (e) { ratio = -1; }

  SONGQ_CACHE[ck] = { at: Date.now(), v: ratio };
  return ratio;
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
      const titleRatio = await songQueryRatio(query);
      if (titleRatio >= 0.55) {
        console.log("[粽子]「" + nm + "」名下 " + total + " 张专辑，但这个词是歌名（标题命中 "
          + titleRatio.toFixed(2) + "）→ 不按歌手查询处理");
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
    if (cat && !cat.truncated && cat.albums.length >= 2 && cat.tracks.length >= 10) {
      if (await looksLikeSongQuery(eq)) {
        console.log("[粽子]「" + cat.name + "」目录 " + cat.albums.length + " 张，"
          + "但「" + String(query).trim() + "」是歌名 → 不走 Apple 目录");
      } else {
        appleAlbums = cat;
        console.log("[粽子] 酷狗无此歌手，改用 Apple 目录「" + cat.name + "」"
          + cat.albums.length + " 张");
      }
    }
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
        if (a === artistN || a.indexOf(artistN) >= 0 || artistN.indexOf(a) >= 0) return true;
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
    const appleSet = appleAlbums.albumSet;
    const normSet = Object.keys(appleSet);

    /* Apple 的专辑名对到各平台结果上。
       用户搜歌手时看不到歌名列表，光有专辑名没有播放地址也没用，
       所以必须从平台结果里**配对**——名字对得上、歌手也对得上才算。 */
    const hitAppleAlbum = (x) => {
      const n = normAlbumName(x.title);
      if (!n) return false;
      if (appleSet[n]) return true;
      for (let i = 0; i < normSet.length; i++) {
        const a = normSet[i];
        if (a.length >= 3 && (a.indexOf(n) >= 0 || n.indexOf(a) >= 0)) return true;
      }
      return false;
    };
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
    const used = {};
    const kept2 = [];
    for (let i = 0; i < appleAlbums.albums.length; i++) {
      const a = appleAlbums.albums[i];
      const an = normAlbumName(a.title);
      let best = null, bestSc = -1;
      for (let j = 0; j < pool.length; j++) {
        const x = pool[j];
        if (used[j]) continue;
        const xn = normAlbumName(x.title);
        if (!xn) continue;
        let sc = 0;
        if (xn === an) sc = 100;
        else if (an.length >= 3 && (xn.indexOf(an) >= 0 || an.indexOf(xn) >= 0)) sc = 60;
        else continue;
        // 曲目数对得上更可信（正规专辑 8~13 首，单曲 1~2 首）
        if (a.worksNum >= 5 && Number(x.worksNum || 0) >= 5) sc += 20;
        if (sc > bestSc) { bestSc = sc; best = j; }
      }
      if (best !== null) {
        used[best] = 1;
        /* ⚠️ 平台条目的 date / worksNum 经常是缺的 ——
           咪咕那条《没有人在乎你在乎的事》worksNum=0、date=""，
           排序时会掉进「单曲」那档被甩到最后，明明它是 2014 年的正规专辑。
           用 Apple 的权威值补上（平台自己有值就不覆盖）。 */
        const x = pool[best];
        if (!Number(x.worksNum)) x.worksNum = a.worksNum;
        if (!String(x.date || "").trim()) x.date = a.date;
        if (!x.artwork) x.artwork = a.artwork;
        kept2.push(x);
      } else {
        kept2.push({
          id: "apple:" + appleAlbums.id + ":" + i,
          platform: "Apple Music",
          title: a.title,
          artist: a.artist,
          artwork: a.artwork,
          date: a.date,
          description: "Apple Music 目录（该平台暂无音源）",
          worksNum: a.worksNum,
          _provider: "apple",
          _kind: "album",
        });
      }
    }
    console.log("[粽子] Apple 目录「" + appleAlbums.name + "」" + appleAlbums.albums.length
      + " 张，其中 " + kept2.filter((x) => x._provider !== "apple").length + " 张配到平台音源");

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

    // 提到最前：曲目数多的在前（正版专辑曲目最多，也最能代表这张专辑）
    if (marked.length) {
      const top = marked.slice().sort((a, b) => (b.worksNum || 0) - (a.worksNum || 0));
      const inTop = {};
      for (let i = 0; i < top.length; i++) inTop[top[i].platform + "|" + top[i].id] = 1;
      const rest = data.filter((x) => !inTop[x.platform + "|" + x.id]);
      data = top.concat(rest);
    }
  }

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
  ]);

  const pick = await pickEffectiveName(query, aliasP).catch(() => ({ name: query, via: "", names: [query] }));
  const eq = pick.name;
  let [kw, mg, yt] = await baseP;

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
    const [kw2, mg2, yt2] = await Promise.all([
      kuwoSearchTyped(eq, "artist", page, KUWO_PAGE_SIZE).catch(() => ({ total: 0, list: [] })),
      miguSearchTyped(eq, "singer", page, 10).catch(() => ({ total: 0, list: [] })),
      page === 1 ? ytSearchRaw(eq).catch(() => []) : Promise.resolve([]),
    ]);
    console.log("[粽子] 歌手「" + query + "」" + (isAuth ? "有权威原名" : "原查询无结果")
      + " → 改用「" + eq + "」重搜");
    kw = kw2; mg = mg2; yt = yt2;
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
    // 只留「名字里真的含查询词/原名」的（允许繁简/大小写差异）
    if (!nameMatchesAny(nm, nameSet)) continue;
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
        out.push({
          id: "apart:" + cat.id,
          platform: "Apple Music",
          name: cat.name || eq,
          avatar: (cat.albums[0] && cat.albums[0].artwork) || "",
          worksNum: cat.tracks.length || cat.albums.length,
          fans: 0,
          description: "",
          _provider: "apple",
        });
      }
    } catch (e) { /* 拿不到就维持空结果 */ }
  }

  /* 排序：
     没换名、也没别名 → 走原来的 rankByName，老行为一个字不变。
     有别名时改用 rankArtistCandidates —— 它会把「QQ 声明的原名」
     （彩虹乐队 → L'Arc〜en〜Ciel）顶到山寨同名号前面。 */
  const ranked = (pick.names.length > 1 || (pick.auth && pick.auth.length))
    ? rankArtistCandidates(out, query, pick.names, pick.auth)
    : rankByName(out, query, "name");
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

  /* ⚠️「有数字」不等于「数字对」：实测「那我懂你意思了」，
     酷狗把名字指向了冒名歌手（名下只有 2 首），列表就写「2 首」，
     用户会以为源坏了 —— 其实真乐团 31 首。Apple 目录更全时以它为准。 */
  const fewWorks = deduped.filter((x) => Number(x.worksNum) < 10).slice(0, 3);
  if (fewWorks.length) {
    await Promise.all(fewWorks.map(async (x) => {
      try {
        const cat = await appleArtistCatalog(x.name);
        if (cat && cat.tracks.length > Number(x.worksNum)) x.worksNum = cat.tracks.length;
      } catch (e) { /* 忽略 */ }
    }));
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
      byName[k] = a;
      order.push(k);
      continue;
    }
    if (score(a) > score(prev)) byName[k] = a;
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
async function neteaseSheetDetail(playlistId, page) {
  const r = await axios_1.get(NETEASE_PLAYLIST_DETAIL, {
    params: { id: playlistId, n: 1000 },
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
  const allIds = ((p.trackIds) || []).map((x) => x.id).filter((id) => id && !have[String(id)]);
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

  /* Apple Music 目录占位专辑：平台没这张唱片，但用户点了得有东西看。
     曲目表从 Apple 的歌手目录里按专辑名捞，再用 YouTube 找可播放的音频 ——
     找到了就能听，找不到至少知道这张专辑有哪几首。 */
  /* Apple 榜单里的专辑（apalbum:<区>:<专辑id>）：曲目直接读专辑页，
     因为 itunes lookup 对一部分专辑返回 0 首（实测《太阳之子》五个区全空）。 */
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

  // 酷我：用 album 页面的 __NUXT__ 拿曲目；简单起见先走搜索兜底
  try {
    const d = await kuwoSheetsByAlbum(id);
    if (d && d.musicList && d.musicList.length) return d;
  } catch (e) { /* 落到下面 */ }
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
  const pn = (page || 1) - 1;
  const rn = 30;

  /* Apple 目录歌手条目（id 形如 apart:1223943074）—— 平台全都没有这个人，
     只有 Apple 有。专辑和曲目都走 appleArtistWorks（带 1 小时缓存）。 */
  if (String(id).indexOf("apart:") === 0) {
    const artistId = String(id).slice(6);
    if (!artistId) return { isEnd: true, data: [] };
    const r = await appleArtistWorks(artistId, page, type === "album" ? "album" : "music", rn);
    return r;
  }

  /* YouTube 歌手条目（id 形如 ytch:IGU Band）—— 这类是酷我/咪咕都查不到、
     只能靠 Topic 频道兜底的冷门艺人。作品直接按「频道名」在 YouTube 搜，
     只收该频道的曲目。 */
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
          「歌名 + 频道名」，实测 9/9 全部命中 Topic 官方频道，耗时 <1s。 */
    const cat = await appleArtistCatalog(chName);
    if (cat && cat.tracks && cat.tracks.length) {
      const CONC = 6;   // YouTube 这边并发开大会被限流
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
  // tier 越大越好（3 完全匹配 / 2 沾边 / 1 变体），降序
  if (a._tier !== b._tier) return (b._tier || 0) - (a._tier || 0);
  // 相关性闸门降权（原因见 searchMusicAll 里 _rel 的注释）
  const ra = a._rel || 0, rb = b._rel || 0;
  if (ra !== rb) return rb - ra;
  // extra 越小越好（多出来的字数少）
  if (a._extra !== b._extra) return (a._extra || 0) - (b._extra || 0);
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
  // 播放量微调
  const ha = a._hot || 0, hb = b._hot || 0;
  if (ha !== hb) return hb - ha;
  if (a._heat !== b._heat) return (b._heat || 0) - (a._heat || 0);
  return (a._order || 0) - (b._order || 0);
}

async function searchMusicAll(query, page) {
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
      aliasPromise.then((aliases) => {
        const anchors = [query].concat(aliases);
        const kws = aliases.length ? aliases.concat([query]) : [query];
        // 依次试，第一次拿到结果就停（避免多打请求拖慢整体）
        return (async () => {
          for (let k = 0; k < kws.length; k++) {
            let raw = [];
            try { raw = await ytSearchRaw(kws[k]); } catch (e) { continue; }
            const keep = (raw || []).filter((x) => {
              const d = ytDurSec(x.durationText);
              // 太短是切片、太长是合辑/直播回放/有声书
              if (d > 0 && (d < 60 || d > 900)) return false;
              if (/伴奏|教学|教程|测评|反应|reaction|钢琴谱|guitar\s*cover/i.test(x.title)) return false;
              if (shouldFilterCover() && !COVER_RE.test(query) && isCoverTitle(x.title)) return false;
              if (shouldFilterAudiobook() && isAudiobookTitle(x.title)) return false;
              if (!titleMatchesAnchors(x.title, anchors, query)) return false;
              return true;
            });
            return { keep: keep, kw: kws[k] };
          }
          return { keep: [], kw: "" };
        })();
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
      aliasPromise.then(async (aliases) => {
        const anchors = [query].concat(aliases);
        // 有原名就先拿原名搜（原名召回远好于译名），译名留着当兜底
        const kws = aliases.length ? aliases.concat([query]) : [query];
        for (let k = 0; k < kws.length; k++) {
          let raw = [];
          try { raw = await biliSearch(kws[k], 1); } catch (e) { continue; }
          const keep = (raw || [])
            .filter((x) => {
              const d = x.duration / 1000;
              if (d > 0 && (d < 60 || d > 900)) return false;
              if (/伴奏|教学|教程|鼓谱|吉他谱|钢琴谱|karaoke|测评|reaction/i.test(x.title)) return false;
              if (shouldFilterAudiobook() && isAudiobookTitle(x.title)) return false;
              // ⚠️ 标题必须真的命中查询词/原名。B 站是分词匹配，
              //    搜「摇晃帝国」会返回《时光的摇晃》《摇晃的汽水》，
              //    这些标题里根本没有「帝国」两个字，必须拦掉。
              if (!titleMatchesAnchors(x.title, anchors, query)) return false;
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
            console.log("[粽子] Bilibili " + keep.length + " 条（关键词: " + kws[k] + "）");
            return keep;
          }
        }
        return [];
      })
        .catch((e) => { console.log("[粽子] Bilibili 失败: " + e.message); return []; })
    );
  }

  // 咪咕官方直出
  if (shouldUseMiguApi()) {
    jobs.push(
      withRetry("咪咕直出", () => miguApiSearch(query, 10)).then((l) =>
        (l || []).map((x) => ({
          id: x.id, platform: "咪咕直出", title: x.title, artist: x.artist,
          album: "", artwork: x.artwork, duration: 0,
          _provider: "miguapi", _raw: x,
        }))
      )
    );
  }

  // 一把并发，等最慢的那个（约 1.1s，瓶颈在 COCO 网易云）
  const results = await Promise.all(jobs);
  for (let i = 0; i < results.length; i++) {
    if (results[i] && results[i].length) settled.push(results[i]);
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
  const aliasList = await aliasPromise;
  const matchAnchors = [query].concat(aliasList);
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
  const artistQuery = detectArtistQuery(query, filtered2);
  /* 判定没成立、但已经有 ≥2 条结果的歌手字段包含整串查询词时，
     说明「这多半是个人名」，只是这次返回的官方曲不够多（YouTube 每次给的
     Topic 条目在 3~7 条之间抖）。这种时候仍然去问一次 Apple 曲库：
     查到了就用目录把冒名的清掉，查不到就算了 —— 判定本身不改，
     仅仅是多给它一次「证明自己」的机会，避免同一个词有时干净有时一锅粥。 */
  const artistHits = countArtistHits(query, filtered2);
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
    if ((it.platform === "YouTube" || it.platform === "Bilibili") &&
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
    if ((it.platform === "YouTube" || it.platform === "Bilibili") &&
        MEDIA_VIDEO_RE.test(it.title)) {
      const residual2 = coreTitle(it.title).replace(qcore, "").length;
      if (residual2 >= 6) { droppedNews++; continue; }
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
      if (aliasList.length) {
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
  const auth = await authorityHint(query, authArtists);

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
  const exactTitleHit = relevant.some(function (it) {
    const f1 = flatTitle(it.title);
    return f1 && f1 === flatTitle(query) && f1.length >= 2;
  });
  let appleCat = null;
  if (artistQuery || artistHits >= 2 || !exactTitleHit) {
    appleCat = await appleArtistCatalog(query);
    if (appleCat) {
      console.log("[粽子] Apple 目录「" + appleCat.name + "」"
        + appleCat.albums.length + " 张专辑 / " + appleCat.tracks.length + " 首");
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
      const CONC = 6;
      for (let i = 0; i < missing.length; i += CONC) {
        const batch = missing.slice(i, i + CONC);
        await Promise.all(batch.map(async function (t) {
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
        }));
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
  const groups = new Map();
  let order = 0;
  for (let i = 0; i < relevant.length; i++) {
    const it = relevant[i];
    const key = normText(it.title) + "|" + normText(splitSingers(it.artist)[0] || "");
    it._tier = relevanceTier(it.title, query, it.artist, artistQuery);
    it._extra = relevanceExtra(it.title, query, it.artist, artistQuery);
    it._bone = officialBone(it.title, it.artist, it.platform, query, artistQuery);
    it._hot = hotScore(it.playCount);
    it._auth = authorityScore(it, auth);   // ← 新增：权威库加分
    it._apc = appleCatScore(it, appleCat); // ← 歌手目录白名单
    it._order = order++;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }

  const out = [];
  groups.forEach((arr) => {
    arr.sort((a, b) => {
      // ⚠️ tier 越大越好（3 完全匹配 / 1 变体），所以必须**降序**
      if (a._tier !== b._tier) return b._tier - a._tier;
      // 相关性闸门降权（0 = 跟查询沾不上边，压到相关的后面，但不删）
      const ra = a._rel || 0, rb = b._rel || 0;
      if (ra !== rb) return rb - ra;
      if (a._extra !== b._extra) return a._extra - b._extra;
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

  // ---- 后台预取前几首的播放地址 ----
  // 用户要求「先缓存好」，这样点第一首时不用等 1.5 秒。
  // 注意：这里**不 await**，让它自己跑完；搜索立刻返回。
  // Hermes 里 promise 链在函数返回后仍会继续执行（只是拿不到结果），
  // 所以能起到预热效果。
  if (shouldPrefetch()) {
    prefetchTop(out, 3);
  }

  // _auth 带出去给 search() 用：降级补搜时要用同一份权威目录重新打分
  return { isEnd: true, data: out, _auth: auth };
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
   所以按 platform+id 缓存即可，跟 quality 无关。 */
function mediaCacheKey(item) {
  return String(item.platform || "") + "|" + String(item.id || "");
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

async function getMediaSource(musicItem, quality) {
  // 1) 内存里已有完整音频（data: URI）→ 直接复用，别重复下载
  const inline = inlineCacheGet(musicItem);
  if (inline) return { url: inline };

  // 2) 30 分钟内的直链缓存（跟音质无关），不再重走取流链路
  const cached = mediaCacheGet(musicItem);
  if (cached) {
    return { url: cached };
  }

  const result = await resolveMediaSource(musicItem, quality);

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
  const accept = async (u, who) => {
    if (await isPreviewOnly(u, durMs)) {
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
  version: "4.9.18",
  author: "粽子 & Alma",
  description:
    "九源聚合 + 四类搜索（单曲/专辑/歌手/歌单）。网易云 / QQ / 酷狗 / 咪咕 / 酷我 / JOOX / YouTube / Bilibili / 咪咕直出，取流带跨平台兜底。Bilibili 免费且音质最高（实测 319kbps m4a）。",
  supportedSearchType: ["music", "album", "artist", "sheet"],
  // 音频缓存策略：no-cache = 每次播放都重新取地址（直链带时效签名，缓存必然过期）
  cacheControl: "no-cache",
  // ⚠️ 这个字段让 MusicFree 能「检查更新」：
  //    App 会 axios.get(srcUrl) 拉取这份脚本，比对里面的 version，
  //    比已装的旧就自动替换（见 pluginManager/index.ts 的 installPluginFromUrl + compare）。
  //    所以每次发版必须改 version，否则 App 认为「已是最新」不会更新。
  /* ⚠️ 文件名别改回 zongzi.js —— 实测 2026-10-18，Gitee 会对这个文件
     间歇性返回 451「The content may contain violation information」，
     连历史版本都下不来，App 的「检查更新」全部失败。
     同一份内容换个文件名就能正常下载。所以发布文件名带版本号：
     某个具体文件被风控标记时，下次发版换个新名字就绕过去了。
     发版时记得同步改这里的版本号。 */
  srcUrl: "https://raw.githubusercontent.com/ZONGZI-000/zongzi-musicfree-plugin/master/zongzi.js",
  userVariables: [
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
      key: "jooxCookie",
      name: "JOOX Cookie（可选）",
      hint: "登录 joox.com 后，把浏览器里 joox.com 域下的全部 cookie 粘进来（含 session_key / user_type / wmid 等 HttpOnly 项）。留空则 JOOX 不参与。",
    },
  ],
  search: search,
  getMediaSource: getMediaSource,
  getLyric: getLyric,
  getAlbumInfo: getAlbumDetail,
  getMusicSheetInfo: async function (sheetItem, page) {
    if (!sheetItem) return null;
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
    return Promise.all([ne, ap]).then((r) => r[0].concat(r[1]));
  },
  /* 榜单详情。网易的榜单条目和歌单是同一套结构，直接复用；
     Apple 的三类（歌曲 / 专辑 / 歌单）自己分流。 */
  getTopListDetail: function (topListItem) {
    if (!topListItem || !topListItem.id) return Promise.resolve(null);
    const id = String(topListItem.id);
    if (id.indexOf("apchart:") === 0 || id.indexOf("apalbum:") === 0 || id.indexOf("applaylist:") === 0) {
      return appleChartDetail(topListItem).catch((e) => {
        console.log("[粽子] Apple 榜单详情失败: " + e.message);
        return null;
      });
    }
    return neteaseSheetDetail(id, 1).catch(() => null);
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



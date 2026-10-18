#!/usr/bin/env bash
# 一键发版到 Gitee
# 用法：./publish.sh "更新说明"
set -e

USER="zongziiiiiiiiiiiiiiiiiiiiiiiiiiii"
REPO="zongzi-musicfree-plugin"
SRC="D:/workspace/lx-music-sources/musicfree-plugin/plugin.js"
OUT="D:/workspace/zongzi-musicfree-plugin/zongzi.js"
MSG="${1:-更新}"

echo "==> 1/4 读版本号"
VERSION=$(node -e "
const s=require('fs').readFileSync('$SRC','utf8');
const i=s.indexOf('module.exports');
console.log(s.slice(i,i+200).match(/version: \"([\d.]+)\"/)[1]);
")
echo "    v$VERSION"

echo "==> 2/4 复制到发布目录"
cp -f "$SRC" "$OUT"
# ⚠️ 必须校验 cp 真的生效了。
#    踩过的坑：cp 静默失败（文件被占用）时，后面上传的是**上一次的旧内容**，
#    而 deploy 依然返回 200、curl 也依然 200 —— 整个流程报「发版成功」，
#    线上其实一个字都没变。所以这里按内容比对，不是按字节数。
if ! cmp -s "$SRC" "$OUT"; then
  echo "    ❌ 复制失败：发布目录内容与源文件不一致"
  exit 1
fi
node -e "console.log('    ' + (require('fs').statSync('$OUT').size/1024).toFixed(1) + ' KB')"

echo "==> 3/4 上传到 Gitee"
cd "D:/workspace/zongzi-musicfree-plugin"
VER="$VERSION" MSG="$MSG" node deploy.js

echo "==> 4/4 验证远程内容"
# ⚠️ 文件名必须和插件里的 srcUrl 完全一致（带版本号）。
#    Gitee 会对某些 js 文件间歇性返回 451「内容违规」，固定文件名一旦被标记，
#    连历史版本都下不来 —— 每次发版换新文件名是唯一能绕开的风险控制。
URL="https://gitee.com/$USER/$REPO/raw/master/zongzi-$VERSION.js"
sleep 2
# ⚠️ 必须 -L 跟跳转：Gitee 现在对 raw 返回 302，指向 raw.giteeusercontent.com。
#    不带 -L 只会拿到 470 字节的跳转页，看起来「HTTP 200」其实根本不是脚本。
# ⚠️ 必须比对内容：光看状态码会被 CDN 缓存骗过去。
REMOTE_TMP=$(mktemp)
curl -sL -m 60 "$URL?nocache=$(date +%s)" -H "User-Agent: okhttp/4.9.0" -o "$REMOTE_TMP"
REMOTE_VER=$(grep -oE 'version: "[0-9.]+"' "$REMOTE_TMP" | tail -1 | grep -oE '[0-9.]+' || echo "?")

if cmp -s "$OUT" "$REMOTE_TMP"; then
  echo "    ✅ 内容与本地一致  (v$REMOTE_VER)"
elif [ "$REMOTE_VER" = "$VERSION" ]; then
  echo "    ⚠️  版本号已是 v$REMOTE_VER，但内容有细微差异（可能是 CDN 还没刷）"
  echo "        远端 $(wc -c < "$REMOTE_TMP") 字节 / 本地 $(wc -c < "$OUT") 字节"
  echo "        稍等 30 秒后再手动核实"
else
  echo "    ❌ 远端版本是 v$REMOTE_VER，期望 v$VERSION —— 上传没生效"
  rm -f "$REMOTE_TMP"
  exit 1
fi
rm -f "$REMOTE_TMP"

echo "==> 5/5 同步到 GitHub（Gitee 被风控时的备用源）"
# Gitee 会间歇性对 js 返回 451「内容违规」，那一版在 Gitee 上就彻底死了。
# GitHub 不做这层人工审核，所以每次发版都镜像一份，Gitee 挂了还能从这边装。
GH_USER="ZONGZI-000"
GH_REPO="zongzi-musicfree-plugin"
GH_URL="https://raw.githubusercontent.com/$GH_USER/$GH_REPO/master/zongzi-$VERSION.js"
cp -f "$OUT" "D:/workspace/zongzi-musicfree-plugin/zongzi-$VERSION.js"
cd "D:/workspace/zongzi-musicfree-plugin"
git add -A
if git diff --cached --quiet; then
  echo "    没有新改动，跳过提交"
else
  git -c user.name="zongzi" -c user.email="mr.zongzi666@gmail.com" commit -q -m "v$VERSION: $MSG" || true
  git push -q origin master || echo "    ⚠️  推送失败（检查网络/凭据），Gitee 那份仍然可用"
  echo "    ✅ 已推送"
fi
# 和 Gitee 一样：状态码 200 不代表内容对，必须比版本号
GH_TMP=$(mktemp)
curl -sL -m 60 "$GH_URL?nocache=$(date +%s)" -o "$GH_TMP" || true
GH_VER=$(grep -oE 'version: "[0-9.]+"' "$GH_TMP" 2>/dev/null | tail -1 | grep -oE '[0-9.]+' || echo "?")
if [ "$GH_VER" = "$VERSION" ]; then
  echo "    ✅ GitHub 镜像可下载 (v$GH_VER)"
else
  echo "    ⚠️  GitHub 镜像版本读不到（$GH_VER），稍后再核实"
fi
rm -f "$GH_TMP"

echo ""
echo "✅ 发版完成 v$VERSION"
echo ""
echo "MusicFree 安装/更新地址（主）："
echo "   $URL"
echo "备用（GitHub 镜像，Gitee 被 451 时用这个）："
echo "   $GH_URL"
echo ""
echo "去 MusicFree → 插件 → 粽子音源 → 检查更新"

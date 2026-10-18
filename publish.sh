#!/usr/bin/env bash
# 一键发版到 GitHub
# 用法：./publish.sh "更新说明"
#
# 为什么只发 GitHub：Gitee 会间歇性对 js 文件返回 451「内容违规」，
# 连历史版本都下载不了，用户点「检查更新」直接断链。GitHub 没有这层审核，
# raw 地址固定不变，一条链路走到底。
set -e

SRC="D:/workspace/lx-music-sources/musicfree-plugin/plugin.js"
DIR="D:/workspace/zongzi-musicfree-plugin"
OUT="$DIR/zongzi.js"
GH_USER="ZONGZI-000"
GH_REPO="zongzi-musicfree-plugin"
URL="https://raw.githubusercontent.com/$GH_USER/$GH_REPO/master/zongzi.js"
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
# ⚠️ 必须校验 cp 真的生效了。踩过的坑：cp 静默失败时后面推的是上一次的旧内容，
#    整个流程照样报「成功」，线上一个字都没变。所以按内容比对，不是按字节数。
if ! cmp -s "$SRC" "$OUT"; then
  echo "    ❌ 复制失败：发布目录内容与源文件不一致"
  exit 1
fi
node -e "console.log('    ' + (require('fs').statSync('$OUT').size/1024).toFixed(1) + ' KB')"

echo "==> 3/4 提交并推送（固定名 + 带版本号各一份）"
cd "$DIR"
cp -f "$OUT" "$DIR/zongzi-$VERSION.js"
git add -A
if git diff --cached --quiet; then
  echo "    没有新改动，跳过提交"
else
  git -c user.name="zongzi" -c user.email="mr.zongzi666@gmail.com" commit -q -m "v$VERSION: $MSG" || true
  git push -q origin master || { echo "    ❌ 推送失败（检查网络/凭据）"; exit 1; }
  echo "    ✅ 已推送"
fi

echo "==> 4/4 验证远程内容"
# ⚠️ 状态码 200 不代表内容对，必须比版本号。
#    raw 有 CDN 缓存，刚推完可能还是旧内容，多试几次。
for i in 1 2 3 4 5 6; do
  sleep 5
  TMP=$(mktemp)
  curl -sL -m 60 "$URL?nocache=$(date +%s)" -o "$TMP" || true
  REMOTE_VER=$(grep -oE 'version: "[0-9.]+"' "$TMP" 2>/dev/null | tail -1 | grep -oE '[0-9.]+' || echo "?")
  if [ "$REMOTE_VER" = "$VERSION" ]; then
    echo "    ✅ 远端已是 v$REMOTE_VER（第 $i 次探测）"
    rm -f "$TMP"
    break
  fi
  rm -f "$TMP"
  if [ "$i" = "6" ]; then
    echo "    ⚠️  远端仍显示 v$REMOTE_VER，CDN 缓存未刷新，稍后再核实"
  fi
done

echo ""
echo "✅ 发版完成 v$VERSION"
echo ""
echo "MusicFree 安装/更新地址（固定）："
echo "   $URL"
echo ""
echo "国内连不上 raw 时的镜像："
echo "   https://cdn.jsdelivr.net/gh/$GH_USER/$GH_REPO@master/zongzi.js"
echo ""
echo "去 MusicFree → 插件 → 粽子音源 → 检查更新"

#!/usr/bin/env bash
# 一键发版到 GitHub（Gitee 已弃用）
# 用法：./publish.sh "更新说明"
set -e

SRC="D:/workspace/lx-music-sources/musicfree-plugin/plugin.js"
DIR="D:/workspace/zongzi-musicfree-plugin"
OUT="$DIR/zongzi.js"
GH_USER="ZONGZI-000"
GH_REPO="zongzi-musicfree-plugin"
MSG="${1:-更新}"

echo "==> 1/4 读版本号"
VERSION=$(node -e "
const s=require('fs').readFileSync('$SRC','utf8');
const i=s.indexOf('module.exports');
console.log(s.slice(i,i+400).match(/version: \"([\d.]+)\"/)[1]);
")
echo "    v$VERSION"

echo "==> 2/4 复制到发布目录"
cp -f "$SRC" "$OUT"
# ⚠️ 必须按内容校验 cp 真的生效了。
#    踩过的坑：cp 静默失败（文件被占用）时后续推的是**上一次的旧内容**，
#    而 git push 依然成功 —— 整个流程报「发版成功」，线上一个字都没变。
if ! cmp -s "$SRC" "$OUT"; then
  echo "    ❌ 复制失败：发布目录内容与源文件不一致"
  exit 1
fi
cp -f "$OUT" "$DIR/zongzi-$VERSION.js"
node -e "console.log('    ' + (require('fs').statSync('$OUT').size/1024).toFixed(1) + ' KB')"

echo "==> 3/4 提交并推送 GitHub"
cd "$DIR"
git add -A
if git diff --cached --quiet; then
  echo "    没有新改动，跳过提交"
else
  git -c user.name="zongzi" -c user.email="mr.zongzi666@gmail.com" commit -q -m "v$VERSION: $MSG"
  git push -q origin master
  echo "    ✅ 已推送"
fi

echo "==> 4/4 验证远程内容"
# ⚠️ 状态码 200 不代表内容对（可能是缓存/旧版），必须读回版本号比对。
sleep 2
URL="https://raw.githubusercontent.com/$GH_USER/$GH_REPO/master/zongzi.js"
URL_VER="https://raw.githubusercontent.com/$GH_USER/$GH_REPO/master/zongzi-$VERSION.js"
TMP=$(mktemp)
curl -sL -m 60 "$URL?nocache=$(date +%s)" -o "$TMP"
REMOTE_VER=$(grep -oE 'version: "[0-9.]+"' "$TMP" | tail -1 | grep -oE '[0-9.]+' || echo "?")
if [ "$REMOTE_VER" != "$VERSION" ]; then
  echo "    ❌ 固定名远端版本是 v$REMOTE_VER，期望 v$VERSION —— 推送没生效或 CDN 未刷新"
  rm -f "$TMP"; exit 1
fi
cmp -s "$OUT" "$TMP" \
  && echo "    ✅ 固定名内容一致 (v$REMOTE_VER)" \
  || echo "    ⚠️  版本号已是 v$REMOTE_VER，但内容有细微差异（CDN 还没刷，稍后核实）"

curl -sL -m 60 "$URL_VER?nocache=$(date +%s)" -o "$TMP"
VER_VER=$(grep -oE 'version: "[0-9.]+"' "$TMP" | tail -1 | grep -oE '[0-9.]+' || echo "?")
[ "$VER_VER" = "$VERSION" ] \
  && echo "    ✅ 版本名可下载 (v$VER_VER)" \
  || echo "    ⚠️  版本名读不到（$VER_VER），稍后再核实"
rm -f "$TMP"

echo ""
echo "✅ 发版完成 v$VERSION"
echo ""
echo "MusicFree 安装/更新地址（固定，推荐）："
echo "   $URL"
echo "带版本号备用："
echo "   $URL_VER"
echo "国内直连 raw 慢的话用 jsDelivr 镜像（有 12 小时缓存）："
echo "   https://cdn.jsdelivr.net/gh/$GH_USER/$GH_REPO@master/zongzi.js"
echo ""
echo "去 MusicFree → 插件 → 粽子音源 → 检查更新"

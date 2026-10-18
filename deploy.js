// 用 Gitee API 上传/更新插件文件
// ⚠️ Gitee 的 contents 接口：新建用 POST，更新必须用 PUT（带 sha）。
//    用 POST 更新会返回 400「文件名已存在」，这是踩过的坑。
const fs = require('fs')
const https = require('https')

const TOKEN = fs.readFileSync('D:/workspace/.secrets/gitee-token.txt', 'utf8').trim()
const USER = 'zongziiiiiiiiiiiiiiiiiiiiiiiiiiii'
const REPO = 'zongzi-musicfree-plugin'
/* ⚠️ 文件名带版本号，别改回固定的 zongzi.js。
   Gitee 会对某些 js 文件**间歇性**返回 451「内容违规」，
   一旦命中，raw 下载连历史版本都拿不到，App 的「检查更新」全失败。
   同一份内容换个名字就能下 —— 所以每次发版用新文件名，
   并且这个文件名必须和插件里 srcUrl 写的完全一致。
   由环境变量 VER 决定，未给就退回 zongzi.js。 */
const FILE = process.env.VER ? `zongzi-${process.env.VER}.js` : 'zongzi.js'
const BRANCH = 'master'

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const req = https.request({
      hostname: 'gitee.com',
      path: '/api/v5' + path,
      method,
      headers: Object.assign(
        { Authorization: 'token ' + TOKEN, 'Content-Type': 'application/json;charset=UTF-8' },
        data ? { 'Content-Length': Buffer.byteLength(data) } : {}
      ),
      timeout: 90000,
    }, (res) => {
      let buf = ''
      res.on('data', (d) => buf += d)
      res.on('end', () => {
        let j
        try { j = JSON.parse(buf) } catch (e) { j = { raw: buf.slice(0, 200) } }
        resolve({ status: res.statusCode, data: j })
      })
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    if (data) req.write(data)
    req.end()
  })
}

;(async () => {
  const content = fs.readFileSync('D:/workspace/zongzi-musicfree-plugin/zongzi.js')
  const b64 = content.toString('base64')
  const base = `/repos/${USER}/${REPO}/contents/${FILE}`
  const msg = process.env.VER ? `v${process.env.VER}: ${process.env.MSG || '更新'}` : '更新'

  console.log('    文件: ' + content.length + ' 字节')

  // 查现状
  const cur = await api('GET', base + '?ref=' + BRANCH)
  const exists = cur.status === 200 && cur.data.sha

  const body = { access_token: TOKEN, content: b64, message: msg, branch: BRANCH }
  if (exists) body.sha = cur.data.sha

  // 新建 POST / 更新 PUT
  const method = exists ? 'PUT' : 'POST'
  const up = await api(method, base, body)

  if (up.status === 200 || up.status === 201) {
    console.log('    ✅ ' + (exists ? '已更新' : '已创建') + ' (' + up.data.content.size + ' 字节)')
  } else {
    console.log('    ❌ HTTP ' + up.status + ' ' + JSON.stringify(up.data).slice(0, 300))
    process.exit(1)
  }
})()

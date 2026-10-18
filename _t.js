// 临时测试台：直接加载插件，跑指定类型搜索
process.env.TZ = "Asia/Shanghai";
const p = require("./zongzi.js");

const type = process.argv[2] || "music";
const q = process.argv[3] || "摇晃帝国";
const page = Number(process.argv[4] || 1);

(async () => {
  const t0 = Date.now();
  const r = await p.search(q, page, type);
  const dt = Date.now() - t0;
  const d = r.data || [];
  console.log(`== ${type} "${q}" page=${page} → ${d.length} 条, isEnd=${r.isEnd}, ${dt}ms`);
  d.slice(0, 30).forEach((x, i) => {
    const nm = x.title || x.name || "";
    const sub = x.artist || x.description || "";
    console.log(
      String(i + 1).padStart(2) + ". [" + (x.platform || "?") + "] " + nm +
      (sub ? "  —  " + String(sub).slice(0, 40) : "") +
      (x.date ? "  (" + x.date + ")" : "") +
      (x.worksNum ? "  " + x.worksNum + "首" : "")
    );
  });
})().catch((e) => { console.error("ERR", e); process.exit(1); });

// 版本读取模块：/version 指令的唯一数据源。
// 为什么读 CHANGELOG.md 顶部而不是 package.json：CHANGELOG 每次发版由收尾任务更新，
// 顶部第一条 [x.y.z] 即当前版本；发布时同步 package.json 与 package-lock.json。
// [Unreleased] 不参与版本解析。公开测试版标记由 GitHub Release 的 pre-release 属性表达。
import { readFile } from 'node:fs/promises';

// 安静兜底：文件缺失/读损坏/找不到版本标题一律返回 'unknown'，不抛异常也不打日志。
// 版本只是展示性信息，/version 是低频指令，不值得为它产生 ERROR 噪音；
// 调用方拿到 'unknown' 照常拼进回复展示即可（天然兜底，无需额外分支）。
export async function getVersion() {
  // 每次调用都现读现解析：CHANGELOG 只有几 KB、指令低频，缓存毫无收益，反而引入
  // 失效时机问题；现读还让测试用临时 CHANGELOG_PATH 即可隔离，零 mock 成本。
  const path = process.env.CHANGELOG_PATH ?? './CHANGELOG.md';
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return 'unknown';
  }
  // 取首个「## [x.y.z]」标题：CHANGELOG 自上而下由新到旧，第一条即当前版本；
  // m 标志锚定行首，避免误匹配正文里引用的版本号写法（如变更说明里提到的旧版本）
  const match = raw.match(/^## \[(\d+\.\d+\.\d+)\]/m);
  return match ? match[1] : 'unknown';
}

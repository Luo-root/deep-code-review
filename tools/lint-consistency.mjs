#!/usr/bin/env node
// lint-consistency.mjs — 跨文件一致性检查
//
// 为什么单独一个文件：lint-skill.mjs 管「单文件合不合法」，这里管「几个文件之间说得一不一致」。
// 背景不是假想——deep-code-review 自审的前两轮里，绝大多数真缺陷都是这一类：
//   - 同一个级别 / 维度 / 段落名在两个文件里写法不同
//   - 覆盖表结果格出现声明之外的值
//   - 结论计数格式在两处不一样
//   - 快模式与全量模式的 finding 标签形态不一样
// 人工守不住，因为每次改文案都要记得同步另一处。机器化之后它就退不回去了。
//
// 用法：node tools/lint-consistency.mjs [repo-root]     默认当前目录
// 退出码：0 = 通过，1 = 有错误

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? '.');
let errors = 0;

function fail(msg) {
  console.error(`[FAIL] ${msg}`);
  errors += 1;
}
function ok(msg) {
  console.log(`[OK]   ${msg}`);
}

function read(rel) {
  const p = join(dir, rel);
  if (!existsSync(p)) {
    fail(`缺少文件 ${rel}`);
    return [];
  }
  return readFileSync(p, 'utf8')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .split('\n');
}

/** 取某个标题之后、下一个同级标题之前的正文行 */
function section(lines, headingRe) {
  const start = lines.findIndex((l) => headingRe.test(l));
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{2,3}\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

/**
 * 取某个标题之后、下一个**二级**标题之前的正文行（**含三级小节**）。
 * section() 遇到三级标题就停——那一节里如果长出「### 全量轮」这类小节，
 * 判据就只剩小节前面的那几行，后面的门槛表全看不见了。
 */
function sectionDeep(lines, headingRe) {
  const start = lines.findIndex((l) => headingRe.test(l));
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

/** 切出所有围栏块（字符串数组），保持出现顺序 */
function fencedBlocks(lines) {
  const blocks = [];
  let cur = null;
  for (const l of lines) {
    if (/^\s*```/.test(l)) {
      if (cur === null) cur = [];
      else { blocks.push(cur.join('\n')); cur = null; }
      continue;
    }
    if (cur !== null) cur.push(l);
  }
  return blocks;
}

/** 取某个锚点行之后的第一个围栏块（找不到返回 null） */
function fencedBlockAfter(lines, anchorRe) {
  const idx = lines.findIndex((l) => anchorRe.test(l));
  if (idx === -1) return null;
  let cur = null;
  for (let i = idx + 1; i < lines.length; i += 1) {
    if (/^\s*```/.test(lines[i])) {
      if (cur === null) cur = [];
      else return cur.join('\n');
      continue;
    }
    if (cur !== null) cur.push(lines[i]);
  }
  return null;
}

/**
 * finding 的定义（**唯一真相源**）：第 23 / 24 / 25 项共用这一份解析器。
 *   - 全量示例的 finding 是 `### [级别][维度][引入方式] 标题`（三级标题）
 *   - 快模式示例的 finding 是 `- [级别][维度][引入方式] 标题`（列表项）
 * 三处各认各的，就会出现「一处改标题层级、另两处跟着失灵」——
 * 第 25 项的落点规则被绕过、第 24 项的双向对账整体失效，而报错还归错了因
 * （报「覆盖表声明 1 条、正文数出来 0 条」，真正的原因是标题层级变了）。
 * 所以：**形态只有这一种定义，三处共用**。
 * 四级标题（`####`）**不算合法 finding**——但它也不是「这条 finding 不存在」：
 * 下游按标题层级解析报告，写成 #### 的条目会从阅读里消失。
 * 所以见到就报红，并说清是层级问题（而不是让计数对账去报一个假原因）。
 */
const FINDING_LEVELS = ['P0', 'P1', 'P2', 'P3', '待拍板'];
// 合法的 finding 形态：三级标题，或列表项（快模式）
const FINDING_RE = /^(?:###\s+|[-*]\s+)\[(P0|P1|P2|P3|待拍板)\]\[([^\]]+)\](?:\[([^\]]+)\])?/;
// 「像 finding 但形态不对」的形态：标题层级不是 ###（## / #### / …）
const FINDING_BAD_HEAD_RE = /^(#{1,6}\s+)\[(P0|P1|P2|P3|待拍板)\](?:\[([^\]]+)\])?/;

/**
 * 解析一段正文里的 finding。
 * found = 形态合法的；rejected = 形态不合法但确实是 finding 的（层级写错）。
 * rejected 也要**计入条数**：条目存在，只是写法不对——报「层级错了」，
 * 而不是报「正文里数出来 0 条」（后者会把人引到错的地方去改）。
 */
function parseFindings(lines) {
  const found = [];
  const rejected = [];
  lines.forEach((l, i) => {
    const m = l.match(FINDING_RE);
    if (m) {
      found.push({ level: m[1], dim: m[2], origin: m[3], index: i, text: l });
      return;
    }
    const bm = l.match(FINDING_BAD_HEAD_RE);
    if (bm) {
      rejected.push({
        level: bm[2],
        dim: bm[3],
        index: i,
        text: l,
        reason: `标题层级「${bm[1].trim()}」不是合法的 finding 形态：finding 必须是 ### 标题（快模式用列表项）`,
      });
    }
  });
  return { found, rejected };
}

/**
 * 结论档的写法有三种形态，三种都要认：
 *   - 「结论：**方向先定** —— …」（全量 / 零发现示例）
 *   - 「**改完再合** —— …」（快模式示例）
 *   - 「**可以合**。没有发现本次改动引入的缺陷。」（快模式零发现示例）
 * 此前只认前两种，零发现示例那一行（句号形态）压根解析不出结论档——
 * 那一块示例于是**整块不被检查**：把「可以合」改成「改完再合」，lint 照样全绿。
 */
function verdictOf(text) {
  const m =
    text.match(/结论：\*{0,2}(可以合|改完再合|方向先定)/) ||
    text.match(/^\s*\**(可以合|改完再合|方向先定)\**\s*[—–。.]/m);
  return m ? m[1] : null;
}

/**
 * 契约文件里的示例块有四类，特征互斥——按特征定位，不要用「第一个匹配」。
 *   skeleton 骨架：有覆盖表 + 有「## 必须修」，结论行用 n 占位（没有真实计数）
 *   full     全量示例：有覆盖表 + 有「## 必须修」+ 有 5 项计数
 *   zero     零发现示例：有覆盖表 + 有 5 项计数，但没有「## 必须修」
 *   fast     快模式示例：没有覆盖表、没有「## 必须修」、有 5 项计数
 * 每一类在一个文件里应当恰好命中一块；命中 0 块或 >1 块都算漂移。
 * 定位不唯一就会出这种事：删掉骨架的「## 必须修」，示例那一处替它兜底，检查照样全绿。
 */
const COUNT5_RE = /P0 \d+、P1 \d+、P2 \d+、P3 \d+、待拍板 \d+/;
const COVERAGE_HEAD = '| 维度 | 结果 | 查了什么 |';
const BLOCK_KINDS = {
  skeleton: (b) => b.includes(COVERAGE_HEAD) && /##\s*必须修/.test(b) && !COUNT5_RE.test(b),
  full: (b) => b.includes(COVERAGE_HEAD) && /##\s*必须修/.test(b) && COUNT5_RE.test(b),
  zero: (b) => b.includes(COVERAGE_HEAD) && !/##\s*必须修/.test(b) && COUNT5_RE.test(b),
  fast: (b) => !b.includes(COVERAGE_HEAD) && !/##\s*必须修/.test(b) && COUNT5_RE.test(b),
  // 快模式示例的「像不像」判据：**不能依赖五项计数**——快模式零发现示例本来就不写计数，
  // 靠计数来识别，等于「缺计数的示例」整块隐形，而那正是要抓的情形。
  fastish: (b) => !b.includes(COVERAGE_HEAD) && !/##\s*必须修/.test(b),
};

/**
 * 契约里的示例块清单：**每个 (文件, 形态) 应当恰好命中一块**。
 * 示例是模型模仿的对象——少一块，模型就少一种形态可照抄，CI 却全绿。
 * kind 见 BLOCK_KINDS；fastishZero = 快模式但没有五项计数（零发现那一句）。
 * needClaim 标这一形态是否必须写「宣称：… ／ 实际：…」。
 * coverage 标这一形态的覆盖表该长什么样（**唯一真相源**，第 2/3 项与第 45 项都从这张表派生）：
 *   blank  —— 骨架模板：同样 15 行（行名与顺序逐字等于规范），但结果格整张留空
 *   abbrev —— 零发现示例：允许「省略行」，但省略行必须独立成行（行名含省略号、另外两格为空）
 *   exact  —— 全量示例：**恰好 15 行**，一行一个维度，不许用省略行
 *   excerpt—— README 的节选：允许省略行（独立成行），实行的行名必须是规范维度名
 *   none   —— 这一形态没有覆盖表（快模式）
 * **这里是唯一真相源**：第 36 项（宣称行）、第 44 项（块存在性）、第 2/3 项（覆盖表行数规则）
 * 都从这张表派生。抄两份就会漂——加一种形态只改一处，检查就漏了一半。
 */
const EXAMPLE_BLOCKS = [
  { rel: 'references/output-template.md', kind: 'skeleton', want: 1, needClaim: true, coverage: 'blank' },
  { rel: 'references/output-template.md', kind: 'zero', want: 1, needClaim: true, coverage: 'abbrev' },
  { rel: 'references/output-template.md', kind: 'fast', want: 1, needClaim: true, coverage: 'none' },
  { rel: 'references/output-template.md', kind: 'full', want: 1, needClaim: true, coverage: 'exact' },
  { rel: 'README.md', kind: 'full', want: 1, needClaim: true, coverage: 'excerpt' },
  { rel: 'references/regression-review.md', kind: 'fast', want: 1, needClaim: true, coverage: 'none' },
  { rel: 'references/regression-review.md', kind: 'fastishZero', want: 1, needClaim: true, coverage: 'none' },
];

/** 按 EXAMPLE_BLOCKS 的形态取示例块；命中数不等于 1 时返回 null（调用方必须报红） */
function exampleBlock(rel, kind) {
  const blocks = fencedBlocks(read(rel));
  const hits =
    kind === 'fastishZero'
      ? blocks.filter((b) => BLOCK_KINDS.fastish(b) && !BLOCK_KINDS.fast(b))
      : blocks.filter(BLOCK_KINDS[kind]);
  return hits.length === 1 ? hits[0] : null;
}

/** 按特征取块；命中数不等于 1 时返回 null（调用方必须报红，不能默认取第一个） */
function pickBlock(lines, kind) {
  const hits = fencedBlocks(lines).filter(BLOCK_KINDS[kind]);
  return hits.length === 1 ? hits[0] : null;
}

/** 按 markdown 标题把文件切成小节，返回每节的正文（不含标题行） */
function headingSections(lines) {
  const out = [];
  let cur = null;
  for (const l of lines) {
    if (/^#{1,6}\s/.test(l)) { cur = []; out.push(cur); continue; }
    if (cur !== null) cur.push(l);
  }
  return out.map((s) => s.join('\n'));
}

/**
 * 契约的七段小节名（**唯一真相源**）：第 4 项与第 29 项共用这一份。
 * 抄两份就会漂——第 4 项按一份核对「第 4 维/第 29 项」按另一份定位，
 * 改一处段名，另一处就静默失效（示例里把小节改了名，示例示范的内容就没人查了）。
 */
const SECTION_NAMES = ['结论', '维度覆盖', '必须修', '建议修', '需要你拍板', '已查过没问题', '本次没覆盖'];

/** 段名归一化：去掉括注（`（…）` / `(…)`）与首尾空白 */
function normSection(s) {
  return s.replace(/（.*?）/g, '').replace(/\(.*?\)/g, '').trim();
}

/**
 * 契约文件清单：**从磁盘推导**（references/ 下全部 .md + SKILL.md + README.md）。
 * 第 6 / 31 / 38 项共用这一份——此前三项各自手写一份名单：
 * 新增一个 references/*.md，它的全部内容就同时逃过「标签形态」与「维度指针」两项检查，
 * 而 lint-skill 的孤儿检查还要求它必须被登记——于是新文件「登记了，但没人查」。
 */
function referenceFiles() {
  const refDir = join(dir, 'references');
  if (!existsSync(refDir)) return [];
  return readdirSync(refDir).filter((f) => f.endsWith('.md')).sort().map((f) => `references/${f}`);
}

/** 要扫的契约文件（从磁盘推导，不手写名单） */
function contractFiles() {
  return ['SKILL.md', 'README.md', ...referenceFiles()];
}

/** 取 frontmatter 里某个键的值（支持 `|` 块标量） */
function frontmatterBlock(lines, key) {
  const start = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (start === -1) return '';
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (!/^\s+\S/.test(lines[i])) break;
    out.push(lines[i].trim());
  }
  return out.join(' ').trim();
}

// ---------- 1. 七维速查表：SKILL.md 与 README.md 必须逐行一致 ----------
{
  const pick = (lines) => lines.filter((l) => /^\|\s*[1-7]\s*\|/.test(l)).map((l) => l.trim());
  const a = pick(read('SKILL.md'));
  const b = pick(read('README.md'));
  if (a.length !== 7 || b.length !== 7) {
    fail(`七维速查表行数不对：SKILL.md ${a.length} 行，README.md ${b.length} 行（应各 7 行）`);
  } else {
    const diffs = [];
    for (let i = 0; i < 7; i += 1) if (a[i] !== b[i]) diffs.push(i);
    if (diffs.length) {
      fail('七维速查表在 SKILL.md 与 README.md 里不一致——两份副本必须逐行相同');
      for (const i of diffs) {
        fail(`  第 ${i + 1} 行不同：\n    SKILL.md: ${a[i]}\n    README.md: ${b[i]}`);
      }
    } else {
      ok('七维速查表在 SKILL.md 与 README.md 里逐行一致');
    }
  }
}

// ---------- 2/3. 覆盖表：行名是 15 行封闭集合，结果格取值也在封闭集合内 ----------
const CANONICAL_DIMENSIONS = [
  '设计', '方法契约', '实现', '文档', '硬编码', '重复', '过度设计',
  '错误路径与部分失败', '并发与生命周期', '安全', '兼容性', '可观测性', '性能', '规模与复杂度', '测试盲区',
];
// 结果格的合法取值集合：**唯一真相源**。正则、数量声明、错误消息都从这里派生——
// 手工维护三份副本时，加一种取值漏改一处，lint 就对不上它自己声称守住的东西。
// kind 用于语义分类：exact = 固定词；count = 条数（可带级别）；pointer = 指向别的维度。
// re 是该取值的正则源，同样只有这一份——「n 条」的 n 必须 ≥1（契约写死「n=0 写『无发现』」），
// 这个约束写进正则是唯一守得住它的地方：另写一份正则就等于多一个真相源，
// 于是「0 条（P1）」这种非法值能从两条真相源之间钻过去。
const RESULT_VALUES = [
  { kind: 'exact', text: '无发现', desc: '无发现', re: '无发现' },
  { kind: 'pointer', text: '已查（见 X）', desc: '已查（见 X）', re: '已查（见 .+）' },
  { kind: 'exact', text: '未扫（理由）', desc: '未扫（理由）', re: '未扫（.+）' },
  { kind: 'count', text: 'n 条（级别）', desc: 'n 条（级别）', re: '[1-9]\\d* 条（.+）' },
  { kind: 'count+pointer', text: 'n 条（级别），另见 X', desc: 'n 条（级别），另见 X', re: '[1-9]\\d* 条（.+），另见 .+' },
];
// 结果格的合法形态：从 RESULT_VALUES 派生，不另写一份
const resultRe = new RegExp(`^(?:${RESULT_VALUES.map((v) => v.re).join('|')})$`);
// 结果格数量 = RESULT_VALUES.length。第 22 项用它与各处「N 种取值」的声明比对。
const ACTUAL_RESULT_COUNT = RESULT_VALUES.length;
// 允许出现在结果格里的取值描述（供错误消息与文档使用）
const CANONICAL_RESULTS = RESULT_VALUES.map((v) => v.desc);
// 标签的第三段合法取值（引入方式）
const CANONICAL_ORIGINS = ['本次引入', '既有', '现状'];
// 「查了什么」列禁止的模板句——契约点名禁止「只写维度名」「已全面检查」「模板句」。
// 只写维度名由下面那条单独判（what === dim）。
const FORBIDDEN_WHAT = ['已全面检查', '已全部检查', '全面检查', '已检查', '已看', '已读'];

/** 从一组行里取出所有维度覆盖表（每张表 = 行数组）；表头之后、表格结束之前算表内 */
function coverageTables(lines) {
  const tables = [];
  let current = null;
  for (const l of lines) {
    if (/^\|\s*维度\s*\|\s*结果\s*\|\s*查了什么\s*\|/.test(l)) {
      current = [];
      tables.push(current);
      continue;
    }
    if (current) {
      if (/^\|\s*-{2,}/.test(l)) continue;
      if (!/^\|\s/.test(l)) { current = null; continue; }
      current.push(l);
    }
  }
  return tables;
}

/**
 * 省略标记行：行名格是「…」或「...」。
 * 两种写法都认——零发现示例用「…」，README 的示例用「...」，
 * 只认一种，另一处就会被当成真行名报红（而报错的人改不掉，因为契约就是这么写的）。
 */
function isOmissionRow(line) {
  const name = (line.split('|')[1] ?? '').trim();
  return name.includes('…') || name.includes('...');
}
/**
 * 像不像 finding 标签：级别开头，或维度段是规范维度名，或第三段是引入方式。
 * 否则就是 markdown 的引用式链接（[文字][fast-mode]）——那种不是标签，
 * 按标签去校验它，贡献者在契约文件里写一个正常链接就被 CI 说成「维度段不合法」。
 * 三个条件合起来，既放行正常链接，又不放过写错级别（[待定][实现][本次引入]）
 * 与漏了级别段（[实现][本次引入]）这两种真错。
 */
function looksLikeTag(level, dim, origin) {
  if (/^(P\d+|待拍板|级别)$/.test(level)) return true;
  if (CANONICAL_DIMENSIONS.includes(dim)) return true;
  if (origin && CANONICAL_ORIGINS.includes(origin)) return true;
  return false;
}
{
  const tpl = read('references/output-template.md');
  const tables = coverageTables(tpl);
  if (!tables.length) {
    fail('output-template.md 里找不到维度覆盖表');
  } else {
    let bad = 0;
    // 覆盖表的行名 / 行序 / 行数：**按示例形态**决定（规则来自 EXAMPLE_BLOCKS，唯一真相源）
    //   blank  骨架模板 —— 恰好 15 行，行名与顺序逐字等于规范（结果格整张留空）
    //   abbrev 零发现   —— 允许省略行，但省略行必须独立成行（行名含省略号、另外两格为空）
    //   exact  全量     —— 恰好 15 行，不许用省略行
    //   excerpt README  —— 允许省略行（独立成行），实行的行名必须是规范维度名
    // 此前是「该表任一行名含省略号就整表跳过」：把维度名改成「重复…」就能把整张表从
    // 检查里摘出去，而汇总那一句还在说「N 张覆盖表的行名、顺序与行数都符合规范」。
    const rowChecked = [];
    for (const entry of EXAMPLE_BLOCKS) {
      if (entry.coverage === 'none') continue;
      const blk = exampleBlock(entry.rel, entry.kind);
      if (!blk) continue; // 块不在 → 第 44 项报红
      const bt = coverageTables(blk.split('\n'));
      if (!bt.length) {
        fail(`${entry.rel} 的 ${entry.kind} 示例里找不到维度覆盖表`);
        bad += 1;
        continue;
      }
      const t = bt[0];
      const where = `${entry.rel} 的 ${entry.kind} 示例`;
      const omissions = t.filter((l) => isOmissionRow(l));
      const real = t.filter((l) => !isOmissionRow(l));
      const realNames = real.map((l) => l.split('|')[1].trim());
      // 省略标记必须**独立成行**：行名含省略号，另外两格都空。
      // 否则「| 重复… | 无发现 | 对比既有 ratelimit 包 |」这种把维度名改成省略号的写法，
      // 就能把整张表从检查里摘出去。
      for (const o of omissions) {
        const cells = o.split('|').map((c) => c.trim());
        if (cells[2] || cells[3]) {
          fail(`${where}：省略标记必须独立成行（行名含省略号、另外两格要空）——「${cells[1]}」这一行不是省略标记`);
          bad += 1;
        }
      }
      if (omissions.length > 1) {
        fail(`${where}：一张表里出现了 ${omissions.length} 个省略标记——省略版只能有一个省略行`);
        bad += 1;
      }
      if (entry.coverage === 'exact' || entry.coverage === 'blank') {
        if (omissions.length) {
          fail(
            `${where}：覆盖表必须恰好 ${CANONICAL_DIMENSIONS.length} 行，不许用省略标记行——` +
              '省略版只允许出现在明确声明可缩写的示例上（骨架 / 零发现）',
          );
          bad += 1;
        }
        const names = t.map((l) => l.split('|')[1].trim());
        const s = new Set(names);
        const missing = CANONICAL_DIMENSIONS.filter((d) => !s.has(d));
        const extra = [...s].filter((d) => !CANONICAL_DIMENSIONS.includes(d));
        if (missing.length || extra.length) {
          fail(`${where}：覆盖表行名与规范集合不一致：缺 [${missing.join(', ')}]，多 [${extra.join(', ')}]`);
          bad += 1;
        }
        // 行数与顺序也要对：只比集合的话，重复行、行序错乱、16 行都能通过
        if (names.length !== CANONICAL_DIMENSIONS.length) {
          fail(`${where}：覆盖表有 ${names.length} 行（应 ${CANONICAL_DIMENSIONS.length} 行）——重复行也算行数不对`);
          bad += 1;
        } else if (names.join('|') !== CANONICAL_DIMENSIONS.join('|')) {
          fail(
            `${where}：覆盖表的行序与规范顺序不一致：\n    实际：${names.join(' | ')}\n    规范：${CANONICAL_DIMENSIONS.join(' | ')}\n` +
              '覆盖表按固定顺序排列——顺序乱了，读者逐行对照会串。',
          );
          bad += 1;
        }
        rowChecked.push(`${entry.rel} ${entry.kind} ${names.length} 行`);
      } else {
        // 省略版（零发现 / README 节选）：实行的行名必须是规范维度名，且不重复
        const s = new Set(realNames);
        const extra = [...s].filter((d) => !CANONICAL_DIMENSIONS.includes(d));
        if (extra.length) {
          fail(`${where}：覆盖表行名与规范集合不一致：多 [${extra.join(', ')}]`);
          bad += 1;
        }
        if (s.size !== realNames.length) {
          fail(`${where}：覆盖表有重复行（${realNames.length} 行里只有 ${s.size} 个不同的维度名）`);
          bad += 1;
        }
        if (entry.coverage === 'abbrev') {
          if (omissions.length !== 1) {
            fail(`${where}：省略版必须恰好一个省略行，实际 ${omissions.length} 个`);
            bad += 1;
          }
        }
        rowChecked.push(
          `${entry.rel} ${entry.kind} 省略版（${realNames.length} 实行 + ${omissions.length} 省略行）`,
        );
      }
    }
    if (!bad) {
      ok(`覆盖表按各自形态检查通过（共 ${rowChecked.length} 张：${rowChecked.join('；')}）`);
    }

    // 结果格取值：逐条匹配 RESULT_VALUES 派生的正则（resultRe 由唯一真相源生成）。
    // 「n 条（级别），另见 X」是第 5 种取值：本维既有自己的条目、又有结论归到别的维度时用。
    // 裸「n 条」（不带级别）不是合法取值——级别是与结论行对账的唯一钥匙。
    // n 必须是正整数：契约写死「n=0 写『无发现』」，「0 条（P1）」不在取值集合内。
    const offenders = [];
    for (const t of tables) {
      for (const l of t) {
        const cell = l.split('|')[2].trim();
        if (!cell) continue;
        if (!resultRe.test(cell)) offenders.push(cell);
      }
    }
    if (offenders.length) {
      fail(`覆盖表结果格出现声明之外的取值：${[...new Set(offenders)].join(' / ')}（允许：${CANONICAL_RESULTS.join(' / ')}）`);
    } else {
      ok(`覆盖表结果格取值都在声明的取值集合内（${CANONICAL_RESULTS.join(' / ')}）`);
    }

    // 结果格必须每行都有结论——覆盖表的全部意义就是「我扫过了」的凭证。
    // 例外是骨架模板：它整张都空（模型照着填）。所以规则是**要么整张都空、要么整张都不空**：
    // 此前空格子被直接跳过，示例里空一行照样全绿，而模型会照抄那个空格。
    const blankBad = [];
    for (const [ti, t] of tables.entries()) {
      // 省略行用**同一个判定**（isOmissionRow）：此前只滤掉含「…」的行，
      // 而 README 的示例用的是「...」——那一张表会被误报成「覆盖表有行没有结论」。
      const rows = t.filter((l) => !isOmissionRow(l));
      const cells = rows.map((l) => l.split('|')[2].trim());
      const nonEmpty = cells.filter((c) => c).length;
      if (!nonEmpty) continue; // 整张空 = 骨架模板
      const blanks = cells.filter((c) => !c).length;
      if (blanks) blankBad.push(`第 ${ti + 1} 张覆盖表有 ${blanks} 行没有结论`);
    }
    if (blankBad.length) {
      fail(
        `覆盖表有行没有结论：\n    ${blankBad.join('\n    ')}\n` +
          '契约写「每个维度都要留下结论，包括『无发现』」——空格子既不是「扫过没问题」，也不是「没扫」，读者无法区分。',
      );
      bad += 1;
    } else {
      ok('覆盖表每行都有结论（骨架模板整张留空是允许的）');
    }

    // 「查了什么」列不能是模板句——契约点名禁止「只写维度名」「已全面检查」「模板句」，
    // 此前只查非空，模板句照样过。模型照抄模板句，覆盖表看着齐全，读者无法复核。
    const whatBad = [];
    for (const [ti, t] of tables.entries()) {
      for (const l of t) {
        const cells = l.split('|');
        const dim = (cells[1] || '').trim();
        if (isOmissionRow(l)) continue;
        const what = (cells[3] || '').trim();
        if (!what) continue; // 非空由「查了什么」列非空那项管
        if (FORBIDDEN_WHAT.includes(what)) {
          whatBad.push(`第 ${ti + 1} 张「${dim}」行的「查了什么」写的是模板句「${what}」`);
          continue;
        }
        if (what === dim) whatBad.push(`第 ${ti + 1} 张「${dim}」行的「查了什么」只写了维度名`);
      }
    }
    if (whatBad.length) {
      fail(
        `「查了什么」列出现模板句：\n    ${whatBad.join('\n    ')}\n` +
          '契约要求「每行至少给一个可核对的事实」——模板句与「我真扫了」逐字不可区分，读者无法复核。',
      );
      bad += 1;
    } else {
      ok('「查了什么」列没有模板句，也不是只写维度名');
    }

    // 「已查（见 X）」与「另见 X」的 X 必须是一个规范维度名——
    // 指向不存在的维度，那一行的语义（结论归到了别处）就落空了。
    const pointerBad = [];
    for (const t of tables) {
      for (const l of t) {
        const cell = l.split('|')[2].trim();
        const m = cell.match(/^(?:已查（见 (.+)）|\d+ 条（(.+)），另见 (.+))$/);
        if (!m) continue;
        const target = m[1] ?? m[3];
        if (!CANONICAL_DIMENSIONS.includes(target)) {
          pointerBad.push(`${cell} → 指向的「${target}」不是规范维度名`);
        }
      }
    }
    if (pointerBad.length) {
      fail(
        `覆盖表结果格里的跨维指针指向了非规范维度名：\n    ${pointerBad.join('\n    ')}\n` +
          `「已查（见 X）」与「另见 X」的 X 必须是这 ${CANONICAL_DIMENSIONS.length} 个维度名之一` +
          '（含扩展维度）——指不到任何一行，那一行的结论在报告里就失踪了。',
      );
    } else {
      ok('覆盖表结果格里的跨维指针都指向规范维度名');
    }

    // 「查了什么」列：不能空，也不能误用结果格专用的 token。
    // 例外：**骨架表**（第 1 张）是空模板，格位本来就空着——它要的就是模型自己填。
    // 只有填了内容的表（结果格非空）才要求「查了什么」列也填上。
    const emptyWhat = [];
    const tokenMisuse = [];
    for (const [ti, t] of tables.entries()) {
      // 判断这是不是骨架空模板：结果格全空
      const resultCells = t.map((l) => l.split('|')[2].trim());
      const isBlankTemplate = resultCells.every((c) => !c);
      if (isBlankTemplate) {
        ok(`第 ${ti + 1} 张覆盖表是空模板（骨架），跳过「查了什么」列非空检查`);
        continue;
      }
      for (const l of t) {
        const cells = l.split('|').map((c) => c.trim());
        const what = cells[3];
        if (what === undefined) continue;
        // 省略行（标了「…」，表示"其余 15 行同理"）不是真行，跳过
        if (isOmissionRow(l)) continue;
        if (!what) { emptyWhat.push(cells[1]); continue; }
        if (what.includes('已查（见')) tokenMisuse.push(`${cells[1]} 行：${what}`);
      }
    }
    if (emptyWhat.length) {
      fail(
        `覆盖表的「查了什么」列有空格：${emptyWhat.join('、')}\n` +
          '这一列是覆盖表里唯一能让人复核「我扫过了」的地方——空着的话，它和「压根没扫」没区别。',
      );
    } else if (tokenMisuse.length) {
      fail(
        `覆盖表的「查了什么」列误用了结果格专用的 token：\n    ${tokenMisuse.join('\n    ')}\n` +
          '「已查（见 X）」只出现在结果格；「查了什么」列写「由 XX playbook 覆盖」这类措辞。',
      );
    } else {
      ok('覆盖表每行的「查了什么」列都非空，且没有误用结果格 token');
    }
  }
}

// ---------- 4. 七段结构：三个文件里的段名与顺序必须一致 ----------
{
  const EXPECTED = SECTION_NAMES;
  const norm = (a) => a.map(normSection);

  const skill = read('SKILL.md');
  const tpl = read('references/output-template.md');
  const readme = read('README.md');

  const skillList = norm(
    section(skill, /^###\s*完整结构/)
      .filter((l) => /^\d+\.\s+\*\*/.test(l))
      .map((l) => l.match(/^\d+\.\s+\*\*(.+?)\*\*/)[1]),
  );
  // README 的七段清单：锚点用契约里的实际措辞（「七段骨架：」）。
  // 此前锚点写的是「固定七段」——README 里根本没这四个字，于是这一分支**一次都没跑过**，
  // 却照样打印「在 README 里一致」。现在找不到锚点就报红，不许静默跳过。
  const readmeLine = readme.find((l) => l.startsWith('七段骨架：'));
  const readmeList = norm(
    readmeLine
      ? readmeLine.replace('七段骨架：', '').replace(/。$/, '').split('、').map((s) => s.trim())
      : [],
  );
  const expect = norm(EXPECTED);

  let bad = 0;
  if (!skillList.length) { fail('SKILL.md 里找不到「完整结构」小节的段名列表'); bad += 1; }
  else if (skillList.join('|') !== expect.join('|')) {
    fail(`SKILL.md 的完整结构段名与顺序不符：${skillList.join(' | ')}（应为 ${expect.join(' | ')}）`);
    bad += 1;
  }
  if (!readmeLine) {
    fail(
      'README.md 里找不到「七段骨架：结论、…」那一行——README 的七段清单无从校验。' +
        '锚点必须跟着契约的实际措辞走，措辞一改就要同步这里（否则这一项会静默失效）。',
    );
    bad += 1;
  } else if (readmeList.join('|') !== expect.join('|')) {
    fail(`README 的段名与顺序不符：${readmeList.join(' | ')}（应为 ${expect.join(' | ')}）`);
    bad += 1;
  }
  // output-template 的骨架里应按顺序出现这七个小节
  let idx = -1;
  for (const sec of expect) {
    const i = tpl.findIndex((l, li) => li > idx && l.trim() === `## ${sec}`);
    if (i === -1) { fail(`output-template.md 的骨架里找不到或顺序不对：小节「## ${sec}」`); bad += 1; break; }
    idx = i;
  }
  // ---- 升级（第 24A-03）：七段结构必须**逐块**成立，不许靠别的块兜底 ----
  // 此前这里是「整个 output-template.md 里有没有出现过这七个小节名」：
  // 把示例块里的「## 已查过没问题」改成「## 已查过没问题的维度」，
  // 骨架里那一份还在 → 这一项照样绿，而第 29 项（示例条目要有验证方式）已经失效。
  // 现在改成：
  //   ① **完整块**（骨架块 + 全量示例块）各自都要含这七段；
  //   ② 任何示例块里的 `##` 小节名都必须是规范段名（改名 → 报红）。
  // README 的示例是**节选**（「已查过没问题」是条件段），允许少段，但不许改段名。
  const COMPLETE_BLOCKS = [
    ['references/output-template.md', 'skeleton', '骨架块'],
    ['references/output-template.md', 'full', '全量示例块'],
  ];
  for (const [rel, kind, label] of COMPLETE_BLOCKS) {
    const block = exampleBlock(rel, kind);
    if (!block) {
      fail(`${rel} 的${label}定位失败——七段结构无从校验`);
      bad += 1;
      continue;
    }
    const heads = block.split('\n')
      .filter((l) => /^##\s/.test(l))
      .map((l) => normSection(l.replace(/^##\s+/, '')));
    const missing = expect.filter((s) => !heads.includes(s));
    if (missing.length) {
      fail(`${rel} 的${label}里缺少小节：${missing.join('、')}——模型照抄这一块就会少段`);
      bad += 1;
    }
  }
  // 任何示例块里的 `##` 小节名都必须是规范段名
  for (const rel of ['references/output-template.md', 'README.md', 'references/regression-review.md']) {
    fencedBlocks(read(rel)).forEach((b, bi) => {
      b.split('\n')
        .filter((l) => /^##\s/.test(l))
        .forEach((l) => {
          const name = normSection(l.replace(/^##\s+/, ''));
          if (!expect.includes(name)) {
            fail(
              `${rel} 第 ${bi + 1} 个代码块里的小节「## ${l.replace(/^##\s+/, '').trim()}」` +
                `不是规范段名（应为 ${expect.join(' / ')}）——小节被改名，模型照抄就产出了另一套结构`,
            );
            bad += 1;
          }
        });
    });
  }
  if (!bad) ok('七段结构在 SKILL.md / output-template.md / README.md 里段名与顺序一致（骨架块与示例块逐块核对）');
}

// ---------- 5. 结论计数格式：多处必须逐字相同 ----------
// 三处都要写明格式：SKILL.md（权威出处）、output-template.md（骨架）、regression-review.md（快模式形态）。
// 此前只比前两处，而且每处只取**第一个**匹配——同一文件里出现第二种写法也看不见。
{
  const re = /P0 n、P1 n、P2 n、P3 n、待拍板 n/;
  const FILES = ['SKILL.md', 'references/output-template.md', 'references/regression-review.md'];
  const byFile = new Map();
  for (const rel of FILES) {
    const spellings = new Set();
    for (const l of read(rel)) {
      const m = l.match(re);
      if (m) spellings.add(m[0]);
    }
    byFile.set(rel, spellings);
  }
  const missing = FILES.filter((f) => !byFile.get(f).size);
  const all = [...new Set([...byFile.values()].flatMap((s) => [...s]))];
  if (missing.length) {
    fail(`结论计数格式在这些文件里没找到声明：${missing.join('、')}——三处副本都必须写明格式`);
  } else if (all.length > 1) {
    fail(
      '结论计数格式在文件之间不一致：\n' +
        FILES.map((f) => `    ${f}: ${[...byFile.get(f)].join(' / ')}`).join('\n'),
    );
  } else {
    ok(`结论计数格式在 ${FILES.join(' / ')} 里一致：${all[0]}`);
  }
}

// ---------- 6. finding 标签形态：三段齐全，级别段与维度段都是规范值 ----------
// 扫描清单**从磁盘推导**（第 24A-04）：此前手写 4 个文件，
// 新增一个 references/*.md，它的全部内容就逃过这一项——
// 而 lint-skill 的孤儿检查还要求它必须被登记，于是新文件「登记了，但没人查」。
{
  const files = contractFiles();
  const ORIGIN = ['本次引入', '既有', '现状'];
  const LEVELS = ['P0', 'P1', 'P2', 'P3', '待拍板'];
  const offenders = [];
  let count = 0;
  for (const f of files) {
    for (const l of read(f)) {
      // 先匹配任何「[X][Y]」形态，再判合法——否则非法级别（写错成「待定」之类）
      // 根本不在匹配范围内，检查就成了摆设
      const re = /\[([^\]\[]{1,12})\]\[([^\]]+)\](?:\[([^\]]+)\])?/g;
      let m;
      while ((m = re.exec(l)) !== null) {
        const [, level, dim, origin] = m;
        if (level === '级别' && dim === '维度') continue; // 占位符模板，不是真标签
        if (!looksLikeTag(level, dim, origin)) continue; // markdown 引用式链接，不是标签
        count += 1;
        if (!CANONICAL_DIMENSIONS.includes(dim)) {
          offenders.push(`${f}: 维度段「${dim}」不在规范维度名里（${level}[${dim}]）`);
        }
        if (!LEVELS.includes(level)) {
          offenders.push(`${f}: 级别段「${level}」不合法（应为 ${LEVELS.join(' / ')}）`);
        }
        if (origin === undefined) {
          offenders.push(`${f}: 标签「${level}[${dim}]」缺引入方式段（形态固定三段）`);
        } else if (!ORIGIN.includes(origin)) {
          offenders.push(`${f}: 第三段「${origin}」不是引入方式（应为 ${ORIGIN.join(' / ')}）`);
        }
      }
    }
  }
  if (offenders.length) {
    fail(`finding 标签形态不一致：\n    ${[...new Set(offenders)].join('\n    ')}`);
  } else {
    ok(`finding 标签形态一致（${count} 处标签：级别段合法、维度段都是规范维度名、第三段都是引入方式）`);
  }
}

// ---------- 7. SKILL.md 引用的输出小节，必须在 output-template.md 里真的存在 ----------
{
  const tpl = read('references/output-template.md');
  const wanted = ['必须修', '建议修', '需要你拍板', '已查过没问题', '本次没覆盖'];
  const missing = wanted.filter((s) => !tpl.some((l) => l.trim() === `## ${s}`));
  if (missing.length) {
    fail(`output-template.md 里缺少被 SKILL.md 引用的小节：${missing.map((s) => `## ${s}`).join('、')}`);
  } else {
    ok('SKILL.md 引用的输出小节在 output-template.md 里都存在');
  }
}

// ---------- 8. 闸门表必须覆盖覆盖表的每一个维度 ----------
{
  // 每个覆盖表维度对应闸门表里哪一类结论
  const GATE_OF = {
    设计: '设计不合理',
    方法契约: '缺参数',
    实现: '实现 bug',
    文档: '文档不清',
    硬编码: '硬编码',
    重复: '重复',
    过度设计: '过度设计',
    错误路径与部分失败: '错误路径与部分失败',
    并发与生命周期: '并发',
    安全: '安全',
    兼容性: '兼容',
    可观测性: '可观测性',
    性能: '性能',
    规模与复杂度: '规模与复杂度',
    测试盲区: '测试盲区',
  };
  const verif = read('references/verification.md');
  const gateTypes = verif
    .filter((l) => /^\|\s*[^-|].*\|.*\|.*\|$/.test(l) && !/^\|\s*结论类型/.test(l))
    .map((l) => l.split('|')[1].trim())
    .filter(Boolean);
  const uncovered = CANONICAL_DIMENSIONS.filter((d) => {
    const kw = GATE_OF[d];
    return !kw || !gateTypes.some((t) => t.includes(kw));
  });
  if (uncovered.length) {
    fail(
      `覆盖表要求出结论的维度在闸门表里没有对应的问题：${uncovered.join('、')}。` +
        '「对每条候选结论回答闸门问题」——没有闸门的维度，模型只能自己发挥强度。',
    );
  } else {
    ok(`闸门表覆盖了覆盖表的全部 ${CANONICAL_DIMENSIONS.length} 个维度（闸门表共 ${gateTypes.length} 类结论）`);
  }
}

// ---------- 9. 必答句清单必须覆盖覆盖表的每一个维度 ----------
{
  // 每个覆盖表维度在「每个维度的必答句」里对应哪几句
  const MUST_ANSWER_OF = {
    设计: ['设计'],
    方法契约: ['缺参数', '跨层形状'],
    实现: ['实现'],
    文档: ['文档'],
    硬编码: ['硬编码'],
    重复: ['重复', '语义分裂', '职责重叠'],
    过度设计: ['过度设计'],
    错误路径与部分失败: ['错误路径与部分失败'],
    并发与生命周期: ['并发'],
    安全: ['安全'],
    兼容性: ['兼容性'],
    可观测性: ['可观测性'],
    性能: ['性能'],
    规模与复杂度: ['规模'],
    测试盲区: ['测试盲区'],
  };
  const verif = read('references/verification.md');
  const bullets = section(verif, /^##\s*每个维度的必答句/)
    .filter((l) => /^\s*-\s/.test(l))
    .map((l) => l.replace(/^\s*-\s*/, '').split('：')[0].trim());
  const missing = [];
  for (const [dim, keys] of Object.entries(MUST_ANSWER_OF)) {
    for (const k of keys) {
      if (!bullets.includes(k)) missing.push(`${dim}（缺「${k}」）`);
    }
  }
  if (missing.length) {
    fail(
      `「每个维度的必答句」没覆盖这些维度：${missing.join('、')}。` +
        '必答句是每条结论定级前的检查清单——缺一维，这一维的结论就没有证据模板，强度只能临场发挥。',
    );
  } else {
    ok(`必答句清单覆盖了覆盖表的全部 ${CANONICAL_DIMENSIONS.length} 个维度（共 ${bullets.length} 句）`);
  }
}

// ---------- 10. 七维速查表不得复述维度细则里的分类措辞 ----------
{
  // 这些词是 dimensions.md 的判断分档。速查表只留「要回答的问题」。
  //
  // 词表**从 dimensions.md 第 5 维的「先分清是哪一类」表头派生**，不抄一份：
  // 抄本会漂——dimensions.md 将来加第三类分档，抄本不会跟着长，
  // 速查表就可以开始复述它而 lint 不认。派生之后，加一档就自动生效。
  const dimSec5 = section(read('references/dimensions.md'), /^##\s*5\./);
  const classifyHeader = dimSec5.find((l) => /^\|\s*\|\s*[^|]+\s*\|/.test(l));
  const CLASSIFY_TERMS = classifyHeader
    ? classifyHeader.split('|').slice(2, -1).map((c) => c.trim()).filter(Boolean)
    : [];
  if (!CLASSIFY_TERMS.length) {
    fail(
      'dimensions.md 第 5 维里找不到「先分清是哪一类」的分档表头——' +
        '分类词表无从派生，速查表复述分类措辞就拦不住了',
    );
  }
  const pick = (lines) => lines.filter((l) => /^\|\s*[1-7]\s*\|/.test(l));
  const offenders = [];
  for (const [f, lines] of [['SKILL.md', read('SKILL.md')], ['README.md', read('README.md')]]) {
    for (const l of pick(lines)) {
      for (const t of CLASSIFY_TERMS) {
        if (l.includes(t)) offenders.push(`${f}: 速查表行里出现「${t}」`);
      }
    }
  }
  if (offenders.length) {
    fail(
      `七维速查表复述了维度细则的分类措辞：\n    ${[...new Set(offenders)].join('\n    ')}\n` +
        '速查表只留「要回答的问题」，分类与「不算」边界只在 references/dimensions.md 里定——' +
        '写两份必然漂移，漂移的那份会让这一维被系统性漏报。',
    );
  } else {
    ok(`七维速查表没有复述维度细则的分类措辞（判据单一真相源在 dimensions.md，本轮词表：${CLASSIFY_TERMS.join(' / ')}）`);
  }
}

// ---------- 11. playbooks.md 不得复用「已查（见 X）」这个 token ----------
{
  const pb = read('references/playbooks.md');
  const bad = pb.filter((l) => l.includes('已查（见'));
  if (bad.length) {
    fail(
      'references/playbooks.md 里出现了「已查（见 X）」：\n    ' + bad.join('\n    ') +
        '\n这个 token 的含义是「本维的结论被归到了别的维度」，且只出现在结果格。' +
        'playbook 覆盖的条目，结果格写「无发现」，覆盖说明写在「查了什么」列。',
    );
  } else {
    ok('playbooks.md 没有复用「已查（见 X）」token');
  }
}

// ---------- 12/13. 示例自身自洽：结论计数、覆盖表声明、正文条目要对得上 ----------
{
  const fencedBlocks = (lines) => {
    const blocks = [];
    let cur = null;
    for (const l of lines) {
      if (/^\s*```/.test(l)) {
        if (cur === null) cur = [];
        else {
          blocks.push(cur.join('\n'));
          cur = null;
        }
        continue;
      }
      if (cur !== null) cur.push(l);
    }
    return blocks;
  };
  const COUNT_RE = /P0 (\d+)、P1 (\d+)、P2 (\d+)、P3 (\d+)、待拍板 (\d+)/;
  // 完整示例 = 有覆盖表 + 有结论计数 + 有「必须修」段（骨架与零发现示例都不算）
  const isExample = (b) => BLOCK_KINDS.full(b);

  const readmeBlocks = fencedBlocks(read('README.md')).filter(isExample);
  const tplBlocks = fencedBlocks(read('references/output-template.md')).filter(isExample);
  let bad = 0;

  if (readmeBlocks.length !== 1) {
    fail(`README.md 里带维度覆盖表与结论计数的示例块应恰好 1 个，实际 ${readmeBlocks.length} 个`);
    bad += 1;
  }
  if (tplBlocks.length !== 1) {
    fail(`output-template.md 里带维度覆盖表与结论计数的示例块应恰好 1 个，实际 ${tplBlocks.length} 个`);
    bad += 1;
  }

  if (readmeBlocks.length === 1 && tplBlocks.length === 1) {
    const a = readmeBlocks[0].match(COUNT_RE);
    const b = tplBlocks[0].match(COUNT_RE);
    if (a[0] !== b[0]) {
      fail(
        'README 与 output-template 的示例是同一个场景，结论计数却不同：\n' +
          `    README:          ${a[0]}\n    output-template: ${b[0]}\n` +
          '两份拷贝会各漂各的——改一处不改另一处，示例自己就自相矛盾了。',
      );
      bad += 1;
    } else {
      ok(`README 与 output-template 的示例结论计数一致：${a[0]}`);
    }

    // 覆盖表声明的「n 条（级别）」必须在正文里数得出来。
    // 双向对账（正文多出的条目、写「无发现」却有该维度条目）由第 24 项负责，
    // 结论计数与正文的一致性由第 23 项负责——这里只保留本项独有的「按级别数」这一层。
    const block = tplBlocks[0];
    if (block.includes('...') || block.includes('…')) {
      ok('示例块里有省略号，跳过「覆盖表声明 ↔ 正文条目」逐行核对');
    } else {
      const rows = block.split('\n').filter((l) => /^\|\s*[^-|\s][^|]*\|/.test(l) && /\|\s*\d+ 条（.+）(，另见 .+)?\s*\|/.test(l));
      const missing = [];
      for (const r of rows) {
        const cells = r.split('|').map((c) => c.trim());
        const dim = cells[1];
        // 「N 条（级别）」与「N 条（级别），另见 X」都要能解析出条数与级别
        const m = cells[2].match(/^(\d+) 条（(.+)?）(，另见 .+)?$/);
        if (!m) continue;
        const [, n, level] = m;
        if (!level) continue;
        const tag = `[${level}][${dim}]`;
        const count = block.split(tag).length - 1;
        if (count < Number(n)) {
          missing.push(`${dim} 声明 ${n} 条（${level}），正文里只找到 ${count} 处 ${tag}`);
        }
      }
      if (missing.length) {
        fail(
          `示例的覆盖表与正文对不上：\n    ${missing.join('\n    ')}\n` +
            '「结论里写的每个数字都要在正文里数得出来」——示例自己得先做到。',
        );
        bad += 1;
      } else {
        ok(`示例的覆盖表声明与正文条目对得上（${rows.length} 行声明了条目数）`);
      }
    }
  }
  if (!bad) {
    ok('两个示例块的结论计数与覆盖表声明都自洽');
  }

  // ---- 快模式示例的两份副本也要对账 ----
  // output-template.md 与 regression-review.md 各有一份**逐字相同**的快模式示例。
  // 此前只有 README↔output-template 的全量示例有交叉校验，这一对没有：
  // 把 output-template 那份的计数改成「P1 2」并加一条 P1，lint 全绿——两份副本已漂移。
  // 现在对四项逐个比：计数、结论档、范围行、条目数。
  {
    const fastOf = (rel) => {
      const hits = fencedBlocks(read(rel)).filter(BLOCK_KINDS.fast);
      return hits.length === 1 ? hits[0] : null;
    };
    const a = fastOf('references/output-template.md');
    const b = fastOf('references/regression-review.md');
    if (!a || !b) {
      // 块不在 → 第 44 项报红
      fail('快模式示例的两份副本对不上：有一份定位失败（应当 output-template.md 与 regression-review.md 各恰好一块）');
      bad += 1;
    } else {
      const diffs = [];
      const countA = (a.match(COUNT_RE) ?? [])[0] ?? '(无计数)';
      const countB = (b.match(COUNT_RE) ?? [])[0] ?? '(无计数)';
      if (countA !== countB) diffs.push(`结论计数：output-template「${countA}」 vs regression-review「${countB}」`);
      const verdictA = verdictOf(a) ?? '(无结论档)';
      const verdictB = verdictOf(b) ?? '(无结论档)';
      if (verdictA !== verdictB) diffs.push(`结论档：output-template「${verdictA}」 vs regression-review「${verdictB}」`);
      const scopeA = a.split('\n').find((l) => l.trim().startsWith('范围：')) ?? '(无范围行)';
      const scopeB = b.split('\n').find((l) => l.trim().startsWith('范围：')) ?? '(无范围行)';
      if (scopeA !== scopeB) diffs.push(`范围行：output-template「${scopeA.trim()}」 vs regression-review「${scopeB.trim()}」`);
      const itemsA = (a.match(/^\s*[-*]\s+\[(P0|P1|P2|P3|待拍板)\]/gm) ?? []).length;
      const itemsB = (b.match(/^\s*[-*]\s+\[(P0|P1|P2|P3|待拍板)\]/gm) ?? []).length;
      if (itemsA !== itemsB) diffs.push(`条目数：output-template ${itemsA} 条 vs regression-review ${itemsB} 条`);
      if (diffs.length) {
        fail(
          `快模式示例的两份副本已经漂移：\n    ${diffs.join('\n    ')}\n` +
            'output-template.md 与 regression-review.md 的快模式示例是同一个场景的两份拷贝——' +
            '各漂各的，读者从哪个入口进来看到的就是哪一份。',
        );
        bad += 1;
      } else {
        ok(`快模式示例的两份副本一致（计数、结论档、范围行、条目数都相同：${countA}）`);
      }
    }
  }
}

// ---------- 14. 结论档（可以合 / 改完再合 / 方向先定）在三处必须一致 ----------
{
  const VERDICTS = ['可以合', '改完再合', '方向先定'];
  const skill = read('SKILL.md');
  const skillLine = skill.find((l) => l.includes('总体结论（'));
  const tplLine = read('references/output-template.md').find((l) => l.includes('结论：**可以合 / 改完再合'));
  const desc = frontmatterBlock(skill, 'description');
  const offenders = [];
  if (!skillLine) {
    offenders.push('SKILL.md 里找不到「总体结论（…）」那一行');
  } else {
    for (const v of VERDICTS) {
      if (!skillLine.includes(v)) continue;
      if (!tplLine || !tplLine.includes(v)) offenders.push(`output-template.md 的结论行没有「${v}」`);
      if (!desc.includes(v)) offenders.push(`frontmatter.description 没有「${v}」`);
    }
  }
  if (offenders.length) {
    fail(
      `结论档写法不一致：\n    ${offenders.join('\n    ')}\n` +
        '三档结论在 SKILL.md / references/output-template.md / frontmatter.description 里必须是同一组——' +
        '少一档，模型就得自己发明一档。',
    );
  } else {
    ok('结论档（可以合 / 改完再合 / 方向先定）在 SKILL.md / output-template.md / description 里一致');
  }
}

// playbook 段解析：抽出成函数，供第 15 / 18 / 21 项共用
function parsePlaybookSections(pb) {
  const sections = [];
  let cur = null;
  for (const l of pb) {
    if (/^##\s/.test(l)) {
      cur = { name: l.replace(/^##\s*/, '').trim(), declared: [], declaredItems: [], items: [], itemNames: [] };
      sections.push(cur);
      continue;
    }
    if (!cur) continue;
    if (/^覆盖扩展维度：/.test(l)) {
      const body = l.replace(/^覆盖扩展维度：/, '').replace(/。\s*$/, '');
      let depth = 0;
      let buf = '';
      const parts = [];
      for (const ch of body) {
        if (ch === '（') depth += 1;
        if (ch === '）') depth -= 1;
        if (ch === '、' && depth === 0) {
          parts.push(buf);
          buf = '';
          continue;
        }
        buf += ch;
      }
      parts.push(buf);
      for (const part of parts) {
        const narrowed = part.match(/^([^（]+)（(.+)）$/);
        if (narrowed) {
          const dim = narrowed[1].trim();
          const names = narrowed[2].split('、').map((s) => s.trim()).filter(Boolean);
          cur.declared.push(dim);
          cur.declaredItems.push({ dim, names });
        } else {
          const dim = part.trim();
          if (dim) {
            cur.declared.push(dim);
            cur.declaredItems.push({ dim, names: null });
          }
        }
      }
      continue;
    }
    const m = l.match(/^- \*\*([^*]+)\*\*（([^）]+)）/);
    if (m) {
      cur.items.push(m[2]);
      cur.itemNames.push(m[1].trim());
    }
  }
  return sections;
}

// ---------- 15. playbook 的覆盖声明必须与它的条目对得上 ----------
{
  const pb = read('references/playbooks.md');
  const sections = parsePlaybookSections(pb);
  const offenders = [];
  for (const s of sections) {
    for (const d of s.declared) {
      if (!s.items.some((it) => it.includes(d))) {
        offenders.push(`${s.name}：声明覆盖「${d}」，但正文里没有一条标注了该维度的条目`);
      }
    }
    for (const it of s.items) {
      for (const one of it.split('/').map((x) => x.trim())) {
        if (!CANONICAL_DIMENSIONS.includes(one)) {
          offenders.push(`${s.name}：条目标注的「${one}」不是规范维度名`);
        }
      }
    }
  }
  if (offenders.length) {
    fail(
      `playbook 的覆盖声明与条目对不上：\n    ${offenders.join('\n    ')}\n` +
        '声明覆盖了却没有对应条目 = 覆盖表会写「无发现」，等于替一个没查过的维度背书。',
    );
  } else {
    ok(`playbook 的覆盖声明与条目一致（${sections.length} 份 playbook，每条必查项都标了规范维度）`);
  }

  // ---------- 18. 覆盖声明必须逐维度写出条目名，且条目名真的存在 ----------
  {
    const bad = [];
    for (const s of sections) {
      for (const d of s.declaredItems) {
        if (!d.names || !d.names.length) {
          bad.push(`${s.name}：维度「${d.dim}」的覆盖声明没写条目名——只写维度名等于宣称整节覆盖`);
          continue;
        }
        for (const n of d.names) {
          if (!s.itemNames.includes(n)) {
            bad.push(`${s.name}：覆盖声明说覆盖「${d.dim}」的「${n}」，但正文里没有这条必查项`);
          }
        }
      }
    }
    if (bad.length) {
      fail(
        `playbook 的覆盖声明粒度不对：\n    ${bad.join('\n    ')}\n` +
          '覆盖声明必须逐维度写出条目名（维度名（条目名1、条目名2）），' +
          '同一维度里没被列出的条目仍要按该维度自己扫——只写维度名会让覆盖表替没查过的条目背书。',
      );
    } else {
      ok('playbook 的覆盖声明逐维度列出了条目名，且每个条目名在本节都能找到对应必查项');
    }
  }
}

// ---------- 16. README 目录树里列出的路径必须真的存在 ----------
{
  const readme = read('README.md');
  const stack = [];
  const missing = [];
  for (const l of readme) {
    const m = l.match(/^((?:[│|][ ]{3}|[ ]{4})*)(?:├──|└──)[ ]+/);
    if (!m) continue;
    const depth = Math.floor(m[1].length / 4);
    let name = l.slice(m[0].length);
    const hash = name.indexOf('#');
    if (hash >= 0) name = name.slice(0, hash);
    name = name.trim();
    if (!name) continue;
    stack[depth] = (depth === 0 ? '' : stack[depth - 1] ?? '') + name;
    stack.length = depth + 1;
    const p = stack[depth].replace(/[/\\]+$/, '');
    if (!p || p.includes('…')) continue;
    if (!existsSync(join(dir, p))) missing.push(p);
  }
  if (missing.length) {
    fail(`README 目录树列出了不存在的路径：\n    ${missing.join('\n    ')}\n目录树是读者判断「这个仓库有什么」的第一依据。`);
  } else {
    ok('README 目录树里列出的路径都存在');
  }
}

// ---------- 17. 结论档决策表：三档齐全且优先级顺序固定 ----------
{
  const skill = read('SKILL.md');
  const start = skill.findIndex((l) => l.includes('结论档按这张表选'));
  const EXPECTED = ['方向先定', '改完再合', '可以合'];
  if (start === -1) {
    fail('SKILL.md 里找不到「结论档按这张表选」那一段——结论档的选取判据必须落成表，段落写法会漏掉组合。');
  } else {
    const rows = [];
    let started = false;
    for (let i = start + 1; i < skill.length; i += 1) {
      const l = skill[i];
      if (!started) {
        if (!l.trim()) continue;
        if (!l.trim().startsWith('|')) break;
        started = true;
      }
      if (!l.trim().startsWith('|')) break;
      if (/^\|\s*-{2,}/.test(l)) continue;
      if (/^\|\s*情况\s*\|/.test(l)) continue;
      rows.push(l);
    }
    const got = rows.map((r) => EXPECTED.find((v) => r.includes(v)) ?? null);
    if (rows.length !== 3 || got.join('|') !== EXPECTED.join('|')) {
      fail(
        `结论档决策表应是 3 行、优先级 方向先定 → 改完再合 → 可以合，实际 ${rows.length} 行：${got.join(' → ')}`,
      );
    } else {
      ok('结论档决策表 3 行齐全，优先级 方向先定 → 改完再合 → 可以合');
    }
  }
}

// ---------- 19. 示例的结论档必须与正文条目自洽 ----------
// 全量示例、零发现示例、快模式示例、快模式零发现示例都要验——模型模仿的是快模式，
// 只查全量示例等于放着模型真正会抄的那份不管。
//
// **快模式零发现示例此前整块没被检查**：它既没有覆盖表也没有五项计数，
// 而本项只遍历 ['full','zero','fast'] 三种形态——它压根不在名单里。
// 加上之后还要把「结论档的句号形态」认出来（「**可以合**。没有发现…」），
// 否则「找不到结论档」会变成另一种漏检：查到了块，却没读到结论档。
{
  const KINDS = ['full', 'zero', 'fast', 'fastishZero'];
  const blocks = [];
  const counts = {};
  const countBad = [];
  // 检查名单**从 EXAMPLE_BLOCKS 派生**（唯一真相源），不按「三个文件 × 三种形态」硬扫：
  // 快模式零发现示例的判据是「没有覆盖表、没有必须修」——README 里的 shell 代码块
  // 也满足这条，照扫会把安装命令当成示例块来判结论档。
  for (const entry of EXAMPLE_BLOCKS) {
    if (!KINDS.includes(entry.kind)) continue;
    const all = fencedBlocks(read(entry.rel));
    const hits =
      entry.kind === 'fastishZero'
        ? all.filter((b) => BLOCK_KINDS.fastish(b) && !BLOCK_KINDS.fast(b))
        : all.filter(BLOCK_KINDS[entry.kind]);
    for (const b of hits) {
      blocks.push(b);
      counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
    }
    if (hits.length !== entry.want) {
      countBad.push(
        `${entry.rel} 的 ${entry.kind} 示例应被检查 ${entry.want} 次，实际 ${hits.length} 次——` +
          '这一块示例没被检查到（或者检查名单里没有它）',
      );
    }
  }
  const bad = [];
  for (const b of blocks) {
    const verdict = verdictOf(b);
    if (!verdict) {
      bad.push('示例里找不到结论档那一行（形如「结论：**方向先定** —— …」或「**改完再合** —— …」）');
      continue;
    }
    const p01 = (b.match(/\[P0\]|\[P1\]/g) || []).length;
    const decide = (b.match(/\[待拍板\]/g) || []).length;
    if (verdict === '可以合' && p01 > 0) {
      bad.push(`结论档「可以合」，但正文里有 ${p01} 条 P0/P1——按决策表应为「改完再合」`);
    }
    if (verdict === '改完再合' && p01 === 0) {
      bad.push('结论档「改完再合」，但正文里没有 P0/P1 条目——按决策表应为「可以合」');
    }
    if (verdict === '方向先定' && decide === 0) {
      bad.push('结论档「方向先定」，但正文里没有待拍板条目');
    }
  }
  // 守卫自身也要被守：四类示例各自被检查到的次数必须与 EXAMPLE_BLOCKS 派生的一致。
  // 少检查一类（例如把 fastishZero 从名单里删掉），这一项就少看一块示例却照样报绿。
  const expected = {};
  for (const e of EXAMPLE_BLOCKS) {
    if (!KINDS.includes(e.kind)) continue;
    expected[e.kind] = (expected[e.kind] ?? 0) + e.want;
  }
  for (const kind of KINDS) {
    const got = counts[kind] ?? 0;
    const want = expected[kind] ?? 0;
    if (got !== want) {
      countBad.push(
        `${kind} 示例应被检查 ${want} 次，实际检查了 ${got} 次——` +
          '示例块少了一块或检查名单漏了一类，这一项就少看了一块示例',
      );
    }
  }
  bad.push(...countBad);
  if (bad.length) {
    fail(
      `示例的结论档与正文对不上：\n    ${bad.join('\n    ')}\n` +
        '结论档决策表是「从上到下匹配，命中第一条即定档」——示例自己必须落在正确的档位，' +
        '否则模型照着示例写就会给出与规则相反的头号信号。',
    );
  } else {
    ok(
      `示例的结论档与正文条目自洽（检查了 ${blocks.length} 个示例块：` +
        KINDS.map((k) => `${k} ${counts[k] ?? 0} 块`).join(' / ') + '）',
    );
  }
}

// ---------- 20. 快模式的行数预算与字段清单在三处必须一致 ----------
{
  const norm = (s) => s.replace(/\s+/g, '');
  const targets = [
    ['SKILL.md', '紧凑列表'],
    ['references/regression-review.md', '紧凑列表'],
    ['references/output-template.md', '紧凑列表'],
  ];
  const missing = [];
  for (const [f, marker] of targets) {
    const hit = read(f).some((l) => {
      const n = norm(l);
      return n.includes(marker) && n.includes('标题+3行') && n.includes('触发/影响/修法');
    });
    if (!hit) missing.push(f);
  }
  if (missing.length) {
    fail(
      `快模式的行数预算与字段清单没写齐：${missing.join('、')}。\n` +
        '三处都要写「标题 + 3 行（触发 / 影响 / 修法）」——只写「2~3 行」时，' +
        '模型为了塞进行数最可能砍掉的就是证据行。',
    );
  } else {
    ok('快模式的行数预算与字段清单在 SKILL.md / regression-review.md / output-template.md 里一致');
  }
}

// ---------- 21. 必查项的扩展维度标签必须在该段的覆盖声明里 ----------
{
  const pb = read('references/playbooks.md');
  const sections = parsePlaybookSections(pb);
  const SEVEN = ['设计', '方法契约', '实现', '文档', '硬编码', '重复', '过度设计'];
  // 「规模与复杂度」按设计不被任何 playbook 覆盖（playbooks.md 的「规模扫描不被任何 playbook 覆盖」一节）
  const EXEMPT = new Set([...SEVEN, '规模与复杂度']);
  const bad = [];
  for (const s of sections) {
    for (const it of s.items) {
      for (const dim of it.split('/').map((x) => x.trim())) {
        if (EXEMPT.has(dim)) continue;
        if (!s.declared.includes(dim)) {
          bad.push(`${s.name}：有条必查项标注了「${dim}」，但该段的覆盖声明里没有这个维度`);
        }
      }
    }
  }
  if (bad.length) {
    fail(
      `playbook 的必查项维度没进覆盖声明：\n    ${bad.join('\n    ')}\n` +
        '一条必查项标了某个扩展维度，却没写进该段的覆盖声明——它就不在「已覆盖」的名单里，' +
        '按规则会落回该维度自己扫，而那个维度的正文里未必有这条，等于这条必查项没人扫。',
    );
  } else {
    ok('playbook 每条必查项的扩展维度标签都在该段覆盖声明里');
  }
}

// ---------- 22. 取值数量的声明必须与实际取值集合一致 ----------
// 「结果格用四种取值」这类数字写在 4 个文件里。取值集合加了第 5 种而这些数字没跟着改，
// 就会出现「契约说有 4 种、实际能写 5 种」——模型按哪份数字理解，决定了它会不会用第 5 种。
//
// 这一项必须对**措辞与位置都稳健**：
//   - 守门条件不能绑死在「结果格」三个字上（SKILL.md 写的是「第 2 段每格用…」，
//     绑死了就等于漏检权威出处那一行——恰恰是最容易漂移的那个文件）；
//   - 数量不能硬编码成常量（改了就与 resultRe 脱钩，改 resultRe 它却还在说「一致」）；
//   - 措辞不能只认「N 种取值」这一种（换个说法就静默失效，而且没有任何提示）。
// 所以：扫全部声明行 → 找到声明就比数量 → 一个都没找到也要报红（守卫自己失效了）。
//
// 还要防两种「看起来在声明、其实不是」的写法：
//   - 数字换成阿拉伯数字（「5 种取值」写成「5 种」）——量词与数字形态都要认；
//   - 用一行诱饵顶替权威声明行——**声明了数量就必须把清单列出来**，
//     只报数字不列清单的，读者无从核对，也无法证明被扫到的那行就是权威出处。
{
  const files = {
    'SKILL.md': read('SKILL.md'),
    'README.md': read('README.md'),
    'references/output-template.md': read('references/output-template.md'),
    'references/playbooks.md': read('references/playbooks.md'),
  };
  const bad = [];
  const seen = [];
  // 声明行 = 含「取值」二字，且带一个数字 + 量词（「种 / 类 / 写法 / 形式」）。
  // 「第 5 种」是序数不是计数，要排除掉。
  const NUM_RE = /([3-6]|[三四五六])\s*(种|类|写法|形式)/g;
  const CN = { 三: 3, 四: 4, 五: 5, 六: 6, 3: 3, 4: 4, 5: 5, 6: 6 };
  const FORM_TOKENS = RESULT_VALUES.map((v) => v.text);
  const countMatches = (line) =>
    [...line.matchAll(NUM_RE)].filter((m) => !/第\s*$/.test(line.slice(0, m.index)));
  for (const [name, lines] of Object.entries(files)) {
    for (const [i, l] of lines.entries()) {
      if (!l.includes('取值')) continue;
      const counts = countMatches(l);
      if (!counts.length) continue;
      const m = counts[0];
      const n = CN[m[1]];
      seen.push(`${name}:${i + 1}`);
      if (n !== ACTUAL_RESULT_COUNT) {
        bad.push(`${name}:${i + 1} 写着「${m[1]}${m[2]}取值」，但实际合法取值有 ${ACTUAL_RESULT_COUNT} 种`);
      }
      // 这一行是不是「把清单也列出来」的声明行？
      const tokens = [...l.matchAll(/`([^`]+)`/g)].map((x) => x[1]);
      const forms = [];
      for (const t of tokens) {
        if (!/n 条|已查（见|未扫（|无发现/.test(t)) continue;
        if (forms.includes(t)) continue;
        forms.push(t);
      }
      if (forms.length < FORM_TOKENS.length) {
        bad.push(
          `${name}:${i + 1} 声明了取值数量却没把清单列全（列出 ${forms.length} 种，应 ${FORM_TOKENS.length} 种）——` +
            '只报数字不列清单的，读者无从核对；这样也能拿一行诱饵顶替真正的权威声明行。',
        );
      }
    }
  }
  // 守卫自身也要被守：三处权威声明出处里，每一处都要有声明被扫到。
  // 守门条件一改就静默失效的场景，只有靠「必须扫到」才兜得住。
  const mustHit = ['SKILL.md', 'README.md', 'references/output-template.md'];
  const notHit = mustHit.filter((f) => !seen.some((s) => s.startsWith(`${f}:`)));
  if (notHit.length) {
    bad.push(
      `这些文件里的「取值数量」声明没有被扫到：${notHit.join('、')}——` +
        '守卫的守门条件与文件实际措辞脱钩了，改一处措辞就会静默失效。',
    );
  }
  if (bad.length) {
    fail(
      `取值数量的声明与实际取值集合不一致：\n    ${bad.join('\n    ')}\n` +
        `结果格的合法取值集合由本文件顶部的 RESULT_VALUES 决定（当前 ${ACTUAL_RESULT_COUNT} 种）；` +
        '往里加一种取值时，所有写着「N 种取值」的地方都要一起改——数字漂了，模型就不知道该不该用新写法。',
    );
  } else {
    ok(`各处「取值数量」的声明与实际取值集合一致（${ACTUAL_RESULT_COUNT} 种，扫到 ${seen.length} 处声明）`);
  }

  // ---------- 22b. 取值清单本身必须逐字一致 ----------
  // 数量对了不等于清单对了：「五种取值」下，清单里第 4 项写成 `n 条` 而不是 `n 条（级别）`，
  // 数量仍是五种，模型却会以为可以不带级别——而级别正是与结论行对账的唯一钥匙。
  // 所以这里把各处声明里的反引号清单抠出来，与 RESULT_VALUES 逐项比对。
  {
    const listBad = [];
    const checkedFiles = [];
    for (const [name, lines] of Object.entries(files)) {
      for (const [i, l] of lines.entries()) {
        if (!l.includes('取值')) continue;
        if (!countMatches(l).length) continue;
        // 抠出这一行里所有反引号包裹的 token
        const tokens = [...l.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
        // 只看长得像取值形态的 token（按出现顺序去重）
        const seenForms = [];
        for (const t of tokens) {
          if (!/n 条|已查（见|未扫（|无发现/.test(t)) continue;
          if (seenForms.includes(t)) continue;
          seenForms.push(t);
        }
        if (!seenForms.length) continue;
        checkedFiles.push(`${name}:${i + 1}`);
        if (seenForms.length !== FORM_TOKENS.length) {
          listBad.push(`${name}:${i + 1} 列了 ${seenForms.length} 种取值（应 ${FORM_TOKENS.length} 种）：${seenForms.join(' / ')}`);
          continue;
        }
        for (let k = 0; k < FORM_TOKENS.length; k += 1) {
          if (seenForms[k] !== FORM_TOKENS[k]) {
            listBad.push(`${name}:${i + 1} 第 ${k + 1} 种取值是「${seenForms[k]}」，应为「${FORM_TOKENS[k]}」`);
          }
        }
      }
    }
    if (listBad.length) {
      fail(
        `取值清单在各处副本里不一致：\n    ${listBad.join('\n    ')}\n` +
          `规范清单（唯一真相源）：${FORM_TOKENS.join(' / ')}\n` +
          '数量相同不代表清单相同——第 4 项差一个「（级别）」，模型就会以为可以不带级别。',
      );
    } else {
      ok(`各处声明的取值清单与规范清单逐项一致（检查了 ${checkedFiles.length} 处：${checkedFiles.join('、')}）`);
    }
  }
}

// ---------- 23. 结论行的数量必须与正文条目数对得上 ----------
// 契约写死「结论里写的每个数字都要在正文里数得出来」，但此前 lint 只比两个示例的
// 数字**字面相同**，从不拿它们去数正文——两个示例一起改成「P1 3」而正文仍是 2 条，CI 全绿。
// 示例是模型模仿的对象：示例自己数字对不上，等于教模型写虚高的报告。
{
  const COUNT_RE = /P0 (\d+)、P1 (\d+)、P2 (\d+)、P3 (\d+)、待拍板 (\d+)/;
  const bad = [];
  const shapeBad = [];
  let checked = 0;
  // 全量示例、零发现示例、快模式示例都要对账——模型模仿的是快模式，
  // 只查全量示例等于放着模型真正会抄的那份不管。
  for (const [name, lines] of [
    ['README.md', read('README.md')],
    ['references/output-template.md', read('references/output-template.md')],
    ['references/regression-review.md', read('references/regression-review.md')],
  ]) {
    for (const kind of ['full', 'zero', 'fast']) {
      for (const b of fencedBlocks(lines).filter(BLOCK_KINDS[kind])) {
        const c = b.match(COUNT_RE);
        if (!c) continue;
        const declared = { P0: +c[1], P1: +c[2], P2: +c[3], P3: +c[4], 待拍板: +c[5] };
        // 「什么算一条 finding」由**共享解析器**给出（第 12/24/25 项共用同一份定义）。
        // 此前这一处自己写了一份正则（`#{2,4}`），第 24 项又写了一份（只认 `###`），
        // 第 25 项再写一份（只认 `###`）——三处口径不一致，改一处另外两处跟着失灵。
        const { found, rejected } = parseFindings(b.split('\n'));
        const actual = { P0: 0, P1: 0, P2: 0, P3: 0, 待拍板: 0 };
        // 形态不合法的 finding（标题层级写错）**也要计入条数**：
        // 条目确实存在，只是写法不对——报「层级错了」，而不是报「正文里数出来 0 条」
        // （后者会把人引到错的地方去改）。
        for (const f of [...found, ...rejected]) actual[f.level] += 1;
        checked += 1;
        for (const r of rejected) {
          shapeBad.push(`${name}（${kind} 示例）：${r.reason}——${r.text.trim()}`);
        }
        for (const lv of FINDING_LEVELS) {
          if (declared[lv] !== actual[lv]) {
            bad.push(
              `${name}（${kind} 示例）：结论行写「${lv} ${declared[lv]}」，正文里数出来是 ${actual[lv]} 条`,
            );
          }
        }
      }
    }
  }
  if (shapeBad.length) {
    fail(
      `示例里的 finding 形态不合法：\n    ${shapeBad.join('\n    ')}\n` +
        'finding 必须是 ### 标题（快模式用列表项）——层级写错，下游按标题解析就找不到这条。',
    );
  }
  if (bad.length) {
    fail(
      `示例的结论计数与正文条目对不上：\n    ${bad.join('\n    ')}\n` +
        '「结论里写的每个数字都要在正文里数得出来」——示例自己得先做到。',
    );
  } else {
    ok(`示例的结论计数与正文条目逐级相等（检查了 ${checked} 个示例块）`);
  }
}

// ---------- 24. 覆盖表声明的条目数与正文必须双向对账 ----------
// 只做下界的话，「无发现」的维度可以带着 finding（读者分不清是「扫了没问题」还是「压根没扫」），
// 写了「n 条」的维度也可以多出正文里没有的条目。双向都要卡。
//
// 全量示例与**零发现示例**都要对账——零发现示例同样有一张覆盖表，
// 此前只对账全量示例：那张表的第一行从「无发现」改成「1 条（P1）」，lint 全绿，
// 而同一块里结论行写着 P0 0、P1 0、正文一条 finding 都没有。
{
  const COUNT_RE = /P0 (\d+)、P1 (\d+)、P2 (\d+)、P3 (\d+)、待拍板 (\d+)/;
  const bad = [];
  const shapeBad = [];
  let checked = 0;
  for (const [name, lines] of [
    ['README.md', read('README.md')],
    ['references/output-template.md', read('references/output-template.md')],
    ['references/regression-review.md', read('references/regression-review.md')],
  ]) {
    for (const kind of ['full', 'zero']) {
      for (const b of fencedBlocks(lines).filter(BLOCK_KINDS[kind])) {
        checked += 1;
        // 「什么算一条 finding」：共享解析器（第 23 / 24 / 25 项共用同一份定义）
        const { found, rejected } = parseFindings(b.split('\n'));
        const actualByDim = {};
        for (const f of [...found, ...rejected]) {
          actualByDim[f.dim] = (actualByDim[f.dim] ?? 0) + 1;
          if (rejected.includes(f)) {
            shapeBad.push(`${name}（${kind} 示例）：${f.reason}——${f.text.trim()}`);
          }
        }
        // 覆盖表每一行
        const rows = b.split('\n').filter((l) => /^\|\s*[^-|\s][^|]*\|/.test(l));
        for (const l of rows) {
          const cells = l.split('|').map((c) => c.trim());
          const dim = cells[1];
          if (!dim || dim === '维度' || isOmissionRow(l)) continue;
          const result = cells[2] ?? '';
          const actual = actualByDim[dim] ?? 0;
          const m = result.match(/^(\d+) 条/);
          if (m) {
            const declared = Number(m[1]);
            if (declared !== actual) {
              bad.push(`${name}（${kind} 示例）：覆盖表「${dim}」声明 ${declared} 条，正文里数出来是 ${actual} 条`);
            }
          } else if (result === '无发现' || result.startsWith('未扫')) {
            if (actual > 0) {
              bad.push(`${name}（${kind} 示例）：覆盖表「${dim}」写「${result}」，但正文里有 ${actual} 条该维度的 finding`);
            }
          }
        }
        // 反向：正文里出现过的维度，覆盖表不能写「无发现」/「未扫」
        for (const [dim, n] of Object.entries(actualByDim)) {
          const row = rows.find((l) => l.split('|')[1].trim() === dim);
          if (!row) continue;
          const result = row.split('|')[2].trim();
          if (result === '无发现' || result.startsWith('未扫')) {
            bad.push(`${name}（${kind} 示例）：正文里有 ${n} 条「${dim}」的 finding，覆盖表该行却写「${result}」`);
          }
        }
        // 零发现示例：覆盖表与结论行的五项计数必须逐项对得上。
        // 覆盖表每行都写「无发现／未扫」时，结论行就不该有任何非零计数；
        // 覆盖表写了「N 条（级别）」时，结论行那一级的计数必须等于 N。
        if (kind === 'zero') {
          const c = b.match(COUNT_RE);
          if (!c) {
            bad.push(`${name}（零发现示例）：结论行没有写各级数量`);
          } else {
            const declared = { P0: +c[1], P1: +c[2], P2: +c[3], P3: +c[4], 待拍板: +c[5] };
            const tableDeclares = rows.some((l) => /^\|\s*[^-|\s][^|]*\|\s*\d+\s*条/.test(l));
            const anyCount = FINDING_LEVELS.some((lv) => declared[lv] !== 0);
            if (!tableDeclares && anyCount) {
              const nz = FINDING_LEVELS.filter((lv) => declared[lv] !== 0)
                .map((lv) => `${lv} ${declared[lv]}`)
                .join('、');
              bad.push(
                `${name}（零发现示例）：覆盖表每行都是「无发现／未扫」，结论行却写「${nz}」——` +
                  '同一块里表说没发现、结论说有，两头对不上',
              );
            }
            if (tableDeclares && !anyCount) {
              bad.push(
                `${name}（零发现示例）：覆盖表里有「N 条（级别）」的行，结论行的五项计数却全是 0`,
              );
            }
            for (const l of rows) {
              const cells = l.split('|').map((x) => x.trim());
              const m = (cells[2] ?? '').match(/^(\d+) 条（(.+?)）/);
              if (!m) continue;
              const lv = m[2].trim();
              if (declared[lv] !== Number(m[1])) {
                bad.push(
                  `${name}（零发现示例）：覆盖表「${cells[1]}」声明 ${m[1]} 条（${lv}），结论行写的是 ${lv} ${declared[lv]}`,
                );
              }
            }
          }
        }
      }
    }
  }
  if (shapeBad.length) {
    fail(
      `示例里的 finding 形态不合法：\n    ${shapeBad.join('\n    ')}\n` +
        'finding 必须是 ### 标题（快模式用列表项）——层级写错，双向对账就数不到它。',
    );
  }
  if (bad.length) {
    fail(
      `示例的覆盖表与正文 finding 双向对不上：\n    ${bad.join('\n    ')}\n` +
        '覆盖表是「我扫过了」的凭证：写了「无发现」却有该维度的条目，等于替没查过背书。',
    );
  } else {
    ok(`示例的覆盖表与正文 finding 双向对账通过（检查了 ${checked} 个示例块）`);
  }
}

// ---------- 25. finding 的落点必须符合分级规则 ----------
// P0/P1 进「必须修」、P2/P3 进「建议修」、待拍板进「需要你拍板」。
// 此前 lint 只在整块里数标签，不看标签落在哪一段——把 P2 放进「必须修」示例，全绿。
{
  const fencedBlocks = (lines) => {
    const blocks = [];
    let cur = null;
    for (const l of lines) {
      if (/^\s*```/.test(l)) {
        if (cur === null) cur = [];
        else { blocks.push(cur.join('\n')); cur = null; }
        continue;
      }
      if (cur !== null) cur.push(l);
    }
    return blocks;
  };
  const COUNT_RE = /P0 (\d+)、P1 (\d+)、P2 (\d+)、P3 (\d+)、待拍板 (\d+)/;
  const isExample = (b) => BLOCK_KINDS.full(b);
  const RULES = [
    { section: '必须修', allow: ['P0', 'P1'] },
    { section: '建议修', allow: ['P2', 'P3'] },
    { section: '需要你拍板', allow: ['待拍板'] },
  ];
  const bad = [];
  let checked = 0;
  for (const [name, lines] of [
    ['README.md', read('README.md')],
    ['references/output-template.md', read('references/output-template.md')],
  ]) {
    for (const b of fencedBlocks(lines).filter(isExample)) {
      checked += 1;
      const blines = b.split('\n');
      // 「什么算一条 finding」：共享解析器（第 23 / 24 / 25 项共用同一份定义）
      const { found, rejected } = parseFindings(blines);
      // 每条 finding 落在哪一段：看它前面最近的二级标题
      const sectionOf = (idx) => {
        for (let i = idx; i >= 0; i -= 1) {
          const m = blines[i].match(/^##\s+(.+?)\s*$/);
          if (m) return m[1].trim();
        }
        return '';
      };
      for (const f of [...found, ...rejected]) {
        const sec = sectionOf(f.index);
        const rule = RULES.find((r) => r.section === sec);
        if (!rule) continue;
        if (!rule.allow.includes(f.level)) {
          bad.push(`${name}：一条 [${f.level}] 条目出现在「${rule.section}」段（该段只放 ${rule.allow.join(' / ')}）`);
        }
      }
    }
  }
  if (bad.length) {
    fail(
      `示例的 finding 落点违反分级规则：\n    ${bad.join('\n    ')}\n` +
        '「每一级都要有落点」——示例把 P2 放进「必须修」，照抄的模型就会拿 P2 挡合并。',
    );
  } else {
    ok(`示例的 finding 落点符合分级规则（检查了 ${checked} 个示例块）`);
  }
}

// ---------- 26. 闸门表的问法与必答句的内容不能被清空 ----------
// 此前 lint 只看闸门表的**行名**与必答句的**标签**：把「安全问题」行的「必须回答」清空，
// 或把必答句写成「- 安全：」，全都全绿。契约说「不要用措辞掩盖不确定」，
// 而把问法清空恰恰就是掩盖。
{
  const verif = read('references/verification.md');
  const bad = [];
  // 闸门表：每行的第 2、3 列（非空）必须有实质问法
  for (const l of verif) {
    if (!/^\|\s*[^-|].*\|.*\|.*\|$/.test(l)) continue;
    if (/^\|\s*结论类型/.test(l)) continue;
    const cells = l.split('|').map((c) => c.trim());
    const [, type, must, fallback] = cells;
    if (!type) continue;
    if (!must || must.length < 4) {
      bad.push(`闸门表「${type}」行的「必须回答」列为空`);
    } else if (!must.includes('？')) {
      // 只测长度会被「见下表。」这种占位糊过去——判据被清空，正是「不要用措辞掩盖不确定」的反面
      bad.push(`闸门表「${type}」行的「必须回答」列一个问句都没有（内容是「${must}」）——这一列必须是问句`);
    }
    // 「答不上来怎么办」允许为空——有些结论类型没有降级路径（答不上就删），
    // 那一列写的是「删」这个动作本身，仍然要非空。
    if (!fallback || fallback.length < 1) bad.push(`闸门表「${type}」行的「答不上来怎么办」列为空`);
  }
  // 必答句：每条在「：」之后要有实质内容（含 ___ 占位）
  const bullets = section(verif, /^##\s*每个维度的必答句/)
    .filter((l) => /^\s*-\s/.test(l))
    .map((l) => l.replace(/^\s*-\s*/, ''));
  for (const b of bullets) {
    const idx = b.indexOf('：');
    if (idx === -1) { bad.push(`必答句「${b}」没有分隔符`); continue; }
    const body = b.slice(idx + 1);
    if (body.trim().length < 4 || !body.includes('___')) {
      bad.push(`必答句「${b.split('：')[0]}」的正文为空或没有 ___ 占位`);
    }
  }  if (bad.length) {
    fail(
      `闸门表或必答句的实质内容被清空：\n    ${bad.join('\n    ')}\n` +
        '闸门表回答「能不能成立」，必答句回答「凭什么成立」——两者空着，模型对这一维就只能临场发挥。',
    );
  } else {
    ok(`闸门表 ${verif.filter((l) => /^\|\s*[^-|].*\|.*\|.*\|$/.test(l) && !/^\|\s*结论类型/.test(l)).length} 行的问法与必答句 ${bullets.length} 句的正文都非空`);
  }
}

// ---------- 27. 必答句的子问数不得少于闸门表 ----------
// 必答句是闸门表的速查副本，副本少一问，模型照着副本走就会漏问那一问
// （例：测试盲区在闸门表有 3 问，副本只有 2 问，「既有测试会不会静默失效」就没人问了）。
//
// 计数口径（两种写法都要能算出来）：
//   闸门表：一行里有几个「？」就是几问。
//   必答句：每问要么留一个「___」占位，要么本身就是一个以「？」收尾的问句
//           （「它是协议固定值还是业务政策值？若业务政策值：必须随 ___ 变化；不改时会 ___。」
//            是 2 个占位 + 1 个问句 = 3 问，与闸门表的 3 问对齐）。
// 所以必答句的问数 = 「___」个数 + 「？」个数。
//
// 配对方式也不能靠「包含关系」——`'过度设计'.includes('设计')` 成立，
// 「设计」必答句会被配到「过度设计」那一行；改「过度设计」的行会报一条指向「设计」的错，
// 按提示去改的人会去改错的那条必答句。现在用**显式映射**配对：标签 → 闸门表「结论类型」列的原文。
// 配不上的标签直接报红——必答句是副本，副本里多出一条判据表没有的问题，同样是漂移。
{
  const verif = read('references/verification.md');
  const MUST_ANSWER_TO_GATE = {
    设计: '设计不合理',
    缺参数: '缺参数/缺省有歧义',
    跨层形状: '跨层形状',
    实现: '实现 bug',
    规模: '规模与复杂度',
    并发: '并发问题',
    硬编码: '硬编码',
    重复: '重复（真重复）',
    语义分裂: '语义分裂',
    职责重叠: '职责重叠',
    文档: '文档不清',
    过度设计: '过度设计',
    安全: '安全问题',
    兼容性: '兼容性问题',
    错误路径与部分失败: '错误路径与部分失败',
    可观测性: '可观测性',
    性能: '性能',
    测试盲区: '测试盲区',
  };
  const gateRows = verif
    .filter((l) => /^\|\s*[^-|].*\|.*\|.*\|$/.test(l) && !/^\|\s*结论类型/.test(l))
    .map((l) => l.split('|').map((c) => c.trim()));
  const bullets = section(verif, /^##\s*每个维度的必答句/)
    .filter((l) => /^\s*-\s/.test(l))
    .map((l) => l.replace(/^\s*-\s*/, ''));
  const bad = [];
  const labels = new Set();
  for (const b of bullets) {
    const idx = b.indexOf('：');
    if (idx === -1) continue;
    const label = b.slice(0, idx).trim();
    labels.add(label);
    const gateType = MUST_ANSWER_TO_GATE[label];
    if (!gateType) {
      bad.push(
        `必答句「${label}」在闸门表里找不到对应行——必答句是闸门表的速查副本，` +
          '多出来的一条判据没人认账；请给它在闸门表里补一行，并在本文件的映射表里补上对应关系',
      );
      continue;
    }
    const row = gateRows.find((r) => r[1] === gateType);
    if (!row) {
      bad.push(`必答句「${label}」对应的闸门行「${gateType}」在闸门表里不存在——闸门行改了名，映射表要跟着改`);
      continue;
    }
    const gateQ = (row[2] || '').split('？').length - 1;
    const body = b.slice(idx + 1);
    const bulletQ = (body.match(/___/g) || []).length + (body.match(/？/g) || []).length;
    if (bulletQ < gateQ) {
      bad.push(`必答句「${label}」只覆盖 ${bulletQ} 问，闸门表「${gateType}」那一行问了 ${gateQ} 问`);
    }
  }
  // 反向：映射表里有的标签，必答句清单与闸门表都得真的在
  for (const [label, gateType] of Object.entries(MUST_ANSWER_TO_GATE)) {
    if (!labels.has(label)) bad.push(`映射表里的必答句「${label}」在必答句清单里不存在（对应闸门行「${gateType}」）`);
    if (!gateRows.some((r) => r[1] === gateType)) {
      bad.push(`映射表指向的闸门行「${gateType}」在闸门表里不存在`);
    }
  }
  if (bad.length) {
    fail(
      `必答句的子问数少于闸门表：\n    ${bad.join('\n    ')}\n` +
        '必答句是闸门表的速查副本——副本少问的那一问，模型照着副本走就不会问。',
    );
  } else {
    ok(`必答句覆盖的问数都不少于闸门表对应行（${bullets.length} 句，按显式映射逐句配对）`);
  }
}

// ---------- 28. finding 的字段名必须固定 ----------
// 契约写「每条 finding 的字段固定」，但此前没有任何检查比对字段名：
// 把骨架里的「- 证据：」改成「- 依据：」，全绿。字段名一漂，按字段解析报告的人就读不到了。
//
// 此前 SKILL.md 那一侧只做「整文件子串存在性」——「触发」「建议」这类词在散文里到处都是，
// 把整个字段定义块删掉它照样报「一致」。现在两侧都从**定义处**抽出字段名序列再逐项比：
//   - 骨架块：按 `- 字段：` 形态抽
//   - SKILL.md：「必须修」「建议修」各有自己的 fenced 块，按 `- 字段：` 形态抽；
//     「需要你拍板」的六字段写在七段结构那一行（顿号形态），按「每条给…」之后切
{
  const EXPECTED = {
    '必须修': ['触发', '影响', '证据', '修法'],
    '建议修': ['问题', '证据', '收益', '修法'],
    '需要你拍板': ['现状', '证据', '路线 A', '路线 B', '建议', '要你定'],
  };
  const bad = [];
  // ---- 骨架侧 ----
  const tpl = read('references/output-template.md');
  const skeleton = pickBlock(tpl, 'skeleton');
  if (!skeleton) {
    bad.push('output-template.md 的骨架块定位失败（应当恰好一块）——字段名无从校验');
  } else {
    for (const [section, fields] of Object.entries(EXPECTED)) {
      const start = skeleton.indexOf(`## ${section}`);
      const rest = skeleton.slice(start + section.length + 3);
      const next = rest.search(/^##\s/m);
      const body = next === -1 ? rest : rest.slice(0, next);
      const got = [...body.matchAll(/^-\s+([^：\n]+)：/gm)].map((m) => m[1].trim());
      if (got.join('|') !== fields.join('|')) {
        bad.push(`骨架「${section}」段的字段是 [${got.join(', ')}]，应为 [${fields.join(', ')}]`);
      }
    }
  }
  // ---- SKILL.md 侧（权威出处）----
  const skill = read('SKILL.md');
  const skillFields = (anchor) => {
    const blk = fencedBlockAfter(skill, anchor);
    if (!blk) return null;
    return [...blk.matchAll(/^-\s+([^：\n]+)：/gm)].map((m) => m[1].trim());
  };
  for (const [section, anchor] of [
    ['必须修', /^「必须修」/],
    ['建议修', /^「建议修」/],
  ]) {
    const got = skillFields(anchor);
    if (got === null) {
      bad.push(`SKILL.md 的字段定义里找不到「${section}」那一段（行首形如「${section}」（…）：」）`);
      continue;
    }
    if (got.join('|') !== EXPECTED[section].join('|')) {
      bad.push(`SKILL.md「${section}」的字段定义是 [${got.join(', ')}]，应为 [${EXPECTED[section].join(', ')}]`);
    }
  }
  // 「需要你拍板」的六字段在七段结构那一行，顿号形态
  const decideLine = skill.find((l) => l.includes('需要你拍板') && l.includes('每条给'));
  if (!decideLine) {
    bad.push('SKILL.md 的七段结构里找不到「需要你拍板」的字段定义（形如「每条给现状、证据、路线 A、路线 B、建议、要你定」）');
  } else {
    const raw = decideLine.match(/每条给([^）]+)/);
    const got = raw ? raw[1].split('、').map((s) => s.trim()).filter(Boolean) : [];
    if (got.join('|') !== EXPECTED['需要你拍板'].join('|')) {
      bad.push(`SKILL.md「需要你拍板」的字段定义是 [${got.join(', ')}]，应为 [${EXPECTED['需要你拍板'].join(', ')}]`);
    }
  }
  // ---- 快模式示例侧 ----
  // 快模式的字段集与全量**不一样**：证据并入「触发」行，所以 P0/P1 是三行
  // （触发 / 影响 / 修法）；P2/P3 是四行（问题 / 证据 / 收益 / 修法）；
  // 待拍板是六字段。此前这一侧**一项检查都没有**——
  // 把快模式示例里的「影响：」改成「后果：」，lint 全绿，而按字段解析的下游读不到。
  const FAST_FIELDS = {
    P0: ['触发', '影响', '修法'],
    P1: ['触发', '影响', '修法'],
    P2: ['问题', '证据', '收益', '修法'],
    P3: ['问题', '证据', '收益', '修法'],
    待拍板: ['现状', '证据', '路线 A', '路线 B', '建议', '要你定'],
  };
  let fastChecked = 0;
  for (const entry of EXAMPLE_BLOCKS.filter((e) => e.kind === 'fast')) {
    const blk = exampleBlock(entry.rel, entry.kind);
    if (!blk) continue; // 块不在 → 第 44 项报红
    fastChecked += 1;
    const blines = blk.split('\n');
    // 每条 finding = 一行 `- [级别][维度][引入方式] …`，正文是它下面的缩进行
    for (let i = 0; i < blines.length; i += 1) {
      const m = blines[i].match(/^\s*[-*]\s+\[(P0|P1|P2|P3|待拍板)\]/);
      if (!m) continue;
      const level = m[1];
      const fields = [];
      for (let j = i + 1; j < blines.length; j += 1) {
        const l = blines[j];
        if (!l.trim()) break; // 空行 = 这一条结束
        if (!/^\s+\S/.test(l)) break; // 不再缩进 = 下一条 / 别的段落
        const fm = l.match(/^\s*[-*]?\s*([^：\n]+)：/);
        if (fm) fields.push(fm[1].trim());
      }
      if (fields.join('|') !== FAST_FIELDS[level].join('|')) {
        bad.push(
          `${entry.rel} 的快模式示例：一条 [${level}] 条目的字段是 [${fields.join(', ')}]，应为 [${FAST_FIELDS[level].join(', ')}]`,
        );
      }
    }
  }
  if (bad.length) {
    fail(
      `finding 的字段名不固定：\n    ${bad.join('\n    ')}\n` +
        '契约写死「每条 finding 的字段固定」——字段名一漂，按字段解析报告的复核链就断了。' +
        'SKILL.md 是权威出处（字段以本节为准），模板只是骨架，两边必须逐项相同。',
    );
  } else {
    ok(`finding 的字段名在骨架模板、SKILL.md 定义与快模式示例里逐项一致（快模式示例检查了 ${fastChecked} 块）`);
  }
}

// ---------- 29. 「已查过没问题」的准入门槛在各副本里必须一致 ----------
// 这条门槛写在三处（SKILL.md / output-template.md / verification.md），
// 此前谁改谁漂，且被指定的基准（output-template）自己先漂也没人管。
//
// 判定按**小节**而不是按行：按行找门槛句，编辑器把长句折成两行就会报「各副本不一致」，
// 而内容一个字都没改；按小节找，被搬走整句也拦不住（内容还在，搬走不算漂移）。
{
  const TOKENS = ['跑了测试', '构造了复现', '对比了 base', '专门证伪'];
  const sources = [
    ['SKILL.md', read('SKILL.md')],
    ['references/output-template.md', read('references/output-template.md')],
    ['references/verification.md', read('references/verification.md')],
  ];
  const bad = [];
  for (const [name, lines] of sources) {
    const secs = headingSections(lines);
    const hit = secs.find((s) => TOKENS.every((t) => s.includes(t)));
    if (hit) continue;
    const missing = TOKENS.filter((t) => !secs.some((s) => s.includes(t)));
    bad.push(
      `${name}：准入门槛缺少「${missing.join('、')}」` +
        `（四个 token 必须出现在同一小节里——门槛被拆散就不再是「四选一」了）`,
    );
  }
  if (bad.length) {
    fail(
      `「已查过没问题」的准入门槛在各副本里不一致：\n    ${bad.join('\n    ')}\n` +
        `门槛是「四选一」：${TOKENS.join(' / ')}——三处副本必须同时齐全，缺一项就放进来一条没有验证方式的条目。`,
    );
  } else {
    ok('「已查过没问题」的准入门槛在 SKILL.md / output-template.md / verification.md 三处一致（四选一）');
  }

  // ---- 示例里「已查过没问题」小节的每一条，都必须带可核对的痕迹 ----
  // 门槛写在文件里 ≠ 示例做对了。此前这一项只查「文件里有没有那四个 token」，
  // 示例里写「- 兼容：看起来没问题。」照样全绿——而 rubric 第 4 维对
  // 「已查过没问题里出现没有验证方式的条目」每条 −1。
  // 可核对的痕迹：做了哪个动作（读了 / 跑了 / 对比了 / 证伪了 / grep 了）、
  // 或者指得出位置（行号、文件名）、或者指得出数量。
  const TRACE_ACTIONS = /(读了|读了|跑了|跑过|构造了|复现|对比了|对比|证伪|grep|查了|核对了)/;
  const TRACE_PLACE = /[:：]\s*\d+|\b[\w-]+\.(go|md|ts|tsx|js|jsx|py|java|kt|rb|rs|yaml|yml|json|toml|sh)\b/;
  const TRACE_COUNT = /\d+\s*(处|个|行|次|条|项|遍|轮|点)/;
  const itemBad = [];
  let itemChecked = 0;
  let blocksWithSection = 0;
  // 下限守卫（第 24A-03）：示例里这一段必须**存在且有内容**。
  // 此前定位靠小节标题的字面量（`^##\s*已查过没问题\s*$`），示例里把它改名，
  // 整块检查就失效——而新增的「看起来没问题」条目照样没人管（第 4 维对每条 −1）。
  // 现在：① 定位改用**规范段名集合**（与第 4 项同一份常量 SECTION_NAMES）；
  //      ② 加下限——扫到的条目数少于下限就报红（扫不到东西比扫出错更糟）。
  // 下限 = 骨架块 2 条 + 全量示例块 2 条（这是契约里两处示例当前的条目数；
  // 契约改了条目数就要同步这里，并说明理由——否则这一项会静默失效）。
  const MIN_TRACE_ITEMS = 4;
  const MIN_TRACE_BLOCKS = 2;
  for (const rel of ['references/output-template.md', 'README.md', 'references/regression-review.md']) {
    for (const b of fencedBlocks(read(rel))) {
      const blines = b.split('\n');
      // 按结构定位：块内 `## ` 开头的标题里，段名属于规范段名集合的那一个
      const start = blines.findIndex(
        (l) => /^##\s/.test(l) && normSection(l.replace(/^##\s+/, '')) === '已查过没问题',
      );
      if (start === -1) continue;
      blocksWithSection += 1;
      let section = [];
      for (let i = start + 1; i < blines.length; i += 1) {
        if (/^##\s/.test(blines[i])) break;
        section.push(blines[i]);
      }
      for (const l of section.filter((x) => /^\s*[-*]\s+\S/.test(x))) {
        itemChecked += 1;
        const text = l.trim();
        if (!TRACE_ACTIONS.test(text) && !TRACE_PLACE.test(text) && !TRACE_COUNT.test(text)) {
          itemBad.push(`${rel}：示例「已查过没问题」里的这一条没有可核对的痕迹——${text}`);
        }
      }
    }
  }
  if (itemBad.length) {
    fail(
      `示例「已查过没问题」小节里有条目没有验证方式：\n    ${itemBad.join('\n    ')}\n` +
        '契约写「写了就每条带一句验证方式（跑了什么 / 读了什么 / 对比了哪个 base）」——' +
        'rubric 第 4 维对这种条目每条 −1，示例自己不能示范一条。',
    );
  } else {
    ok(`示例「已查过没问题」小节的每一条都带可核对的痕迹（检查了 ${itemChecked} 条）`);
  }
  // 下限守卫：扫到的条目数（与含该小节的块数）低于下限 → 这一项已经恒真/整块失效
  if (blocksWithSection < MIN_TRACE_BLOCKS || itemChecked < MIN_TRACE_ITEMS) {
    fail(
      `示例「已查过没问题」只扫到 ${itemChecked} 条（${blocksWithSection} 个块），` +
        `低于下限 ${MIN_TRACE_ITEMS} 条 / ${MIN_TRACE_BLOCKS} 个块——` +
        '要么示例里这一段被改名或删掉了，要么这一项已经扫不到东西了。' +
        '小节被改名的话，第 4 项会同时报红（示例块里的段名不是规范段名）。',
    );
  } else {
    ok(
      `示例「已查过没问题」这一段的下限守卫有效（扫到 ${itemChecked} 条 / ${blocksWithSection} 个块，` +
        `下限 ${MIN_TRACE_ITEMS} 条 / ${MIN_TRACE_BLOCKS} 个块）`,
    );
  }
}

// ---------- 30. 结论行不能出现第 6 个计数 ----------
// 契约明写「不要为『需确认』新增一个计数」，但 lint 的计数正则此前是子串匹配，
// 结论行尾部挂上「、需确认 2」照样全绿。
//
// 判定也不能只认「行首是结论：」那种形态——快模式的结论行写成
// 「**改完再合** —— P0 0、P1 1、…」，压根不以「结论」开头，两档模式一快一慢就漏掉一档。
// 现在：**任何带 5 项计数的行**都受「不许有第 6 个计数」约束；
// 「计数之后不许有多余内容」这条更严的约束只对真正的结论行生效
//（行里出现结论档「可以合 / 改完再合 / 方向先定」）。
//
// 计数正则**同时接受数字与 n 占位**：契约里有三处**格式声明**
// （「P0 n、P1 n、P2 n、P3 n、待拍板 n」）——那是模型照抄的格式定义，
// 只认数字时那些行压根不进检查，把第 6 个计数挂上去也没人管。
{
  const bad = [];
  // 计数位：真实数字，或格式声明里的 n 占位
  const VAL = '(?:\\d+|n)';
  const COUNT_ANY_RE = new RegExp(
    `P0 ${VAL}、P1 ${VAL}、P2 ${VAL}、P3 ${VAL}、待拍板 ${VAL}`,
  );
  const files = [
    ['SKILL.md', read('SKILL.md')],
    ['references/output-template.md', read('references/output-template.md')],
    ['references/regression-review.md', read('references/regression-review.md')],
    ['README.md', read('README.md')],
  ];
  for (const [name, lines] of files) {
    for (const [i, l] of lines.entries()) {
      const m = l.match(COUNT_ANY_RE);
      if (!m) continue;
      const after = l.slice(m.index + m[0].length);
      // 第 6 个计数：紧跟在五项计数之后的那一段里挂着「、xxx N」
      // （N 可能是数字，也可能是格式声明里的 n 占位）
      const seg = after.split(/[。；]/)[0];
      if (/、\s*[^、，。；：）\s]{1,10}\s*(?:\d+|n)(?![0-9])/.test(seg)) {
        bad.push(
          `${name}:${i + 1} 五项计数之后还挂着第 6 个计数：「${seg.trim()}」——计数只有 P0–P3 与待拍板五项`,
        );
      }
      if (/需确认\s*(?:\d+|n)/.test(l)) bad.push(`${name}:${i + 1} 结论行出现了「需确认」计数`);
      // 「计数之后不许有多余内容」这条只对真正的结论行生效：
      // 判据 = 行首就是「结论：」或一个加粗的结论档（**改完再合** —— …）。
      // SKILL.md 里那些引用计数格式的正文（行首是「当…时」）不在此列。
      const isConclusionLine =
        /^\s*(?:[-*]\s*)?\**结论[：:]/.test(l) || /^\s*\**(可以合|改完再合|方向先定)\**\s*[—–-]/.test(l);
      if (!isConclusionLine) continue;
      const tail = after.trim();
      if (!/^[。.]?$/.test(tail)) {
        bad.push(`${name}:${i + 1} 结论计数之后还有多余内容「${tail}」——计数只有 P0–P3 与待拍板五项`);
      }
    }
  }
  if (bad.length) {
    fail(
      `结论行出现了声明之外的计数：\n    ${bad.join('\n    ')}\n` +
        '「需确认」是降级后的 P2，不是独立档位——给它单独计数，「P2 n」和「待拍板 n」的口径就稀释了。',
    );
  } else {
    ok('结论行只有 P0–P3 与待拍板五项计数，没有第 6 个档位（带计数的行都受约束）');
  }
}

// ---------- 31. 标签扫描必须覆盖 references/ 下所有文件 ----------
// 此前只扫 4 个文件，playbooks.md / dimensions.md / verification.md 里的标签无人看——
// 而它们是模型必读的文件，写错维度名照样会被当规范。
// 扫描清单**从磁盘推导**（第 24A-04）：手写名单会漏，新增文件整份内容逃过检查。
{
  const files = contractFiles();
  const ORIGIN = ['本次引入', '既有', '现状'];
  const LEVELS = ['P0', 'P1', 'P2', 'P3', '待拍板'];
  // 只有「级别开头」才算 finding 标签。此前任何相邻的 [X][Y] 都被当标签——
  // markdown 的引用式链接（[文字][fast-mode]）被说成「维度段 fast-mode 不合法」。
  // 级别写成 P4 这类错值仍要报出来，所以「像不像级别」按形态判，不按合法值判。
  // （判据在文件顶部的共享 looksLikeTag() 里，第 6 项与本项共用同一份。）
  const offenders = [];
  let count = 0;
  for (const f of files) {
    for (const l of read(f)) {
      const re = /\[([^\]\[]{1,12})\]\[([^\]]+)\](?:\[([^\]]+)\])?/g;
      let m;
      while ((m = re.exec(l)) !== null) {
        const [, level, dim, origin] = m;
        if (level === '级别' && dim === '维度') continue; // 占位符模板，不是真标签
        if (!looksLikeTag(level, dim, origin)) {
          // 不是标签，多半是 markdown 链接，不当标签——
          // 但「维度][引入方式]」这种漏了级别段的写法仍然要报出来
          if (CANONICAL_DIMENSIONS.includes(level) && ORIGIN.includes(dim)) {
            offenders.push(`${f}: 标签「${level}[${dim}]」漏了级别段（形态固定三段）`);
          }
          continue;
        }
        count += 1;
        if (!CANONICAL_DIMENSIONS.includes(dim)) {
          offenders.push(`${f}: 维度段「${dim}」不在规范维度名里（${level}[${dim}]）`);
        }
        if (!LEVELS.includes(level)) {
          offenders.push(`${f}: 级别段「${level}」不合法（应为 ${LEVELS.join(' / ')}）`);
        }
        if (origin === undefined) {
          offenders.push(`${f}: 标签「${level}[${dim}]」缺引入方式段（形态固定三段）`);
        } else if (!ORIGIN.includes(origin)) {
          offenders.push(`${f}: 第三段「${origin}」不是引入方式（应为 ${ORIGIN.join(' / ')}）`);
        }
      }
    }
  }
  if (offenders.length) {
    fail(`finding 标签形态不一致：\n    ${[...new Set(offenders)].join('\n    ')}`);
  } else {
    ok(`finding 标签形态一致（${files.length} 个文件里共 ${count} 处标签）`);
  }
}

// ---------- 32. 七段结构检查必须落在骨架块内 ----------
// 此前在整个 output-template.md 里找标题——示例块也有同名小节，
// 删掉骨架里的「## 必须修」，示例那一处替它兜底，检查照样全绿。
// 现在按**互斥特征**定位骨架（有覆盖表 + 有「## 必须修」+ 结论行是 n 占位），
// 并且要求恰好命中一块：命中 0 块或 >1 块都报红，不能默默取第一个。
{
  const tpl = read('references/output-template.md');
  const skeleton = pickBlock(tpl, 'skeleton');
  if (!skeleton) {
    fail(
      'output-template.md 的骨架块定位失败（应当恰好一块：有覆盖表 + 有「## 必须修」+ 结论行用 n 占位）——' +
        '七段结构无从校验。若骨架的结论行被填成了真实数字，它就会和示例块混成一类，请把骨架改回 n 占位。',
    );
  } else {
    const EXPECTED = SECTION_NAMES;
    const idx = [];
    for (const sec of EXPECTED) {
      const i = skeleton.split('\n').findIndex((l) => l.trim() === `## ${sec}`);
      idx.push(i);
    }
    const missing = EXPECTED.filter((_, i) => idx[i] === -1);
    if (missing.length) {
      fail(`output-template.md 的骨架块里缺少小节：${missing.join('、')}——模型照抄骨架就会少段`);
    } else {
      for (let i = 1; i < idx.length; i += 1) {
        if (idx[i] < idx[i - 1]) {
          fail(`output-template.md 的骨架块里「${EXPECTED[i]}」出现在「${EXPECTED[i - 1]}」之前——段序不对`);
          break;
        }
      }
      if (!missing.length && idx.every((v) => v !== -1)) ok('output-template.md 骨架块内的七段小节齐全且顺序正确');
    }
  }
}

// ---------- 33. 「无基线」范围行的字面量必须三处一致 ----------
// 契约的「可以合」在无基线时读作「本路径没有必须改的问题」，
// 而这条读法依赖范围行里的「（无基线，全量体检）」——三处字面量漂了没人管。
{
  const TOKEN = '（无基线，全量体检）';
  const files = [
    ['SKILL.md', read('SKILL.md')],
    ['README.md', read('README.md')],
    ['references/output-template.md', read('references/output-template.md')],
  ];
  const bad = [];
  for (const [name, lines] of files) {
    if (!lines.some((l) => l.includes(TOKEN))) bad.push(`${name}：找不到范围行字面量「${TOKEN}」`);
  }
  if (bad.length) {
    fail(
      `「无基线」范围行的字面量在三处副本里不一致：\n    ${bad.join('\n    ')}\n` +
        `三处必须都写着「${TOKEN}」——读者靠这几个字才知道「可以合」不是合并批准。`,
    );
  } else {
    ok(`「无基线」范围行字面量「${TOKEN}」在 SKILL.md / README.md / output-template.md 三处一致`);
  }
}

// ---------- 34. 两档模式表：两处必须对「做什么」说同一件事 ----------
// SKILL.md 与 README.md 各有一张两档模式表。此前 README 那张还写着
// 「反驳与规模扫描只在全量模式跑」，而 SKILL.md 已经改成「类型 playbook 必查项两档都跑」——
// 两份面向不同读者的表各说各的，读者按哪份理解，结论就相反。
// 这里不要求逐行相同（两表的行数与措辞粒度本来就不同），只对「做什么」这一行做**关键词集合**比对。
{
  const SKILL = read('SKILL.md');
  const README = read('README.md');
  const rowOf = (lines, marker) => lines.find((l) => /^\|\s*做什么\s*\|/.test(l));
  const a = rowOf(SKILL, 'SKILL.md');
  const b = rowOf(README, 'README.md');
  const bad = [];
  if (!a) bad.push('SKILL.md 里找不到两档模式表的「做什么」行');
  if (!b) bad.push('README.md 里找不到两档模式表的「做什么」行');
  if (a && b) {
    // 逐格比对：两表都是三列（表头 / 快模式 / 全量），取第 2、3 格
    const ca = a.split('|').map((c) => c.trim());
    const cb = b.split('|').map((c) => c.trim());
    // 关键 token：这些词决定「这一档跑什么」，缺一个就说明两表说法不同
    const TOKENS = [
      { t: '类型 playbook', why: '类型 playbook 必查项跑不跑' },
      { t: '七维', why: '七维跑不跑' },
      { t: '规模扫描', why: '规模扫描跑不跑' },
      { t: '反驳', why: '反驳跑不跑' },
      { t: '证伪', why: '证伪跑不跑' },
    ];
    for (let col = 1; col <= 2; col += 1) {
      for (const { t, why } of TOKENS) {
        const inA = (ca[col] ?? '').includes(t);
        const inB = (cb[col] ?? '').includes(t);
        if (inA !== inB) {
          bad.push(
            `「${why}」两表不一致：SKILL.md 的${col === 1 ? '快模式' : '全量模式'}格${inA ? '有' : '没有'}「${t}」，` +
              `README.md 的同一格${inB ? '有' : '没有'}`,
          );
        }
      }
    }
  }
  if (bad.length) {
    fail(
      `SKILL.md 与 README.md 的两档模式表对不上：\n    ${bad.join('\n    ')}\n` +
        '两张表面向不同读者，但说的必须是同一件事——否则按 README 理解的读者和按 SKILL.md 执行的模型会得出相反结论。',
    );
  } else {
    ok('SKILL.md 与 README.md 的两档模式表对「跑什么」说的一致');
  }
}

// ---------- 35. 待拍板条目的字段集必须与字段定义一致 ----------
// 契约把字段定义放在 SKILL.md 的七段结构里（路线 A / 路线 B 六字段），
// 但两档模式表与 output-template 的快模式说明曾写成「两条路」（五字段）。
// 字段集不统一，按字段解析报告的下游读不到「路线 A」。
{
  const EXPECTED = ['现状', '证据', '路线 A', '路线 B', '建议', '要你定'];
  const bad = [];
  const sources = [
    ['SKILL.md', read('SKILL.md')],
    ['references/output-template.md', read('references/output-template.md')],
    ['references/regression-review.md', read('references/regression-review.md')],
  ];
  for (const [name, lines] of sources) {
    // 判据：找「声明字段集」的行，而不是找「提到待拍板的行」。
    // 声明字段集的行有两个特征——含路线 token，且同句里出现 ≥3 个字段名。
    // 只按「同句含待拍板」来挑行会漏：regression-review.md 的字段集写在
    // 「撞见方向性取舍时……正文要给〈现状 / 证据 / 路线 A / 路线 B / 建议 / 要你定〉」，
    // 句中没有「待拍板」二字，旧判据因此误报「找不到表述」。
    // 「≥3 个字段名」把枚举行和「两条路径」这类普通叙述行分开——
    // 叙述行最多命中 1 个字段名（实测 README/output-template 的示例行均为 1）。
    const candidates = lines.filter(
      (l) =>
        (l.includes('路线 A') || l.includes('两条路')) &&
        EXPECTED.filter((f) => l.includes(f)).length >= 3,
    );
    if (!candidates.length) { bad.push(`${name}：找不到待拍板条目的字段集表述`); continue; }
    for (const hit of candidates) {
      for (const f of EXPECTED) {
        if (!hit.includes(f)) bad.push(`${name}：待拍板字段集缺少「${f}」`);
      }
    }
  }
  if (bad.length) {
    fail(
      `待拍板条目的字段集不统一：\n    ${bad.join('\n    ')}\n` +
        `规范字段集（以 SKILL.md 的字段定义为准）：${EXPECTED.join(' / ')}`,
    );
  } else {
    ok(`待拍板条目的字段集在三处一致（${EXPECTED.join(' / ')}）`);
  }
}

// ---------- 36. 快模式的固定栏位必须有字面量并在示例里出现 ----------
// 「意图：」「宣称：… ／ 实际：…」「未覆盖：」这三个栏位是固定形态的——
// 只描述内容不给字面量，模型每次的写法都不同，靠标签解析的下游就找不到它们。
{
  const TOKENS = ['意图：', '宣称：', '实际：', '未覆盖：'];
  const bad = [];
  for (const [name, rel] of [
    ['references/regression-review.md', 'references/regression-review.md'],
    ['references/output-template.md', 'references/output-template.md'],
  ]) {
    const lines = read(rel);
    for (const t of TOKENS) {
      if (!lines.some((l) => l.includes(t))) bad.push(`${name}：找不到「${t}」这个字面量`);
    }
  }
  // 快模式示例里必须真的出现这四个 token（示例是模型模仿的对象）
  const rr = read('references/regression-review.md');
  const sample = rr.filter((l) => l.startsWith('意图：') || l.startsWith('宣称：') || l.startsWith('未覆盖：'));
  for (const t of TOKENS) {
    if (!sample.some((l) => l.includes(t))) bad.push(`references/regression-review.md 的快模式示例里没有出现「${t}」`);
  }
  // 全量模式与零发现的示例里也必须有「宣称：… ／ 实际：…」这一行——
  // 契约要求两档都写，而模型模仿的是示例：示例里没有，模型就不会写，
  // 第 1 步的落差对照直接消失（补进去之后没人守，照样会漂回去）。
  // 要写「宣称／实际」这一行的形态清单来自 EXAMPLE_BLOCKS（唯一真相源）。
  // 块「在不在」交第 44 项管——这里只管块在时内容对不对，不重复报「缺一块」。
  for (const entry of EXAMPLE_BLOCKS.filter((e) => e.needClaim)) {
    const { rel, kind } = entry;
    const block = exampleBlock(rel, kind);
    if (!block) continue; // 块不在 → 第 44 项报红
    // 两种合法写法：有落差写「宣称：… ／ 实际：…」，没有落差写「宣称与实际一致」。
    // 只认前一种会把零发现示例（按契约写的是后者）误判成违规。
    const claimLine = block
      .split('\n')
      .find((l) => /^宣称[：与]/.test(l.trim()) && l.includes('实际'));
    if (!claimLine) {
      bad.push(
        `${rel}：${kind} 示例里没有「宣称：… ／ 实际：…」这一行` +
          '（没有落差时写「宣称与实际一致」也算）——两档都要写这一行',
      );
    }
  }
  if (bad.length) {
    fail(
      `快模式的固定栏位缺字面量或示例没示范：\n    ${bad.join('\n    ')}\n` +
        `固定栏位：${TOKENS.join(' / ')}——形态要固定，示例必须示范出来。`,
    );
  } else {
    ok('快模式的固定栏位（意图 / 宣称-实际 / 未覆盖）有字面量且示例示范了');
  }
}

// ---------- 37. playbook 的命中判据与多命中规则必须说清且说一致 ----------
// 「先认改动类型」这一步一旦没有判据，「跑该类型 playbook 的必查项」就没有确定范围：
// 只读一节就等于其余那几节覆盖的维度归零（安全只在「配置 / 部署 / 脚本」里被覆盖）。
// 所以：载体判据表要覆盖每一节 playbook，三处都要写明「命中几节跑几节、必查项取并集」。
{
  const bad = [];
  const pb = read('references/playbooks.md');
  // playbook 的小节（## 标题）
  const sections = pb.filter((l) => /^##\s/.test(l)).map((l) => l.replace(/^##\s+/, '').trim());
  // 载体判据表：表头是「类型 | 载体…」
  const carrierRows = [];
  let inTable = false;
  for (const l of pb) {
    if (/^\|\s*类型\s*\|/.test(l)) { inTable = true; continue; }
    if (!inTable) continue;
    if (!l.trim().startsWith('|')) break;
    if (/^\|\s*[-: ]+\|/.test(l)) continue;
    const cells = l.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length >= 2) carrierRows.push(cells);
  }
  if (!carrierRows.length) {
    bad.push('references/playbooks.md：找不到「命中怎么认」的载体判据表');
  } else {
    for (const sec of sections) {
      const row = carrierRows.find((r) => r[0] === sec);
      if (!row) {
        bad.push(`playbooks.md 的「${sec}」一节没有出现在载体判据表里——命中不了这一节，它的必查项就永远不会被跑`);
      } else if (!row[1]) {
        bad.push(`载体判据表里「${sec}」那一行没写载体`);
      }
    }
    for (const row of carrierRows) {
      if (!sections.includes(row[0])) bad.push(`载体判据表里有一行「${row[0]}」，但 playbooks.md 里没有这一节`);
    }
  }
  // 三处都要写明多命中规则
  const REQS = [
    ['references/playbooks.md', ['命中怎么认', '命中几节就跑几节', '必查项取并集', '一节都不命中才不跑']],
    ['SKILL.md', ['命中的那几节', '命中几节跑几节', '必查项取并集']],
    ['references/regression-review.md', ['命中几节跑几节', '必查项取并集', '一节都不命中就不跑']],
  ];
  for (const [rel, toks] of REQS) {
    const text = read(rel).join('\n');
    for (const t of toks) if (!text.includes(t)) bad.push(`${rel}：没有写明「${t}」`);
  }
  if (bad.length) {
    fail(
      `playbook 的命中判据或多命中规则没说清：\n    ${bad.join('\n    ')}\n` +
        '「命中」没有判据，「跑该类型 playbook 的必查项」就没有确定范围——漏跑一节，那一节覆盖的维度就归零。',
    );
  } else {
    ok(
      `playbook 的命中判据覆盖 ${sections.length} 节，且「命中几节跑几节、取并集」在 playbooks / SKILL.md / regression-review 三处一致`,
    );
  }
}

// ---------- 38. 「第 N 维的「X」」类指针必须能在 dimensions.md 里解析到 ----------
// 契约里说「读第 5、6 维的『不算』两节」时，模型是照着这句话去找的。
// 第 6 维根本没有叫「不算」的小节——指针落空，模型要么跳过（丢掉 tie-break 判据），
// 要么整节照读（违背「最小子集」的用意）。所以指针必须指向真实存在的小节或条目。
//
// 扫描清单**从磁盘推导**（第 24A-04）：新增一个 references/*.md，它里面的指针就无人看。
//
// 指针句式**不写死**（第 24A-05）：此前只认「第 N 维的「X」」一种连接词，
// 改成语义等价的「第 N 维中的「X」」就再也扫不到任何指针——而这一项没有「必须扫到 N 处」
// 的下限守卫，于是检查整块失效、CI 照样全绿（第 24 轮 24A 的 R24A-05）。
// 现在：
//   ① 连接词放宽成一份固定集合（的 / 中的 / 里的 / 内的 / 中 / 里 / 内）；
//   ② 另加一道**句式无关**的对账：凡「第 N 维」与紧随其后的「」之间只有连接词的，
//      都算候选指针，必须被上面的正则捕获——否则报红并说清「正则没认出这个句式」。
{
  const dim = read('references/dimensions.md');
  const sections = [];
  let cur = null;
  for (const l of dim) {
    const m = l.match(/^##\s+(.*)$/);
    if (m) { cur = { title: m[1].trim(), body: [] }; sections.push(cur); continue; }
    if (cur) cur.body.push(l);
  }
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const resolves = (body, anchor) =>
    body.some(
      (l) =>
        l.includes(`**${anchor}`) ||
        new RegExp(`^[-*]\\s*${esc(anchor)}\\s*[：:]`).test(l) ||
        new RegExp(`^${esc(anchor)}\\s*[：:]`).test(l),
    );
  // 指针也可能指向 dimensions.md 里的**独立小节**（例如「规模与复杂度」不在任何一维内部）。
  // 只在第 N 维体内找锚点时，这种指针会被误报成落空——反过来把它改写成受检句式
  // 「第 N 维的「规模与复杂度」」同样报红，而那一节确实存在。
  const resolvesSection = (anchor) => sections.some((s) => s.title.startsWith(anchor));
  const bad = [];
  // 扫描清单：从磁盘推导（SKILL.md + README.md + references/ 下全部 .md）
  const sources = contractFiles().map((rel) => [rel, read(rel)]);
  // 连接词集合（唯一一份）：语义等价的改写不该让检查整块失效
  const CONNECT = '(?:的|中的|里的|内的|中|里|内)';
  const DIRECT_RE = new RegExp(`第\\s*([1-7])\\s*维${CONNECT}\\s*「([^」]+)」`, 'g');
  const PAR_RE = new RegExp(
    `第\\s*[1-7]\\s*维${CONNECT}「[^」]+」\\s*(?:与|和|、|,|，)\\s*「([^」]+)」`,
    'g',
  );
  // 句式无关的候选指针：提到「第 N 维」之后、紧跟的「」之前**只有连接词**。
  // 连接词只收「的」这一族（的 / 中 / 里 / 内 / 之）——
  // 它们把引号里的东西**绑定到某一维**（就是指针）。
  // 「与 / 和 / 或」是并列连接词：引号里的东西可能是**并列的另一个对象**而不是指针
  // （例如「第 7 维与「把公开 API 当死代码」这条误判共用这一份」——
  //  引号里是一条误判的名字，不是第 7 维里的小节），所以不收。
  const GAP_RE = /^[的中里内之]+$/;
  let checked = 0;
  let candidates = 0;
  for (const [name, lines] of sources) {
    for (const [i, l] of lines.entries()) {
      const re = new RegExp(DIRECT_RE.source, 'g');
      let m;
      while ((m = re.exec(l)) !== null) {
        checked += 1;
        const n = m[1];
        const anchor = m[2];
        const sec = sections.find((s) => s.title.startsWith(`${n}.`));
        if (!sec) {
          bad.push(`${name}:${i + 1} 指向「第 ${n} 维」，但 dimensions.md 里没有第 ${n} 维`);
          continue;
        }
        if (!resolves(sec.body, anchor) && !resolvesSection(anchor)) {
          bad.push(
            `${name}:${i + 1} 指向「第 ${n} 维的「${anchor}」」，但 dimensions.md 第 ${n} 维里找不到「${anchor}」这一节或这一条`,
          );
        }
      }
      // 并列指针：「第 N 维的「A」与「B」」里的 B 指向的是独立小节，不在第 N 维内部。
      // 此前这个形状压根不进检查（只认「第 N 维的「X」」一种句式），落空无人报。
      const par = new RegExp(PAR_RE.source, 'g');
      let pm;
      while ((pm = par.exec(l)) !== null) {
        checked += 1;
        const anchor = pm[1];
        const found =
          resolvesSection(anchor) ||
          sections.some((s) => s.body.some((x) => x.includes(`**${anchor}`)));
        if (!found) {
          bad.push(
            `${name}:${i + 1} 并列指针「${anchor}」在 dimensions.md 里找不到对应的小节或条目`,
          );
        }
      }
      // ---- 对账：句式无关地找一遍候选指针，正则没认出来的必须报出来 ----
      const mention = /第\s*[1-7]\s*维/g;
      let mm;
      while ((mm = mention.exec(l)) !== null) {
        const after = l.slice(mm.index + mm[0].length);
        const q = after.indexOf('「');
        if (q === -1) continue;
        const gap = after.slice(0, q);
        if (!GAP_RE.test(gap)) continue;
        candidates += 1;
        const tail = l.slice(mm.index);
        // 覆盖判定必须**锚在这一处**上（`^`）——
        // 否则同一行后面还有别的合法指针时，这一处会被误判成「已覆盖」。
        const covered =
          new RegExp(`^第\\s*[1-7]\\s*维${CONNECT}\\s*「[^」]+」`).test(tail) ||
          new RegExp(`^第\\s*[1-7]\\s*维${CONNECT}「[^」]+」\\s*(?:与|和|、|,|，)\\s*「`).test(tail);
        if (!covered) {
          bad.push(
            `${name}:${i + 1} 有一处「第 N 维${gap}「…」」的指针，但第 38 项的正则没认出这个句式——`
              + '这一项会静默漏掉它，请把新的连接词加进正则（CONNECT）',
          );
        }
      }
    }
  }
  // 下限守卫：一句指针都没扫到，说明检查已经恒真（比检查失效更糟）
  if (checked === 0) {
    fail(
      '第 38 项一句维度指针都没扫到——检查已经恒真（正文里的「第 N 维…「…」」全都不认了）',
    );
  }
  if (bad.length) {
    fail(
      `维度指针落空：\n    ${bad.join('\n    ')}\n` +
        '契约里写「读第 N 维的『X』」时，模型是照这句话去找的——指针落空，判据就被跳过了。',
    );
  } else {
    ok(
      `第 N 维的指针都能在 dimensions.md 里解析到（检查了 ${checked} 处指针，` +
        `句式无关地对账了 ${candidates} 处候选）`,
    );
  }
}

// ---------- 39. playbook 不得声明覆盖七维或规模扫描 ----------
// playbooks.md 明写「规模扫描不被任何 playbook 覆盖」、各维也写着「本维不被任何 playbook 覆盖」。
// 但第 15 / 18 / 21 项只查「声明的维度有没有对应条目」，**没人禁止声明它们**——
// 一旦某份 playbook 声明覆盖「方法契约」或「规模与复杂度」，
// 按「扫完 playbook 即视为已覆盖，不再重复扫」，整维会被跳过，而七维是本 skill 的主菜。
{
  const SEVEN = ['设计', '方法契约', '实现', '文档', '硬编码', '重复', '过度设计'];
  const FORBIDDEN = new Set([...SEVEN, '规模与复杂度']);
  const sections = parsePlaybookSections(read('references/playbooks.md'));
  const bad = [];
  for (const s of sections) {
    for (const d of s.declared) {
      if (FORBIDDEN.has(d)) {
        bad.push(
          `${s.name}：覆盖声明里写了「${d}」——七维与规模扫描都不被任何 playbook 覆盖，` +
            '声明了就等于整维被跳过，覆盖表会替没查过的维度背书',
        );
      }
    }
  }
  if (bad.length) {
    fail(`playbook 声明覆盖了不许覆盖的维度：\n    ${bad.join('\n    ')}`);
  } else {
    ok(`playbook 都没有声明覆盖七维或规模扫描（检查了 ${sections.length} 份 playbook）`);
  }
}

// ---------- 40. 引入方式段必须与段落、与模式相容 ----------
// 契约写死两条：①「[既有]」不进「必须修」的 P0/P1（基线之前就存在的问题不能挡合并）；
// ②「快模式必有基线，所以快模式不出现 [现状]」。
// 此前只校验第三段属于 {本次引入, 既有, 现状} 这个集合，不看它落在哪一段、哪种模式里。
{
  const bad = [];
  // ① [既有] 不得出现在「必须修」段
  for (const rel of ['README.md', 'references/output-template.md']) {
    for (const b of fencedBlocks(read(rel)).filter(BLOCK_KINDS.full)) {
      const start = b.indexOf('## 必须修');
      if (start === -1) continue;
      const rest = b.slice(start + '## 必须修'.length);
      const next = rest.search(/^##\s/m);
      const body = next === -1 ? rest : rest.slice(0, next);
      for (const m of body.matchAll(/^###\s+\[(P0|P1)\]\[[^\]]+\]\[([^\]]+)\]/gm)) {
        if (m[2] === '既有') {
          bad.push(`${rel}：「必须修」段里有一条 [${m[1]}][…][既有]——既有问题不进「必须修」的 P0/P1`);
        }
      }
    }
  }
  // ② 快模式示例里不得出现 [现状]
  for (const rel of ['references/regression-review.md', 'references/output-template.md']) {
    for (const b of fencedBlocks(read(rel)).filter(BLOCK_KINDS.fastish)) {
      if (b.includes('[现状]')) {
        bad.push(`${rel}：快模式示例里出现了「[现状]」——快模式必有基线，引入方式段只用「本次引入」或「既有」`);
      }
    }
  }
  if (bad.length) {
    fail(`引入方式段与段落/模式不匹配：\n    ${bad.join('\n    ')}`);
  } else {
    ok('引入方式段与段落、模式相容（[既有] 不进「必须修」；快模式不出现 [现状]）');
  }
}

// ---------- 41. SKILL.md 的维度名清单必须与覆盖表行名一致 ----------
// SKILL.md 写着「维度段以覆盖表行名为准（覆盖表 15 行，一行一个）：……」——
// 覆盖表是权威，那一行是它的副本。此前副本与覆盖表、CANONICAL_DIMENSIONS 三份互不校验，
// 改一处维度名，另外两处静默失配而 CI 全绿。
{
  const skill = read('SKILL.md');
  const line = skill.find((l) => l.includes('以覆盖表行名为准'));
  const bad = [];
  if (!line) {
    bad.push('SKILL.md 里找不到「以覆盖表行名为准」那一行——维度段合法取值的出处没了');
  } else {
    const m = line.match(/一行一个）：\s*([^—]+)—/);
    if (!m) {
      bad.push('SKILL.md 的维度名清单解析不出来（应当是「覆盖表 15 行，一行一个）：<名称 / 名称 / …>——…」的形状）');
    } else {
      const got = m[1].split('/').map((s) => s.trim()).filter(Boolean);
      if (got.join('|') !== CANONICAL_DIMENSIONS.join('|')) {
        bad.push(
          `SKILL.md 的维度名清单与覆盖表行名不一致：\n    实际：[${got.join(', ')}]\n` +
            `    规范：[${CANONICAL_DIMENSIONS.join(', ')}]`,
        );
      }
    }
  }
  if (bad.length) {
    fail(`SKILL.md 的维度名清单与覆盖表对不上：\n    ${bad.join('\n    ')}`);
  } else {
    ok(`SKILL.md 的维度名清单与覆盖表行名逐项一致（${CANONICAL_DIMENSIONS.length} 个）`);
  }
}

// ---------- 42. 快模式示例必须有范围与基线，有条目时必须写各级数量 ----------
// 「一个没有作用域的『能不能合』是最容易被误用的结论」——范围与基线是快模式的头两行。
// 此前没有任何检查看这两行：把「相对 `main`（merge-base `a1b2c3d`）」删掉、把五项计数换成
// 「见下」，CI 照样全绿。识别快模式示例**不能靠五项计数**——快模式零发现示例本来就不写计数。
{
  const bad = [];
  let checked = 0;
  for (const rel of ['references/regression-review.md', 'references/output-template.md']) {
    for (const b of fencedBlocks(read(rel)).filter(BLOCK_KINDS.fastish)) {
      checked += 1;
      const lines = b.split('\n');
      const scopeLine = lines.find((l) => l.trim().startsWith('范围：'));
      if (!scopeLine) {
        bad.push(`${rel}：快模式示例没有「范围：」那一行——一个没有作用域的结论最容易被误用`);
        continue;
      }
      if (!scopeLine.includes('相对') && !scopeLine.includes('merge-base')) {
        bad.push(`${rel}：快模式示例的范围行没写基线（既没有「相对 X」也没有「merge-base xxx」）`);
      }
      const hasFinding = /^\s*[-*]\s+\[(?:P0|P1|P2|P3|待拍板)\]/m.test(b);
      if (hasFinding && !COUNT5_RE.test(b)) {
        bad.push(`${rel}：快模式示例有 finding 条目却没写各级数量（结论行写各级数量这条两档通用）`);
      }
      if (!hasFinding && COUNT5_RE.test(b)) {
        bad.push(`${rel}：快模式零发现示例不该写各级数量（零发现时不写数量）`);
      }
    }
  }
  if (bad.length) {
    fail(`快模式示例缺范围、基线或各级数量：\n    ${bad.join('\n    ')}`);
  } else {
    ok(`快模式示例都有范围 + 基线，且数量与是否有条目相符（检查了 ${checked} 个快模式示例块）`);
  }
}

// ---------- 43. 「本次审查要读哪些文件」表必须列全 references ----------
// 运行时读哪些文件，全看 SKILL.md 开头这张表。lint-skill 的孤儿检查只要求文件在 SKILL.md
// **任意位置**被提过（散文里提一句也算），所以把表格里那一行删掉，闸门表就静默不可达了。
{
  const skill = read('SKILL.md');
  const rows = section(skill, /^##\s*本次审查要读哪些文件/).filter(
    (l) => /^\|/.test(l) && !/^\|\s*[-: ]+\|/.test(l) && !/^\|\s*文件\s*\|/.test(l),
  );
  const listed = new Set();
  for (const r of rows) {
    const m = r.match(/^\|\s*`([^`]+)`/);
    if (m) listed.add(m[1]);
  }
  // references 目录可能整个不存在——此前 readdirSync 直接抛 ENOENT，
  // 进程在栈里中断：退出码仍是 1（CI 不会误绿），但前面积累的几十条契约缺失一条都没汇总，
  // 读者只看到一坨 Node 栈。缺目录要说成「缺目录」，不是让调用方读栈。
  const refDir = join(dir, 'references');
  const refDirMissing = !existsSync(refDir);
  const onDisk = refDirMissing
    ? []
    : readdirSync(refDir).filter((f) => f.endsWith('.md')).sort();
  const expected = ['SKILL.md', ...onDisk.map((f) => `references/${f}`)];
  const missing = expected.filter((f) => !listed.has(f));
  const bad = [];
  if (refDirMissing) bad.push('仓库里没有 references 目录');
  if (!rows.length) {
    bad.push('SKILL.md 里找不到「本次审查要读哪些文件」这张表');
  } else if (missing.length) {
    bad.push(`读文件表里少了：${missing.join('、')}`);
  }
  if (bad.length) {
    fail(
      `「本次审查要读哪些文件」表不完整：\n    ${bad.join('\n    ')}\n` +
        '这张表决定运行时读哪些文件——表里没有的文件在运行时不可达（闸门表被摘掉，证伪环节就静默消失了）。',
    );
  } else {
    ok(`「本次审查要读哪些文件」表列全了 ${expected.length} 个文件（SKILL.md + ${onDisk.length} 个 references）`);
  }
}

// ---------- 44. 契约里的示例块必须齐全：少一块，模型就少一种形态可照抄 ----------
// 此前只有 full / zero 两类被要求「恰好 1 块」，**快模式示例整块删掉，CI 照样全绿**——
// 而快模式正是模型最常照抄的那份。示例没了，模型就退回自己编的形态。
// 清单来自 EXAMPLE_BLOCKS（唯一真相源），第 36 项的「宣称行」也从同一张表派生。
{
  const bad = [];
  for (const entry of EXAMPLE_BLOCKS) {
    const blocks = fencedBlocks(read(entry.rel));
    const got =
      entry.kind === 'fastishZero'
        ? blocks.filter((b) => BLOCK_KINDS.fastish(b) && !BLOCK_KINDS.fast(b)).length
        : blocks.filter(BLOCK_KINDS[entry.kind]).length;
    if (got !== entry.want) {
      bad.push(`${entry.rel}：${entry.kind} 示例块应有 ${entry.want} 个，实际 ${got} 个`);
    }
  }
  if (bad.length) {
    fail(
      `契约里的示例块不齐全：\n    ${bad.join('\n    ')}\n` +
        '示例是模型模仿的对象——少一块，模型就少一种形态可照抄，而 CI 照样全绿。',
    );
  } else {
    ok(
      `契约里的示例块齐全（${EXAMPLE_BLOCKS.length} 个 (文件, 形态) 组合，各恰好 1 块：` +
        '骨架 / 零发现 / 全量 / 快模式 / 快模式零发现）',
    );
  }
}

// ---------- 45. README 里的示例覆盖表也要进校验 ----------
// SKILL.md 明说「这张速查表在 README.md 里也有一份」，而 README 是读者的第一入口。
// 此前覆盖表只从 references/output-template.md 收集：README 那张表的行名、结果格、
// 「查了什么」列一个都不查——把「错误路径与部分失败」改成「错误路径」，CI 全绿。
//
// 这一项**不并进第 2/3 项的表集合**：并进去会改变「第 N 张覆盖表」的编号，
// 反向验证脚本按编号与文案定位，会跟着一起漂。两项分开查，各自独立可测。
{
  const bad = [];
  const blocks = fencedBlocks(read('README.md')).filter(BLOCK_KINDS.full);
  if (blocks.length !== 1) {
    bad.push(`README.md 的全量示例块应恰好 1 个，实际 ${blocks.length} 个`);
  } else {
    const tables = coverageTables(blocks[0].split('\n'));
    if (!tables.length) {
      bad.push('README.md 的示例里找不到维度覆盖表');
    } else {
      const rows = tables[0];
      const real = rows.filter((l) => !isOmissionRow(l));
      const omitted = rows.filter((l) => isOmissionRow(l));
      const names = real.map((l) => l.split('|')[1].trim());
      for (const n of names) {
        if (!CANONICAL_DIMENSIONS.includes(n)) {
          bad.push(`README 示例覆盖表的行名「${n}」不是规范维度名`);
        }
      }
      if (names.length === CANONICAL_DIMENSIONS.length) {
        if (names.join('|') !== CANONICAL_DIMENSIONS.join('|')) {
          bad.push(
            `README 示例覆盖表的行序与规范顺序不一致：\n    实际：${names.join(' | ')}\n` +
              `    规范：${CANONICAL_DIMENSIONS.join(' | ')}`,
          );
        }
      } else if (!omitted.length) {
        bad.push(
          `README 示例覆盖表只有 ${names.length} 行且没有省略标记——` +
            '它要么 15 行齐全，要么用「...」标出省略的行；半张表没有标记，模型会照抄成半张',
        );
      }
      // README 的示例覆盖表是 output-template 那张表的**逐行子集**——
      // 两边是「同一个场景」的两份副本（示例计数与 finding 落点早已两边对过账），
      // 所以同一行的结果格与「查了什么」必须逐字相同：只改一边，两个副本就对不上了，
      // 而读者看到的是哪一份，取决于他从哪个入口进来。
      const tplFull = fencedBlocks(read('references/output-template.md')).filter(BLOCK_KINDS.full);
      if (tplFull.length === 1) {
        const tplTables = coverageTables(tplFull[0].split('\n'));
        const tplRows = new Set((tplTables[0] ?? []).map((l) => l.replace(/\s+/g, ' ').trim()));
        for (const l of real) {
          const key = l.replace(/\s+/g, ' ').trim();
          if (!tplRows.has(key)) {
            bad.push(`README 示例覆盖表的这一行在 output-template 的示例表里没有逐字对应：${key}`);
          }
        }
      }
      for (const l of real) {
        const cells = l.split('|').map((c) => c.trim());
        const dim = cells[1];
        const result = cells[2] ?? '';
        const what = cells[3] ?? '';
        if (result && !resultRe.test(result)) {
          bad.push(
            `README 示例覆盖表「${dim}」行的结果格取值「${result}」不在允许集合内` +
              `（允许：${CANONICAL_RESULTS.join(' / ')}）`,
          );
        }
        if (!what) {
          bad.push(`README 示例覆盖表「${dim}」行的「查了什么」列是空的`);
        } else if (FORBIDDEN_WHAT.includes(what) || what === dim) {
          bad.push(`README 示例覆盖表「${dim}」行的「查了什么」写的是模板句「${what}」`);
        }
      }
    }
  }
  if (bad.length) {
    fail(
      `README 的示例覆盖表没进校验：\n    ${bad.join('\n    ')}\n` +
        'README 是读者的第一入口，SKILL.md 明说这张速查表在 README 里也有一份——' +
        '它写错行名、结果格取值不合法、「查了什么」列空着或写模板句，读者与模型都会被带偏。',
    );
  } else {
    ok('README 的示例覆盖表行名、结果格与「查了什么」列都合规');
  }
}

// ---------- 46–55. evals/ 护栏自身的自洽 ----------
// 为什么单独加这一段：第 22 轮 22C 自审在 evals/ 里挖出 14 条内部矛盾——
// 「满分 25」与「有效分母是 23」并存、证据级别标题写 1–5 而表里有第 6 级、
// 归类的分母在 rubric 与 baseline 里是两套、GT 引用的 baseline 节名根本不存在、
// 样本规模在三处写成 150 / 约 200 / 约 370。
// 前面 45 项检查**一行都不读 evals/**，这类矛盾在 lint 全绿时照样存在。
// 人记不住，所以在这里机器化。
{
  const rubricLines = read('evals/rubric.md');
  const rubric = rubricLines.join('\n');
  const gtTiny = read('evals/ground-truth.md').join('\n');
  const gtRule = read('evals/ground-truth-rule-engine.md').join('\n');
  const base = read('evals/baseline.md').join('\n');
  const runbook = read('evals/runbook.md').join('\n');
  const evalsReadme = read('evals/README.md').join('\n');
  // 扫描清单：**从磁盘推导**（evals/ 下的全部 .md + 根 README.md）。
  // 手写名单会漏——evals/README.md、evals/runbook.md、evals/rubric.md 这几个文件
  // 此前都不在「满分 25」守卫的范围里，而它们同样会写这个数。
  const evalsScanFiles = [
    ...(existsSync(join(dir, 'evals'))
      ? readdirSync(join(dir, 'evals'))
          .filter((f) => f.endsWith('.md'))
          .sort()
          .map((f) => `evals/${f}`)
      : []),
    'README.md',
  ];
  // 证据阶梯的级别集合（**唯一真相源**）：第 47 项的表行检查与区间对账都用它
  const EVIDENCE_LEVELS = [1, 2, 3, 4, 5, 6];

  // ---------- 46. 命中/归类的分母表述不得互斥 ----------
  {
    let bad = 0;
    // 归一化：**折全角数字 + 折叠空白**。
    // 禁止形态与必需形态必须走同一套口径——此前禁止形态容忍空格与全角，
    // 必需形态却要求逐字「有效满分 23」：写成「有效满分23」就报红，
    // 语义一个字没变，CI 照样红（第 24 轮 24A 的 R24A-09）。
    const foldDigits = (s) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    const norm = (s) => foldDigits(s).replace(/\s+/g, ' ');
    const tight = (s) => foldDigits(s).replace(/\s+/g, '');
    for (const rel of evalsScanFiles) {
      const text = read(rel).join('\n');
      // 模式要**容忍空格与全角**：字面量「满分 25」写成「满分25」或「满分 ２５」
      // 就从守卫底下钻过去了。折全角数字 → 再容忍各种空格。
      const n = norm(text);
      if (/满分\s*[:：=]?\s*2\s*5/.test(n)) {
        fail(`${rel} 出现「满分 25」——命中/归类的有效满分是 23（G9 / G25 与 G3 同根因），名义 25 只是条目数`);
        bad += 1;
      }
    }
    if (!tight(rubric).includes('有效满分23')) {
      fail('evals/rubric.md 没有写明「有效满分 23」');
      bad += 1;
    }
    if (bad === 0) {
      ok(`命中/归类的分母表述一致（无「满分 25」，rubric 写明有效满分 23；扫了 ${evalsScanFiles.length} 个文件）`);
    }
  }

  // ---------- 47. 证据级别区间在 rubric 各处必须一致 ----------
  {
    const five = (rubric.match(/1[–-]5/g) ?? []).length;
    const six = (rubric.match(/1[–-]6/g) ?? []).length;
    let bad = 0;
    if (five > 0) {
      fail(`evals/rubric.md 仍有 ${five} 处「1–5」——证据强度有 6 级（只有 D 轮可达），区间写法必须统一成 1–6`);
      bad += 1;
    }
    if (six < 3) {
      fail(`evals/rubric.md 只有 ${six} 处「1–6」——证据级别区间在标题、正文、读分提醒三处都要写`);
      bad += 1;
    }
    // 阶梯表本身也要查：此前只数「1–6」这个字符串出现几次——
    // 把阶梯表的第 1 级那两行删掉，字符串还在，全绿，而阶梯只剩 2–6 五级，
    // 与正文「1–6 级」矛盾（「无基线轮次拿不到第 1 级」也成了空话）。
    const ladder = [];
    let cur = null;
    for (const l of rubricLines) {
      if (/^\|\s*(级别|级)\s*\|/.test(l)) { cur = []; ladder.push(cur); continue; }
      if (cur) {
        if (/^\|\s*-{2,}/.test(l)) continue;
        if (!/^\|/.test(l)) { cur = null; continue; }
        cur.push(l);
      }
    }
    if (!ladder.length) {
      fail('evals/rubric.md 里找不到证据阶梯表（表头形如「| 级别 | 描述 |」）——级别集合无从校验');
      bad += 1;
    }
    for (const [i, t] of ladder.entries()) {
      const levels = t.map((l) => Number(l.split('|')[1].trim()));
      const set = new Set(levels);
      if (t.length !== EVIDENCE_LEVELS.length || !EVIDENCE_LEVELS.every((v) => set.has(v))) {
        fail(
          `evals/rubric.md 第 ${i + 1} 张证据阶梯表是 [${levels.join(' / ')}]——` +
            `应恰好 ${EVIDENCE_LEVELS.length} 级（${EVIDENCE_LEVELS.join('、')} 各一行）`,
        );
        bad += 1;
      }
    }
    // 区间字符串与表行数交叉对账：阶梯有 6 级，文档里就不许写「1–5」
    const ladderSize = ladder.length ? ladder[0].length : EVIDENCE_LEVELS.length;
    for (const m of rubric.matchAll(/1\s*[–-]\s*(\d+)/g)) {
      if (Number(m[1]) !== ladderSize) {
        fail(
          `evals/rubric.md 里的区间「${m[0]}」与证据阶梯表的行数（${ladderSize} 级）对不上——` +
            '区间与表必须说同一件事',
        );
        bad += 1;
      }
    }
    if (bad === 0) {
      ok(
        `证据强度级别区间在 rubric 各处一致（1–6，${six} 处；` +
          `阶梯表 ${ladder.length} 张，每张 ${EVIDENCE_LEVELS.length} 级）`,
      );
    }
  }

  // ---------- 48. 误报口径：正文与细则三必须逐行对应，且写明不叠加 ----------
  //
  // 此前只查 `细则三.includes('口味问题')`——而「口味问题」这四个字在细则三的**补充句**里
  // 也出现，于是把细则三的那一整行删掉，lint 照样全绿（第 23 轮 23C 的 R23C-09）。
  // 现在改成**逐行对应**：正文 §2 的每一行，细则三 里必须找得到对应行。
  //
  // 对应关系按**关键片段集合**判定（第 24A-06），不再按「中文去重后的字符覆盖率」：
  // 覆盖率 ≥ 0.8 太松——把细则三的「口味问题」改写成「命名问题」，
  // 16 个不同的字里还留着 14 个（0.875 ≥ 0.8），口径已经分叉
  // （细则三把范围从 命名/分包/格式 缩到 命名）照样报绿。
  // 关键片段 = ①括号里的枚举项（逐项相等）②类别名（相等）。
  // 覆盖率只留作诊断信息（最接近的一行是哪一行）。
  {
    let bad = 0;
    // 只看正文的误报表（### 2. 误报 那一节），不扫全文——判定表里也会提到「不该报」
    const body = section(rubricLines, /^### 2\. 误报/);
    if (body.length === 0) {
      fail('evals/rubric.md 找不到「### 2. 误报（precision）」正文节');
      bad += 1;
    }
    for (const l of body) {
      if (/^\|/.test(l) && l.includes('不该报') && !l.includes('修复项')) {
        fail(`evals/rubric.md 正文误报表里提到「不该报」的那行没写「修复项」：${l.trim()}`);
        bad += 1;
      }
    }
    const detail = section(rubricLines, /^## 三、误报/);
    if (detail.length === 0) {
      fail('evals/rubric.md 找不到「## 三、误报」细则节');
      bad += 1;
    } else {
      const d = detail.join('\n');
      if (!d.includes('不叠加')) {
        fail('evals/rubric.md 细则三没写「不叠加」——同一条候选可能被重复扣分');
        bad += 1;
      }
      // ---- 逐行对应：正文每一行都要在细则三里找到对应行 ----
      const rowsOf = (ls) => ls
        .filter((l) => /^\s*\|/.test(l))
        .map((l) => l.split('|').slice(1, -1).map((x) => x.trim()))
        .filter((c) => c.length >= 2 && c[0] && !/^:?-{2,}$/.test(c[0]) && !/^(项|情形|场景)$/.test(c[0]));
      const cjkSet = (s) => new Set((s.match(/[\u4e00-\u9fff]/g) || []));
      /**
       * 一行的**关键片段**：
       *   enums —— 最后一个括号组里的枚举项（逐项比较）；
       *   label —— 类别名（括号之前、最后一个冒号之后的那一段）。
       * 两处措辞可以不同（「命名、分包、格式」vs「命名 / 分包 / 格式」），
       * 但类别名与枚举项必须一致——否则就是口径分叉。
       */
      const rowKey = (row) => {
        const text = row.replace(/\*\*/g, '').replace(/`/g, '').trim();
        const groups = [...text.matchAll(/[（(]([^）)]*)[）)]/g)];
        const last = groups.length ? groups[groups.length - 1] : null;
        const head = last ? text.slice(0, last.index) : text;
        const enums = last
          ? last[1].split(/[、\/]/).map((s) => s.replace(/\s+/g, '')).filter(Boolean)
          : [];
        const colon = Math.max(head.lastIndexOf('：'), head.lastIndexOf(':'));
        const label = (colon === -1 ? head : head.slice(colon + 1)).replace(/\s+/g, '');
        return { label, enums: [...new Set(enums)].sort() };
      };
      const sameEnums = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
      const bodyRows = rowsOf(body);
      const detailRows = rowsOf(detail);
      if (bodyRows.length < 3) {
        fail(`evals/rubric.md 正文误报表只认出 ${bodyRows.length} 行——第 48 项检查已经近乎恒真，表头解析要跟着正文一起维护`);
        bad += 1;
      }
      for (const row of bodyRows) {
        const want = cjkSet(row[0]);
        const key = rowKey(row[0]);
        // 诊断用：字符覆盖率最高的那一行
        let best = 0;
        let bestRow = '';
        for (const cand of detailRows) {
          const have = cjkSet(cand[0]);
          let inter = 0;
          for (const ch of want) if (have.has(ch)) inter += 1;
          const cover = want.size === 0 ? 0 : inter / want.size;
          if (cover > best) { best = cover; bestRow = cand[0]; }
        }
        // 真正的判据：类别名与枚举项必须逐项一致
        const hit = detailRows.find((cand) => {
          const k = rowKey(cand[0]);
          return k.label === key.label && sameEnums(k.enums, key.enums);
        });
        if (!hit) {
          fail(
            `evals/rubric.md 细则三没有与正文这条对应的行：「${row[0]}」——`
            + `正文与细则三的扣分口径会分叉（类别名与括号里的枚举项必须逐项一致；`
            + `最接近的一行是「${bestRow}」，字符只覆盖 ${(best * 100).toFixed(0)}%）`,
          );
          bad += 1;
        }
      }
    }
    if (bad === 0) ok('误报口径：正文与细则三逐行对应（类别名与枚举项逐项一致），且写明同一条候选不叠加扣分');
  }

  // ---------- 49. 归类分母的主口径在 rubric 与 baseline 一致 ----------
  {
    let bad = 0;
    if (base.includes('归类的分母是**报告实际交付')) {
      fail('evals/baseline.md 把「已报条目数」当成了归类的主分母——rubric 的主分母是 N 条 GT，已报条目只是辅助值');
      bad += 1;
    }
    if (!base.includes('有效分母 23')) {
      fail('evals/baseline.md 没有写「有效分母 23」');
      bad += 1;
    }
    if (!base.includes('辅助值')) {
      fail('evals/baseline.md 没有标明哪个数字是辅助值');
      bad += 1;
    }
    if (!rubric.includes('分母：N 条 GT')) {
      fail('evals/rubric.md 的记录格式里没有「分母：N 条 GT」');
      bad += 1;
    }
    if (bad === 0) ok('归类分母：rubric 与 baseline 都以 N 条 GT 为主分母，已报条目标为辅助值');
  }

  // ---------- 50. GT 引用的 baseline 节名必须真实存在 ----------
  //
  // 此前只扫 rule-engine 那一份 GT，且用「整文件包含子串」判断节名存在——
  // 把节标题改写成别的说法、那几个字还留在正文里，就照样全绿；
  // tiny-shop 那份 GT 里的引用根本没被扫（第 23 轮 23C 的 R23C-10）。
  // 现在：**两份 GT 都扫**（文件清单从磁盘推导），**节名存在性按标题行判定**。
  {
    // 只抓「紧跟在 baseline 引用之后」的引号名——同一行里别的引号不是节名引用
    const refRe = /`?\s*baseline(?:\.md)?`?\s*的?\s*[「"]([^「」"]{2,40})[」"]/g;
    let bad = 0;
    const evalsDir = join(dir, 'evals');
    const gtFiles = existsSync(evalsDir)
      ? readdirSync(evalsDir, { withFileTypes: true })
          .filter((e) => e.isFile() && /^ground-truth.*\.md$/.test(e.name))
          .map((e) => `evals/${e.name}`)
          .sort()
      : [];
    if (gtFiles.length === 0) {
      fail('evals/ 下找不到任何 ground-truth*.md——第 50 项没有可扫的标准答案，检查已经空转');
      bad += 1;
    }
    // baseline 的**节标题**清单——只认标题行，不再拿整文件做子串匹配。
    // 引用常常只写标题的前缀（「GT 之外挖出的真缺陷」vs 完整标题「GT 之外挖出的真缺陷（四轮合计，共 20 条）」），
    // 所以允许**前缀匹配**，但前缀之后必须紧跟标点或空白——否则「口径待裁定」会匹配上「口径待裁定记录」。
    const baseHeadings = [];
    for (const l of base.split('\n')) {
      const m = l.match(/^#{1,4}\s+(.+?)\s*$/);
      if (m) baseHeadings.push(m[1].trim());
    }
    const headingMatches = (name) => baseHeadings.some((h) => (
      h === name
      || (h.startsWith(name) && /^[\s（(：:·、，,—-]/.test(h.slice(name.length)))
    ));
    let total = 0;
    for (const rel of gtFiles) {
      const text = read(rel).join('\n');
      const refs = new Set();
      for (const l of text.split('\n')) {
        if (!l.includes('baseline')) continue;
        for (const m of l.matchAll(refRe)) refs.add(m[1]);
      }
      total += refs.size;
      for (const r of refs) {
        if (!headingMatches(r)) {
          fail(`${rel} 引用了 baseline 的「${r}」，但 evals/baseline.md 里没有这一节——复核者按引用找不到对应条目`);
          bad += 1;
        }
      }
    }
    // 守卫自身要被守：一份引用都没抓到，说明正则已经跟正文脱节——那比检查失效更糟
    if (total === 0) {
      fail(`evals/ 下 ${gtFiles.length} 份标准答案里一条 baseline 节名引用都没抓到——第 50 项检查已经恒真，正则必须跟着正文一起维护`);
      bad += 1;
    }
    if (bad === 0) ok(`GT 引用的 baseline 节名都真实存在（扫了 ${gtFiles.length} 份标准答案、${total} 处引用）`);
  }

  // ---------- 51. 样本规模：唯一真相源、实测行数、各文件写法三者一致 ----------
  {
    function goLines(rel) {
      let n = 0;
      const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith('.go')) {
            const raw = readFileSync(p, 'utf8');
            const parts = raw.split('\n');
            n += parts.length - (raw.endsWith('\n') ? 1 : 0);
          }
        }
      };
      walk(join(dir, rel));
      return n;
    }
    let bad = 0;
    // ---- 样本清单：**从磁盘推导**（evals/fixtures/ 下的目录）----
    const fixturesDir = join(dir, 'evals', 'fixtures');
    const samples = existsSync(fixturesDir)
      ? readdirSync(fixturesDir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort()
      : [];
    if (!samples.length) {
      fail('evals/fixtures 下没有任何样本目录——样本清单无从推导');
      bad += 1;
    }
    // ---- 唯一真相源：evals/README.md 的样本规模表（样本名也从这张表推导）----
    const canon = {};
    for (const l of evalsReadme.split('\n')) {
      const m = l.match(/`fixtures\/([^`/]+)\/`\s*\|\s*(\d+)\s*行/);
      if (m) canon[m[1]] = Number(m[2]);
    }
    for (const sample of samples) {
      if (canon[sample] === undefined) {
        fail(`evals/README.md 的样本规模表里找不到 ${sample} 的行数`);
        bad += 1;
        continue;
      }
      const actual = goLines(`evals/fixtures/${sample}`);
      if (actual !== canon[sample]) {
        fail(`evals/README.md 写 ${sample} ${canon[sample]} 行，实测 ${actual} 行——样本改了但规模表没跟着改`);
        bad += 1;
      }
    }
    // ---- 扫描清单：**从磁盘推导**（evals/ 下的全部 .md + 根 README.md）----
    // 此前是手写的 5 个文件：根 README.md 不在其中，
    // 于是「184 行的结算模块 + 377 行的规则引擎」那一句写错也没人管。
    const scanFiles = evalsScanFiles;
    /**
     * 归属：**这个文件讲哪个样本**——不靠句子里有没有样本名。
     *   GT 文件只讲一个样本：文件名里带样本名的（ground-truth-rule-engine.md）直接认；
     *   其余从它自己的规模自述（「N 行 Go」）反查；都认不出 → 归属为空 → 下面的规模自述
     *   会被判成「认不出是哪个样本」并报红（而不是静默跳过）。
     *   README / runbook / baseline 这些文件讲**两个**样本：每个规模自述数字都要跟
     *   其中一个对得上；两个都对不上 = 认不出 = 报红。
     */
    const universeOf = (rel, text) => {
      if (!/^evals\/ground-truth/.test(rel)) return samples;
      const byName = samples.find((s) => rel.includes(s));
      if (byName) return [byName];
      const claimed = [
        ...new Set([...text.matchAll(/(\d+)\s*行\s*Go/g)].map((m) => Number(m[1]))),
      ];
      const hit = claimed.map((n) => samples.find((s) => canon[s] === n)).filter(Boolean);
      return [...new Set(hit)];
    };
    for (const rel of scanFiles) {
      const text = read(rel).join('\n');
      const universe = universeOf(rel, text);
      const allowed = universe.map((s) => canon[s]).filter((v) => v !== undefined);
      for (const l of read(rel)) {
        for (const m of l.matchAll(/(\d{2,4})\s*行/g)) {
          const num = Number(m[1]);
          const before = l.slice(0, m.index);
          const after = l.slice(m.index);
          // 这一句是不是在讲「样本有多大」：句子里有样本标记才算。
          // （「README 上限 200 行」「覆盖表 15 行」这类不是规模自述，不进检查。）
          const window = before.slice(-40);
          const marked =
            /行\s*Go/.test(after) ||
            /样本/.test(window) ||
            samples.some((s) => window.includes(s));
          if (!marked) continue;
          if (!allowed.length) {
            fail(
              `${rel} 里样本规模写成「${num} 行」，但认不出是哪个样本——` +
                `这个文件只讲一个样本，它自己的规模自述与任何样本都对不上 —— ${l.trim().slice(0, 50)}`,
            );
            bad += 1;
            continue;
          }
          if (!allowed.includes(num)) {
            fail(
              `${rel} 里样本规模写成「${num} 行」，` +
                `认不出是哪个样本：这个文件讲的是 ${universe.join(' / ')}，` +
                `唯一真相源（evals/README.md 的样本规模表）是 ${allowed.join(' / ')} 行 —— ${l.trim().slice(0, 50)}`,
            );
            bad += 1;
          }
        }
      }
    }
    if (bad === 0) {
      ok(
        `样本规模一致（${samples.map((s) => `${s} ${canon[s]} 行`).join(' / ')}，与实测相同，` +
          `各文件写法一致；扫描了 ${scanFiles.length} 个文件）`,
      );
    }
  }

  // ---------- 52. rubric 必须有「通过 / 不通过」的放行判据 ----------
  {
    // 这一节可能带三级小节（「### 全量轮」「### 快模式轮」）——
    // 用只收二级标题的取法，否则门槛表落在小节里就看不见了。
    const verdict = sectionDeep(rubricLines, /^## 判定/);
    let bad = 0;
    if (verdict.length === 0) {
      fail('evals/rubric.md 没有「## 判定」一节——没有放行判据时，某个维度整体漏扫在命中维度里完全看不见');
      bad += 1;
    } else {
      const v = verdict.join('\n');
      for (const token of ['通过', '不通过', '契约', '命中', '误报']) {
        if (!v.includes(token)) {
          fail(`evals/rubric.md 的「## 判定」一节里没有「${token}」——放行条件写不全`);
          bad += 1;
        }
      }
    }
    if (bad === 0) ok('rubric.md 有完整的放行判据（契约分 + 命中 + 误报 三条门槛）');
  }

  // ---------- 53. 「改动文件 → 必须跑哪几轮」映射表不得有缺口 ----------
  {
    let bad = 0;
    // 只看映射表的表体——runbook 别处也出现过 `README.md`，全文找 token 等于恒真
    const rbLines = read('evals/runbook.md');
    const idx = rbLines.findIndex((l) => l.includes('改动文件 → 必须跑哪几轮'));
    if (idx === -1) {
      fail('evals/runbook.md 找不到「改动文件 → 必须跑哪几轮」映射表');
      bad += 1;
    } else {
      const rows = [];
      // 标题与表体之间有一个空行，先跳过空行，再收连续的表行
      for (let i = idx + 1; i < rbLines.length; i += 1) {
        if (rbLines[i].trim() === '') continue;
        if (!rbLines[i].startsWith('|')) break;
        rows.push(rbLines[i]);
      }
      if (rows.length === 0) {
        fail('evals/runbook.md 的改动→轮次映射表一行都没有');
        bad += 1;
      }
      const table = rows.join('\n');
      for (const token of ['`README.md`', 'evals/fixtures/**', 'evals/runbook.md', 'evals/README.md']) {
        if (!table.includes(token)) {
          fail(`evals/runbook.md 的「改动文件 → 必须跑哪几轮」映射表里没有 ${token}——改了它却不知道要跑哪几轮`);
          bad += 1;
        }
      }
    }
    if (bad === 0) ok('改动→轮次映射表覆盖了 README / fixtures / runbook / evals README');
  }

  // ---------- 54. runbook 必须有「同轮次不并发」与「skill 全程冻结」两条可检查动作 ----------
  {
    let bad = 0;
    // 只查「并发」「冻结」两个字是恒真的——把它们改写成「不要同时跑」「skill 固定」，
    // 字还在、纪律已经没了，lint 照样全绿（第 23 轮 23C 的 R23C-14）。
    // 改成要求**可执行的具体字面量**：每条纪律都要有一句写死的原话 + 一条能照着做的命令。
    //
    // 而且必须限定在「常见坑」一节里查：这些原话在别处（准备步骤的交叉引用里）
    // 也出现过一次，光看全文的话，把常见坑里那条改掉也照样全绿。
    const rbLines = read('evals/runbook.md');
    const pit = section(rbLines, /^## 常见坑/);
    if (pit.length === 0) {
      fail('evals/runbook.md 找不到「## 常见坑」一节——并发与冻结两条纪律的家没了');
      bad += 1;
    }
    const pitText = pit.join('\n');
    const MUSTS = [
      ['同一轮次不要并发', '同轮次并发会互相污染的纪律'],
      ['每个轮次用独立目录', '轮次之间不共用样本目录的纪律'],
      ['skill 全程冻结', '评测期间冻结 skill 的纪律'],
      ['rev-parse HEAD', '冻结检查的可执行命令'],
    ];
    for (const [lit, what] of MUSTS) {
      if (!pitText.includes(lit)) {
        fail(`evals/runbook.md 的「常见坑」一节里没有「${lit}」——${what}的规则不见了`);
        bad += 1;
      }
    }
    if (bad === 0) ok('runbook 的「常见坑」一节里有「同轮次不并发」与「skill 全程冻结」两条规则，且给了可执行检查');
  }

  // ---------- 55. rubric 里的「覆盖表 N 行」必须等于契约的维度数 ----------
  // rubric 第 6 维按「覆盖表 15 行」判分，而 15 这个数**写死在 rubric 里**——
  // 契约的维度数在另一个文件（契约的覆盖表），两边从没对过账。
  // 把 rubric 里两处「覆盖表 15 行」改成「16 行」，lint 全绿：
  // 评分口径说 16 行、契约说 15 行，评测会按错的标准判分。
  //
  // 第 24 轮 24A 补的（R24A-07）：
  //   ① 「覆盖表」与数字之间的间隔此前只允许 ≤3 个字符，写成「覆盖表一共有 15 行」
  //      （4 个字符）就不再被扫到——这一处从此不与契约对账，而 `hits === 0` 的守卫
  //      因为别的文件还有命中而不触发。现在放宽到 8 个字符。
  //   ② 守卫从「全局一句都没扫到」改成**逐处对账**：
  //      凡「覆盖表」后面紧跟着一个数字（可能是「覆盖表（15 行」这种带括号的），
  //      这一处就必须能被解析成一句可对账的声明——否则报红，
  //      不能靠「别的文件还有命中」蒙混过去。
  {
    const bad = [];
    let hits = 0;
    // 间隔放宽到 8 个字符（原来 ≤3）
    const DECL_RE = /覆盖表[^0-9\n]{0,8}(\d+)\s*行/g;
    // 「覆盖表 + 数字」的出现位置：这些地方必须是可对账的声明
    const POTENTIAL_RE = /覆盖表\s*[（(]?\s*\d+/g;
    const filesWithHit = new Set();
    for (const rel of evalsScanFiles) {
      let fileHits = 0;
      let filePotential = 0;
      for (const l of read(rel)) {
        // 「覆盖表 15 行」「覆盖表（15 行，…）」都算；「13 行覆盖表」是历史记录，不算
        for (const m of l.matchAll(DECL_RE)) {
          hits += 1;
          fileHits += 1;
          filesWithHit.add(rel);
          if (Number(m[1]) !== CANONICAL_DIMENSIONS.length) {
            bad.push(
              `${rel} 写着「覆盖表 ${m[1]} 行」，但契约的覆盖表是 ${CANONICAL_DIMENSIONS.length} 行` +
                `（${CANONICAL_DIMENSIONS.join(' / ')}）——评分口径与契约对不上`,
            );
          }
        }
        // 逐处对账：这一处「覆盖表 N」必须真的被解析成声明
        for (const m of l.matchAll(POTENTIAL_RE)) {
          filePotential += 1;
          const tail = l.slice(m.index);
          if (!DECL_RE.test(tail)) {
            bad.push(
              `${rel} 有一处「${m[0]}…」没有写成可对账的「覆盖表 N 行」声明——`
                + '这一处的行数不再与契约对账，写错了也没人知道',
            );
          }
          DECL_RE.lastIndex = 0;
        }
      }
      if (filePotential > 0 && fileHits === 0) {
        bad.push(`${rel} 提到了「覆盖表 N」，却没有一处能被解析成「覆盖表 N 行」的声明`);
      }
    }
    if (!hits) {
      bad.push(
        '各处都找不到「覆盖表 N 行」的表述——维度数无从对账，' +
          '本项已经恒真（比检查失效更糟）',
      );
    }
    if (bad.length) {
      fail(`覆盖表的行数声明与契约对不上：\n    ${bad.join('\n    ')}`);
    } else {
      ok(
        `各处「覆盖表 N 行」的声明与契约的 ${CANONICAL_DIMENSIONS.length} 个维度一致` +
          `（扫到 ${hits} 处，分布在 ${filesWithHit.size} 个文件）`,
      );
    }
  }
}

// ---------- 56. 「宣称／实际」行的适用范围必须与契约的表述对账 ----------
// EXAMPLE_BLOCKS 里 needClaim: false 意味着「这一形态不用写『宣称：… ／ 实际：…』」。
// 契约写的是「两档都要写」——那份清单里就不该再有 needClaim: false 的条目：
// 否则模型照着那份示例就不写这一行，而契约要求两档都写。
// 此前第 36 项只查「needClaim 为 true 的形态有没有写这一行」，
// false 的形态**没人管**——清单里的一个 false 就把这一档的要求悄悄摘掉了。
//
// 例外曾经有一个：**骨架模板**（kind = skeleton），理由是「它整张是空的」。
// 但那个理由只对**覆盖表**成立——骨架的「结论」段并不空，它把范围 / 结论 / 最值得关注的是
// 三行都摆出来了，却偏偏漏了第五行「宣称／实际」。模型照骨架产出，就缺一整行，
// 第 1 步的落差对照直接消失（第 24 轮 R24B-03）。所以骨架现在也示范这一行。
{
  const MARKERS = ['两档都要写', '两档都写', '两档同一条句式'];
  const skillText = read('SKILL.md').join('\n');
  const hit = MARKERS.filter((m) => skillText.includes(m));
  const bad = [];
  if (!hit.length) {
    // 守卫自身也要被守：契约的措辞一改，这一条就静默失效了
    bad.push(
      `SKILL.md 里找不到「${MARKERS.join(' / ')}」这类表述——` +
        '本项的守门条件与契约实际措辞脱钩了，改一处措辞就会静默失效',
    );
  } else {
    const offenders = EXAMPLE_BLOCKS
      .filter((e) => e.needClaim === false)
      .map((e) => `${e.rel}（${e.kind}）`);
    if (offenders.length) {
      bad.push(
        `契约写明「${hit[0]}」，但 EXAMPLE_BLOCKS 里还有 needClaim: false 的条目：${offenders.join('、')}——` +
          '模型照着那份示例就不写「宣称／实际」这一行，而契约要求两档都写',
      );
    }
  }
  if (bad.length) {
    fail(`「宣称／实际」行的适用范围与契约对不上：\n    ${bad.join('\n    ')}`);
  } else {
    ok(
      `「宣称／实际」行的适用范围与契约一致（契约写「${hit[0]}」，` +
        '所有示例形态都要写这一行）',
    );
  }
}

// ---------- 57. baseline 的逐条对照表必须能自己加出合计 ----------
//
// rubric 细则要求「必须逐条列出明细（哪条几分），否则不可复算」。
// 而 pass-3 那一节曾经**逐条表加起来是 19.0 / 12.5、合计行写的是 17.0 / 13.5**
// （合计行算错了，逐条判定没错）——rubric 那条要求没有任何机器检查守着，
// 于是这个矛盾在文件里躺了很久才被发现（第 23 轮 23C 的 R23C-02）。
//
// 这一项把「逐条表自己加出来 == 合计行」变成机器检查。
// 两种表形态都要认：
//   A) 每轮一列、格子里是「命中/归类」二元组：| GT | 级别 | B | C | 说明 |
//   B) 命中与归类各占一列：| GT | GT 级别 | 报告 | 命中 | 归类 |
//
// 第 24 轮 24A 补的两条（第 24A-01 / R24A-02）：
//   ① 合计行的分隔符不再只认 `/`（斜杠→逗号也是合法中文写法）；
//      **「写了合计却认不出」必须报红**——此前是 `continue` 静默跳过整节，
//      逐条值改错也没人管；而唯一的守卫是「一张都没查到」，少查一张完全无感。
//      现在分成三类并**逐节计数**：已检查 / 符号表（不参与加总）/ 报红，
//      三类之和必须等于「逐条对照」小节总数——少查一张再也不可能悄无声息。
//   ② 比较前先断言**列数一致**、每个取值**确实是数字**：
//      此前按位置配对，合计行少一列时比较变成 NaN（`NaN >= 0.005` 恒为 false），
//      那一列的合计从此不再被校验，也不报任何错。
{
  const baseLines = read('evals/baseline.md');
  const cellSplit = (l) => l.split('|').slice(1, -1).map((x) => x.trim());
  const cellNum = (s) => {
    const m = (s || '').replace(/\*\*/g, '').match(/-?\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : 0;
  };
  const r2 = (n) => Math.round(n * 100) / 100;

  const sections = [];
  for (let i = 0; i < baseLines.length; i += 1) {
    if (!/^#{2,3}\s*逐条对照/.test(baseLines[i])) continue;
    let end = baseLines.length;
    for (let j = i + 1; j < baseLines.length; j += 1) {
      if (/^#{1,3}\s/.test(baseLines[j])) { end = j; break; }
    }
    sections.push({ title: baseLines[i].trim(), body: baseLines.slice(i, end) });
  }

  const bad = [];
  let checked = 0; // 真正参与加总对账的表
  let symbolTables = 0; // 不参与加总的符号表（格子里是 G×/— 这类符号，不是分数）
  let failed = 0; // 报红的表
  // 合计行的两种分隔符：`／` `/` `，` `,` `、` 都认（斜杠换成逗号也是合法中文写法）
  const TOTAL_INLINE_RE = /合计[：:]\s*命中\s*(-?[\d.]+)\s*[／\/，,、]\s*归类\s*(-?[\d.]+)/;
  const TOTAL_WORDS = ['合计', '小计', '总计'];
  for (const sec of sections) {
    const tableRows = sec.body.filter((l) => /^\s*\|/.test(l));
    if (tableRows.length < 3) {
      bad.push(`${sec.title}：这一节里没有认出逐条对照表（表体不足 3 行）——数据没人复算`);
      failed += 1;
      continue;
    }

    // 认表头
    let header = null;
    let headerIdx = -1;
    for (let i = 0; i < tableRows.length; i += 1) {
      const c = cellSplit(tableRows[i]);
      const hi = c.findIndex((x) => x.includes('命中'));
      const ci = c.findIndex((x) => x.includes('归类'));
      if (hi >= 0 && ci >= 0) { header = { kind: 'split', hi, ci }; headerIdx = i; break; }
      // 轮次列是 A/B/C/D。列位不写死（此前写死 `k >= 2`，
      // 于是「| GT | A | B | C | 说明 |」这种排法漏掉 A 列）。
      const roundCols = c.map((x, k) => (k >= 1 && /^[A-D]$/.test(x) ? k : -1)).filter((k) => k >= 0);
      if (roundCols.length >= 1 && c[0].includes('GT')) { header = { kind: 'pair', cols: roundCols }; headerIdx = i; break; }
    }
    if (!header) {
      bad.push(`${sec.title}：这一节里没有认出逐条对照表的表头——数据没人复算`);
      failed += 1;
      continue;
    }

    // 数据行：GT 编号开头
    const dataRows = [];
    for (let i = headerIdx + 1; i < tableRows.length; i += 1) {
      const c = cellSplit(tableRows[i]);
      const first = (c[0] || '').replace(/\*\*/g, '').trim();
      if (/^:?-{2,}/.test(first)) continue;
      if (/^(GT|命中合计|归类合计|合计)/.test(first)) continue;
      if (!/^(G|R)\d/.test(first)) continue;
      dataRows.push(c);
    }
    if (!dataRows.length) {
      bad.push(`${sec.title}：这一节里没有认出任何逐条数据行——数据没人复算`);
      failed += 1;
      continue;
    }

    // 这一张表是不是「可加总」的分数表？符号表（格子里是 G×/—/G×(0.5)）加总没有意义。
    const scoreCells = (c) => (header.kind === 'split'
      ? [c[header.hi], c[header.ci]]
      : header.cols.map((k) => c[k]));
    const isScore = (v) => /^[+-]?\d/.test((v || '').replace(/\*\*/g, '').trim());
    const scoreish = dataRows.some((c) => scoreCells(c).some((v) => isScore(v)));

    // 求和
    const computed = [];
    if (header.kind === 'split') {
      computed.push({
        name: '汇总',
        hit: r2(dataRows.reduce((s, c) => s + cellNum(c[header.hi]), 0)),
        cls: r2(dataRows.reduce((s, c) => s + cellNum(c[header.ci]), 0)),
      });
    } else {
      for (const col of header.cols) {
        let hit = 0;
        let cls = 0;
        for (const c of dataRows) {
          const raw = (c[col] || '').replace(/\*\*/g, '');
          if (!raw || raw === '—' || raw === '-') continue;
          const parts = raw.split('/');
          hit += cellNum(parts[0]);
          cls += cellNum(parts[1]);
        }
        computed.push({ name: cellSplit(tableRows[headerIdx])[col] || `列${col}`, hit: r2(hit), cls: r2(cls) });
      }
    }

    // 声明的合计
    let declared = null;
    for (const l of sec.body) {
      const m = l.match(TOTAL_INLINE_RE);
      if (m) { declared = [{ hit: parseFloat(m[1]), cls: parseFloat(m[2]) }]; break; }
    }
    if (!declared) {
      const hitRow = sec.body.find((l) => /^\s*\|/.test(l) && /命中合计/.test(l.split('|')[1] || ''));
      const clsRow = sec.body.find((l) => /^\s*\|/.test(l) && /归类合计/.test(l.split('|')[1] || ''));
      if (hitRow && clsRow) {
        // 取值：**只裁掉末尾的空列**，中间的空格保留 ——
        // 此前 filter(v => v !== null) 把中间的空格也滤掉了，
        // 于是列会错位，而错位之后对不上也不报错。
        const vals = (row) => {
          const cells = cellSplit(row).slice(2)
            .map((v) => v.replace(/\*\*/g, '').trim());
          while (cells.length && cells[cells.length - 1] === '') cells.pop();
          return cells.map((v) => {
            const m = v.match(/^([\d.]+)$/);
            return m ? parseFloat(m[1]) : null;
          });
        };
        const hitVals = vals(hitRow);
        const clsVals = vals(clsRow);
        declared = hitVals.map((h, k) => ({ hit: h, cls: k < clsVals.length ? clsVals[k] : null }));
      }
    }

    const bodyText = sec.body.join('\n');
    const wroteTotal = TOTAL_WORDS.some((w) => bodyText.includes(w));

    if (!scoreish) {
      // 符号表：加总没有意义，跳过是合理的——但要**计数**，
      // 并且「写了合计却认不出」不能被当成符号表悄悄放过。
      if (wroteTotal && !declared) {
        bad.push(
          `${sec.title}：正文里写了「合计」，但认不出合计行——` +
            '合计行必须能被解析（形如「合计：命中 7.0 / 归类 5.5」或「命中合计 / 归类合计」两行），' +
            '否则这一节的分数没人复算',
        );
        failed += 1;
      } else {
        symbolTables += 1;
      }
      continue;
    }

    if (!declared) {
      bad.push(
        `${sec.title}：这一节有逐条分数，却没认出合计行——` +
          (wroteTotal
            ? '正文里写了「合计」但解析不出来（形如「合计：命中 7.0 / 归类 5.5」或「命中合计 / 归类合计」两行）'
            : '这一节压根没有合计声明，逐条表必须能自己加出合计') +
          '，否则第三方复算不出这个分数',
      );
      failed += 1;
      continue;
    }

    // ---- 断言：列数一致、每个取值确实是数字（不许用 NaN 静默跳过）----
    if (declared.length !== computed.length) {
      bad.push(
        `${sec.title}：合计行的列数（${declared.length}）与逐条表对不上（${computed.length}）——` +
          '逐条表与合计行必须一一对应，否则有一列的合计从未被校验',
      );
      failed += 1;
      continue;
    }
    let cellBad = false;
    for (let i = 0; i < computed.length; i += 1) {
      const d0 = declared[i];
      if (typeof d0.hit !== 'number' || Number.isNaN(d0.hit)
        || typeof d0.cls !== 'number' || Number.isNaN(d0.cls)) {
        bad.push(
          `${sec.title} 的「${computed[i].name}」：合计行里有一列取不到数字` +
            `（命中=${JSON.stringify(d0.hit)}、归类=${JSON.stringify(d0.cls)}）——` +
            '这一列的合计从未被校验，也不该被静默跳过',
        );
        cellBad = true;
      }
    }
    if (cellBad) {
      failed += 1;
      continue;
    }

    checked += 1;
    for (let i = 0; i < computed.length; i += 1) {
      const c0 = computed[i];
      const d0 = declared[i];
      if (Math.abs(c0.hit - d0.hit) >= 0.005) {
        bad.push(`${sec.title} 的「${c0.name}」：逐行相加命中 ${c0.hit}，合计行写的是 ${d0.hit}`);
      }
      if (Math.abs(c0.cls - d0.cls) >= 0.005) {
        bad.push(`${sec.title} 的「${c0.name}」：逐行相加归类 ${c0.cls}，合计行写的是 ${d0.cls}`);
      }
    }
  }

  // ---- 表数对账：少查一张再也不可能悄无声息 ----
  if (checked + symbolTables + failed !== sections.length) {
    fail(
      `第 57 项的表数对不上：已检查 ${checked} 张 + 符号表 ${symbolTables} 张 + 报红 ${failed} 张 ` +
        `≠「逐条对照」小节共 ${sections.length} 节——有一节既没被检查、也没被计入，说明它被静默跳过了`,
    );
    bad.push('逐条对照小节的对账计数不一致');
  }
  if (checked === 0) {
    fail('第 57 项没认出任何一张可加总的逐条对照表——检查项本身失效了（baseline 的「逐条对照」小节名或表结构改了？）');
    bad.push('没有可检查的逐条表');
  }
  if (bad.length) {
    fail(`baseline 的逐条对照表与合计行对不上：\n    ${bad.join('\n    ')}\n  逐条表必须能自己加出合计，否则第三方复算不出这个分数`);
  } else {
    ok(
      `baseline 的逐条对照表逐行相加与合计行一致（检查了 ${checked}/${sections.length} 张表，` +
        `另有 ${symbolTables} 张符号表不参与加总）`,
    );
  }
}

// ---------- 59. 规模/性能类的形态清单与例外措辞必须逐项一致 ----------
// 第 24 轮的两条发现都落在同一处：
//   R24B-01 —— 降级为 P2 的规模/性能类条目，同一份契约同时要求它写「触发」行和四行制；
//              设计类早就有对应解法（降为 P2 后保留后果锚点，写在「问题」行），规模/性能类却没有。
//   R24B-02 —— 闸门表第 2 档（规模关系清楚但说不出 N 的取值）没有对应的字段形态：
//              原先三种形态每一种都要填一个数字槽，这一档恰恰填不上，而它要计入结论行的 P2，删不掉。
//
// 修法是给这类条目定一份**唯一的形态清单**，让四处说同一件事：
//   SKILL.md 的「触发」字段定义 / references/regression-review.md 的形态清单 /
//   references/verification.md 的闸门表 / SKILL.md 的「问题」字段定义（降级后锚点落哪一行）。
//
// 关键：**逐项比对 token 集合，不只比数量**——数量对而清单错是更隐蔽的漂移
//（读者看到「四种形态」就以为没问题，实际清单已经不一样了）。
{
  const FORMS = [
    'N=___ 时实测 ___',
    'N=___ 时随 N ___（缺实测）',
    'N=（取值待确认）时随 N ___（缺 N 取值）',
    '调用频率 ___ 时每次触发 N 次 ___（缺实测）',
  ];
  const SITES = [
    { rel: 'SKILL.md', anchor: '**「触发」**：' },
    { rel: 'references/regression-review.md', anchor: '触发行按 `SKILL.md` 的输出契约写' },
  ];
  const bad = [];
  for (const site of SITES) {
    const text = read(site.rel).join('\n');
    if (!text.includes(site.anchor)) {
      // 守卫自身也要被守：落点措辞一改，这一条就静默失效了
      bad.push(
        `${site.rel}：找不到形态清单的落点（${site.anchor.slice(0, 24)}…）——` +
          '本项的守门位置与契约实际措辞脱钩了，改一处措辞就会静默失效',
      );
      continue;
    }
    const missing = FORMS.filter((f) => !text.includes(f));
    if (missing.length) {
      bad.push(
        `${site.rel} 的规模/性能类形态清单缺 ${missing.length} 种：${missing.join('、')}——` +
          '四处必须说同一份清单，数量对而清单错同样算漂移',
      );
    }
  }
  // 闸门表第 2 档必须写得出自己的形态，否则那一档的条目填不出字段
  const vf = read('references/verification.md').join('\n');
  const tier2 = FORMS[2];
  if (!vf.includes(tier2)) {
    bad.push(
      `references/verification.md 的闸门表「规模与复杂度」行没有第 2 档（说不出 N 的取值）的形态「${tier2}」——` +
        '那一档的条目照契约做填不出字段',
    );
  }
  // 例外限定词：P2 的四行制与规模/性能类的例外，两份文件必须说同一句
  const EXC = '除规模/性能类外';
  for (const rel of ['SKILL.md', 'references/regression-review.md']) {
    if (!read(rel).join('\n').includes(EXC)) {
      bad.push(
        `${rel} 里没有「${EXC}」这个限定——` +
          'P2 的四行制与规模/性能类的例外被写成互斥，两份文件各自少一半',
      );
    }
  }
  // 规模锚点的落位：未降级在「触发」行，降级为 P2 在「问题」行
  if (!vf.includes('降级为 P2 写在「问题」行')) {
    bad.push('references/verification.md 的闸门表没写清规模锚点在降级后落到哪一行');
  }
  const skillText = read('SKILL.md').join('\n');
  if (!skillText.includes('规模/性能类') || !skillText.includes('规模锚点挪到「问题」行')) {
    bad.push('SKILL.md 的「问题」字段定义里没有规模/性能类的规模锚点落位说明');
  }
  if (bad.length) {
    fail(`规模/性能类的形态清单与例外措辞不一致：\n    ${bad.join('\n    ')}`);
  } else {
    ok(
      `规模/性能类的形态清单与例外措辞一致（${FORMS.length} 种形态 × ${SITES.length} 处声明 + 闸门表 + 落位说明）`,
    );
  }
}

// ---------- 58. 本文件末尾才判定退出码 ----------
// 每一项检查都必须排在退出码判定之前，否则排在后面的检查报红时进程已经退出了 0，
// CI 照样绿。**加新检查时务必加在这行之前。**
console.log('');
if (errors > 0) {
  console.error(`✗ Consistency lint failed: ${errors} error(s)`);
  process.exit(1);
}
console.log('✓ All consistency checks passed');

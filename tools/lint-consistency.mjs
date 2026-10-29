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

import { readFileSync, existsSync } from 'node:fs';
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
const RESULT_VALUES = [
  { kind: 'exact', text: '无发现', desc: '无发现' },
  { kind: 'pointer', text: '已查（见 X）', desc: '已查（见 X）' },
  { kind: 'exact', text: '未扫（理由）', desc: '未扫（理由）' },
  { kind: 'count', text: 'n 条（级别）', desc: 'n 条（级别）' },
  { kind: 'count+pointer', text: 'n 条（级别），另见 X', desc: 'n 条（级别），另见 X' },
];
// 结果格数量 = RESULT_VALUES.length。第 22 项用它与各处「N 种取值」的声明比对。
const ACTUAL_RESULT_COUNT = RESULT_VALUES.length;
// 允许出现在结果格里的取值描述（供错误消息与文档使用）
const CANONICAL_RESULTS = RESULT_VALUES.map((v) => v.desc);
{
  const tpl = read('references/output-template.md');
  const tables = [];
  let current = null;
  for (const l of tpl) {
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
  if (!tables.length) {
    fail('output-template.md 里找不到维度覆盖表');
  } else {
    let bad = 0;
    for (const [i, t] of tables.entries()) {
      const names = t.map((l) => l.split('|')[1].trim());
      // 标了「…」的是省略版（例如零发现示例里的那张），不要求 15 行齐全
      if (names.some((n) => n.includes('…'))) {
        ok(`第 ${i + 1} 张覆盖表是显式省略版（标了「…」），跳过 15 行完整性检查`);
        continue;
      }
      const s = new Set(names);
      const missing = CANONICAL_DIMENSIONS.filter((d) => !s.has(d));
      const extra = [...s].filter((d) => !CANONICAL_DIMENSIONS.includes(d));
      if (missing.length || extra.length) {
        fail(`第 ${i + 1} 张覆盖表行名与规范集合不一致：缺 [${missing.join(', ')}]，多 [${extra.join(', ')}]`);
        bad += 1;
      }
      // 行数与顺序也要对：只比集合的话，重复行、行序错乱、16 行都能通过
      if (names.length !== CANONICAL_DIMENSIONS.length) {
        fail(`第 ${i + 1} 张覆盖表有 ${names.length} 行（应 ${CANONICAL_DIMENSIONS.length} 行）——重复行也算行数不对`);
        bad += 1;
      } else if (names.join('|') !== CANONICAL_DIMENSIONS.join('|')) {
        fail(
          `第 ${i + 1} 张覆盖表的行序与规范顺序不一致：\n    实际：${names.join(' | ')}\n    规范：${CANONICAL_DIMENSIONS.join(' | ')}\n` +
            '覆盖表按固定顺序排列——顺序乱了，读者逐行对照会串。',
        );
        bad += 1;
      }
    }
    if (!bad) ok(`${tables.length} 张覆盖表的行名、顺序与行数都符合规范（${CANONICAL_DIMENSIONS.length} 行）`);

    // 结果格取值：逐条匹配 RESULT_VALUES 派生的正则。
    // 「n 条（级别），另见 X」是第 5 种取值：本维既有自己的条目、又有结论归到别的维度时用。
    // 裸「n 条」（不带级别）不是合法取值——级别是与结论行对账的唯一钥匙。
    const resultRe = new RegExp(
      `^(?:无发现|已查（见 .+）|未扫（.+）|\\d+ 条（.+）(，另见 .+)?)$`,
    );
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
        if (cells[1].includes('…') || cells[1].includes('...')) continue;
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
  const EXPECTED = ['结论', '维度覆盖', '必须修', '建议修', '需要你拍板', '已查过没问题', '本次没覆盖'];
  const norm = (a) => a.map((s) => s.replace(/（.*?）/g, '').replace(/\(.*?\)/g, '').trim());

  const skill = read('SKILL.md');
  const tpl = read('references/output-template.md');
  const readme = read('README.md');

  const skillList = norm(
    section(skill, /^###\s*完整结构/)
      .filter((l) => /^\d+\.\s+\*\*/.test(l))
      .map((l) => l.match(/^\d+\.\s+\*\*(.+?)\*\*/)[1]),
  );
  const readmeLine = readme.find((l) => l.startsWith('固定七段'));
  const readmeList = norm(
    readmeLine
      ? readmeLine.replace('固定七段：', '').replace(/。$/, '').split('、').map((s) => s.trim())
      : [],
  );
  const expect = norm(EXPECTED);

  let bad = 0;
  if (!skillList.length) { fail('SKILL.md 里找不到「完整结构」小节的段名列表'); bad += 1; }
  else if (skillList.join('|') !== expect.join('|')) {
    fail(`SKILL.md 的完整结构段名与顺序不符：${skillList.join(' | ')}（应为 ${expect.join(' | ')}）`);
    bad += 1;
  }
  if (readmeList.length && readmeList.join('|') !== expect.join('|')) {
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
  if (!bad) ok('七段结构在 SKILL.md / output-template.md / README.md 里段名与顺序一致');
}

// ---------- 5. 结论计数格式：多处必须逐字相同 ----------
{
  const re = /P0 n、P1 n、P2 n、P3 n、待拍板 n/;
  const grab = (rel) => {
    for (const l of read(rel)) {
      const m = l.match(re);
      if (m) return m[0];
    }
    return null;
  };
  const found = [
    ['SKILL.md', grab('SKILL.md')],
    ['references/output-template.md', grab('references/output-template.md')],
  ].filter(([, v]) => v);
  if (found.length < 2) {
    fail(`结论计数格式只找到 ${found.length} 处（至少 2 处才能比对）`);
  } else if (new Set(found.map(([, v]) => v)).size > 1) {
    fail('结论计数格式在文件之间不一致：\n' + found.map(([f, v]) => `    ${f}: ${v}`).join('\n'));
  } else {
    ok(`结论计数格式在 ${found.map(([f]) => f).join(' / ')} 里一致：${found[0][1]}`);
  }
}

// ---------- 6. finding 标签形态：三段齐全，级别段与维度段都是规范值 ----------
{
  const files = ['SKILL.md', 'README.md', 'references/regression-review.md', 'references/output-template.md'];
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
  // dimensions.md 以后新增分类时，把新词加进这个列表。
  const CLASSIFY_TERMS = ['协议固定值', '业务政策值'];
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
    ok('七维速查表没有复述维度细则的分类措辞（判据单一真相源在 dimensions.md）');
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
  const isExample = (b) =>
    b.includes('| 维度 | 结果 | 查了什么 |') && COUNT_RE.test(b) && /##\s*必须修/.test(b);

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
  const isExample = (b) => b.includes('| 维度 | 结果 | 查了什么 |') && /P0 \d+、P1 \d+、P2 \d+、P3 \d+、待拍板 \d+/.test(b) && /##\s*必须修/.test(b);
  const blocks = [
    ...fencedBlocks(read('README.md')).filter(isExample),
    ...fencedBlocks(read('references/output-template.md')).filter(isExample),
  ];
  const bad = [];
  for (const b of blocks) {
    const vm = b.match(/结论：\*{0,2}(可以合|改完再合|方向先定)\*{0,2}/);
    if (!vm) {
      bad.push('示例里找不到「结论：**档位**」那一行');
      continue;
    }
    const verdict = vm[1];
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
  if (bad.length) {
    fail(
      `示例的结论档与正文对不上：\n    ${bad.join('\n    ')}\n` +
        '结论档决策表是「从上到下匹配，命中第一条即定档」——示例自己必须落在正确的档位，' +
        '否则模型照着示例写就会给出与规则相反的头号信号。',
    );
  } else {
    ok(`示例的结论档与正文条目自洽（${blocks.length} 个示例块）`);
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
{
  const files = {
    'SKILL.md': read('SKILL.md'),
    'README.md': read('README.md'),
    'references/output-template.md': read('references/output-template.md'),
    'references/playbooks.md': read('references/playbooks.md'),
  };
  const bad = [];
  const seen = [];
  // 声明行 = 含「取值」二字，且带一个中文数字 + 「种」（措辞不再限定具体动词）
  const NUM_RE = /([三四五六])\s*种/;
  for (const [name, lines] of Object.entries(files)) {
    for (const [i, l] of lines.entries()) {
      if (!l.includes('取值')) continue;
      const m = l.match(NUM_RE);
      if (!m) continue;
      const CN = { 三: 3, 四: 4, 五: 5, 六: 6 };
      seen.push(`${name}:${i + 1}`);
      if (CN[m[1]] !== ACTUAL_RESULT_COUNT) {
        bad.push(`${name}:${i + 1} 写着「${m[1]}种取值」，但实际合法取值有 ${ACTUAL_RESULT_COUNT} 种`);
      }
    }
  }
  // 守卫自身也要被守：4 个文件里，SKILL.md 与 output-template.md 各至少有一处声明被扫到。
  // 守门条件一改就静默失效的场景，只有靠「必须扫到 N 处」才兜得住。
  const mustHit = ['SKILL.md', 'references/output-template.md'];
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
    const FORM_TOKENS = RESULT_VALUES.map((v) => v.text);
    const listBad = [];
    const checkedFiles = [];
    for (const [name, lines] of Object.entries(files)) {
      for (const [i, l] of lines.entries()) {
        if (!l.includes('取值')) continue;
        if (!NUM_RE.test(l)) continue;
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
  const isExample = (b) =>
    b.includes('| 维度 | 结果 | 查了什么 |') && COUNT_RE.test(b) && /##\s*必须修/.test(b);
  const bad = [];
  let checked = 0;
  for (const [name, lines] of [
    ['README.md', read('README.md')],
    ['references/output-template.md', read('references/output-template.md')],
  ]) {
    for (const b of fencedBlocks(lines).filter(isExample)) {
      const c = b.match(COUNT_RE);
      const declared = { P0: +c[1], P1: +c[2], P2: +c[3], P3: +c[4], 待拍板: +c[5] };
      // 正文里每条 finding 都有一行以「### [级别]…」开头的标题
      const actual = { P0: 0, P1: 0, P2: 0, P3: 0, 待拍板: 0 };
      for (const m of b.matchAll(/^###\s+\[(P0|P1|P2|P3|待拍板)\]/gm)) actual[m[1]] += 1;
      checked += 1;
      for (const lv of ['P0', 'P1', 'P2', 'P3', '待拍板']) {
        if (declared[lv] !== actual[lv]) {
          bad.push(`${name}：结论行写「${lv} ${declared[lv]}」，正文里数出来是 ${actual[lv]} 条`);
        }
      }
    }
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
  const isExample = (b) =>
    b.includes('| 维度 | 结果 | 查了什么 |') && COUNT_RE.test(b) && /##\s*必须修/.test(b);
  const bad = [];
  let checked = 0;
  for (const [name, lines] of [
    ['README.md', read('README.md')],
    ['references/output-template.md', read('references/output-template.md')],
  ]) {
    for (const b of fencedBlocks(lines).filter(isExample)) {
      checked += 1;
      // 正文里每个维度实际有几条
      const actualByDim = {};
      for (const m of b.matchAll(/^###\s+\[(?:P0|P1|P2|P3|待拍板)\]\[([^\]]+)\]/gm)) {
        actualByDim[m[1]] = (actualByDim[m[1]] ?? 0) + 1;
      }
      // 覆盖表每一行
      for (const l of b.split('\n')) {
        if (!/^\|\s*[^-|\s][^|]*\|/.test(l)) continue;
        const cells = l.split('|').map((c) => c.trim());
        const dim = cells[1];
        if (!dim || dim === '维度' || dim.includes('…')) continue;
        const result = cells[2];
        const actual = actualByDim[dim] ?? 0;
        const m = result.match(/^(\d+) 条/);
        if (m) {
          const declared = Number(m[1]);
          if (declared !== actual) {
            bad.push(`${name}：覆盖表「${dim}」声明 ${declared} 条，正文里数出来是 ${actual} 条`);
          }
        } else if (result === '无发现' || result.startsWith('未扫')) {
          if (actual > 0) {
            bad.push(`${name}：覆盖表「${dim}」写「${result}」，但正文里有 ${actual} 条该维度的 finding`);
          }
        }
      }
      // 反向：正文里出现过的维度，覆盖表不能写「无发现」/「未扫」
      for (const [dim, n] of Object.entries(actualByDim)) {
        const row = b.split('\n').find((l) => {
          if (!/^\|\s*[^-|\s][^|]*\|/.test(l)) return false;
          return l.split('|')[1].trim() === dim;
        });
        if (!row) continue;
        const result = row.split('|')[2].trim();
        if (result === '无发现' || result.startsWith('未扫')) {
          bad.push(`${name}：正文里有 ${n} 条「${dim}」的 finding，覆盖表该行却写「${result}」`);
        }
      }
    }
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
  const isExample = (b) =>
    b.includes('| 维度 | 结果 | 查了什么 |') && COUNT_RE.test(b) && /##\s*必须修/.test(b);
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
      for (const rule of RULES) {
        const start = b.indexOf(`## ${rule.section}`);
        if (start === -1) continue;
        const rest = b.slice(start + rule.section.length + 3);
        const next = rest.search(/^##\s/m);
        const body = next === -1 ? rest : rest.slice(0, next);
        for (const m of body.matchAll(/^###\s+\[(P0|P1|P2|P3|待拍板)\]/gm)) {
          if (!rule.allow.includes(m[1])) {
            bad.push(`${name}：一条 [${m[1]}] 条目出现在「${rule.section}」段（该段只放 ${rule.allow.join(' / ')}）`);
          }
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
    if (!must || must.length < 4) bad.push(`闸门表「${type}」行的「必须回答」列为空`);
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
{
  const verif = read('references/verification.md');
  const gateRows = verif
    .filter((l) => /^\|\s*[^-|].*\|.*\|.*\|$/.test(l) && !/^\|\s*结论类型/.test(l))
    .map((l) => l.split('|').map((c) => c.trim()));
  const bullets = section(verif, /^##\s*每个维度的必答句/)
    .filter((l) => /^\s*-\s/.test(l))
    .map((l) => l.replace(/^\s*-\s*/, ''));
  const bad = [];
  for (const b of bullets) {
    const idx = b.indexOf('：');
    if (idx === -1) continue;
    const label = b.slice(0, idx).trim();
    const body = b.slice(idx + 1);
    // 闸门表里对应的行：类型名与必答句标签相同或相近（取子问最多的那行）
    const cands = gateRows.filter((r) => r[1] && (r[1].includes(label) || label.includes(r[1])));
    if (!cands.length) continue;
    const gateQ = Math.max(...cands.map((r) => (r[2] || '').split('？').length - 1));
    const bulletQ = (body.match(/___/g) || []).length + (body.match(/？/g) || []).length;
    if (bulletQ < gateQ) {
      bad.push(`必答句「${label}」只覆盖 ${bulletQ} 问，闸门表那一行问了 ${gateQ} 问`);
    }
  }
  if (bad.length) {
    fail(
      `必答句的子问数少于闸门表：\n    ${bad.join('\n    ')}\n` +
        '必答句是闸门表的速查副本——副本少问的那一问，模型照着副本走就不会问。',
    );
  } else {
    ok('必答句覆盖的问数都不少于闸门表对应行');
  }
}

// ---------- 28. finding 的字段名必须固定 ----------
// 契约写「每条 finding 的字段固定」，但此前没有任何检查比对字段名：
// 把骨架里的「- 证据：」改成「- 依据：」，全绿。字段名一漂，按字段解析报告的人就读不到了。
{
  const EXPECTED = {
    '必须修': ['触发', '影响', '证据', '修法'],
    '建议修': ['问题', '证据', '收益', '修法'],
    '需要你拍板': ['现状', '证据', '路线 A', '路线 B', '建议', '要你定'],
  };
  const bad = [];
  // 骨架里的三段 finding 模板
  const tpl = read('references/output-template.md');
  const fenced = [];
  {
    let cur = null;
    for (const l of tpl) {
      if (/^\s*```/.test(l)) {
        if (cur === null) cur = [];
        else { fenced.push(cur.join('\n')); cur = null; }
        continue;
      }
      if (cur !== null) cur.push(l);
    }
  }
  const skeleton = fenced.find((b) => b.includes('## 必须修') && b.includes('## 建议修') && b.includes('## 需要你拍板'));
  if (!skeleton) {
    bad.push('output-template.md 的骨架里找不到三段 finding 模板');
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
  // SKILL.md 的字段定义必须同样齐全。拍板六字段在 SKILL.md 里是「现状、证据、路线 A…」的顿号写法，
  // 不带冒号——所以这里按字段名本身出现来查，不限定 `- 字段：` 的形态。
  const skill = read('SKILL.md');
  for (const fields of Object.values(EXPECTED)) {
    for (const f of fields) {
      if (!skill.some((l) => l.includes(f))) {
        bad.push(`SKILL.md 的字段定义里找不到「${f}」`);
      }
    }
  }
  if (bad.length) {
    fail(
      `finding 的字段名不固定：\n    ${bad.join('\n    ')}\n` +
        '契约写死「每条 finding 的字段固定」——字段名一漂，按字段解析报告的复核链就断了。',
    );
  } else {
    ok('finding 的字段名在三段模板与 SKILL.md 定义里一致');
  }
}

// ---------- 29. 「已查过没问题」的准入门槛在各副本里必须一致 ----------
// 这条门槛写在三处（SKILL.md / output-template.md / verification.md），
// 此前谁改谁漂，且被指定的基准（output-template）自己先漂也没人管。
{
  const TOKENS = ['跑了测试', '构造了复现', '对比了 base', '专门证伪'];
  const sources = [
    ['SKILL.md', read('SKILL.md')],
    ['references/output-template.md', read('references/output-template.md')],
    ['references/verification.md', read('references/verification.md')],
  ];
  const bad = [];
  for (const [name, lines] of sources) {
    const hit = lines.find((l) => l.includes('准入门槛') || (l.includes('跑了测试') && l.includes('构造了复现')));
    if (!hit) { bad.push(`${name}：找不到「已查过没问题」的准入门槛表述`); continue; }
    for (const t of TOKENS) {
      if (!hit.includes(t)) bad.push(`${name}：准入门槛缺少「${t}」`);
    }
  }
  if (bad.length) {
    fail(
      `「已查过没问题」的准入门槛在各副本里不一致：\n    ${bad.join('\n    ')}\n` +
        `门槛是「四选一」：${TOKENS.join(' / ')}——三处副本必须同时齐全，缺一项就放进来一条没有验证方式的条目。`,
    );
  } else {
    ok('「已查过没问题」的准入门槛在 SKILL.md / output-template.md / verification.md 三处一致（四选一）');
  }
}

// ---------- 30. 结论行不能出现第 6 个计数 ----------
// 契约明写「不要为『需确认』新增一个计数」，但 lint 的计数正则此前是子串匹配，
// 结论行尾部挂上「、需确认 2」照样全绿。
{
  const bad = [];
  const files = [
    ['SKILL.md', read('SKILL.md')],
    ['references/output-template.md', read('references/output-template.md')],
    ['README.md', read('README.md')],
  ];
  for (const [name, lines] of files) {
    for (const [i, l] of lines.entries()) {
      // 只看「结论行」——即带结论计数、且以「结论」二字开头或含结论档的那一行
      const isConclusionLine = /^\s*(?:[-*]\s*)?\**结论[：:]/.test(l) || /结论：\*/.test(l);
      if (!isConclusionLine) continue;
      if (!/P0 \d+、P1 \d+、P2 \d+、P3 \d+、待拍板 \d+/.test(l)) continue;
      const m = l.match(/P0 \d+、P1 \d+、P2 \d+、P3 \d+、待拍板 \d+(.*)$/);
      const tail = (m[1] ?? '').trim();
      if (!/^[。.]?$/.test(tail)) {
        bad.push(`${name}:${i + 1} 结论计数之后还有多余内容「${tail}」——计数只有 P0–P3 与待拍板五项`);
      }
      if (/需确认\s*\d/.test(l)) bad.push(`${name}:${i + 1} 结论行出现了「需确认」计数`);
    }
  }
  if (bad.length) {
    fail(
      `结论行出现了声明之外的计数：\n    ${bad.join('\n    ')}\n` +
        '「需确认」是降级后的 P2，不是独立档位——给它单独计数，「P2 n」和「待拍板 n」的口径就稀释了。',
    );
  } else {
    ok('结论行只有 P0–P3 与待拍板五项计数，没有第 6 个档位');
  }
}

// ---------- 31. 标签扫描必须覆盖 references/ 下所有文件 ----------
// 此前只扫 4 个文件，playbooks.md / dimensions.md / verification.md 里的标签无人看——
// 而它们是模型必读的文件，写错维度名照样会被当规范。
{
  const files = [
    'SKILL.md', 'README.md',
    'references/regression-review.md', 'references/output-template.md',
    'references/playbooks.md', 'references/dimensions.md', 'references/verification.md',
  ];
  const ORIGIN = ['本次引入', '既有', '现状'];
  const LEVELS = ['P0', 'P1', 'P2', 'P3', '待拍板'];
  const offenders = [];
  let count = 0;
  for (const f of files) {
    for (const l of read(f)) {
      const re = /\[([^\]\[]{1,12})\]\[([^\]]+)\](?:\[([^\]]+)\])?/g;
      let m;
      while ((m = re.exec(l)) !== null) {
        const [, level, dim, origin] = m;
        if (level === '级别' && dim === '维度') continue; // 占位符模板，不是真标签
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
{
  const tpl = read('references/output-template.md');
  const blocks = [];
  {
    let cur = null;
    for (const l of tpl) {
      if (/^\s*```/.test(l)) {
        if (cur === null) cur = [];
        else { blocks.push(cur.join('\n')); cur = null; }
        continue;
      }
      if (cur !== null) cur.push(l);
    }
  }
  const skeleton = blocks.find((b) => b.includes('| 维度 | 结果 | 查了什么 |') && b.includes('## 必须修'));
  if (!skeleton) {
    fail('output-template.md 的骨架块里找不到覆盖表与「必须修」段——七段结构无从校验');
  } else {
    const EXPECTED = ['结论', '维度覆盖', '必须修', '建议修', '需要你拍板', '已查过没问题', '本次没覆盖'];
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

// ---------- 35. 本文件末尾才判定退出码 ----------
// 每一项检查都必须排在退出码判定之前，否则排在后面的检查报红时进程已经退出了 0，
// CI 照样绿。**加新检查时务必加在这行之前。**
console.log('');
if (errors > 0) {
  console.error(`✗ Consistency lint failed: ${errors} error(s)`);
  process.exit(1);
}
console.log('✓ All consistency checks passed');

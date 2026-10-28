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
const CANONICAL_RESULTS = ['无发现', '已查（见 X）', '未扫（理由）', 'n 条'];
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
      const s = new Set(names);
      const missing = CANONICAL_DIMENSIONS.filter((d) => !s.has(d));
      const extra = [...s].filter((d) => !CANONICAL_DIMENSIONS.includes(d));
      if (missing.length || extra.length) {
        fail(`第 ${i + 1} 张覆盖表行名与规范集合不一致：缺 [${missing.join(', ')}]，多 [${extra.join(', ')}]`);
        bad += 1;
      }
    }
    if (!bad) ok(`${tables.length} 张覆盖表的行名与规范集合（15 行）一致`);

    // 结果格取值：允许 无发现 / 已查（见 ...） / 未扫（...） / N 条 / N 条（...）
    const resultRe = /^(无发现|已查（见 .+）|未扫（.+）|\d+ 条(（.+）)?)$/;
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

// ---------- 6. finding 标签形态：维度段必须是规范维度名，第三段只能是引入方式 ----------
{
  const files = ['SKILL.md', 'references/regression-review.md', 'references/output-template.md'];
  const ORIGIN = ['本次引入', '既有'];
  const offenders = [];
  let count = 0;
  for (const f of files) {
    for (const l of read(f)) {
      const re = /\[(P[0-3])\]\[([^\]]+)\](?:\[([^\]]+)\])?/g;
      let m;
      while ((m = re.exec(l)) !== null) {
        count += 1;
        const [, level, dim, origin] = m;
        if (!CANONICAL_DIMENSIONS.includes(dim)) {
          offenders.push(`${f}: 维度段「${dim}」不在规范维度名里（${level}[${dim}]）`);
        }
        if (origin !== undefined && !ORIGIN.includes(origin)) {
          offenders.push(`${f}: 第三段「${origin}」不是引入方式（应为 ${ORIGIN.join(' / ')}）`);
        }
        if (f === 'references/regression-review.md' && origin === undefined) {
          offenders.push(`${f}: 快模式标签「${level}[${dim}]」缺引入方式段`);
        }
      }
    }
  }
  if (offenders.length) {
    fail(`finding 标签形态不一致：\n    ${[...new Set(offenders)].join('\n    ')}`);
  } else {
    ok(`finding 标签形态一致（${count} 处标签：维度段都是规范维度名，第三段都是引入方式）`);
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

console.log('');
if (errors > 0) {
  console.error(`✗ Consistency lint failed: ${errors} error(s)`);
  process.exit(1);
}
console.log('✓ All consistency checks passed');

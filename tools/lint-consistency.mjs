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
  const isExample = (b) => b.includes('| 维度 | 结果 | 查了什么 |') && COUNT_RE.test(b);

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

    // 覆盖表声明的「n 条（级别）」必须在正文里数得出来
    const block = tplBlocks[0];
    if (block.includes('...') || block.includes('…')) {
      ok('示例块里有省略号，跳过「覆盖表声明 ↔ 正文条目」逐行核对');
    } else {
      const rows = block.split('\n').filter((l) => /^\|\s*[^-|\s][^|]*\|/.test(l) && /\|\s*\d+ 条（.+）\s*\|/.test(l));
      const missing = [];
      for (const r of rows) {
        const cells = r.split('|').map((c) => c.trim());
        const dim = cells[1];
        const m = cells[2].match(/^(\d+) 条（(.+)）$/);
        if (!m) continue;
        const [, n, level] = m;
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

console.log('');
if (errors > 0) {
  console.error(`✗ Consistency lint failed: ${errors} error(s)`);
  process.exit(1);
}
console.log('✓ All consistency checks passed');

#!/usr/bin/env node
// lint-skill.mjs — deep-code-review 仓库自带的 skill 校验器
//
// 用法: node tools/lint-skill.mjs [skill-dir]     默认当前目录
// 退出码: 0 = 通过，1 = 有错误
//
// 为什么不用运行时自带的 lint-skill.js：
//   1. 那个脚本把 README.md 判为 forbidden file —— 那是「已安装的 skill 目录」的规则。
//      本仓库根目录同时是公开仓库根，README 是必须的，不该为了过 lint 删掉它。
//   2. 那个脚本的 frontmatter 正则不认 \r：CRLF 文件会被解析成空 frontmatter。
//      本脚本先统一换行再解析，并把 CRLF 本身列为错误（.gitattributes 已要求 LF）。
//   3. 本脚本随仓库走，CI 与贡献者本地跑的是同一份，不依赖运行环境。

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';

const FORBIDDEN_FRONTMATTER_KEYS = ['allowed-tools', 'license', 'model'];
const MAX_BODY_LINES = 500;
// Agent Skills 规范：description 必须 1–1024 字符（agentskills.io/specification.md）。
// 超限时，宽松的实现会截断——截断点常常落在能力说明或触发词中间，命中率直接受损。
const MAX_DESCRIPTION_CHARS = 1024;

// 成品里不出现相对表述：提一次「内置」，这个 skill 就始终是相对于别的东西定义的。
// 这条规矩以前靠人工 grep 守，容易漏——机器化之后它就退不回去了。
// 词表覆盖同义说法：光拦「内置」，换个「自带」「预置」就绕过去了。
const RELATIVE_PHRASES = [
  '内置', '别的工具', '第二个工具',
  '自带', '预置', '随运行时', '官方那套',
];
const RELATIVE_PHRASE_SCOPE = ['SKILL.md', 'README.md', 'references', 'evals'];

let errors = 0;
let warnings = 0;

function fail(msg) {
  console.error(`[FAIL] ${msg}`);
  errors += 1;
}
function warn(msg) {
  console.warn(`[WARN] ${msg}`);
  warnings += 1;
}
function ok(msg) {
  console.log(`[OK]   ${msg}`);
}

/** 读文本并统一换行：去 BOM，\r\n -> \n */
function readText(p) {
  return readFileSync(p, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

/** 极简 frontmatter 解析（先统一换行，因此对 CRLF 免疫） */
function parseFrontmatter(content) {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return { frontmatter: null, bodyStart: 0 };
  let endIdx = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return { frontmatter: null, bodyStart: 0 };

  const fm = {};
  let key = null;
  let buf = [];
  let inBlock = false;

  for (let i = 1; i < endIdx; i += 1) {
    const line = lines[i];
    if (inBlock) {
      if (/^[a-zA-Z_-]+\s*:/.test(line)) {
        fm[key] = buf.join('\n').trim();
        inBlock = false;
        key = null;
        buf = [];
        // 不 continue：同一行可能是一个新 key，继续往下解析
      } else {
        buf.push(line.replace(/^\s{0,4}/, ''));
        continue;
      }
    }
    const m = line.match(/^([a-zA-Z_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (v === '|' || v === '>' || v === '|-' || v === '>-') {
      key = k;
      buf = [];
      inBlock = true;
    } else {
      fm[k] = v.trim();
    }
  }
  if (inBlock && key) fm[key] = buf.join('\n').trim();
  return { frontmatter: fm, bodyStart: endIdx + 1 };
}

const dir = resolve(process.argv[2] ?? '.');
const skillMd = join(dir, 'SKILL.md');

console.log(`Linting skill at: ${dir}\n`);

if (!existsSync(skillMd)) {
  fail(`SKILL.md not found at ${skillMd}`);
  process.exit(1);
}
ok('SKILL.md exists');

// --- 换行符 ---
const raw = readFileSync(skillMd);
if (raw.includes(0x0d)) {
  fail(
    'SKILL.md 含 CRLF 换行。CRLF 会让以正则解析 frontmatter 的工具把 name/description 读成空。' +
      '请确认 .gitattributes 含 `* text=auto eol=lf`，并以 LF 提交。',
  );
} else {
  ok('SKILL.md uses LF line endings');
}

const content = readText(skillMd);
const { frontmatter, bodyStart } = parseFrontmatter(content);

if (!frontmatter) {
  fail('frontmatter (--- ... ---) missing or unclosed');
  process.exit(1);
}
ok('frontmatter parsed');

// --- name ---
const name = frontmatter.name;
const dirName = basename(dir);
if (!name) {
  fail('frontmatter.name is missing');
} else if (!/^[a-z][a-z0-9-]*$/.test(name)) {
  fail(`frontmatter.name "${name}" is not kebab-case (lowercase letters/digits/hyphens, start with letter)`);
} else if (name !== dirName) {
  fail(`frontmatter.name "${name}" does not match directory name "${dirName}"`);
} else {
  ok(`name "${name}" is valid kebab-case and matches directory`);
}

// --- description ---
const desc = frontmatter.description ?? '';
if (!desc) {
  fail('frontmatter.description is missing');
} else {
  const hasTrigger = /\b(when|trigger|use this|load this)\b/i.test(desc) || /["']/.test(desc);
  if (!hasTrigger) {
    fail('frontmatter.description must contain a trigger phrase: a quoted phrase, "when", "trigger", "use this", or "load this"');
  } else {
    ok('description contains trigger hint');
  }
  if (desc.length < 30) {
    warn(`description is very short (${desc.length} chars); make sure it covers what + when + near misses`);
  }
  if (desc.length > MAX_DESCRIPTION_CHARS) {
    fail(
      `frontmatter.description is ${desc.length} characters (> ${MAX_DESCRIPTION_CHARS}). ` +
        'Agent Skills 规范要求 1–1024 字符；超限时运行时可能截断，截断点常落在能力说明或触发词中间。' +
        '请压缩描述，触发词与能力清单都要留住。',
    );
  } else {
    ok(`description is ${desc.length} characters (limit ${MAX_DESCRIPTION_CHARS})`);
  }
}

// --- 禁用 frontmatter 字段 ---
for (const key of FORBIDDEN_FRONTMATTER_KEYS) {
  if (key in frontmatter) {
    fail(`frontmatter contains forbidden key "${key}" (remove it)`);
  }
}
if (FORBIDDEN_FRONTMATTER_KEYS.every((k) => !(k in frontmatter))) {
  ok('no forbidden frontmatter keys');
}

// --- 正文行数 ---
const bodyLines = content.split('\n').length - bodyStart;
if (bodyLines > MAX_BODY_LINES) {
  fail(`SKILL.md body is ${bodyLines} lines (> ${MAX_BODY_LINES}); split into references/<topic>.md`);
} else {
  ok(`body is ${bodyLines} lines (limit ${MAX_BODY_LINES})`);
}

// --- references 链接 ---
const refNames = [...new Set([...content.matchAll(/references\/([a-zA-Z0-9_-]+\.md)/g)].map((m) => m[1]))];
for (const ref of refNames) {
  if (!existsSync(join(dir, 'references', ref))) {
    fail(`SKILL.md references "references/${ref}" but file does not exist`);
  }
}
if (refNames.length > 0 && refNames.every((r) => existsSync(join(dir, 'references', r)))) {
  ok(`all ${refNames.length} references/*.md links resolve`);
}

// --- references 目录：孤儿文件与换行符 ---
// 孤儿文件此前只报 WARN，退出码不受影响——那意味着把 verification.md（证伪闸门）
// 从 SKILL.md 的引用里摘掉，CI 照样绿，而闸门在运行时已经不可达了。
// 引用是契约的一部分：文件在仓里却没被任何流程读到，它就是死的。
const refDir = join(dir, 'references');
if (existsSync(refDir)) {
  for (const f of readdirSync(refDir)) {
    if (!f.endsWith('.md')) continue;
    if (!refNames.includes(f)) {
      fail(
        `references/${f} is not referenced from SKILL.md (orphan). ` +
          '契约文件必须被 SKILL.md 以 `references/<name>.md` 形式引用——' +
          '没人读到的文件在运行时不可达（比如闸门表被摘掉，证伪环节就静默消失了）。',
      );
    }
    if (readFileSync(join(refDir, f)).includes(0x0d)) {
      fail(`references/${f} contains CRLF line endings`);
    }
  }
}

// --- 相对表述 ---
// skill 必须自述能力，不靠对比定义。跨工具的选型说明属于「给人看的」，但也不该用
// 「内置 X」这种措辞——正确做法是让本 skill 覆盖那件事，而不是比较谁更强。
function collectFiles(rel) {
  const abs = join(dir, rel);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(abs, f));
}

const phraseTargets = [
  ...(existsSync(join(dir, 'SKILL.md')) ? [join(dir, 'SKILL.md')] : []),
  ...(existsSync(join(dir, 'README.md')) ? [join(dir, 'README.md')] : []),
  ...collectFiles('references'),
  ...collectFiles('evals'),
];

let phraseHits = 0;
for (const f of phraseTargets) {
  const lines = readText(f).split('\n');
  lines.forEach((line, i) => {
    for (const phrase of RELATIVE_PHRASES) {
      if (line.includes(phrase)) {
        fail(
          `${f.replace(dir + '/', '')}:${i + 1} 含相对表述「${phrase}」。` +
            '成品要自述能力，不要靠与别的东西比较来定义——改写成本 skill 自己的说法。',
        );
        phraseHits += 1;
      }
    }
  });
}
if (phraseHits === 0) {
  ok(`no relative phrasing (${RELATIVE_PHRASES.join(' / ')})`);
}

console.log('');
if (errors > 0) {
  console.error(`✗ Lint failed: ${errors} error(s), ${warnings} warning(s)`);
  process.exit(1);
}
console.log(`✓ All checks passed${warnings > 0 ? ` (${warnings} warning(s))` : ''}`);

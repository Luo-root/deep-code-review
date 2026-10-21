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
const refDir = join(dir, 'references');
if (existsSync(refDir)) {
  for (const f of readdirSync(refDir)) {
    if (!f.endsWith('.md')) continue;
    if (!refNames.includes(f)) {
      warn(`references/${f} is not referenced from SKILL.md (orphan?)`);
    }
    if (readFileSync(join(refDir, f)).includes(0x0d)) {
      fail(`references/${f} contains CRLF line endings`);
    }
  }
}

console.log('');
if (errors > 0) {
  console.error(`✗ Lint failed: ${errors} error(s), ${warnings} warning(s)`);
  process.exit(1);
}
console.log(`✓ All checks passed${warnings > 0 ? ` (${warnings} warning(s))` : ''}`);

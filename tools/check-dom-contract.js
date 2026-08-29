#!/usr/bin/env node
/*
[UI-REDESIGN / Stage 0]
WHAT: Dependency-free static checker for the HTML <-> JS DOM contract.
WHY: src/main.js captures ~109 element references as module-scope consts at parse
     time. A single removed, renamed, or duplicated id silently becomes null and
     breaks a feature at runtime with no build-time error. This repo has no
     package.json, linter, or test runner, so this script is the only automated
     gate the staged redesign has.
FUTURE: Add new capability as a new numbered check block following the existing
     pattern below; do not weaken an existing block to make a stage pass. Keep this
     file dependency-free and runnable as `node tools/check-dom-contract.js` so it
     works in any Codespace without an install step.
*/

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HTML_FILE = path.join(ROOT, 'index.html');

let failures = 0;
let warnings = 0;

function fail(label, detail) {
  failures++;
  console.log(`FAIL  ${label}`);
  if (detail) console.log(indent(detail));
}
function warn(label, detail) {
  warnings++;
  console.log(`WARN  ${label}`);
  if (detail) console.log(indent(detail));
}
function pass(label, detail) {
  console.log(`ok    ${label}${detail ? ` — ${detail}` : ''}`);
}
function indent(text) {
  return String(text)
    .split('\n')
    .map((l) => `        ${l}`)
    .join('\n');
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// docs/ is excluded per agents.md and is not referenced by index.html.
const jsFiles = walk(path.join(ROOT, 'src')).filter((f) => f.endsWith('.js'));
const html = fs.readFileSync(HTML_FILE, 'utf8');
const jsSources = new Map(jsFiles.map((f) => [f, fs.readFileSync(f, 'utf8')]));
const allJs = [...jsSources.values()].join('\n');

console.log(`DOM contract check — ${jsFiles.length} JS files, index.html\n`);

/* ---------- 1. every JS file parses ---------- */
{
  const bad = [];
  for (const file of jsFiles) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (err) {
      bad.push(`${path.relative(ROOT, file)}\n${err.stderr.toString().trim()}`);
    }
  }
  if (bad.length) fail('JavaScript syntax', bad.join('\n\n'));
  else pass('JavaScript syntax', `${jsFiles.length} files parse`);
}

/* ---------- 2. no duplicate ids in index.html ---------- */
const idAttrs = [
  ...html.matchAll(/\sid\s*=\s*"([^"]+)"/g),
  ...html.matchAll(/\sid\s*=\s*'([^']+)'/g),
].map((m) => m[1]);
const idCounts = new Map();
for (const id of idAttrs) idCounts.set(id, (idCounts.get(id) || 0) + 1);
const duplicateIds = [...idCounts].filter(([, n]) => n > 1);
{
  if (duplicateIds.length) {
    fail(
      'duplicate ids',
      duplicateIds.map(([id, n]) => `${id} appears ${n}x`).join('\n')
    );
  } else {
    pass('duplicate ids', `${idCounts.size} unique ids, none repeated`);
  }
}

/* ---------- 3. every getElementById target exists ---------- */
{
  const targets = new Map(); // id -> [files]
  for (const [file, src] of jsSources) {
    for (const m of src.matchAll(/getElementById\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
      if (!targets.has(m[1])) targets.set(m[1], new Set());
      targets.get(m[1]).add(path.relative(ROOT, file));
    }
  }
  const missing = [...targets].filter(([id]) => !idCounts.has(id));
  if (missing.length) {
    fail(
      'getElementById targets',
      missing
        .map(([id, files]) => `#${id} — referenced in ${[...files].join(', ')}`)
        .join('\n')
    );
  } else {
    pass('getElementById targets', `${targets.size} ids all present in index.html`);
  }
}

/* ---------- 4. dynamic id lookups flagged for human review ---------- */
{
  const dynamic = [];
  for (const [file, src] of jsSources) {
    src.split('\n').forEach((line, i) => {
      if (/getElementById\(\s*(?!["'`])/.test(line)) {
        dynamic.push(`${path.relative(ROOT, file)}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  if (dynamic.length) {
    warn(
      'computed getElementById calls (cannot be statically verified)',
      dynamic.join('\n')
    );
  } else {
    pass('computed getElementById calls', 'none');
  }
}

/* ---------- 5. aria / label references resolve ---------- */
{
  const broken = [];
  const refAttrs = /\s(aria-controls|aria-labelledby|aria-describedby|for|list)\s*=\s*(?:"([^"]+)"|'([^']+)')/g;
  for (const m of html.matchAll(refAttrs)) {
    const value = m[2] !== undefined ? m[2] : m[3];
    for (const id of value.trim().split(/\s+/)) {
      if (id && !idCounts.has(id)) broken.push(`${m[1]}="${id}"`);
    }
  }
  if (broken.length) fail('aria/label references', [...new Set(broken)].join('\n'));
  else pass('aria/label references', 'all resolve');
}

/* ---------- 6. local script/link/module paths resolve ---------- */
{
  const broken = [];
  const seen = new Set();
  const assetRefs = /(?:src|href)\s*=\s*(?:"(\.\/[^"]+|\.\.\/[^"]+|\/[^"]*)"|'(\.\/[^']+|\.\.\/[^']+|\/[^']*)')/g;
  for (const m of html.matchAll(assetRefs)) {
    const ref = m[1] !== undefined ? m[1] : m[2];
    if (seen.has(ref)) continue;
    seen.add(ref);
    const resolved = path.join(ROOT, ref.replace(/^\//, ''));
    if (!fs.existsSync(resolved)) broken.push(`${ref} (index.html)`);
  }
  const importRe = /\bfrom\s+["'](\.[^"']+)["']|import\s*\(\s*["'](\.[^"']+)["']\s*\)/g;
  for (const [file, src] of jsSources) {
    for (const m of src.matchAll(importRe)) {
      const ref = m[1] || m[2];
      const resolved = path.resolve(path.dirname(file), ref);
      if (!fs.existsSync(resolved) && !fs.existsSync(`${resolved}.js`)) {
        broken.push(`${ref} (${path.relative(ROOT, file)})`);
      }
    }
  }
  if (broken.length) fail('local asset & module paths', broken.join('\n'));
  else pass('local asset & module paths', 'all resolve');
}

/* ---------- 7. redesign-specific invariants ---------- */
{
  // Elements captured as module-scope consts must exist in static markup at
  // parse time. A protected workspace container must be shown/hidden with CSS,
  // never destroyed or rebuilt. This is a FOCUSED GUARD, not a proof: it cannot
  // confirm every captured DOM node stays attached at runtime. It catches the
  // specific mistake this codebase is prone to — a destructive DOM operation on
  // a variable whose name looks like a workspace container — and leaves the rest
  // to human review.
  const moduleScopeCaptures = (
    fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8').match(
      /^(?:const|let|var)\s+\w+\s*=\s*document\.getElementById/gm
    ) || []
  ).length;
  pass('module-scope element captures in src/main.js', String(moduleScopeCaptures));

  // Match `<ident>.<op>` where <ident> contains "workspace" (case-insensitive)
  // — e.g. galleryWorkspace, settingsWorkspace, workspacePanel — and <op> is a
  // destructive DOM operation. Property-assignment ops (innerHTML/outerHTML)
  // require `=`; method ops (replaceChildren/replaceWith/remove) require `(`.
  const destructiveOnWorkspace = [];
  const workspaceVar = /\b(\w*workspace\w*)\s*\.\s*(innerHTML\s*=|outerHTML\s*=|replaceChildren\s*\(|replaceWith\s*\(|remove\s*\()/i;
  for (const [file, src] of jsSources) {
    src.split('\n').forEach((line, i) => {
      const m = line.match(workspaceVar);
      if (m) {
        const op = m[2].replace(/\s*[=(]$/, '').trim();
        destructiveOnWorkspace.push(
          `${path.relative(ROOT, file)}:${i + 1}  ${m[1]}.${op}  —  ${line.trim()}`
        );
      }
    });
  }
  if (destructiveOnWorkspace.length) {
    fail(
      'destructive DOM op on a workspace-named variable (likely destroys captured refs — verify by hand)',
      destructiveOnWorkspace.join('\n')
    );
  } else {
    pass(
      'no destructive DOM op on workspace-named variables',
      'focused guard only — does not prove all captured nodes remain attached'
    );
  }
}

/* ---------- summary ---------- */
console.log(`\n${failures} failure(s), ${warnings} warning(s)`);
process.exit(failures ? 1 : 0);

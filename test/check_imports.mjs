#!/usr/bin/env node
/**
 * 静态检查：main.js 里用到的跨模块常量是否都正确导入。
 *
 * 背景：之前 main.js 用了 HOOK_FLYING 但没 import，
 * 该变量是 undefined → `state !== HOOK_FLYING` 恒成立 → 整段逻辑静默失效。
 * 这类 bug 不会报错，只是功能不生效，靠肉眼看代码很难发现。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname.replace(/^\//, '');
const files = readdirSync(SRC).filter(f => f.endsWith('.js'));

let problems = 0;

// 收集每个模块的导出
const exportsMap = new Map();
for (const f of files) {
  const src = readFileSync(join(SRC, f), 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:const|let|var|function|class)\s+(\w+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([\s\S]*?)\}/g)) {
    m[1].split(',').forEach(n => {
      const name = n.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    });
  }
  exportsMap.set(f, names);
}

// 检查每个文件的 import
for (const f of files) {
  const src = readFileSync(join(SRC, f), 'utf8');
  // import 语句可能跨行 → 用 [\s\S] 让 . 匹配换行
  for (const m of src.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*'\.\/([^']+)'/g)) {
    const imported = m[1].split(',').map(x => x.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    const target = m[2];
    const available = exportsMap.get(target);
    if (!available) continue;
    for (const name of imported) {
      if (!available.has(name)) {
        console.log(`❌ ${f}: 从 ${target} 导入了不存在的 ${name}`);
        problems++;
      }
    }
  }

  // 找出「用了但没导入」的模块级常量
  const localDecls = new Set();
  for (const m of src.matchAll(/(?:const|let|var|function|class)\s+(\w+)/g)) localDecls.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([\s\S]*?)\}\s*=/g)) {
    m[1].split(',').forEach(n => {
      const name = n.trim().split(':').pop().trim().split('=')[0].trim();
      if (name) localDecls.add(name);
    });
  }
  for (const m of src.matchAll(/import\s+(\w+)\s+from/g)) localDecls.add(m[1]);
  // 具名导入：import { A, B } from './x.js'  → A、B 都是本地可见的名字
  for (const m of src.matchAll(/import\s*\{([\s\S]*?)\}\s*from/g)) {
    m[1].split(',').forEach(n => {
      const name = n.trim().split(/\s+as\s+/).pop().trim();
      if (name) localDecls.add(name);
    });
  }

  // 收集所有被使用的大写常量
  const used = new Set([...src.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)].map(m => m[1]));
  for (const [mod, names] of exportsMap) {
    if (mod === f) continue;
    for (const name of names) {
      if (!/^HOOK_|^LAYER_|^TILE_/.test(name)) continue;  // 只查约定的常量前缀
      if (used.has(name) && !localDecls.has(name)) {
        console.log(`❌ ${f}: 用了 ${name}（来自 ${mod}）但没有 import`);
        problems++;
      }
    }
  }
}

if (problems === 0) {
  console.log('✓ 跨模块常量导入检查通过');
} else {
  console.log(`\n共 ${problems} 个问题`);
}
process.exit(problems ? 1 : 0);

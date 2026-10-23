#!/usr/bin/env node
/**
 * 把本地目录【完整同步】到 GitHub 仓库 —— 包括删除远端多余的文件。
 *
 * 背景：本机代理阻断了 git-upload-pack，但 api.github.com 可达，所以走 Git Data API。
 *      旧的 tools/gh_upload.js 只增不删，历史截图就一直堆在仓库里，
 *      这里改成"远端树 = 本地树"的镜像式同步。
 *
 * 用法:
 *   node tools/gh_sync.js <repo> [本地目录] [分支] [选项]
 *   node tools/gh_sync.js andguy/ddrace3d . main --squash
 *
 * 选项:
 *   --squash   把结果压成一个新的根提交（丢弃远端历史）。
 *              只有这样才能把历史里的大文件真正清掉 ——
 *              只在 HEAD 上删文件，旧的 blob 还留在 .git 里，仓库体积不会变小。
 *   --dry-run  只打印将要删除/改动的内容，不真写。
 *
 * 待上传清单 = git ls-files -c -o --exclude-standard，
 * 也就是【已被跟踪 + 未被忽略的新文件】，.gitignore 直接生效。
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const pos = args.filter(a => !a.startsWith('--'));

const REPO = pos[0] || 'andguy/ddrace3d';
const ROOT = pos[1] || '.';
const BRANCH = pos[2] || 'main';
const TOKEN = process.env.GH_TOKEN;
const MSG = process.env.COMMIT_MSG || 'sync';
const SQUASH = flags.has('--squash');
const DRY = flags.has('--dry-run');
const API = 'https://api.github.com';

if (!TOKEN) {
  console.error('缺少 GH_TOKEN 环境变量');
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'ddrace3d-sync'
};

async function api(path, method = 'GET', body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}\n${JSON.stringify(json).slice(0, 400)}`);
  return json;
}

/** 计算 git blob 的 sha1，用于判断"远端已有同样内容"从而跳过上传 */
function blobSha(buf) {
  return createHash('sha1')
    .update(`blob ${buf.length}\0`)
    .update(buf)
    .digest('hex');
}

// ── 待上传清单（.gitignore 直接生效）──
const listed = execFileSync('git', ['ls-files', '-z', '-c', '-o', '--exclude-standard'],
  { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
  .toString('utf8').split('\0').filter(Boolean);

// ── 远端现状 ──
let remote = new Map();      // path -> blob sha
let headSha = null;
try {
  const ref = await api(`/repos/${REPO}/git/ref/heads/${BRANCH}`);
  headSha = ref.object.sha;
  const tree = await api(`/repos/${REPO}/git/trees/${headSha}?recursive=1`);
  for (const x of tree.tree) {
    if (x.type === 'blob') remote.set(x.path, x.sha);
  }
} catch (e) {
  console.log('远端分支还不存在，将创建初始提交');
}

// ── 逐个文件：内容相同就复用远端 blob，否则上传 ──
const entries = [];
let uploaded = 0, reused = 0;
for (const rel of listed.sort()) {
  const buf = readFileSync(`${ROOT}/${rel}`);
  const sha = blobSha(buf);
  if (remote.get(rel) === sha) {
    entries.push({ path: rel, mode: '100644', type: 'blob', sha });
    reused++;
  } else {
    uploaded++;
    if (DRY) {
      entries.push({ path: rel, mode: '100644', type: 'blob', sha });
      continue;
    }
    const blob = await api(`/repos/${REPO}/git/blobs`, 'POST',
      { content: buf.toString('base64'), encoding: 'base64' });
    entries.push({ path: rel, mode: '100644', type: 'blob', sha: blob.sha });
  }
}

// ── 会被删掉的文件 ──
const keep = new Set(listed);
const doomed = [...remote.keys()].filter(p => !keep.has(p));

console.log(`仓库 ${REPO}@${BRANCH}`);
console.log(`  保留 ${listed.length} 个文件（上传 ${uploaded}，内容未变复用 ${reused}）`);
console.log(`  删除 ${doomed.length} 个远端多余文件`);
for (const p of doomed) console.log(`    - ${p}`);

if (DRY) {
  console.log('\n[dry-run] 未写入任何内容');
  process.exit(0);
}
if (doomed.length === 0 && uploaded === 0) {
  console.log('\n没有任何变化');
  process.exit(0);
}

// ── 建树 → 建提交 → 移动分支 ──
const tree = await api(`/repos/${REPO}/git/trees`, 'POST', { tree: entries });
const commit = await api(`/repos/${REPO}/git/commits`, 'POST', {
  message: MSG,
  tree: tree.sha,
  parents: SQUASH || !headSha ? [] : [headSha]
});

if (headSha) {
  await api(`/repos/${REPO}/git/refs/heads/${BRANCH}`, 'PATCH',
    { sha: commit.sha, force: true });
} else {
  await api(`/repos/${REPO}/git/refs`, 'POST',
    { ref: `refs/heads/${BRANCH}`, sha: commit.sha });
}

console.log(`\n✓ 已推送 ${commit.sha.slice(0, 7)}` +
  (SQUASH ? '（压缩为单个根提交，历史已丢弃）' : ''));

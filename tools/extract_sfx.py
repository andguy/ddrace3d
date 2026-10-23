#!/usr/bin/env python3
"""
把 DDNet 的 .wv 音效转成浏览器能用的标准 WAV。

背景：DDNet 的 data/audio/*.wv 文件头是 'wvpk'（WAVPACK 容器）。
注意它虽然内嵌了 RIFF/WAVE 头，但块里的数据是【压缩过的】，
直接抠出来会被浏览器当成 PCM 播放 → 时长算错、声音是噪声。
所以必须真正解码 → 用 ffmpeg。

用法：python tools/extract_sfx.py <src目录> <目标目录> [文件名...]

ffmpeg 路径可用环境变量 FFMPEG 指定，默认依次尝试：
  ffmpeg（PATH）/ d:/oopz/ffmpeg.exe / d:/JianyingPro/*/ffmpeg.exe
"""
import struct
import sys
import os
import glob
import subprocess


def find_ffmpeg():
    env = os.environ.get('FFMPEG')
    if env and os.path.exists(env):
        return env
    for name in ('ffmpeg',):
        from shutil import which
        p = which(name)
        if p:
            return p
    for pat in ('d:/oopz/ffmpeg.exe', 'd:/JianyingPro/*/ffmpeg.exe',
                'c:/ffmpeg*/bin/ffmpeg.exe'):
        hits = glob.glob(pat)
        if hits:
            return hits[0]
    return None


def extract_wav(src, dst, ff):
    """用 ffmpeg 解码 WAVPACK → 标准 PCM WAV（48kHz 单声道 16bit）"""
    cmd = [ff, '-hide_banner', '-loglevel', 'error', '-y',
           '-i', src, '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '1', dst]
    r = subprocess.run(cmd, capture_output=True)
    return r.returncode == 0 and os.path.exists(dst) and os.path.getsize(dst) > 44


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    src_dir, dst_dir = sys.argv[1], sys.argv[2]
    names = sys.argv[3:] or [
        'foley_dbljump-01', 'foley_dbljump-02',
        'hook_attach-01', 'hook_noattach-01',
    ]
    os.makedirs(dst_dir, exist_ok=True)

    ff = find_ffmpeg()
    if not ff:
        print('找不到 ffmpeg，请安装或设置环境变量 FFMPEG 指向它')
        sys.exit(1)
    print('  使用 ffmpeg:', ff)

    for name in names:
        src = os.path.join(src_dir, name + '.wv')
        dst = os.path.join(dst_dir, name + '.wav')
        if not os.path.exists(src):
            print('  跳过（不存在）:', src)
            continue
        if extract_wav(src, dst, ff):
            print('  ✓ %-24s -> %s (%d 字节)' % (name + '.wv', dst, os.path.getsize(dst)))
        else:
            print('  ✗ 转换失败:', src)


if __name__ == '__main__':
    main()

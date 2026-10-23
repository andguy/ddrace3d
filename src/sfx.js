// 音效：钩锁与二段跳
// 素材来自 DDNet 的 data/audio/*.wv —— 那是 WAVPACK 容器（文件头 'wvpk'），
// 但里面直接嵌着标准 RIFF/WAVE，用 tools/extract_sfx.py 抠出来即可，
// 不需要 ffmpeg。浏览器原生支持 WAV。
//
// 浏览器策略：首次用户交互后才能播放音频（自动播放限制）。
// 所以音效在第一次按键/触摸时才真正 unlock。

const SOUNDS = {
  dbljump: ['./vendor/sfx/foley_dbljump-01.wav', './vendor/sfx/foley_dbljump-02.wav'],
  hookAttach: ['./vendor/sfx/hook_attach-01.wav'],
  hookNoAttach: ['./vendor/sfx/hook_noattach-01.wav'],
};

class Sfx {
  constructor() {
    this.buffers = new Map();     // name -> AudioBuffer[]
    this.ctx = null;
    this.unlocked = false;
    this.lastPlay = new Map();    // 防止同一音效在极短时间内重复触发
    this.muted = false;
  }

  /** 初始化 AudioContext（必须在用户手势里调用） */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();

    // 预加载所有音效
    for (const [name, urls] of Object.entries(SOUNDS)) {
      const list = [];
      let pending = urls.length;
      for (const url of urls) {
        fetch(url)
          .then(r => r.arrayBuffer())
          .then(buf => this.ctx.decodeAudioData(buf))
          .then(decoded => {
            list.push(decoded);
            if (--pending === 0) this.buffers.set(name, list);
          })
          .catch(err => console.warn('音效加载失败', name, err));
      }
    }
    this.unlocked = true;
  }

  /**
   * 播放音效
   * @param {string} name  音效名
   * @param {number} volume 音量 0~1
   * @param {number} minGap 同名音效的最小间隔（秒），避免叠加成噪音
   */
  play(name, volume = 0.5, minGap = 0.05) {
    if (!this.ctx || this.muted || !this.unlocked) return;
    const now = this.ctx.currentTime;
    const last = this.lastPlay.get(name) || -1;
    if (now - last < minGap) return;
    this.lastPlay.set(name, now);

    const list = this.buffers.get(name);
    if (!list || !list.length) return;
    // 多个变体时随机挑一个
    const buf = list[Math.floor(Math.random() * list.length)];

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain);
    gain.connect(this.ctx.destination);
    src.start();
  }

  setMuted(m) {
    this.muted = m;
  }
}

export const sfx = new Sfx();

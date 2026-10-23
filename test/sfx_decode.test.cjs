// 验证音效能被浏览器解码并播放
const { spawn } = require('child_process');
const http = require('http');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9280;
function getJSON(url){return new Promise((res,rej)=>{http.get(url,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}})}).on('error',rej)})}
(async () => {
  const proc = spawn(EDGE, ['--headless=new','--enable-unsafe-swiftshader','--use-angle=swiftshader',
    '--remote-debugging-port='+PORT,'--window-size=860,430',
    '--autoplay-policy=no-user-gesture-required',
    'http://127.0.0.1:8117/index.html?touch=1'], {stdio:'ignore', detached:true});
  await new Promise(r=>setTimeout(r,3500));
  const t = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
  const page = t.find(x=>x.type==='page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id=0; const pending=new Map();
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data); if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id)}});
  await new Promise((res,rej)=>{ws.addEventListener('open',res);ws.addEventListener('error',rej)});
  const send=(method,params)=>new Promise(res=>{const mid=++id;pending.set(mid,res);ws.send(JSON.stringify({id:mid,method,params}))});
  const evalJS=async e=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});
    if(r.result?.exceptionDetails) return 'EXC: '+JSON.stringify(r.result.exceptionDetails).slice(0,300);
    return r.result?.result?.value};
  await new Promise(r=>setTimeout(r,3000));
  const res = await evalJS(`(async () => {
    const out = {};
    const ctx = new (window.AudioContext||window.webkitAudioContext)();
    out.ctxState = ctx.state;
    const files = ['foley_dbljump-01','foley_dbljump-02','hook_attach-01','hook_noattach-01'];
    out.decoded = {};
    for (const f of files) {
      try {
        const r = await fetch('./vendor/sfx/'+f+'.wav');
        const buf = await r.arrayBuffer();
        const dec = await ctx.decodeAudioData(buf);
        out.decoded[f] = { ok: true, dur: +dec.duration.toFixed(3), ch: dec.numberOfChannels, sr: dec.sampleRate };
      } catch(e) { out.decoded[f] = { ok: false, err: String(e).slice(0,80) }; }
    }
    return JSON.stringify(out, null, 1);
  })()`);
  console.log(res);
  ws.close(); try{proc.kill()}catch(e){}
  setTimeout(()=>process.exit(0), 300);
})();

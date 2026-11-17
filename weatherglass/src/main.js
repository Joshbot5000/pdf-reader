/* ───────── sky clock ───────── */
const sky = {live:true, lapse:false, min:0};
const nowMin = () => { const d=new Date(); return d.getHours()*60+d.getMinutes()+d.getSeconds()/60; };
sky.min = nowMin();
function phaseName(h){
  if(h<4.8||h>=20.2) return 'Night'; if(h<6.2) return 'Dawn'; if(h<7.6) return 'Sunrise'; if(h<11) return 'Morning';
  if(h<14) return 'Midday'; if(h<16.6) return 'Afternoon'; if(h<18) return 'Golden hour'; if(h<19) return 'Sunset'; return 'Dusk';
}
const hhmm = m => { m=((Math.floor(m)%1440)+1440)%1440; return String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0'); };

/* ───────── WebGL ───────── */
const cv = $('sky');
const gl = cv.getContext('webgl',{antialias:false,alpha:false,powerPreference:'high-performance'}) || cv.getContext('experimental-webgl');
let U = {}, glOK = false, quality = matchMedia('(pointer:coarse)').matches ? .8 : 1, fixedQ = 0;
function initGL(){
  if(!gl) return;
  const mk = (type,src) => { const s=gl.createShader(type); gl.shaderSource(s,src); gl.compileShader(s);
    if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  try{
    const pr = gl.createProgram();
    gl.attachShader(pr, mk(gl.VERTEX_SHADER,'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}'));
    gl.attachShader(pr, mk(gl.FRAGMENT_SHADER,FRAG));
    gl.linkProgram(pr);
    if(!gl.getProgramParameter(pr,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
    gl.useProgram(pr);
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,b);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr,'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);
    for(const n of ['uLayer','uRes','uT','uWT','uH','uScene','uSwash','uFade','uMistY','uDay','uTw','uElev','uSun','uMoon','uFireP','uRain','uWind','uCover','uFire','uWave','uMist','uFlash','uLant','uBolt','uLantP'])
      U[n] = gl.getUniformLocation(pr,n);
    const tex = gl.createTexture(); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,tex);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,true);
    gl.uniform1i(U.uLayer,0);
    glOK = true;
  }catch(e){ console.error('Weatherglass shader:',e.message); }
}
function resize(){
  const dpr = Math.min(window.devicePixelRatio||1, 2) * (fixedQ||quality);
  const w = Math.max(2,Math.round(cv.clientWidth*dpr)), h = Math.max(2,Math.round(cv.clientHeight*dpr));
  if(cv.width!==w||cv.height!==h){ cv.width=w; cv.height=h; if(gl) gl.viewport(0,0,w,h); }
  if(lc.width!==w||lc.height!==h){ lc.width=w; lc.height=h; }
  W=w; Hh=h; u=h/100;
  const P = cv.clientHeight > cv.clientWidth*1.15;
  if(!SC || SC.name!==S.scene || SC.P!==P || Math.abs((SC.asp||0)-w/h)>.25){ env.portrait=P; buildScene(); SC.asp=w/h; }
}
addEventListener('resize',resize);

const bolt = {x:.5,seed:1,t0:-99,power:0};
let windT = 0, lastT = performance.now(), fAcc=0, fN=0, fade=1, pendingScene=null;
function todayCount(){ const d=S.log[dayKey()]; return d?d.n:0; }
function swashAt(now){ let v=0; for(const e of env.waves){ const x=now-e.t0; if(x<0||x>9) continue; v=Math.max(v, e.str*sstep(1.7,3.3,x)*(1-sstep(3.3,8.6,x))); } return v; }
function frame(now){
  requestAnimationFrame(frame);
  const dt = Math.min(.1,(now-lastT)/1000); lastT = now; env.t += dt;
  fAcc += dt; fN++;
  if(fN>=45 && !fixedQ){ const avg=fAcc/fN; fAcc=0; fN=0;
    if(avg>.027 && quality>.4){ quality=Math.max(.4,quality*.84); resize(); }
    else if(avg<.0175 && quality<1){ quality=Math.min(1,quality*1.08); resize(); } }
  if(sky.lapse){ sky.min = (sky.min + dt*1440/45) % 1440; syncSkyUI(); }
  else if(sky.live){ sky.min = nowMin(); }
  // scene change: dip to black, swap, come back
  if(pendingScene){ fade=Math.max(0,fade-dt*4.5); if(fade<=0){ S.scene=pendingScene; pendingScene=null; SC=null; resize(); save(); } }
  else fade=Math.min(1,fade+dt*3);
  resize();
  const scn = S.scene, P = env.portrait, h = sky.min/60;
  const elev = Math.sin((h-6)/12*Math.PI);
  const day = clamp((elev+.12)/.4,0,1); const dayS = day*day*(3-2*day);
  const tw = Math.exp(-Math.pow((elev-.03)/.18,2));
  const H = scn==='lake' ? (P?.40:.29) : scn==='coast' ? (P?.47:.43) : (P?.38:.30);
  const sx = lerp(.12,.88,clamp((h-6)/12,-.2,1.2)), sy = H + elev*.6*(1-H);
  const hm = (h+12)%24, elevM = Math.sin((hm-6)/12*Math.PI);
  const mx = lerp(.14,.86,clamp((hm-6)/12,-.2,1.2)), my = H + elevM*.62*(1-H);
  const k = 1-Math.exp(-dt*1.6), m = S.mix;
  V.rain = lerp(V.rain,m.rain,k); V.wind = lerp(V.wind,m.wind,k); V.fire = lerp(V.fire,m.fire,k);
  V.wave = lerp(V.wave,m.shore,k); V.mist = lerp(V.mist,m.mist,k);
  V.cover = lerp(V.cover, clamp(.12 + m.rain*.72 + m.thunder*.45,0,1), k);
  V.lant = lerp(V.lant, Math.min(14,todayCount()), 1-Math.exp(-dt*.9));
  windT += dt*(.006 + V.wind*.075*(.5+env.gust));
  env.gust = gustAt(env.t); env.day = dayS; env.tw = tw; env.elev = elev; env.H = H;
  env.swash = lerp(env.swash, swashAt(now/1000)*(.35+.65*V.wave), 1-Math.exp(-dt*6));
  env.horC = skyColJS(.03);
  const age = (now-bolt.t0)/1000; let flash=0, bz=0;
  if(age>=0 && age<1.4){ const strobe = age<.42 ? (.7+.3*Math.sign(Math.sin(age*58+bolt.seed))) : 1;
    flash = bolt.power*Math.exp(-age*5.2)*strobe; bz = bolt.power*Math.exp(-age*11)*strobe; }
  V.flash = flash;
  director(dt); updateActors(dt);
  if(!glOK) return;
  try{ drawLayer(); }catch(e){ if(!frame.err){ frame.err=1; console.error('Weatherglass layer:',e); } }
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,lc);
  const fp = firePos(), water = scn==='lake'||scn==='coast';
  gl.uniform2f(U.uRes,cv.width,cv.height); gl.uniform1f(U.uT,env.t%3600); gl.uniform1f(U.uWT,windT); gl.uniform1f(U.uH,H);
  gl.uniform1f(U.uScene,SCENES[scn].idx); gl.uniform1f(U.uSwash,env.swash); gl.uniform1f(U.uFade,fade);
  gl.uniform1f(U.uMistY, water ? H : SC.gy(.5)+.05);
  gl.uniform1f(U.uDay,dayS); gl.uniform1f(U.uTw,tw); gl.uniform1f(U.uElev,elev);
  gl.uniform2f(U.uSun,sx,sy); gl.uniform2f(U.uMoon,mx,my); gl.uniform2f(U.uFireP,fp.x,fp.y);
  gl.uniform1f(U.uRain,V.rain); gl.uniform1f(U.uWind,V.wind); gl.uniform1f(U.uCover,V.cover); gl.uniform1f(U.uFire,V.fire);
  gl.uniform1f(U.uWave,V.wave); gl.uniform1f(U.uMist,V.mist); gl.uniform1f(U.uFlash,flash); gl.uniform1f(U.uLant,V.lant);
  gl.uniform3f(U.uBolt,bolt.x,bolt.seed,bz);
  if(scn==='lake') gl.uniform3f(U.uLantP,H*.94,H*(P?.62:.5),1);
  else if(scn==='coast') gl.uniform3f(U.uLantP,H*.96,H*.66,1);
  else gl.uniform3f(U.uLantP,H+(1-H)*.2,H+(1-H)*.78,0);
  gl.drawArrays(gl.TRIANGLES,0,3);
}

/* ───────── sound ─────────
   Desktop: the live engine. Phones and tablets: the mix is rendered into a looping track played
   by an <audio> element, which keeps playing with the screen locked or the app in the background.
   The live engine stays on for thunder you call by tapping and for the end-of-session bell. */
const A = {ctx:null,E:null,on:false,st:{}};
const TRACK_MODE = matchMedia('(pointer:coarse)').matches || /[?&]track=1/.test(location.search);
const TR = {el:null, cur:null, busy:false, id:0, key:'', lastPos:0, quietUntil:0};
const quiet = () => { TR.quietUntil = performance.now()+1500; };
let mutedByUser=false, nextAuto=0, nextWave=0;
function initAudio(){
  if(A.ctx) return;
  const AC = window.AudioContext||window.webkitAudioContext; if(!AC) return;
  try{ A.ctx = new AC(); A.E = buildAudio(A.ctx); }catch(e){ A.ctx=null; console.error('Weatherglass audio:',e); }
}
const trackPlaying = () => !!(TR.el && TR.cur && A.on && !TR.el.paused && TR.el.src===TR.cur.url);
function trackEl(){
  if(TR.el) return TR.el;
  const el = TR.el = document.createElement('audio'); el.loop = true; el.preload = 'auto'; el.setAttribute('playsinline',''); el.setAttribute('webkit-playsinline','');
  const ours = () => performance.now() < TR.quietUntil;
  // paused or played from the lock screen, headphones, or by a phone call: follow it
  el.addEventListener('pause',()=>{ if(A.on && !ours()) setSound(false,true); });
  el.addEventListener('play',()=>{ if(!A.on && !ours() && TR.cur && el.src===TR.cur.url){ mutedByUser=false; A.on=true; initAudio(); applyLevels(); syncSoundUI(); } });
  document.body.appendChild(el); return el;
}
const SILENT = (()=>{ const n=800, b=new Uint8Array(44+n), dv=new DataView(b.buffer), w=(o,t)=>{ for(let i=0;i<t.length;i++) b[o+i]=t.charCodeAt(i); };
  w(0,'RIFF'); dv.setUint32(4,36+n,true); w(8,'WAVEfmt '); dv.setUint32(16,16,true); dv.setUint16(20,1,true); dv.setUint16(22,1,true);
  dv.setUint32(24,8000,true); dv.setUint32(28,8000,true); dv.setUint16(32,1,true); dv.setUint16(34,8,true); w(36,'data'); dv.setUint32(40,n,true); b.fill(128,44);
  let t=''; for(let i=0;i<b.length;i++) t+=String.fromCharCode(b[i]); return 'data:audio/wav;base64,'+btoa(t); })();
function trackKey(){ const h=sky.min/60, d=env.day; return JSON.stringify([S.mix,S.scene,d<.2?0:d>.5?2:1,h>4.8&&h<9]); }
function queueTrack(delay=1200){
  if(!TRACK_MODE) return;
  clearTimeout(queueTrack.t); queueTrack.t = setTimeout(()=>{ queueTrack.t=0; buildTrack(); }, delay);
}
async function buildTrack(){
  const key = trackKey(); if(TR.cur && TR.key===key) return;
  if(TR.busy){ TR.again=true; return; }
  TR.busy=true; const id=++TR.id, h=sky.min/60;
  try{
    const r = await renderLoop({...S.mix},{day:env.day,scene:S.scene,dawn:h>4.8&&h<9,seed:Math.random()*99});
    if(r && id===TR.id){ const old=TR.cur; TR.cur={...r,url:URL.createObjectURL(r.blob)}; TR.key=key; useTrack(); if(old) setTimeout(()=>URL.revokeObjectURL(old.url),4000); }
  }catch(e){ console.error('Weatherglass track:',e); }
  TR.busy=false; if(TR.again){ TR.again=false; queueTrack(200); }
}
function useTrack(){   // swap the new render in, at the same point in the loop
  if(!A.on || !TR.cur) return;
  const el=trackEl(), pos = el.src===SILENT||!el.duration ? 0 : (el.currentTime % TR.cur.len);
  quiet(); el.src=TR.cur.url;
  const go=()=>{ try{ el.currentTime=pos; }catch(e){} quiet(); el.play().then(()=>applyLevels()).catch(()=>{}); };
  if(el.readyState>=1) go(); else el.addEventListener('loadedmetadata',go,{once:true});
  TR.lastPos=pos; mediaInfo();
}
function applyLevels(fast){
  if(!A.E) return;
  const m = trackPlaying() ? {rain:0,wind:0,fire:0,shore:0,mist:0,life:0,thunder:S.mix.thunder} : S.mix;   // the track carries the beds
  setLevels(A.E,m,A.on,S.vol,fast?.05:.5);
}
function mediaInfo(){
  const ms=navigator.mediaSession; if(!ms) return;
  try{
    ms.metadata = new MediaMetadata({title:SCENES[S.scene].name+(S.weather&&S.weather!=='Clear'?' · '+S.weather:''), artist:'Weatherglass', album:T.mode==='focus'?'Focus':'Break',
      artwork:[{src:'icon-512.png',sizes:'512x512',type:'image/png'},{src:'icon-192.png',sizes:'192x192',type:'image/png'}]});
    ms.playbackState = A.on ? 'playing' : 'paused';
  }catch(e){}
}
if(navigator.mediaSession){ try{
  navigator.mediaSession.setActionHandler('play',()=>{ mutedByUser=false; setSound(true); });
  navigator.mediaSession.setActionHandler('pause',()=>{ mutedByUser=true; setSound(false); });
  navigator.mediaSession.setActionHandler('stop',()=>{ mutedByUser=true; setSound(false); });
}catch(e){} }
function setSound(on, fromEl){
  if(on){
    initAudio(); if(!A.ctx){ toast('This browser cannot play sound'); return; } A.ctx.resume().catch(()=>{});
    if(TRACK_MODE){ const el=trackEl(); A.on=true;
      if(TR.cur && TR.key===trackKey()) useTrack();
      else { if(!TR.cur){ quiet(); el.src=SILENT; el.play().catch(()=>{}); } else useTrack(); queueTrack(0); } }   // the silent play unlocks the element inside this tap
  }
  A.on = on && !!A.ctx;
  if(!A.on && TR.el && !fromEl){ quiet(); TR.el.pause(); }
  applyLevels();
  if(!on && A.ctx) setTimeout(()=>{ if(!A.on) A.ctx.suspend(); },700);
  syncSoundUI();
}
function syncSoundUI(){ $('btnSound').setAttribute('aria-pressed',A.on?'true':'false'); $('sndWaves').style.opacity = A.on?1:.25; mediaInfo(); }
document.addEventListener('visibilitychange',()=>{ if(!document.hidden && A.on && A.ctx && A.ctx.state!=='running') A.ctx.resume().catch(()=>{}); });
function strike(x, manual, silent){
  bolt.x = clamp(x,.04,.96); bolt.seed = Math.random()*50; bolt.t0 = performance.now(); bolt.power = manual?1:.55+Math.random()*.45;
  if(A.on && !silent){ const dist = manual?Math.random()*.35:.15+Math.random()*.8; thunderSound(A.E, A.ctx.currentTime+.08+dist*1.9, dist, (bolt.x-.5)*1.4, manual?1:bolt.power); }
}
// The world clock: waves and lightning, seen and heard together, and the small random sounds.
setInterval(()=>{
  const now=performance.now()/1000;
  if(trackPlaying()){
    // follow the track: fire each wave and strike as the playhead passes it
    const pos=TR.el.currentTime, last=TR.lastPos, crossed=t=> last<=pos ? (t>last&&t<=pos) : (t>last||t<=pos);
    for(const w of TR.cur.waves) if(crossed(w.t)){ const ev={t0:now-((pos-w.t+TR.cur.len)%TR.cur.len),str:w.str}; env.waves.push(ev); if(env.waves.length>4) env.waves.shift(); }
    if(!reduceMotion && !document.hidden) for(const k of TR.cur.strikes) if(crossed(k.t)){ strike(k.x,false,true); bolt.power=k.power; }
    TR.lastPos=pos; nextWave=now+4; nextAuto=0;
    if(TR.key!==trackKey() && !TR.busy && !queueTrack.t) queueTrack(1500);
  } else {
    if(now>=nextWave){ const ev={t0:now,str:.6+Math.random()*.4}; env.waves.push(ev); if(env.waves.length>4) env.waves.shift();
      if(A.on && S.mix.shore>.02) waveSound(A.E,A.ctx.currentTime+.05,ev.str);
      nextWave = now + 6.5 + Math.random()*4.5; }
    const th=S.mix.thunder;
    if(th>.03 && !reduceMotion && !document.hidden){
      if(!nextAuto) nextAuto = now + 1.5 + Math.random()*4;
      if(now>=nextAuto){ strike(.08+Math.random()*.84,false); nextAuto = now + lerp(42,6.5,th)*(.55+Math.random()*.95); }
    } else nextAuto = 0;
    if(A.on){ const h=sky.min/60; stepAudio(A.E,A.ctx.currentTime,.2,A.st,{mix:S.mix,gust:env.gust,day:env.day,scene:S.scene,dawn:h>4.8&&h<9}); }
  }
},200);
env.waves.push({t0:performance.now()/1000-2.2,str:.8}); nextWave = performance.now()/1000+4;

/* ───────── Do Not Disturb through an Apple Shortcut ─────────
   A web page cannot change Focus itself. It can run a Shortcut the user made once, which
   turns on Do Not Disturb until the session ends and starts a Clock timer that rings even
   with the screen locked. */
const SHORTCUT = 'Weatherglass Focus';
const isApple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
const inFrame = (()=>{ try{ return window.top!==window; }catch(e){ return true; } })();
const shortcutURL = m => 'shortcuts://run-shortcut?name='+encodeURIComponent(SHORTCUT)+'&input=text&text='+m;
// minutes > 0: Do Not Disturb on until then. 0: off now.
function runShortcut(minutes){
  const m = minutes>0 ? Math.max(1,Math.ceil(minutes)) : 0, url = shortcutURL(m);
  S.dndActive = m>0; save(); renderDnd();
  try{
    if(!inFrame) location.href = url;
    else { const a=document.createElement('a'); a.href=url; a.target='_top'; a.rel='noopener'; document.body.appendChild(a); a.click(); a.remove(); }
  }catch(e){}
  // if the phone didn't switch to Shortcuts, offer a button to tap instead
  clearTimeout(runShortcut.t); $('dndCard').hidden=true;
  runShortcut.t = setTimeout(()=>{ if(!document.hidden) showDndCard(m); }, 1600);
  return url;
}
function showDndCard(m){
  $('dndLink').href = shortcutURL(m);
  $('dndLink').textContent = m>0 ? 'Turn on for '+m+' min' : 'Turn off now';
  $('dndCardMsg').textContent = inFrame
    ? 'Inside the Claude app, Weatherglass can’t open Shortcuts by itself. Tap the button. To make it automatic, open Weatherglass from your Home Screen or in Safari.'
    : 'Your phone didn’t switch to Shortcuts. Tap the button. If nothing happens, check your shortcut is named exactly “'+SHORTCUT+'”.';
  $('dndCard').hidden=false; setZenSafe();
}
function setZenSafe(){ document.body.classList.remove('zen'); }
document.addEventListener('visibilitychange',()=>{ if(document.hidden){ clearTimeout(runShortcut.t); $('dndCard').hidden=true; } });
function bell(kind){
  const ctx=A.ctx; if(!ctx||!A.on) return; const t=ctx.currentTime+.05;
  const notes = kind==='focus' ? [392,587.3,784,1174.7] : [523.3,784];
  notes.forEach((fq,i)=>{ const o=ctx.createOscillator(), g=ctx.createGain(); o.type='sine'; o.frequency.value=fq;
    const st=t+i*.16; g.gain.setValueAtTime(0,st); g.gain.linearRampToValueAtTime(.2/(1+i*.35),st+.012); g.gain.exponentialRampToValueAtTime(.0006,st+4.5);
    o.connect(g); g.connect(A.E.master); o.start(st); o.stop(st+4.7); });
}

/* ───────── timer ───────── */
const T = S.timer;
const LENS = [5,15,25,50];
let wake=null;
async function holdWake(on){ try{ if(on && navigator.wakeLock){ wake = await navigator.wakeLock.request('screen'); } else if(wake){ await wake.release(); wake=null; } }catch(e){} }
document.addEventListener('visibilitychange',()=>{ if(!document.hidden && T.running) holdWake(true); });
function setMode(mode){ T.mode=mode; T.total = (mode==='focus'?S.len:Math.max(1,Math.round(S.len/5)))*60000; T.remain=T.total; T.running=false; }
function startTimer(fromUser){
  if(T.remain<=0) setMode(T.mode);
  const fresh = T.remain>=T.total-1000;
  T.running=true; T.endAt=Date.now()+T.remain; holdWake(true); if(!A.on && !mutedByUser) setSound(true); renderTimer(); save(); mediaInfo();
  if(fromUser && S.dnd && isApple && T.mode==='focus') runShortcut(T.remain/60000);
}
function pauseTimer(fromUser){ T.remain=Math.max(0,T.endAt-Date.now()); T.running=false; holdWake(false); renderTimer(); save(); if(fromUser) dndOff(); }
function dndOff(){ if(S.dndActive && isApple) runShortcut(0); }
function finish(){
  if(T.mode==='focus'){
    const k=dayKey(); const d=S.log[k]||(S.log[k]={n:0,min:0}); d.n++; d.min+=Math.round(T.total/60000);
    S.dndActive=false; renderDnd(); bell('focus'); toast('Session done. A lantern is lit.'); setMode('break'); startTimer(); renderLog(); touch();
  } else { bell('break'); toast('Break over. Ready when you are.'); setMode('focus'); holdWake(false); }
  renderTimer(); save();
}
let lastShown='';
function renderTimer(){
  if($('btnDndQuick')) renderDnd();
  const rem = T.running ? Math.max(0,T.endAt-Date.now()) : T.remain;
  const s = Math.ceil(rem/1000), txt = String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
  if(txt!==lastShown){ lastShown=txt; const el=$('digits'); el.textContent='';
    for(const ch of txt){ const sp=document.createElement('span'); sp.textContent=ch; if(ch===':') sp.className='c'; el.appendChild(sp); }
    el.setAttribute('aria-label',txt+' remaining'); }
  $('bar').style.width = (100*(1-rem/T.total)).toFixed(2)+'%';
  $('mode').innerHTML = T.mode==='focus' ? 'Focus' : '<i>Break</i>';
  const go=$('btnGo'); go.classList.toggle('running',T.running);
  $('goText').textContent = T.running ? 'Pause' : (rem<T.total ? 'Resume' : (T.mode==='focus'?'Start focus':'Start break'));
  $('goIcon').innerHTML = T.running ? '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>' : '<path d="M7 4.5v15l12-7.5z"/>';
  const aim = S.tasks.find(t=>t.id===S.aim && !t.done);
  $('intent').textContent = T.mode==='break' ? 'Look away. Breathe.' : (aim ? aim.text : '');
  for(const b of $('lens').children) b.setAttribute('aria-pressed', String(+b.dataset.m===S.len));
}
setInterval(()=>{ if(T.running && Date.now()>=T.endAt){ T.remain=0; finish(); } else if(T.running) renderTimer();
  $('clock').textContent = hhmm(sky.min)+' · '+phaseName(sky.min/60)+' · '+SCENES[S.scene].name; if(sky.live&&!sky.lapse) syncSkyUI(); },250);

/* ───────── UI wiring ───────── */
function toast(msg){ const t=$('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toast.t); toast.t=setTimeout(()=>t.classList.remove('show'),2600); }
LENS.forEach(mn=>{ const b=document.createElement('button'); b.textContent=mn; b.dataset.m=mn; b.title=mn+' minutes';
  b.onclick=()=>{ S.len=mn; if(T.mode==='focus'&&!T.running){ setMode('focus'); } renderTimer(); touch(); }; $('lens').appendChild(b); });
$('btnGo').onclick = () => T.running ? pauseTimer(true) : startTimer(true);
$('btnReset').onclick = () => { setMode(T.mode); holdWake(false); renderTimer(); save(); dndOff(); };
$('btnSkip').onclick = () => { setMode(T.mode==='focus'?'break':'focus'); holdWake(false); renderTimer(); save(); dndOff(); };
$('btnSound').onclick = () => { mutedByUser = A.on; setSound(!A.on); };
const setZen = z => { document.body.classList.toggle('zen',z); if(z) toast('Tap anywhere to bring the controls back'); };
$('btnZen').onclick = () => setZen(true);
const fsEl = document.documentElement;
if(!fsEl.requestFullscreen) $('btnFull').hidden = true;
$('btnFull').onclick = () => { try{ (document.fullscreenElement ? document.exitFullscreen() : fsEl.requestFullscreen()).catch(()=>{}); }catch(e){} };
cv.addEventListener('pointerdown',e=>{
  if(document.body.classList.contains('zen')){ setZen(false); return; }
  const r=cv.getBoundingClientRect(); strike((e.clientX-r.left)/r.width,true); $('hint').style.opacity=0;
});
addEventListener('keydown',e=>{
  if((e.target.tagName==='INPUT' && e.target.type!=='range') || e.target.tagName==='TEXTAREA') return;
  if(e.code==='Space'){ e.preventDefault(); T.running?pauseTimer(true):startTimer(true); }
  else if(e.key==='h'||e.key==='H') setZen(!document.body.classList.contains('zen'));
  else if(e.key==='m'||e.key==='M') $('btnSound').click();
  else if(e.key==='f'||e.key==='F') $('btnFull').click();
  else if(e.key==='Escape') setZen(false);
});

const panel=$('panel');
const isPhone = () => matchMedia('(max-width:899.98px)').matches;
if(isPhone()) panel.dataset.open='false';
for(const b of panel.querySelectorAll('[role=tab]')) b.onclick = () => {
  const was = b.getAttribute('aria-selected')==='true';
  if(was && isPhone()){ panel.dataset.open = panel.dataset.open==='true'?'false':'true'; return; }
  panel.dataset.open='true';
  for(const o of panel.querySelectorAll('[role=tab]')){ const on=o===b; o.setAttribute('aria-selected',String(on)); $('pane-'+o.dataset.tab).hidden=!on; }
};

// places, weather and the mixer
const fill = el => el.style.setProperty('--v',(100*(el.value-el.min)/(el.max-el.min))+'%');
function setScene(name){
  if(!SCENES[name] || (name===S.scene && !pendingScene)) return;
  pendingScene = name; const w = WEATHER[S.weather]||{};
  S.mix = {...SCENES[name].mix, ...(S.weather&&S.weather!=='Clear'?w:{})};
  syncMix(); applyLevels(); markChips(name); save(); queueTrack(); mediaInfo();
}
function buildMix(){
  for(const id in SCENES){ const c=document.createElement('button'); c.className='chip'; c.textContent=SCENES[id].name; c.dataset.s=id; c.onclick=()=>setScene(id); $('places').appendChild(c); }
  for(const name in WEATHER){ const c=document.createElement('button'); c.className='chip'; c.textContent=name; c.dataset.p=name;
    c.onclick=()=>{ const base=SCENES[pendingScene||S.scene].mix; S.mix={...S.mix, rain:0, thunder:0, wind:base.wind, ...WEATHER[name]}; S.weather=name; syncMix(); applyLevels(); save(); queueTrack(); mediaInfo(); }; $('presets').appendChild(c); }
  const box=$('mix');
  for(const L of LAYERS){
    const lab=document.createElement('label'); lab.textContent=L.name; lab.htmlFor='mx-'+L.id;
    const r=document.createElement('input'); r.type='range'; r.min=0; r.max=100; r.id='mx-'+L.id;
    const o=document.createElement('output'); o.htmlFor=r.id;
    r.oninput=()=>{ S.mix[L.id]=r.value/100; if(L.id==='rain'||L.id==='thunder') S.weather=''; o.textContent=r.value; fill(r); applyLevels(true); markChips(); save(); queueTrack(); };
    box.append(lab,r,o);
  }
}
function markChips(scene){ const sc=scene||pendingScene||S.scene;
  for(const c of $('places').children) c.setAttribute('aria-pressed',String(c.dataset.s===sc));
  for(const c of $('presets').children) c.setAttribute('aria-pressed',String(c.dataset.p===S.weather)); }
function syncMix(){ for(const L of LAYERS){ const r=$('mx-'+L.id); r.value=Math.round((S.mix[L.id]||0)*100); r.nextElementSibling.textContent=r.value; fill(r); } markChips(); }

function syncSkyUI(){ const r=$('skyRange'); r.value=Math.floor(sky.min); $('skyLabel').textContent=hhmm(sky.min)+' · '+phaseName(sky.min/60);
  $('btnLive').setAttribute('aria-pressed',String(sky.live&&!sky.lapse)); $('btnLapse').setAttribute('aria-pressed',String(sky.lapse)); }
$('skyRange').oninput = e => { sky.live=false; sky.lapse=false; sky.min=+e.target.value; syncSkyUI(); };
$('btnLive').onclick = () => { sky.live=true; sky.lapse=false; sky.min=nowMin(); syncSkyUI(); };
$('btnLapse').onclick = () => { sky.lapse=!sky.lapse; sky.live=false; syncSkyUI(); };

// today
function renderTasks(){
  const ul=$('tasks'); ul.textContent='';
  if(!S.tasks.length){ const p=document.createElement('li'); p.className='empty'; p.textContent='Nothing yet. Add the one thing that would make today a good day.'; ul.appendChild(p); }
  for(const t of S.tasks){
    const li=document.createElement('li'); if(t.done) li.classList.add('done'); if(t.id===S.aim&&!t.done) li.classList.add('focus');
    const tick=document.createElement('button'); tick.className='tick'; tick.setAttribute('aria-label',(t.done?'Mark not done: ':'Mark done: ')+t.text);
    tick.innerHTML='<svg viewBox="0 0 12 12"><path d="M2.5 6.2l2.4 2.4 4.6-5"/></svg>';
    tick.onclick=()=>{ t.done=!t.done; renderTasks(); renderTimer(); touch(); };
    const txt=document.createElement('span'); txt.className='txt'; txt.textContent=t.text;
    const aim=document.createElement('button'); aim.className='aim'; aim.textContent = t.id===S.aim&&!t.done?'aiming':'aim';
    aim.onclick=()=>{ S.aim = S.aim===t.id?'':t.id; renderTasks(); renderTimer(); touch(); };
    const del=document.createElement('button'); del.className='del'; del.textContent='×'; del.setAttribute('aria-label','Delete: '+t.text);
    del.onclick=()=>{ S.tasks=S.tasks.filter(x=>x!==t); renderTasks(); renderTimer(); touch(); };
    li.append(tick,txt,aim,del); ul.appendChild(li);
  }
  const left=S.tasks.filter(t=>!t.done).length; $('tabCount').textContent = left||'';
  $('exampleNote').hidden = !S.tasks.some(t=>t.ex);
}
$('addForm').addEventListener('submit',e=>{ e.preventDefault(); const v=$('addInput').value.trim(); if(!v) return;
  const t={id:uid(),text:v,done:false}; S.tasks.push(t); if(!S.tasks.some(x=>x.id===S.aim&&!x.done)) S.aim=t.id; $('addInput').value=''; renderTasks(); renderTimer(); touch(); });
$('btnClearEx').onclick = () => { S.tasks=S.tasks.filter(t=>!t.ex); renderTasks(); renderTimer(); touch(); };

function renderLog(){
  const today=S.log[dayKey()]||{n:0,min:0};
  $('stSessions').textContent=today.n; $('stMinutes').textContent=today.min;
  let streak=0; const d=new Date(); if(!(S.log[dayKey(d)]||{}).n) d.setDate(d.getDate()-1);
  while((S.log[dayKey(d)]||{}).n){ streak++; d.setDate(d.getDate()-1); }
  $('stStreak').textContent=streak;
  const wk=$('week'); wk.textContent=''; const days=[]; let mx=30;
  for(let i=6;i>=0;i--){ const x=new Date(); x.setDate(x.getDate()-i); const v=(S.log[dayKey(x)]||{}).min||0; mx=Math.max(mx,v); days.push({v,l:'SMTWTFS'[x.getDay()],now:i===0}); }
  for(const q of days){ const c=document.createElement('div'); if(q.now) c.className='now'; const b=document.createElement('i'); b.style.height=(q.v/mx*72)+'px'; b.title=q.v+' min';
    const s=document.createElement('span'); s.textContent=q.l; c.append(b,s); wk.appendChild(c); }
}

/* ───────── sync: tasks, aim, session length and the log follow you ───────── */
let cloud=null, pushT=0;
const syncDoc = () => ({rev:S.rev||0, dev:S.dev, tasks:S.tasks, aim:S.aim, log:S.log, len:S.len});
function touch(){ S.rev=Date.now(); save(); if(cloud){ clearTimeout(pushT); pushT=setTimeout(push,1200); } }
function push(){ if(!cloud) return; cloud.set(syncDoc()).then(()=>syncStatus(true)).catch(()=>syncStatus(false,'Could not reach your Claude account just now. Changes are saved on this device.')); }
function adopt(d, force){
  if(!d || typeof d!=='object') return false; let ch=false;
  for(const k in (d.log||{})){ const a=S.log[k]||{n:0,min:0}, b=d.log[k]||{}; if((b.n||0)>a.n||(b.min||0)>a.min){ S.log[k]={n:Math.max(a.n,b.n||0),min:Math.max(a.min,b.min||0)}; ch=true; } }
  if(Array.isArray(d.tasks) && (force || (d.rev||0)>(S.rev||0))){
    S.tasks=d.tasks.filter(t=>t&&typeof t.text==='string').map(t=>({id:String(t.id||uid()),text:t.text.slice(0,200),done:!!t.done,...(t.ex?{ex:true}:{})}));
    S.aim=String(d.aim||''); if(LENS.includes(d.len) && d.len!==S.len){ S.len=d.len; if(T.mode==='focus'&&!T.running&&T.remain===T.total) setMode('focus'); }
    S.rev=d.rev||Date.now(); ch=true; }
  if(ch){ renderTasks(); renderLog(); renderTimer(); save(); }
  return ch;
}
function syncStatus(ok,msg){ $('syncDot').classList.toggle('on',!!ok);
  $('syncNote').textContent = msg || (ok ? 'Synced with your Claude account. Tasks and lanterns follow you to any device where you open this page signed in.' : 'Saved on this device.'); }
async function initSync(){
  try{
    const c = window.claude; if(!c || !c.use) return;
    const [db,user] = await Promise.all([c.use('db'), c.use('user')]); if(!db||!user) return;
    const id = await user.id(); if(!id) return;
    cloud = db.collection('data/users/'+id).doc('weatherglass');
    let first=true;
    cloud.onSnapshot(snap=>{
      const d = snap.exists ? snap.data() : null;
      if(first){ first=false; syncStatus(true);
        if(d){ const fresh = !S.rev; adopt(d, fresh); if(!fresh && (S.rev||0)>(d.rev||0)) push(); }
        else if(S.rev) push();
        return; }
      if(d && d.dev!==S.dev) adopt(d,false);
    }, ()=>{ cloud=null; syncStatus(false); });
  }catch(e){ cloud=null; }
}
const encodeXfer = () => 'WG1:'+btoa(unescape(encodeURIComponent(JSON.stringify(syncDoc()))));
$('btnExport').onclick = async () => { const code=encodeXfer(); const box=$('xfer');
  try{ await navigator.clipboard.writeText(code); toast('Code copied. Paste it on your other device.'); }
  catch(e){ box.hidden=false; box.value=code; box.focus(); box.select(); toast('Select and copy this code'); } };
$('btnImport').onclick = () => { const box=$('xfer'); box.hidden=false; box.value=''; $('btnLoad').hidden=false; box.focus(); };
$('btnLoad').onclick = () => { const raw=$('xfer').value.trim();
  try{ if(!raw.startsWith('WG1:')) throw 0; const d=JSON.parse(decodeURIComponent(escape(atob(raw.slice(4))))); d.rev=Date.now(); adopt(d,true); touch();
    $('xfer').hidden=true; $('btnLoad').hidden=true; toast('Loaded your tasks and lanterns'); }
  catch(e){ toast('That code is not valid. Copy it again from the other device.'); } };

/* ───────── boot ───────── */
if(T.running && Date.now()>=T.endAt){ T.running=false; T.remain=T.total; }   // a session that ran out while away is not counted
buildMix(); syncMix(); syncSkyUI(); renderTasks(); renderLog(); renderTimer();
initGL(); resize();
if(!glOK){ cv.style.background='linear-gradient(#0b1230,#3a2a5c 55%,#0a1420 56%,#05070d)'; }
requestAnimationFrame(frame);
setTimeout(()=>{ $('hint').style.opacity=0; },12000);
initSync();
if(TRACK_MODE) setTimeout(()=>queueTrack(0),2500);
// One switch, shown under the timer and in Today. Turning it on mid-session applies it straight away.
function toggleDnd(){
  S.dnd=!S.dnd; save(); renderDnd();
  const focusing = T.running && T.mode==='focus';
  if(S.dnd){
    if(!S.dndSetup){ S.dndSetup=true; save(); openDndSetup(); toast('Make the shortcut once, then tap Test'); return; }
    if(focusing) runShortcut((T.endAt-Date.now())/60000);
    else toast('Do Not Disturb will turn on when you start focus');
  } else { if(focusing || S.dndActive) runShortcut(0); else toast('Do Not Disturb won’t be used'); }
}
function openDndSetup(){
  if(isPhone()) panel.dataset.open='true';
  for(const o of panel.querySelectorAll('[role=tab]')){ const on=o.dataset.tab==='today'; o.setAttribute('aria-selected',String(on)); $('pane-'+o.dataset.tab).hidden=!on; }
  $('dndSteps').open=true; setTimeout(()=>$('dndBox').scrollIntoView({behavior:'smooth',block:'start'}),60);
}
function renderDnd(){
  $('dndApple').hidden=!isApple; $('dndOther').hidden=isApple;
  $('btnDndQuick').hidden=!isApple;
  $('btnDnd').setAttribute('aria-pressed',String(!!S.dnd)); $('btnDnd').textContent = S.dnd ? 'Do Not Disturb during focus: on' : 'Do Not Disturb during focus: off';
  $('btnDndQuick').setAttribute('aria-pressed',String(!!S.dnd));
  $('dndQuickText').textContent = !S.dnd ? 'Do Not Disturb off' : (S.dndActive && T.running && T.mode==='focus') ? 'Do Not Disturb on' : 'Do Not Disturb with focus';
}
$('btnDnd').onclick = toggleDnd;
$('btnDndQuick').onclick = toggleDnd;
$('btnDndTest').onclick = () => { S.dndSetup=true; save(); runShortcut(1); };
$('dndCardClose').onclick = () => { $('dndCard').hidden=true; };
$('dndLink').addEventListener('click',()=>{ setTimeout(()=>{ $('dndCard').hidden=true; },400); });
$('btnCopyPrompt').onclick = async () => { const t=$('dndPrompt').textContent;
  try{ await navigator.clipboard.writeText(t); toast('Copied. Paste it into Shortcuts.'); }
  catch(e){ const r=document.createRange(); r.selectNodeContents($('dndPrompt')); const sel=getSelection(); sel.removeAllRanges(); sel.addRange(r); toast('Selected. Tap Copy.'); } };
renderDnd();
window.__wg = {S,V,env,T,sky,actors,TR,A,TRACK_MODE,trackPlaying,buildTrack,runShortcut,spawn,strike,finish,setScene,setMode,renderLog,renderTimer,syncSkyUI,renderOffline,adopt,encodeXfer,setQ:q=>{fixedQ=q;resize();},get SC(){return SC;}};

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

/* ───────── live audio ───────── */
const A = {ctx:null,E:null,on:false,st:{}};
let mutedByUser=false, nextAuto=0, nextWave=0;
function iosUnlock(){   // a silent looping <audio> keeps iPhone sound playing with the ring switch off
  if(iosUnlock.el) return;
  try{ const n=4000, b=new Uint8Array(44+n), dv=new DataView(b.buffer), w=(o,s)=>{ for(let i=0;i<s.length;i++) b[o+i]=s.charCodeAt(i); };
    w(0,'RIFF'); dv.setUint32(4,36+n,true); w(8,'WAVEfmt '); dv.setUint32(16,16,true); dv.setUint16(20,1,true); dv.setUint16(22,1,true);
    dv.setUint32(24,8000,true); dv.setUint32(28,8000,true); dv.setUint16(32,1,true); dv.setUint16(34,8,true); w(36,'data'); dv.setUint32(40,n,true); b.fill(128,44);
    let s=''; for(let i=0;i<b.length;i++) s+=String.fromCharCode(b[i]);
    const a=iosUnlock.el=document.createElement('audio'); a.loop=true; a.setAttribute('playsinline',''); a.src='data:audio/wav;base64,'+btoa(s); a.play().catch(()=>{});
  }catch(e){}
}
function initAudio(){
  if(A.ctx) return;
  const AC = window.AudioContext||window.webkitAudioContext; if(!AC) return;
  try{ A.ctx = new AC(); A.E = buildAudio(A.ctx); }catch(e){ A.ctx=null; console.error('Weatherglass audio:',e); }
}
function applyLevels(fast){ if(A.E) setLevels(A.E,S.mix,A.on,S.vol,fast?.05:.5); }
function setSound(on){
  if(on){ initAudio(); if(!A.ctx){ toast('This browser cannot play sound'); return; } iosUnlock(); A.ctx.resume(); }
  A.on = on && !!A.ctx; applyLevels();
  if(!on && A.ctx) setTimeout(()=>{ if(!A.on) A.ctx.suspend(); },700);
  $('btnSound').setAttribute('aria-pressed',A.on?'true':'false');
  $('sndWaves').style.opacity = A.on?1:.25;
}
function strike(x, manual){
  bolt.x = clamp(x,.04,.96); bolt.seed = Math.random()*50; bolt.t0 = performance.now(); bolt.power = manual?1:.55+Math.random()*.45;
  if(A.on){ const dist = manual?Math.random()*.35:.15+Math.random()*.8; thunderSound(A.E, A.ctx.currentTime+.08+dist*1.9, dist, (bolt.x-.5)*1.4, manual?1:bolt.power); }
}
// The world clock: waves (seen and heard together), lightning, and the small random sounds.
setInterval(()=>{
  const now=performance.now()/1000;
  if(now>=nextWave){ const ev={t0:now,str:.6+Math.random()*.4}; env.waves.push(ev); if(env.waves.length>4) env.waves.shift();
    if(A.on && S.mix.shore>.02) waveSound(A.E,A.ctx.currentTime+.05,ev.str);
    nextWave = now + 6.5 + Math.random()*4.5; }
  const th=S.mix.thunder;
  if(th>.03 && !reduceMotion && !document.hidden){
    if(!nextAuto) nextAuto = now + 1.5 + Math.random()*4;
    if(now>=nextAuto){ strike(.08+Math.random()*.84,false); nextAuto = now + lerp(42,6.5,th)*(.55+Math.random()*.95); }
  } else nextAuto = 0;
  if(A.on){ const h=sky.min/60; stepAudio(A.E,A.ctx.currentTime,.2,A.st,{mix:S.mix,gust:env.gust,day:env.day,scene:S.scene,dawn:h>4.8&&h<9}); }
},200);
env.waves.push({t0:performance.now()/1000-2.2,str:.8}); nextWave = performance.now()/1000+4;
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
function startTimer(){ if(T.remain<=0) setMode(T.mode); T.running=true; T.endAt=Date.now()+T.remain; holdWake(true); if(!A.on && !mutedByUser) setSound(true); renderTimer(); save(); }
function pauseTimer(){ T.remain=Math.max(0,T.endAt-Date.now()); T.running=false; holdWake(false); renderTimer(); save(); }
function finish(){
  if(T.mode==='focus'){
    const k=dayKey(); const d=S.log[k]||(S.log[k]={n:0,min:0}); d.n++; d.min+=Math.round(T.total/60000);
    bell('focus'); toast('Session done. A lantern is lit.'); setMode('break'); startTimer(); renderLog(); touch();
  } else { bell('break'); toast('Break over. Ready when you are.'); setMode('focus'); holdWake(false); }
  renderTimer(); save();
}
let lastShown='';
function renderTimer(){
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
$('btnGo').onclick = () => T.running ? pauseTimer() : startTimer();
$('btnReset').onclick = () => { setMode(T.mode); holdWake(false); renderTimer(); save(); };
$('btnSkip').onclick = () => { setMode(T.mode==='focus'?'break':'focus'); holdWake(false); renderTimer(); save(); };
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
  if(e.code==='Space'){ e.preventDefault(); T.running?pauseTimer():startTimer(); }
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
  syncMix(); applyLevels(); markChips(name); save();
}
function buildMix(){
  for(const id in SCENES){ const c=document.createElement('button'); c.className='chip'; c.textContent=SCENES[id].name; c.dataset.s=id; c.onclick=()=>setScene(id); $('places').appendChild(c); }
  for(const name in WEATHER){ const c=document.createElement('button'); c.className='chip'; c.textContent=name; c.dataset.p=name;
    c.onclick=()=>{ const base=SCENES[pendingScene||S.scene].mix; S.mix={...S.mix, rain:0, thunder:0, wind:base.wind, ...WEATHER[name]}; S.weather=name; syncMix(); applyLevels(); save(); }; $('presets').appendChild(c); }
  const box=$('mix');
  for(const L of LAYERS){
    const lab=document.createElement('label'); lab.textContent=L.name; lab.htmlFor='mx-'+L.id;
    const r=document.createElement('input'); r.type='range'; r.min=0; r.max=100; r.id='mx-'+L.id;
    const o=document.createElement('output'); o.htmlFor=r.id;
    r.oninput=()=>{ S.mix[L.id]=r.value/100; if(L.id==='rain'||L.id==='thunder') S.weather=''; o.textContent=r.value; fill(r); applyLevels(true); markChips(); save(); };
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
window.__wg = {S,V,env,T,sky,actors,spawn,strike,finish,setScene,setMode,renderLog,renderTimer,syncSkyUI,renderOffline,adopt,encodeXfer,setQ:q=>{fixedQ=q;resize();},get SC(){return SC;}};

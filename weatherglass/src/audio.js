/* ───────── audio: every sound is built from noise and sine grains, shaped like the real thing ───────── */
function noiseBuf(ctx,kind,sec){
  const sr=ctx.sampleRate, L=Math.floor(sr*sec), N=Math.floor(sr*.25), buf=ctx.createBuffer(2,L,sr);
  for(let c=0;c<2;c++){
    const x=new Float32Array(L+N); let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0,br=0;
    for(let i=0;i<L+N;i++){ const w=Math.random()*2-1;
      if(kind==='white') x[i]=w*.5;
      else if(kind==='pink'){ b0=.99886*b0+w*.0555179; b1=.99332*b1+w*.0750759; b2=.969*b2+w*.153852; b3=.8665*b3+w*.3104856;
        b4=.55*b4+w*.5329522; b5=-.7616*b5-w*.016898; x[i]=(b0+b1+b2+b3+b4+b5+b6+w*.5362)*.11; b6=w*.115926; }
      else { br=(br+.02*w)/1.02; x[i]=br*3.4; } }
    const d=buf.getChannelData(c);
    for(let i=0;i<L;i++) d[i] = i<N ? x[i]*(i/N)+x[L+i]*(1-i/N) : x[i];
  }
  return buf;
}
// Rain is thousands of separate impacts, not a hiss: render them once into a loop.
function dropsBuf(ctx){
  const sr=ctx.sampleRate, L=Math.floor(sr*11), buf=ctx.createBuffer(2,L,sr), l=buf.getChannelData(0), r=buf.getChannelData(1);
  for(let n=0;n<9000;n++){ const pos=Math.floor(Math.random()*L), f=1800+Math.random()*Math.random()*7800, dur=Math.floor((.0012+Math.random()*.0045)*sr);
    const amp=Math.pow(Math.random(),4)*.85+.025, pan=Math.random(), ph=Math.random()*6.283, w=6.283*f/sr;
    for(let k=0;k<dur;k++){ const e=Math.exp(-k/(dur*.28)), s=(Math.sin(ph+w*k)*.5+(Math.random()*2-1)*.5)*e*amp, i=(pos+k)%L; l[i]+=s*(1-pan)*1.3; r[i]+=s*pan*1.3; } }
  for(let n=0;n<110;n++){ const pos=Math.floor(Math.random()*L), f0=380+Math.random()*800, dur=Math.floor((.012+Math.random()*.03)*sr), amp=.1+Math.random()*.3, pan=Math.random(); let ph=0;
    for(let k=0;k<dur;k++){ const x=k/dur; ph+=6.283*f0*(1+.5*x)/sr; const s=Math.sin(ph)*Math.exp(-x*5)*Math.min(1,k/30)*amp, i=(pos+k)%L; l[i]+=s*(1-pan); r[i]+=s*pan; } }
  return buf;
}
function cricketBuf(ctx){
  const sr=ctx.sampleRate, L=Math.floor(sr*7), buf=ctx.createBuffer(2,L,sr), l=buf.getChannelData(0), r=buf.getChannelData(1);
  for(let v=0;v<5;v++){ const f=3900+Math.random()*1200, rate=1.7+Math.random()*1.1, amp=.03+Math.random()*.09, pan=Math.random(), np=3+Math.floor(Math.random()*2), pd=Math.floor(sr*.011), gap=Math.floor(sr*(.016+Math.random()*.004));
    for(let t=Math.random()*.5; t<7; t+=1/rate*(.93+Math.random()*.14)){ if(Math.random()<.08) continue;
      for(let p=0;p<np;p++){ const st=Math.floor(t*sr)+p*gap; for(let k=0;k<pd;k++){ const e=.5-.5*Math.cos(6.283*k/pd), s=Math.sin(6.283*f*k/sr)*e*amp*(.7+.3*p/np), i=(st+k)%L; l[i]+=s*(1-pan); r[i]+=s*pan; } } } }
  return buf;
}
function irBuf(ctx){   // wide, dark outdoor tail for thunder and distant calls
  const sr=ctx.sampleRate, L=Math.floor(sr*3.4), buf=ctx.createBuffer(2,L,sr);
  for(let c=0;c<2;c++){ const d=buf.getChannelData(c); let lp=0;
    for(let i=0;i<L;i++){ const t=i/sr, k=.04+.5*Math.exp(-t*2.2); lp += k*((Math.random()*2-1)-lp); d[i]=lp*Math.exp(-t/.75)*(i<sr*.012?i/(sr*.012):1)*2.2; } }
  return buf;
}
function buildAudio(ctx){
  const E={ctx,g:{}};
  const G=v=>{ const g=ctx.createGain(); g.gain.value=v; return g; };
  const F=(type,f,q=.7)=>{ const b=ctx.createBiquadFilter(); b.type=type; b.frequency.value=f; b.Q.value=q; return b; };
  const loop=(buf,rate=1,off)=>{ const s=ctx.createBufferSource(); s.buffer=buf; s.loop=true; s.playbackRate.value=rate; s.start(0,off===undefined?Math.random()*buf.duration:off); return s; };
  const chain=(...n)=>{ for(let i=0;i<n.length-1;i++) n[i].connect(n[i+1]); return n[n.length-1]; };
  E.master=G(0);
  const comp=ctx.createDynamicsCompressor(); comp.threshold.value=-12; comp.knee.value=12; comp.ratio.value=3; comp.attack.value=.02; comp.release.value=.4;
  chain(E.master,comp,ctx.destination);
  E.rev=ctx.createConvolver(); E.rev.buffer=irBuf(ctx); chain(E.rev,G(.55),E.master);
  const bus=(id,send)=>{ const g=E.g[id]=G(0); g.connect(E.master); if(send){ chain(g,G(send),E.rev); } return g; };
  E.white=noiseBuf(ctx,'white',5); E.pink=noiseBuf(ctx,'pink',9); E.brown=noiseBuf(ctx,'brown',11); E.drops=dropsBuf(ctx);
  // rain
  const gr=bus('rain',0);
  E.rlp=F('lowpass',6500); E.rbed=G(0); E.rbedW=G(1); chain(loop(E.pink,1.07),F('highpass',420),E.rlp,E.rbedW,E.rbed,gr);
  E.rair=G(0); chain(loop(E.white),F('highpass',5200),E.rair,gr);
  E.rdrop=G(0); E.rdropW=G(1); chain(loop(E.drops,1,0),E.rdropW,E.rdrop,gr); chain(loop(E.drops,.84,5.3),F('lowpass',5000),G(.7),E.rdropW);
  E.rlow=G(0); chain(loop(E.brown,.9),F('lowpass',170),E.rlow,gr);
  // wind
  const gw=bus('wind',0);
  E.w1=F('bandpass',260,.7); E.w1g=G(.6); chain(loop(E.pink,.8),E.w1,E.w1g,gw);
  E.w2=F('bandpass',700,1.3); E.w2g=G(.2); chain(loop(E.pink,1.13),E.w2,E.w2g,gw);
  E.w3=F('bandpass',2200,.9); E.w3g=G(.02); chain(loop(E.white,.7),E.w3,E.w3g,gw);
  E.wlow=G(.4); chain(loop(E.brown,.6),F('lowpass',170),E.wlow,gw);
  // sea: a distant bed, the waves themselves are events
  const gs=bus('shore',.06); chain(loop(E.pink,.6),F('lowpass',950),G(.13),gs);
  chain(loop(E.brown),F('lowpass',560),G(1.15),bus('mist',0));
  const gf=bus('fire',.05); E.fbedW=G(.7);
  chain(loop(E.brown,1.4),F('bandpass',240,.5),E.fbedW,G(.085),gf);
  chain(loop(E.white,.9),F('highpass',3000),G(.5),E.fbedW);
  bus('thunder',.5);
  const gl=bus('life',.6); E.crick=G(0); chain(loop(cricketBuf(ctx)),E.crick,gl);
  return E;
}
const panner=(c,p)=>{ if(c.createStereoPanner){ const n=c.createStereoPanner(); n.pan.value=clamp(p,-1,1); return n; } return c.createGain(); };
function burst(E,buf,t,dur,rate=1){ const s=E.ctx.createBufferSource(); s.buffer=buf; s.playbackRate.value=rate; s.loop=true; s.start(t,Math.random()*(buf.duration-.5)); s.stop(t+dur+.1); return s; }

function waveSound(E,t,str){
  const c=E.ctx, out=panner(c,(Math.random()-.5)*.9); out.connect(E.g.shore);
  // the swell gathering
  let f=c.createBiquadFilter(); f.type='lowpass'; f.frequency.value=240; let g=c.createGain();
  g.gain.setValueAtTime(0,t); g.gain.linearRampToValueAtTime(.13*str,t+2.1); g.gain.linearRampToValueAtTime(0,t+5);
  burst(E,E.brown,t,5,.8).connect(f); f.connect(g); g.connect(out);
  // the break
  f=c.createBiquadFilter(); f.type='lowpass'; f.Q.value=.5; f.frequency.setValueAtTime(320,t+1.3); f.frequency.exponentialRampToValueAtTime(5200+Math.random()*1600,t+2.6); f.frequency.exponentialRampToValueAtTime(950,t+6.5);
  g=c.createGain(); g.gain.setValueAtTime(0,t+1.3); g.gain.linearRampToValueAtTime(1.05*str,t+2.5+Math.random()*.3); g.gain.exponentialRampToValueAtTime(.001,t+7.6);
  burst(E,E.pink,t+1.3,6.4).connect(f); f.connect(g); g.connect(out);
  // foam fizzing as the water runs back
  const hp=c.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=2400;
  f=c.createBiquadFilter(); f.type='lowpass'; f.frequency.setValueAtTime(9500,t+2.3); f.frequency.exponentialRampToValueAtTime(2800,t+8.6);
  g=c.createGain(); g.gain.setValueAtTime(0,t+2.2); g.gain.linearRampToValueAtTime(.42*str,t+3.5); g.gain.exponentialRampToValueAtTime(.001,t+9);
  burst(E,E.white,t+2.2,7).connect(hp); hp.connect(f); f.connect(g); g.connect(out);
}
function thunderSound(E,t,dist,pan,power){
  const c=E.ctx, out=panner(c,pan); out.connect(E.g.thunder);
  const lvl=2.2*power*lerp(1,.5,dist);
  if(dist<.55){ let ct=t; const n=1+Math.floor(Math.random()*3);
    for(let i=0;i<n;i++){ const hp=c.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=700+Math.random()*900; const g=c.createGain(), d=.08+Math.random()*.22;
      g.gain.setValueAtTime(0,ct); g.gain.linearRampToValueAtTime(.5*lvl*(1-dist)*(1-i*.25),ct+.003); g.gain.exponentialRampToValueAtTime(.001,ct+d);
      burst(E,E.white,ct,d).connect(hp); hp.connect(g); g.connect(out); ct+=.04+Math.random()*.13; } }
  let rt=t+(dist<.55?.05:0); const n=3+Math.floor(Math.random()*4);
  for(let i=0;i<n;i++){ const d=2+Math.random()*3, f=c.createBiquadFilter(); f.type='lowpass';
    f.frequency.setValueAtTime(lerp(1900,620,dist)*(.6+Math.random()*.7),rt); f.frequency.exponentialRampToValueAtTime(95,rt+d);
    const g=c.createGain(), pk=lvl*(i===0?1:.35+Math.random()*.5)*Math.pow(.86,i);
    g.gain.setValueAtTime(0,rt); g.gain.linearRampToValueAtTime(pk,rt+.04+Math.random()*.25); g.gain.exponentialRampToValueAtTime(.001,rt+d);
    burst(E,E.brown,rt,d,.5+Math.random()*.6).connect(f); f.connect(g); g.connect(out); rt+=.25+Math.random()*.9; }
  const f=c.createBiquadFilter(); f.type='lowpass'; f.frequency.value=130; const g=c.createGain(), d=6+Math.random()*3;
  g.gain.setValueAtTime(0,t); g.gain.linearRampToValueAtTime(lvl*.6,t+.6); g.gain.exponentialRampToValueAtTime(.001,t+d);
  burst(E,E.brown,t,d,.6).connect(f); f.connect(g); g.connect(out);
}
function crackle(E,t){
  const c=E.ctx, big=Math.random()<.07, f=c.createBiquadFilter(); f.type='bandpass'; f.frequency.value=900+Math.random()*Math.random()*5600; f.Q.value=.7+Math.random()*2.2;
  const g=c.createGain(), d=big?.04+Math.random()*.07:.006+Math.random()*.035, pk=big?1.3:Math.pow(Math.random(),2)*1.0+.14;
  g.gain.setValueAtTime(0,t); g.gain.linearRampToValueAtTime(pk,t+.0008); g.gain.exponentialRampToValueAtTime(.0006,t+d);
  const p=panner(c,(Math.random()-.5)*.8); burst(E,E.white,t,d).connect(f); f.connect(g); g.connect(p); p.connect(E.g.fire);
  if(big){ const o=c.createOscillator(), og=c.createGain(); o.frequency.setValueAtTime(190+Math.random()*90,t); o.frequency.exponentialRampToValueAtTime(90,t+.06);
    og.gain.setValueAtTime(.1,t); og.gain.exponentialRampToValueAtTime(.001,t+.09); o.connect(og); og.connect(p); o.start(t); o.stop(t+.1); }
}
function birdSound(E,t){
  const c=E.ctx, base=2300+Math.random()*2300, type=Math.random(), out=c.createGain(); out.gain.value=.05+Math.random()*Math.random()*.22;
  const p=panner(c,Math.random()*1.7-.85); out.connect(p); p.connect(E.g.life);
  const note=(st,dur,f0,f1,f2)=>{ const o=c.createOscillator(); o.frequency.setValueAtTime(f0,st); o.frequency.exponentialRampToValueAtTime(f1,st+dur*.5); o.frequency.exponentialRampToValueAtTime(f2,st+dur);
    const g=c.createGain(); g.gain.setValueAtTime(0,st); g.gain.linearRampToValueAtTime(1,st+dur*.22); g.gain.setValueAtTime(1,st+dur*.6); g.gain.linearRampToValueAtTime(0,st+dur);
    o.connect(g); g.connect(out); o.start(st); o.stop(st+dur+.02);
    const o2=c.createOscillator(), g2=c.createGain(); o2.frequency.setValueAtTime(f0*2,st); o2.frequency.exponentialRampToValueAtTime(f2*2,st+dur); g2.gain.value=.12; o2.connect(g2); g2.connect(g); o2.start(st); o2.stop(st+dur+.02); };
  const jit=()=>1+(Math.random()-.5)*.04;
  if(type<.4){ const n=2+Math.floor(Math.random()*4), d=.055+Math.random()*.05, gap=d+.045+Math.random()*.09; for(let i=0;i<n;i++) note(t+i*gap*jit(),d,base*1.25*jit(),base,base*.82*(1-i*.02)); }
  else if(type<.7){ const n=6+Math.floor(Math.random()*10), d=.026+Math.random()*.02; for(let i=0;i<n;i++) note(t+i*d*1.55*jit(),d,base*(i%2?1.12:1),base*(i%2?1.2:.95),base*(i%2?1.1:1)*jit()); }
  else { const d=.13+Math.random()*.15; note(t,d,base*.8,base*1.05,base*.9); if(Math.random()<.6) note(t+d+.07,d*.8,base*.95,base*1.2,base); if(Math.random()<.4) note(t+2*d+.17,d*1.2,base*1.1,base*.8,base*.75); }
}
function owlSound(E,t){
  const c=E.ctx, f0=290+Math.random()*70, out=c.createGain(); out.gain.value=.05+Math.random()*.04; const lp=c.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=900;
  const p=panner(c,Math.random()*1.4-.7); out.connect(lp); lp.connect(p); p.connect(E.g.life);
  const hoot=(st,d)=>{ const o=c.createOscillator(); o.frequency.setValueAtTime(f0*1.04,st); o.frequency.linearRampToValueAtTime(f0,st+d*.3); o.frequency.linearRampToValueAtTime(f0*.95,st+d);
    const g=c.createGain(); g.gain.setValueAtTime(0,st); g.gain.linearRampToValueAtTime(1,st+.07); g.gain.setValueAtTime(.9,st+d*.6); g.gain.linearRampToValueAtTime(0,st+d); o.connect(g); g.connect(out); o.start(st); o.stop(st+d+.05);
    const o2=c.createOscillator(), g2=c.createGain(); o2.frequency.value=f0*2.01; g2.gain.value=.15; o2.connect(g2); g2.connect(g); o2.start(st); o2.stop(st+d+.05); };
  hoot(t,.42); hoot(t+.72,.22); hoot(t+1.0,.24); hoot(t+1.34,.55);
}
// Slow, continuous modulation plus the small random events. Works live and in an offline render.
function stepAudio(E,t,dt,st,x){
  const m=x.mix, g=x.gust;
  E.w1.frequency.setTargetAtTime(300+g*420,t,.7); E.w1g.gain.setTargetAtTime(.35+.65*g,t,.7);
  E.w2.frequency.setTargetAtTime(800+g*1300,t,.7); E.w2g.gain.setTargetAtTime(.22+.7*g,t,.7);
  E.w3.frequency.setTargetAtTime(2200+g*2600,t,.9); E.w3g.gain.setTargetAtTime(.06+.34*g*g*(.4+m.wind),t,.9);
  E.wlow.gain.setTargetAtTime(.06+.16*g,t,.8);
  st.rw=(st.rw||0)-dt;
  if(st.rw<=0){ st.rw=.9+Math.random()*1.4; E.rbedW.gain.setTargetAtTime(.8+Math.random()*.4,t,1.2); E.rlp.frequency.setTargetAtTime(5000+Math.random()*3400,t,1.5); E.rdropW.gain.setTargetAtTime(.72+Math.random()*.56,t,.8); }
  E.fbedW.gain.setTargetAtTime(.45+Math.random()*.55,t,.12);
  if(m.fire>.02){ const lam=m.fire*24*dt; let n=Math.floor(lam)+(Math.random()<lam%1?1:0); if(Math.random()<m.fire*.05) n+=3+Math.floor(Math.random()*6);
    for(let i=0;i<n;i++) crackle(E,t+Math.random()*dt); }
  const night=1-x.day, dry=1-Math.min(1,m.rain*1.7);
  E.crick.gain.setTargetAtTime(x.scene==='coast'?0:night*night*dry*2.2,t,1.5);
  if(m.life>.02 && x.day>.35 && m.rain<.6){ st.nb=(st.nb===undefined?.8:st.nb)-dt;
    if(st.nb<=0){ birdSound(E,t+.05); st.nb=(x.dawn?rnd(.4,1.8):rnd(2,7))*(x.scene==='coast'?2.5:1); } }
  if(m.life>.02 && x.day<.2 && x.scene!=='coast' && m.rain<.5){ st.no=(st.no===undefined?7:st.no)-dt; if(st.no<=0){ owlSound(E,t+.05); st.no=rnd(24,60); } }
}
function setLevels(E,m,on,vol,tc){
  const t=E.ctx.currentTime, set=(p,v)=>p.setTargetAtTime(v,t,tc), r=m.rain;
  set(E.rbed.gain,Math.pow(r,1.4)*.42); set(E.rair.gain,r*r*.15); set(E.rdrop.gain,r>.01?Math.sqrt(r)*.6:0); set(E.rlow.gain,r*r*.11);
  set(E.g.rain.gain,r>.005?1:0);
  set(E.g.wind.gain,Math.pow(m.wind,1.3)*.9); set(E.g.shore.gain,Math.pow(m.shore,1.3)*.95); set(E.g.mist.gain,m.mist*m.mist*.9);
  set(E.g.fire.gain,m.fire*1.7); set(E.g.thunder.gain,.4+m.thunder*.6); set(E.g.life.gain,m.life*.8);
  E.master.gain.setTargetAtTime(on?vol:0,t,on?.4:.12);
}
// Renders a mix without speakers, so levels and spectrum can be measured in tests.
async function renderOffline(mix,sec,o={}){
  const ctx=new OfflineAudioContext(2,44100*sec,44100), E=buildAudio(ctx), st={};
  setLevels(E,mix,true,.8,.01);
  for(let t=0;t<sec;t+=.2) stepAudio(E,t,.2,st,{mix,gust:gustAt(t*3),day:o.day===undefined?1:o.day,scene:o.scene||'lake',dawn:!!o.dawn});
  if(mix.shore>.02) for(let t=.1;t<sec-1;t+=6.5+Math.random()*4) waveSound(E,t,.8);
  if(o.thunder) thunderSound(E,.5,o.dist===undefined?.2:o.dist,0,1);
  return ctx.startRendering();
}

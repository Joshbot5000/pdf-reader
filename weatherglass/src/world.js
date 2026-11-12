/* ───────── shared helpers and state ───────── */
const $ = id => document.getElementById(id);
const clamp = (v,a,b) => Math.min(b,Math.max(a,v));
const lerp = (a,b,t) => a+(b-a)*t;
const sstep = (a,b,x) => { const t=clamp((x-a)/(b-a),0,1); return t*t*(3-2*t); };
const rnd = (a=1,b) => b===undefined ? Math.random()*a : a+Math.random()*(b-a);
const rng = seed => { let a=(seed*2654435761)>>>0; return () => { a=(a+0x6D2B79F5)>>>0; let t=a; t=Math.imul(t^(t>>>15),t|1); t^=t+Math.imul(t^(t>>>7),t|61); return ((t^(t>>>14))>>>0)/4294967296; }; };
const hsh = n => { const s=Math.sin(n)*43758.5453123; return s-Math.floor(s); };
const sn = x => { const i=Math.floor(x), f=x-i, u=f*f*(3-2*f); return lerp(hsh(i),hsh(i+1),u)*2-1; };   // smooth noise, -1..1
const mix3 = (a,b,t) => [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t];
const rgb = (c,al=1) => 'rgba('+(c[0]|0)+','+(c[1]|0)+','+(c[2]|0)+','+al+')';
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const uid = () => Math.random().toString(36).slice(2,9);

const KEY = 'weatherglass.v2';
const LAYERS = [
  {id:'rain',name:'Rain'},{id:'wind',name:'Wind'},{id:'thunder',name:'Thunder'},{id:'fire',name:'Campfire'},
  {id:'shore',name:'Waves'},{id:'mist',name:'Low hum'},{id:'life',name:'Wildlife'},
];
const SCENES = {
  lake:  {name:'Lake',   idx:0, mix:{rain:0, wind:.25,thunder:0,fire:0,  shore:.3, mist:.3, life:.5}},
  coast: {name:'Beach',  idx:1, mix:{rain:0, wind:.35,thunder:0,fire:0,  shore:.85,mist:0,  life:.4}},
  forest:{name:'Forest', idx:2, mix:{rain:0, wind:.3, thunder:0,fire:.75,shore:0,  mist:.25,life:.6}},
  meadow:{name:'Meadow', idx:3, mix:{rain:0, wind:.55,thunder:0,fire:0,  shore:0,  mist:.1, life:.6}},
};
const WEATHER = {
  'Clear':  {rain:0,  thunder:0},
  'Drizzle':{rain:.4, thunder:0},
  'Storm':  {rain:.9, thunder:.8, wind:.75},
};
const dayKey = (d=new Date()) => d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
const S = {
  scene:'lake', mix:{...SCENES.lake.mix}, weather:'Clear', vol:.8,
  tasks:[
    {id:'ex1',text:'Read this week’s chapter',done:false,ex:true},
    {id:'ex2',text:'Reply to the email I keep putting off',done:false,ex:true},
    {id:'ex3',text:'Twenty-minute walk',done:true,ex:true},
  ], aim:'ex1', log:{}, len:25, rev:0, dev:uid(),
  timer:{mode:'focus',running:false,endAt:0,remain:25*60000,total:25*60000},
};
try{ const raw = localStorage.getItem(KEY); if(raw){ const o = JSON.parse(raw); Object.assign(S,o); S.mix = {...SCENES.lake.mix,...o.mix}; if(!SCENES[S.scene]) S.scene='lake'; } }catch(e){}
let saveT=0;
const save = () => { clearTimeout(saveT); saveT=setTimeout(()=>{ try{ localStorage.setItem(KEY,JSON.stringify(S)); }catch(e){} },200); };

/* eased visual values and the shared environment (wind gusts, waves, light) */
const V = {rain:0,wind:0,cover:0,fire:0,wave:0,mist:0,lant:0,flash:0};
const env = {t:0, gust:.5, day:1, tw:0, elev:1, H:.29, portrait:false, swash:0, waves:[], horC:[150,200,245]};
const gustAt = t => clamp(.5 + .30*Math.sin(t*.23) + .20*Math.sin(t*.61+1.7) + .12*Math.sin(t*1.37+.4) + .06*Math.sin(t*3.1), 0, 1);
function skyColJS(h){   // mirrors skyCol() in the shader so the 2D layer matches the backdrop
  const d=env.day, tw=env.tw, c=V.cover;
  let zen=mix3([.010,.018,.065],[.11,.33,.76],d), hor=mix3([.06,.09,.21],[.60,.79,.96],d);
  hor=mix3(hor,[1,.5,.22],tw*.9); const mid=mix3(mix3(zen,hor,.45),[.78,.32,.46],tw*.62); zen=mix3(zen,[.13,.13,.36],tw*.65);
  let col=mix3(hor,mid,sstep(0,.34,h)); col=mix3(col,zen,sstep(.22,1,h));
  const l=col[0]*.3+col[1]*.59+col[2]*.11; col=mix3(col,[.52*(l*.72+.034),.58*(l*.72+.034),.68*(l*.72+.034)],c*.86);
  return [col[0]*255,col[1]*255,col[2]*255];
}

/* ───────── the foreground layer: ground, plants, trees, animals ───────── */
const lc = document.createElement('canvas'), L = lc.getContext('2d');
let W=2, Hh=2, u=1;                       // layer size in px; u = 1% of height
let SC = null;                            // current scene description
const actors = []; let spawnIn = 2.2, flockIn = 5;

function groundFn(scene, P){
  if(scene==='lake')   return x => (P?.17:.105) + .03*sn(x*2.1+3) + .012*sn(x*7+1) + .075*Math.pow(Math.abs(x-.5)*2,2.2)*(x<.5?1:.6);
  if(scene==='forest') return x => (P?.19:.13) + .035*sn(x*1.7+9) + .012*sn(x*6.3);
  if(scene==='meadow') return x => (P?.20:.14) + .04*sn(x*1.3+4) + .01*sn(x*5);
  const lw = P?.52:.30, lh = P?.25:.21;   // beach: dunes in the corners only, the sand is drawn by the shader
  return x => Math.max(lh*Math.pow(Math.max(0,1-x/lw),1.35), lh*.62*Math.pow(Math.max(0,(x-.80)/.20),1.3)) + .012*sn(x*9)*(x<lw||x>.8?1:0) - .012;
}
function buildScene(){
  const P = env.portrait, name = S.scene, R = rng(SCENES[name].idx*97+ (P?11:3));
  const dens = clamp(W/Hh*.72, .42, 1.25);
  const sc = SC = {name, P, gy:groundFn(name,P), blades:[], inner:[], reeds:[], trees:[], back:[], flies:[], gulls:[], bfly:[]};
  const N = n => Math.round(n*dens);
  if(name==='lake'){
    for(let i=0;i<N(170);i++) sc.blades.push({x:R(),len:1.4+R()*3.2,r:R(),s:R()});
    for(let i=0;i<N(70);i++){ const side=R()<.6; const x= side ? R()*R()*.22 : 1-R()*R()*.16; sc.reeds.push({x,len:5+R()*7,r:R(),s:R(),head:R()<.45}); }
    sc.trees = P ? [{x:.07,h:.30,seed:2},{x:.96,h:.36,seed:5}] : [{x:.03,h:.44,seed:2},{x:.095,h:.30,seed:3},{x:.155,h:.19,seed:4},{x:.925,h:.34,seed:5},{x:.985,h:.46,seed:6}];
    sc.fire = {x:P?.34:.235};
  } else if(name==='forest'){
    for(let i=0;i<N(190);i++) sc.blades.push({x:R(),len:1+R()*2.6,r:R(),s:R()});
    sc.back = P ? [{x:.30,h:.30,seed:21},{x:.66,h:.26,seed:22}] : [{x:.24,h:.34,seed:21},{x:.33,h:.26,seed:22},{x:.56,h:.30,seed:23},{x:.69,h:.36,seed:24},{x:.78,h:.27,seed:25}];
    sc.trees = P ? [{x:.03,h:.62,seed:11},{x:.97,h:.74,seed:13}] : [{x:.035,h:.84,seed:11},{x:.125,h:.58,seed:12},{x:.885,h:.52,seed:14},{x:.965,h:.92,seed:13}];
    sc.fire = {x:P?.5:.42};
  } else if(name==='meadow'){
    for(let i=0;i<N(300);i++) sc.blades.push({x:R(),len:3+R()*5.5,r:R(),s:R(),fl:R()<.07?1+Math.floor(R()*3):0});
    for(let i=0;i<N(420);i++) sc.inner.push({x:R(),d:R(),len:2.2+R()*4,r:R(),s:R(),fl:R()<.035?1+Math.floor(R()*3):0});
    sc.oak = P ? {x:.22,size:.30,seed:31} : {x:.17,size:.46,seed:31};
    sc.fire = {x:P?.62:.66};
    for(let i=0;i<4;i++) sc.bfly.push({x:R(),y:R(),s:R()});
  } else {
    for(let i=0;i<N(34);i++){ const left=R()<.72; const x = left ? R()*(P?.42:.24) : .84+R()*.16; const k=7+Math.floor(R()*6); for(let j=0;j<k;j++) sc.blades.push({x:x+(R()-.5)*.012,len:3+R()*4.5,r:R(),s:R(),fan:(j/(k-1)-.5)*1.5}); }
    sc.palms = P ? [{x:.10,h:.36,lean:.22,seed:41},{x:.25,h:.25,lean:.42,seed:42}] : [{x:.055,h:.52,lean:.20,seed:41},{x:.13,h:.36,lean:.42,seed:42}];
    sc.fire = {x:P?.56:.36, y:P?.15:.105};
    sc.light = {x:P?.80:.64};
    sc.boat = {x:R()};
    for(let i=0;i<3;i++) sc.gulls.push({s:R(),p:R()*6.28});
  }
  for(let i=0;i<24;i++) sc.flies.push({x:R(),y:R(),s:R()});
  actors.length = 0; spawnIn = 2.2; flockIn = 4;
}
const gyPx = xn => Hh*(1-SC.gy(xn));
function sway(xn){ const w=V.wind, t=env.t;
  return (.035+.5*w)*(Math.sin(t*1.6-xn*7)*.5 + Math.sin(t*2.7-xn*15+1)*.28 + (env.gust-.5)*1.5)*.5 + w*.2*env.gust; }

/* trees */
function pine(X,Y,h,sw,seed,col){
  const R=rng(seed), n=Math.round(10+R()*4), w=h*(.19+.06*R()), off=f=>sw*h*.17*Math.pow(f,1.7);
  L.fillStyle=col;
  L.beginPath(); L.moveTo(X-h*.02,Y+u); L.lineTo(X+h*.02,Y+u); L.lineTo(X+off(.9)+h*.004,Y-h*.9); L.lineTo(X+off(.9)-h*.004,Y-h*.9); L.fill();
  const left=[], right=[];
  for(let i=0;i<n;i++){ const f=i/n, f2=(i+1)/n, yy=Y-h*(.15+.85*f), y2=Y-h*(.15+.85*f2);
    const half=w*Math.pow(1-f,.85)*(.7+.5*R()), o=off(f), fl=Math.sin(env.t*2.6+i*1.3+seed)*h*.004*(1+V.wind*6);
    left.push([X+o-half, yy+half*.30+fl],[X+o-half*.26, y2+(yy-y2)*.22]);
    right.push([X+o+half*(.85+.3*R()), yy+half*.30-fl],[X+o+half*.26, y2+(yy-y2)*.22]); }
  L.beginPath(); L.moveTo(X+off(0),Y-h*.15);
  for(const p of left) L.lineTo(p[0],p[1]);
  L.lineTo(X+off(1),Y-h);
  for(let i=right.length-1;i>=0;i--) L.lineTo(right[i][0],right[i][1]);
  L.closePath(); L.fill();
}
function palm(X,Y,h,lean,sw,seed,col){
  const tx=X+lean*h+sw*h*.11, ty=Y-h, R=rng(seed), n=11;
  L.strokeStyle=col; L.fillStyle=col; L.lineCap='round';
  L.lineWidth=h*.034; L.beginPath(); L.moveTo(X,Y+u*2); L.quadraticCurveTo(X+lean*h*.22,Y-h*.6,tx,ty); L.stroke();
  L.lineWidth=h*.05; L.beginPath(); L.moveTo(X,Y+u*2); L.lineTo(X+lean*h*.03,Y-h*.1); L.stroke();
  L.lineWidth=Math.max(1,h*.0065); L.beginPath();
  for(let i=0;i<n;i++){ const f=i/(n-1), ang=-Math.PI*(.03+.94*f)+(R()-.5)*.25, len=h*(.36+.15*R());
    const fl=sw*(.5+R())*.6 + Math.sin(env.t*2.3+i*1.7)*.05*(.3+V.wind*2.4);
    const dx=Math.cos(ang+fl*.4), dy=Math.sin(ang+fl*.4);
    const ex=tx+dx*len+sw*len*.4, ey=ty+dy*len*.55+len*.44, mx=tx+dx*len*.55, my=ty+dy*len*.75-len*.08;
    L.moveTo(tx,ty); L.quadraticCurveTo(mx,my,ex,ey);
    for(let k=2;k<=17;k++){ const s=k/17, q=1-s, px=q*q*tx+2*q*s*mx+s*s*ex, py=q*q*ty+2*q*s*my+s*s*ey;
      const ll=len*.21*Math.pow(Math.sin(Math.PI*Math.min(1,s*1.04)),.7);
      const tgx=2*q*(mx-tx)+2*s*(ex-mx), tgy=2*q*(my-ty)+2*s*(ey-my), tl=Math.hypot(tgx,tgy)||1, nx=-tgy/tl, ny=tgx/tl, ax=tgx/tl*ll*.5+sw*ll*.5, ay=tgy/tl*ll*.5+ll*.38;
      L.moveTo(px,py); L.lineTo(px+nx*ll*.6+ax, py+ny*ll*.6+ay);
      L.moveTo(px,py); L.lineTo(px-nx*ll*.6+ax, py-ny*ll*.6+ay); } }
  L.stroke();
  L.beginPath(); for(let i=0;i<3;i++){ const cx=tx+(i-1)*h*.022, cy=ty+h*.03+(i%2)*h*.012; L.moveTo(cx+h*.016,cy); L.arc(cx,cy,h*.016,0,6.283); } L.fill();
}
function oak(X,Y,size,sw,seed,trunk,leafA,leafB){
  const R=rng(seed), leaves=[]; L.strokeStyle=trunk; L.lineCap='round';
  (function br(x,y,ang,len,wd,d){
    const a=ang + sw*.035*d + Math.sin(env.t*3.1+d*2+x*.01)*.011*d*(.2+V.wind*2.2);
    const x2=x+Math.sin(a)*len, y2=y-Math.cos(a)*len;
    L.lineWidth=wd; L.beginPath(); L.moveTo(x,y); L.lineTo(x2,y2); L.stroke();
    const r1=R(), r2=R(), r3=R(), r4=R();
    if(d>=2) leaves.push([x2,y2,len*(d===2?.6:.85+r1*.9)]);
    if(d<6){ const k=(d>0&&r2<.3)?3:2; for(let i=0;i<k;i++){ const spread=(i/(k-1)-.5)*(1.15+r3*.5)+(r4-.5)*.3; br(x2,y2,a*.72+spread,len*(.69+.12*hsh(seed+d*7+i)),wd*.66,d+1); } }
  })(X,Y+u,(R()-.5)*.08,size*.25,size*.105,0);
  const j=(i,k)=>Math.sin(env.t*(2.2+k)+i*1.9)*size*.004*(.3+V.wind*3);
  L.fillStyle=leafA; L.beginPath(); leaves.forEach((p,i)=>{ const x=p[0]+j(i,0), y=p[1]+j(i,1); L.moveTo(x+p[2],y); L.arc(x,y,p[2],0,6.283); }); L.fill();
  L.fillStyle=leafB; L.beginPath(); leaves.forEach((p,i)=>{ const r=p[2]*.55, x=p[0]-p[2]*.25+j(i,0), y=p[1]-p[2]*.36+j(i,1); L.moveTo(x+r,y); L.arc(x,y,r,0,6.283); }); L.fill();
}
function blades(list, baseY, col, lw, flowerCols){
  L.strokeStyle=col; L.lineWidth=lw; L.lineCap='round'; L.beginPath();
  const tips=[];
  for(const b of list){ const X=b.x*W, Y=baseY(b), len=b.len*u*(b.sc||1);
    const a=(b.fan||0) + (b.r-.5)*.5 + sway(b.x)*(.7+b.s*.9) + Math.sin(env.t*(3+b.s*2)+b.r*40)*.03*(1+V.wind*3);
    const tx=X+Math.sin(a)*len, ty=Y-Math.cos(a)*len;
    L.moveTo(X,Y+u*.4); L.quadraticCurveTo(X+Math.sin(a*.25)*len*.5, Y-len*.55, tx, ty);
    if(b.fl||b.head) tips.push([tx,ty,b]); }
  L.stroke();
  for(const [x,y,b] of tips){
    if(b.head){ L.fillStyle=col; L.beginPath(); L.ellipse(x,y,u*.28,u*.95,sway(b.x)*.8,0,6.283); L.fill(); }
    else if(flowerCols){ L.fillStyle=flowerCols[b.fl-1]; L.beginPath(); L.arc(x,y,u*(.2+b.s*.14),0,6.283); L.fill(); } }
}

/* animals */
const KIND = {
  stag:{bl:1.3, bh:.54,leg:.74,nl:.52,na:1.02,hd:.22,ant:1,tail:0,  un:5.0,sp:.95,col:[98,66,42]},
  doe: {bl:1.22,bh:.5, leg:.70,nl:.48,na:.98, hd:.21,ant:0,tail:0,  un:4.4,sp:.95,col:[112,78,50]},
  fox: {bl:1.25,bh:.33,leg:.42,nl:.25,na:.38, hd:.2, ant:0,tail:.78,un:3.5,sp:1.7,col:[176,86,30]},
};
function drawQuad(a,X,Y,col){
  const K=KIND[a.kind], unit=K.un*u*(a.sc||1), amp=a.amp, ph=a.ph;
  L.save(); L.translate(X,Y); L.scale(a.dir*unit,unit); L.fillStyle=L.strokeStyle=col; L.lineCap='round'; L.lineJoin='round';
  const by=-(K.leg+K.bh*.5)+Math.sin(ph*12.566)*.012*amp;
  const leg=(hx,hy,p,fr)=>{ const s=Math.sin(p*6.283)*amp, lift=Math.max(0,Math.cos(p*6.283))*amp, len=-hy, l1=len*.52, l2=len*.52;
    const a1=fr? s*.30 : s*.27+.15, a2=fr? a1-lift*.8 : a1-.32-lift*.6;
    const kx=hx+Math.sin(a1)*l1, ky=hy+Math.cos(a1)*l1, fx=kx+Math.sin(a2)*l2, fy=Math.min(0,ky+Math.cos(a2)*l2);
    L.lineWidth=K.bh*.27; L.beginPath(); L.moveTo(hx,hy); L.lineTo(kx,ky); L.stroke();
    L.lineWidth=K.bh*.13; L.beginPath(); L.moveTo(kx,ky); L.lineTo(fx,fy); L.stroke(); };
  leg(-.36*K.bl,by+K.bh*.2,ph,0); leg(.33*K.bl,by+K.bh*.2,ph+.25,1); leg(-.30*K.bl,by+K.bh*.2,ph+.5,0); leg(.38*K.bl,by+K.bh*.2,ph+.75,1);
  L.beginPath(); L.ellipse(0,by,K.bl*.5,K.bh*.5,0,0,6.283); L.fill();
  L.beginPath(); L.ellipse(K.bl*.3,by-K.bh*.04,K.bh*.56,K.bh*.56,0,0,6.283); L.fill();
  L.beginPath(); L.ellipse(-K.bl*.32,by-K.bh*.02,K.bh*.54,K.bh*.54,0,0,6.283); L.fill();
  const g=a.graze, ang=K.na*(1-g)-.95*g+Math.sin(ph*12.566)*.03*amp;
  const sx=K.bl*.42, sy=by-K.bh*.2, hx=sx+Math.cos(ang)*K.nl, hy=sy-Math.sin(ang)*K.nl;
  L.beginPath(); L.moveTo(sx-K.bh*.24,sy-K.bh*.12); L.lineTo(hx-K.hd*.28,hy-K.hd*.2); L.lineTo(hx+K.hd*.22,hy+K.hd*.28); L.lineTo(sx+K.bh*.12,sy+K.bh*.44); L.closePath(); L.fill();
  L.save(); L.translate(hx,hy); L.rotate(.3-ang*.3+g*.95);
  L.beginPath(); L.ellipse(K.hd*.42,0,K.hd*(a.kind==='fox'?.86:.76),K.hd*.36,0,0,6.283); L.fill();
  const eh=a.kind==='fox'?1.0:.85, tw=Math.sin(env.t*.9+a.seed)>.93?.25:0;
  L.beginPath(); L.moveTo(-K.hd*.12,-K.hd*.18); L.lineTo(-K.hd*(.5+tw),-K.hd*eh); L.lineTo(K.hd*.16,-K.hd*.3); L.fill();
  if(K.ant){ L.lineWidth=.035; L.beginPath();
    L.moveTo(0,-K.hd*.3); L.quadraticCurveTo(-.22,-.5,-.1,-.82); L.moveTo(-.13,-.42); L.lineTo(.06,-.6); L.moveTo(-.17,-.6); L.lineTo(.02,-.78); L.moveTo(-.12,-.74); L.lineTo(-.3,-.86);
    L.moveTo(.06,-K.hd*.3); L.quadraticCurveTo(-.06,-.46,.1,-.74); L.moveTo(.0,-.5); L.lineTo(.2,-.62); L.stroke(); }
  L.restore();
  if(K.tail){ L.save(); L.translate(-K.bl*.5,by+.02); L.rotate(.32+Math.sin(env.t*2+a.seed)*.08+amp*.1); L.beginPath(); L.ellipse(-K.tail*.48,0,K.tail*.52,K.bh*.3,0,0,6.283); L.fill(); L.restore(); }
  else { L.beginPath(); L.ellipse(-K.bl*.54,by-K.bh*.22,.07,.1,.5,0,6.283); L.fill(); }
  L.restore();
}
function drawRabbit(a,X,Y,col){
  const unit=2.1*u, hop=a.hop, air=Math.sin(Math.PI*hop), sit=a.sit;
  L.save(); L.translate(X,Y-air*unit*.55); L.scale(a.dir*unit,unit); L.fillStyle=col;
  L.rotate(-air*.25*(hop<.5?1:-1) - sit*.5);
  L.beginPath(); L.ellipse(0,-.42,.58+air*.14,.36,0,0,6.283); L.fill();
  L.beginPath(); L.ellipse(.48,-.72-sit*.1,.25,.22,0,0,6.283); L.fill();
  const ea=-.35+Math.sin(env.t*1.3+a.seed)*.08-air*.5;
  for(const o of [0,.12]){ L.save(); L.translate(.42+o,-.9); L.rotate(ea+o); L.beginPath(); L.ellipse(0,-.3,.075,.32,0,0,6.283); L.fill(); L.restore(); }
  L.beginPath(); L.arc(-.58,-.5,.13,0,6.283); L.fill();
  L.beginPath(); L.ellipse(-.25-air*.3,-.08+air*.1,.34,.1,air*.6,0,6.283); L.fill();
  L.beginPath(); L.ellipse(.35+air*.25,-.1,.08,.2,-air*.8,0,6.283); L.fill();
  L.restore();
}
function drawCrab(a,X,Y,col){
  const unit=1.7*u, w=a.amp;
  L.save(); L.translate(X,Y); L.scale(unit,unit);
  L.fillStyle='rgba(0,0,0,.22)'; L.beginPath(); L.ellipse(0,.05,1.25,.16,0,0,6.283); L.fill();
  L.fillStyle=L.strokeStyle=col; L.lineCap='round'; L.lineJoin='round'; L.lineWidth=.09;
  L.beginPath();
  for(const sd of [-1,1]) for(let i=0;i<3;i++){ const wg=Math.sin(a.ph*6.283*2+i*2.1+(sd>0?1.5:0))*.14*w;
    L.moveTo(sd*.4,-.32); L.lineTo(sd*(.78+i*.1)+wg*.4,-.6+i*.05-Math.abs(wg)*.6); L.lineTo(sd*(1.0+i*.13)+wg,0); }
  L.stroke();
  L.beginPath(); L.ellipse(0,-.36,.6,.3,0,0,6.283); L.fill();
  const cl=Math.sin(env.t*1.7+a.seed)*.12;
  for(const sd of [-1,1]){ L.lineWidth=.11; L.beginPath(); L.moveTo(sd*.42,-.5); L.lineTo(sd*.72,-.86-cl*sd); L.stroke(); L.beginPath(); L.arc(sd*.8,-.98-cl*sd,.19,0,6.283); L.fill();
    L.lineWidth=.05; L.beginPath(); L.moveTo(sd*.16,-.6); L.lineTo(sd*.2,-.86); L.stroke(); L.beginPath(); L.arc(sd*.2,-.9,.06,0,6.283); L.fill(); }
  L.restore();
}
function drawPiper(a,X,Y,col){
  const unit=1.5*u, pk=a.graze;
  L.save(); L.translate(X,Y); L.scale(a.dir*unit,unit);
  L.fillStyle='rgba(0,0,0,.2)'; L.beginPath(); L.ellipse(0,.03,.6,.08,0,0,6.283); L.fill();
  L.fillStyle=L.strokeStyle=col; L.lineCap='round'; L.lineWidth=.05;
  const sc=Math.sin(a.ph*6.283)*.32*a.amp;
  L.beginPath(); L.moveTo(-.02,-.6); L.lineTo(sc,0); L.moveTo(.06,-.6); L.lineTo(-sc,0); L.stroke();
  L.save(); L.translate(0,-.78); L.rotate(pk*.5-.08);
  L.beginPath(); L.ellipse(0,0,.5,.28,0,0,6.283); L.fill();
  L.beginPath(); L.moveTo(-.4,-.1); L.lineTo(-.78,.02); L.lineTo(-.4,.14); L.fill();
  L.beginPath(); L.arc(.42,-.26,.17,0,6.283); L.fill();
  L.lineWidth=.045; L.beginPath(); L.moveTo(.55,-.24); L.lineTo(1.0,-.14); L.stroke();
  L.restore(); L.restore();
}
function spawn(kind, o={}){
  const dir = o.dir || (Math.random()<.5?1:-1);
  const a = {kind, dir, x: o.x!==undefined ? o.x : (dir>0?-.08:1.08), ph:Math.random(), amp:1, graze:0, st:'walk', tm:rnd(3,8), seed:Math.random()*99, hop:0, sit:0, sc:o.sc||1, lag:o.lag||0};
  actors.push(a); return a;
}
function director(dt){
  spawnIn -= dt;
  if(spawnIn<=0){
    const walkers = actors.filter(a=>a.kind!=='flock').length;
    if(walkers<3){ const r=Math.random(), n=S.scene;
      if(n==='lake'){ if(r<.55){ const a=spawn('stag'); spawn('doe',{dir:a.dir,x:a.x-a.dir*.09,sc:.95}); } else if(r<.8) spawn('fox'); else spawn('doe'); }
      else if(n==='forest'){ if(r<.4) spawn('fox'); else if(r<.7){ const a=spawn('doe'); if(Math.random()<.5) spawn('doe',{dir:a.dir,x:a.x-a.dir*.07,sc:.72}); } else if(r<.85) spawn('stag'); else { const a=spawn('rabbit'); spawn('rabbit',{dir:a.dir,x:a.x-a.dir*.05}); } }
      else if(n==='meadow'){ if(r<.5){ const a=spawn('rabbit'); if(Math.random()<.6) spawn('rabbit',{dir:a.dir,x:a.x-a.dir*.06}); } else if(r<.8){ const a=spawn('doe'); spawn('doe',{dir:a.dir,x:a.x-a.dir*.08,sc:.7}); } else spawn('fox'); }
      else { if(r<.5) spawn('crab'); else { const a=spawn('piper'); spawn('piper',{dir:a.dir,x:a.x-a.dir*.04}); if(Math.random()<.5) spawn('piper',{dir:a.dir,x:a.x-a.dir*.075}); } }
    }
    spawnIn = rnd(11,24)*(1+V.rain*1.6);
  }
  flockIn -= dt;
  if(flockIn<=0){
    if(env.day>.25 && V.rain<.7){ const dir=Math.random()<.5?1:-1, n=5+Math.floor(Math.random()*6), f={kind:'flock',dir,x:dir>0?-.1:1.1,y:rnd(.55,.86),birds:[],sp:rnd(.035,.06)};
      for(let i=0;i<n;i++){ const k=Math.ceil(i/2)*(i%2?1:-1); f.birds.push({dx:-Math.abs(k)*.016-Math.random()*.006, dy:k*.012+(Math.random()-.5)*.006, ph:Math.random()*6}); }
      actors.push(f); }
    flockIn = rnd(16,38);
  }
}
function updateActors(dt){
  for(let i=actors.length-1;i>=0;i--){ const a=actors[i];
    if(a.kind==='flock'){ a.x += a.dir*a.sp*dt; for(const b of a.birds) b.ph += dt*(7+V.wind*3); if(a.x<-.3||a.x>1.3) actors.splice(i,1); continue; }
    const px = u/W;                                    // one layer-unit as a fraction of width
    if(a.kind==='rabbit'){
      if(a.st==='hop'){ a.hop += dt/.36; a.x += a.dir*2.1*1.7*px*dt/.36; if(a.hop>=1){ a.hop=0; a.st='rest'; a.tm = Math.random()<.3 ? rnd(1.2,3.2) : rnd(.04,.22); a.wantSit = a.tm>1; } }
      else { a.tm -= dt; a.sit = lerp(a.sit, a.wantSit?1:0, dt*6); if(a.tm<=0){ a.st='hop'; a.wantSit=false; } }
    } else {
      const K = KIND[a.kind], sp = a.kind==='crab' ? 1.7*1.3 : a.kind==='piper' ? 1.5*5.5 : K.un*K.sp*(a.sc||1);
      a.tm -= dt;
      if(a.st==='walk'){ a.amp = lerp(a.amp,1,dt*5); if(a.tm<=0 && a.x>.08 && a.x<.92){ a.st='idle'; a.tm = a.kind==='piper'?rnd(.5,1.5):rnd(2.5,5.5); } }
      else { a.amp = lerp(a.amp,0,dt*6); if(a.tm<=0){ a.st='walk'; a.tm = a.kind==='piper'?rnd(.8,2.2):rnd(4,10); } }
      const grazing = a.st==='idle' && a.kind!=='crab' && (a.kind!=='piper' || Math.sin(env.t*9+a.seed)>0);
      a.graze = lerp(a.graze, grazing?1:0, dt*(a.kind==='piper'?14:3));
      a.x += a.dir*sp*px*a.amp*dt;
      a.ph += dt*a.amp*(a.kind==='piper'?6:a.kind==='crab'?2.2:(K.sp/1.15));
    }
    if(a.x<-.14||a.x>1.14) actors.splice(i,1);
  }
}

function drawLayer(){
  const sc=SC, n=sc.name, d=env.day, tw=env.tw, hor=env.horC;
  L.clearRect(0,0,W,Hh);
  let sil=mix3([3,4,9],[10,20,22],d); sil=mix3(sil,[28,13,15],tw*.5);
  const desat=c=>{ const l=c[0]*.3+c[1]*.59+c[2]*.11; return mix3(c,[l*.92,l,l*1.05],V.cover*.5); };
  const far=mix3(sil,hor,.5);
  // birds in the sky
  for(const a of actors) if(a.kind==='flock'){ L.strokeStyle=rgb(mix3(sil,hor,.25)); L.lineWidth=Math.max(1,u*.16); L.lineCap='round'; L.beginPath();
    for(const b of a.birds){ const x=(a.x+b.dx*a.dir)*W, y=Hh*(1-a.y-b.dy)+Math.sin(env.t*.7+b.ph)*u*.3, s=u*.85, w=Math.sin(b.ph);
      L.moveTo(x-s,y-w*s*.6); L.quadraticCurveTo(x-s*.4,y-s*.25*(1+w*.3),x,y); L.quadraticCurveTo(x+s*.4,y-s*.25*(1+w*.3),x+s,y-w*s*.6); }
    L.stroke(); }

  if(n==='coast'){
    const hy=Hh*(1-env.H);
    // sailing boat on the horizon
    const bx=((sc.boat.x+env.t*.0035)%1.2-.1)*W, by=hy+u*.5, bs=u*2.2; L.fillStyle=rgb(mix3(far,[235,235,230],d*.5));
    L.beginPath(); L.moveTo(bx-bs*.6,by); L.lineTo(bx+bs*.6,by); L.lineTo(bx+bs*.4,by+bs*.18); L.lineTo(bx-bs*.45,by+bs*.18); L.fill();
    L.beginPath(); L.moveTo(bx,by-bs*.05); L.lineTo(bx,by-bs*1.25); L.lineTo(bx+bs*.55,by-bs*.1); L.fill();
    L.beginPath(); L.moveTo(bx-bs*.06,by-bs*.05); L.lineTo(bx-bs*.06,by-bs*1.0); L.lineTo(bx-bs*.42,by-bs*.1); L.fill();
    // headland and lighthouse
    const lx=sc.light.x*W; L.fillStyle=rgb(far);
    L.beginPath(); L.moveTo(lx-u*15,hy+u*.4);
    for(let i=0;i<=24;i++){ const f=i/24; L.lineTo(lx-u*15+f*u*27, hy+u*.4-u*(3.6*Math.sin(Math.PI*Math.pow(f,.8))+.7*sn(f*9+2))); }
    L.lineTo(lx+u*12,hy+u*.4); L.fill();
    const ty=hy-u*3.3; L.beginPath(); L.moveTo(lx-u*.75,ty); L.lineTo(lx-u*.5,ty-u*7); L.lineTo(lx+u*.5,ty-u*7); L.lineTo(lx+u*.75,ty); L.fill();
    L.fillRect(lx-u*.75,ty-u*7.3,u*1.5,u*.35); L.fillRect(lx-u*.42,ty-u*8.3,u*.84,u*1.0);
    L.beginPath(); L.moveTo(lx-u*.55,ty-u*8.3); L.lineTo(lx,ty-u*9.1); L.lineTo(lx+u*.55,ty-u*8.3); L.fill();
    const nt=1-d; if(nt>.2){ const bm=Math.pow(Math.max(0,Math.cos(env.t*.9)),10), ly=ty-u*7.8;
      const g=L.createRadialGradient(lx,ly,0,lx,ly,u*(3+bm*10)); g.addColorStop(0,'rgba(255,236,170,'+(.55+.45*bm)*nt+')'); g.addColorStop(1,'rgba(255,236,170,0)');
      L.fillStyle=g; L.beginPath(); L.arc(lx,ly,u*(3+bm*10),0,6.283); L.fill();
      const ang=env.t*.9, dir=Math.sin(ang)>0?1:-1, bl=u*34*Math.abs(Math.sin(ang));
      const g2=L.createLinearGradient(lx,ly,lx+dir*bl,ly); g2.addColorStop(0,'rgba(255,236,170,'+.3*nt+')'); g2.addColorStop(1,'rgba(255,236,170,0)');
      L.fillStyle=g2; L.beginPath(); L.moveTo(lx,ly); L.lineTo(lx+dir*bl,ly-u*1.6); L.lineTo(lx+dir*bl,ly+u*1.6); L.fill(); }
    // gulls
    const gc=rgb(mix3(sil,[240,240,236],d*.85)); L.strokeStyle=gc; L.fillStyle=gc; L.lineCap='round'; L.lineJoin='round';
    if(V.rain<.75) for(const g of sc.gulls){ const tt=env.t*(.11+g.s*.05)+g.p, x=(.5+.42*Math.sin(tt)+.06*Math.sin(tt*2.3))*W, y=Hh*(1-env.H-(1-env.H)*(.28+.2*g.s+.12*Math.sin(tt*2+g.p)));
      const s=u*(1.5+g.s*.9), fl=Math.sin(env.t*(1.3+g.s)+g.p), w=fl>.55?Math.sin(env.t*9+g.p)*.7:.18+.1*Math.sin(env.t*.8+g.p), dir=Math.cos(tt)>0?1:-1;
      L.lineWidth=s*.16; L.beginPath(); L.moveTo(x-s,y-w*s*.5); L.quadraticCurveTo(x-s*.45,y-s*.32,x,y); L.quadraticCurveTo(x+s*.45,y-s*.32,x+s,y-w*s*.5); L.stroke();
      L.beginPath(); L.ellipse(x+dir*s*.06,y+s*.05,s*.3,s*.1,0,0,6.283); L.fill(); }
    // animals on the sand
    for(const a of actors){ if(a.kind==='crab'){ drawCrab(a,a.x*W,Hh*(1-(sc.P?.17:.115)-.03*hsh(a.seed)),rgb(mix3(sil,[190,74,42],d*.8))); }
      else if(a.kind==='piper'){ const yn=env.H*(.30+.16*a.x)-env.H*.11*env.swash-.022-a.lag; drawPiper(a,a.x*W,Hh*(1-yn),rgb(mix3(sil,[120,104,90],d*.7))); } }
    // dunes, grass, palms
    const sand=desat(mix3(mix3([9,10,14],[204,176,133],d),[112,66,48],tw*.6));
    const gr=L.createLinearGradient(0,Hh*.72,0,Hh); gr.addColorStop(0,rgb(mix3(sand,[255,255,255],.06*d))); gr.addColorStop(1,rgb(mix3(sand,[0,0,0],.4)));
    L.fillStyle=gr; L.beginPath(); L.moveTo(0,Hh+2); for(let x=0;x<=W+6;x+=6) L.lineTo(x,gyPx(x/W)); L.lineTo(W,Hh+2); L.fill();
    const pc=rgb(mix3(sil,[22,40,26],d*.6));
    for(const p of sc.palms) palm(p.x*W,gyPx(p.x)+u,p.h*Hh,p.lean,sway(p.x),p.seed,pc);
    blades(sc.blades, b=>gyPx(b.x), rgb(desat(mix3(sil,[96,118,62],d*.75))), Math.max(1,u*.17));
  } else {
    const meadow=n==='meadow';
    const pineC=rgb(mix3(sil,[14,34,28],d*.6)), backC=rgb(mix3(mix3(sil,[14,34,28],d*.6),hor,.34+V.mist*.2));
    for(const t of sc.back) pine(t.x*W,gyPx(t.x)+u*2,t.h*Hh,sway(t.x)*.7,t.seed,backC);
    if(meadow && sc.oak){ const o=sc.oak; oak(o.x*W,gyPx(o.x),o.size*Hh,sway(o.x),o.seed,rgb(mix3(sil,[40,28,20],d*.5)),rgb(desat(mix3(sil,[30,74,30],d*.85))),rgb(desat(mix3(mix3(sil,[30,74,30],d*.85),[104,150,56],d*.5+tw*.1)))); }
    let top, bot;
    if(meadow){ let g=mix3([5,9,11],[52,104,38],d); g=desat(mix3(g,[84,48,22],tw*.5)); top=g; bot=mix3(g,[0,0,0],.5); }
    else if(n==='forest'){ top=mix3(sil,[34,52,32],d*.65); bot=mix3(top,[0,0,0],.45); }
    else { top=mix3(sil,[36,60,42],d*.7); bot=mix3(top,[0,0,0],.55); }
    const gr=L.createLinearGradient(0,Hh*.74,0,Hh); gr.addColorStop(0,rgb(top)); gr.addColorStop(1,rgb(bot));
    L.fillStyle=gr; L.beginPath(); L.moveTo(0,Hh+2); for(let x=0;x<=W+6;x+=6) L.lineTo(x,gyPx(x/W)); L.lineTo(W,Hh+2); L.fill();
    const fcols = meadow ? [rgb(mix3(sil,[250,246,230],d)),rgb(mix3(sil,[246,204,70],d)),rgb(mix3(sil,[224,74,56],d))] : null;
    if(meadow) blades(sc.inner, b=>gyPx(b.x)+u*(1.5+b.d*b.d*13), rgb(mix3(top,[190,220,120],.16+.1*d)), Math.max(1,u*.16), fcols);
    // animals stand a little inside the ground so the grass covers their feet
    for(const a of actors){ if(a.kind==='flock') continue; const X=a.x*W, Y=gyPx(a.x)+u*(a.kind==='rabbit'?.9:1.3);
      if(a.kind==='rabbit') drawRabbit(a,X,Y,rgb(mix3(sil,[120,102,84],d*.55)));
      else if(KIND[a.kind]) drawQuad(a,X,Y,rgb(mix3(sil,KIND[a.kind].col,d*.6))); }
    const rim = meadow ? rgb(mix3(top,[200,228,130],.12+.1*d)) : rgb(mix3(top,hor,.10));
    blades(sc.blades, b=>gyPx(b.x), rim, Math.max(1,u*(meadow?.2:.16)), fcols);
    if(sc.reeds.length) blades(sc.reeds, b=>gyPx(b.x)+u*.5, rgb(mix3(sil,[30,44,30],d*.5)), Math.max(1,u*.2));
    for(const t of sc.trees) pine(t.x*W,gyPx(t.x)+u*1.5,t.h*Hh,sway(t.x),t.seed,pineC);
  }
  // campfire logs
  if(V.fire>.02){ const f=firePos(), X=f.x*W, Y=Hh*(1-f.y); L.fillStyle=rgb(mix3([10,7,6],[70,30,12],V.fire*.6)); L.strokeStyle=L.fillStyle; L.lineCap='round'; L.lineWidth=u*.8;
    L.beginPath(); L.moveTo(X-u*2.4,Y+u*.5); L.lineTo(X+u*1.6,Y-u*.5); L.moveTo(X+u*2.4,Y+u*.5); L.lineTo(X-u*1.6,Y-u*.5); L.moveTo(X-u*.2,Y+u*.7); L.lineTo(X+u*.3,Y-u*1.2); L.stroke();
    L.fillStyle=rgb(mix3(sil,[60,56,54],.5)); L.beginPath(); for(const o of [-3.1,-1.6,1.7,3.2]){ L.moveTo(X+u*o+u*.7,Y+u*.8); L.ellipse(X+u*o,Y+u*.8,u*.7,u*.45,0,0,6.283); } L.fill(); }
  // fireflies at night, butterflies by day
  const nf=(1-d)*(1-d)*(1-Math.min(1,V.rain*2))*(n==='coast'?0:1)*clamp(S.mix.life*2,0,1);
  if(nf>.05) for(const f of sc.flies){ const x=(f.x+.03*Math.sin(env.t*.21+f.s*40)+.012*Math.sin(env.t*.9+f.s*9))*W, y=gyPx(f.x)-u*(1+f.y*22)+Math.sin(env.t*.5+f.s*70)*u*2.2;
    const bl=Math.pow(Math.max(0,Math.sin(env.t*(.7+f.s)+f.s*50)),3)*nf; if(bl<.03) continue;
    L.fillStyle='rgba(210,255,120,'+.2*bl+')'; L.beginPath(); L.arc(x,y,u*.75,0,6.283); L.fill();
    L.fillStyle='rgba(235,255,170,'+bl+')'; L.beginPath(); L.arc(x,y,u*.28,0,6.283); L.fill(); }
  if(n==='meadow' && d>.5 && V.rain<.2 && S.mix.life>.05) sc.bfly.forEach((b,i)=>{ const tt=env.t*(.22+b.s*.1)+i*2.4;
    const x=((b.x+.25*Math.sin(tt)+.05*Math.sin(tt*3.1)+env.t*.004)%1.1)*W, y=gyPx(b.x)-u*(7+b.y*14)+Math.sin(tt*2.3)*u*4+Math.sin(env.t*7+i)*u*.5, fl=Math.abs(Math.sin(env.t*13+i*2)), s=u*1.15;
    L.fillStyle=['rgba(252,244,220,.95)','rgba(246,190,60,.95)','rgba(238,120,64,.95)','rgba(190,214,250,.95)'][i%4];
    L.beginPath(); L.ellipse(x-s*.5*fl,y-s*.15,s*.55*fl+.3,s*.62,-.4,0,6.283); L.ellipse(x+s*.5*fl,y-s*.15,s*.55*fl+.3,s*.62,.4,0,6.283); L.fill(); });
}
function firePos(){ const f=SC.fire; return {x:f.x, y:(f.y!==undefined?f.y:SC.gy(f.x)+.004)}; }


precision highp float;
uniform sampler2D uLayer;
uniform vec2 uRes; uniform float uT, uWT, uH, uScene, uSwash, uFade, uMistY;
uniform float uDay, uTw, uElev; uniform vec2 uSun, uMoon, uFireP;
uniform float uRain, uWind, uCover, uFire, uWave, uMist, uFlash, uLant;
uniform vec3 uBolt, uLantP;
float hash(float n){ return fract(sin(n)*43758.5453123); }
float hash2(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(hash2(i),hash2(i+vec2(1.,0.)),f.x), mix(hash2(i+vec2(0.,1.)),hash2(i+vec2(1.,1.)),f.x), f.y); }
float fbm(vec2 p){ float a=.5, s=0.; for(int i=0;i<5;i++){ s+=a*noise(p); p=p*2.03+vec2(17.3,9.1); a*=.5; } return s; }
float n1(float x){ float i=floor(x), f=fract(x); f=f*f*(3.-2.*f); return mix(hash(i),hash(i+1.),f); }
float ridge(float x, float seed){ float h=0., a=.5, fq=1.; for(int i=0;i<5;i++){ h+=a*n1(x*fq+seed); fq*=2.13; a*=.47; seed+=13.7; } return h; }

vec3 skyCol(float h){
  vec3 zen = mix(vec3(.010,.018,.065), vec3(.11,.33,.76), uDay);
  vec3 hor = mix(vec3(.06,.09,.21), vec3(.60,.79,.96), uDay);
  hor = mix(hor, vec3(1.,.50,.22), uTw*.9);
  vec3 mid = mix(mix(zen,hor,.45), vec3(.78,.32,.46), uTw*.62);
  zen = mix(zen, vec3(.13,.13,.36), uTw*.65);
  vec3 c = mix(hor, mid, smoothstep(0.,.34,h));
  c = mix(c, zen, smoothstep(.22,1.,h));
  float l = dot(c, vec3(.3,.59,.11));
  c = mix(c, vec3(.52,.58,.68)*(l*.72+.034), uCover*.86);
  return c;
}

// sky, stars, sun, moon, clouds, lightning
vec3 sky(vec2 p, float a){
  float h = clamp((p.y-uH)/(1.-uH), 0., 1.6);
  vec3 col = skyCol(h);
  float night = 1.-uDay;
  vec2 cp = vec2(p.x*1.25 + uWT, h*3.1 + uWT*.07);
  float cf = fbm(cp + vec2(0., fbm(cp*.6 - uWT*.3)*.6));
  float thr = mix(.74, .26, uCover);
  float cl = smoothstep(thr, thr+.34, cf) * smoothstep(-.02,.12,h);
  float inner = smoothstep(thr+.12, thr+.6, cf);
  vec2 g = p*95.; vec2 id = floor(g); vec2 f = fract(g)-.5; float r = hash2(id);
  vec2 off = (vec2(hash2(id+1.3),hash2(id+2.7))-.5)*.6;
  float st = step(.972,r)*smoothstep(.13,0.,length(f-off))*(.55+.45*sin(uT*(1.5+r*3.)+r*90.));
  col += st*night*night*(1.-cl)*(1.-uCover*.9)*vec3(.9,.95,1.)*1.3;
  vec2 sp = vec2(uSun.x*a, uSun.y); float sd = length(p-sp);
  vec3 sunC = mix(vec3(1.,.55,.25), vec3(1.,.96,.86), smoothstep(.0,.5,uElev));
  float sunVis = (1.-smoothstep(.45,.9,uCover));
  col += sunC*(smoothstep(.034,.028,sd)*1.4 + exp(-sd*9.)*.55 + exp(-sd*2.6)*.28*(.4+uTw))*sunVis*step(-.25,uElev);
  vec2 mp = vec2(uMoon.x*a, uMoon.y); float md = length(p-mp);
  float moon = smoothstep(.030,.026,md) * smoothstep(.016,.034,length(p-mp-vec2(.013,.007)));
  col += (vec3(.95,.96,1.)*moon*1.2 + vec3(.5,.6,.9)*exp(-md*11.)*.28)*night*(1.-uCover*.97);
  vec3 cc = mix(vec3(.10,.115,.18), vec3(1.), uDay);
  cc = mix(cc, vec3(1.,.60,.44), uTw*.75*(1.-inner*.6));
  cc *= mix(1., .36, uCover) * mix(1., .58, inner);
  cc += vec3(.1,.12,.2)*night*exp(-md*3.)*(1.-uCover);
  float bx = uBolt.x*a;
  cc += uFlash*vec3(.75,.8,1.)*(.25+1.4*exp(-abs(p.x-bx)*2.2));
  col = mix(col, cc, cl*.94);
  col += uFlash*vec3(.2,.22,.32)*(.3+exp(-abs(p.x-bx)*3.));
  if(uBolt.z>0.01 && p.y>uH*.6){
    float yy = (1.-p.y);
    float path = bx + (ridge(p.y*7.+uBolt.y, uBolt.y)-.5)*.34*yy + (n1(p.y*60.+uBolt.y)-.5)*.012;
    float d = abs(p.x-path);
    float br = bx + (ridge(p.y*9.+uBolt.y*2., 3.+uBolt.y)-.5)*.5*yy + yy*.12;
    float d2 = abs(p.x-br) + smoothstep(.75,.45,p.y)*1.;
    col += uBolt.z*vec3(.85,.88,1.)*(.0046/(d+.0011) + .0014/(d2+.0015));
  }
  return col;
}

// LAKE: layered mountains
vec3 mountains(vec3 col, vec2 p){
  vec3 horC = skyCol(.03);
  vec3 mDark = mix(vec3(.010,.016,.032), vec3(.055,.105,.135), uDay);
  mDark = mix(mDark, vec3(.07,.03,.06), uTw*.5);
  for(int i=0;i<5;i++){
    float fi = float(i)/4.;
    float amp = mix(.66,.17,fi)*(1.-uH);
    float fq = mix(1.1,2.9,fi);
    float rg = ridge(p.x*fq + float(i)*31.7 + 2.3, float(i)*7.1);
    rg = mix(pow(rg,1.7)*1.5, rg, fi);
    float hg = uH + amp*(rg - .10) + .012;
    if(i==4){ float tx = p.x*85.; hg += (1.-2.*abs(fract(tx)-.5))*.022*(.35+hash(floor(tx)*1.7)); }
    float haze = (1.-fi)*.74 + .06;
    vec3 mc = mix(mDark, horC, clamp(haze + uMist*.25,0.,1.));
    mc = mix(mc, horC, smoothstep(hg, uH, p.y)*(.42*(1.-fi) + uMist*.5 + uRain*.25));
    mc += uFlash*vec3(.12,.13,.2)*(1.-fi*.5);
    col = mix(col, mc, smoothstep(hg+.0015, hg-.0015, p.y));
  }
  return col;
}

// FOREST: ranks of firs fading into mist
vec3 firs(vec3 col, vec2 p){
  vec3 horC = skyCol(.03);
  vec3 dk = mix(vec3(.007,.012,.022), vec3(.030,.080,.066), uDay);
  dk = mix(dk, vec3(.06,.03,.04), uTw*.5);
  for(int i=0;i<6;i++){
    float fi = float(i)/5.;
    float base = uH*mix(1.95,.62,fi);
    float hg = base + .15*(1.-fi*.4)*(ridge(p.x*mix(.8,1.5,fi)+float(i)*17.3, float(i)*5.)-.5);
    float tx = p.x*mix(150.,30.,fi) + float(i)*7.7; float ti = floor(tx), tf = fract(tx);
    float hh = hash(ti*1.31+float(i)*3.1);
    float sp = pow(max(0.,1.-2.2*abs(tf-.5)), 1.2);
    float th = mix(.022,.20,fi*fi)*(.3+.7*hh);
    hg += sp*th + (fract(sp*6.)-.5)*th*.10*step(.04,sp);
    float haze = (1.-fi)*.84 + .03;
    vec3 mc = mix(dk, horC, clamp(haze + uMist*.3,0.,1.));
    mc = mix(mc, horC, smoothstep(hg, hg-.30, p.y)*(.6*(1.-fi) + uMist*.5 + uRain*.2));
    mc += uFlash*vec3(.10,.11,.17)*(1.-fi*.5);
    col = mix(col, mc, smoothstep(hg+.0015, hg-.0015, p.y));
  }
  return col;
}

// MEADOW: rolling hills
vec3 hills(vec3 col, vec2 p){
  vec3 horC = skyCol(.03);
  vec3 g0 = mix(vec3(.010,.020,.024), vec3(.19,.40,.12), uDay);
  vec3 g1 = mix(vec3(.022,.034,.058), vec3(.30,.55,.34), uDay);
  g0 = mix(g0, vec3(.24,.13,.06), uTw*.55); g1 = mix(g1, vec3(.55,.30,.24), uTw*.55);
  for(int i=0;i<5;i++){
    float fi = float(i)/4.;
    float base = uH*mix(1.22,.52,fi);
    float hg = base + mix(.11,.075,fi)*(n1(p.x*mix(.7,1.25,fi)+fi*9.+3.) + .45*n1(p.x*mix(1.9,3.1,fi)+fi*31.) - .72);
    if(i>0 && i<4){ // small far trees along the crest
      float tx = p.x*mix(70.,30.,fi)+fi*5.; float tf = fract(tx)-.5; float hh = hash(floor(tx)*2.7+fi);
      hg += sqrt(max(0.,1.-tf*tf*5.))*mix(.004,.012,fi)*step(.66,hh)*(.5+hh);
    }
    vec3 mc = mix(g1, g0, fi);
    float l = dot(mc, vec3(.3,.59,.11)); mc = mix(mc, vec3(l)*vec3(.9,1.,1.05), uCover*.45);
    mc = mix(mc, horC, clamp((1.-fi)*.34 + uMist*.25,0.,.95));
    mc *= mix(.70,1.10, smoothstep(hg-.13,hg,p.y));
    mc *= 1. + (noise(vec2(p.x*34. - uWT*14., p.y*110.))-.5)*.16*fi;
    mc += uFlash*vec3(.10,.11,.17);
    col = mix(col, mc, smoothstep(hg+.0015, hg-.0015, p.y));
  }
  return col;
}

// COAST: open sea, breaking waves, wet sand
vec3 coast(vec2 p, float a){
  vec3 horC = skyCol(.03);
  float sx = p.x/a;
  float ys0 = uH*(.30+.16*sx);
  float ys = ys0 - uH*.11*uSwash*(.8+.4*noise(vec2(p.x*3., uT*.15))) + (noise(vec2(p.x*9., uT*.35))-.5)*.006;
  vec3 foamC = mix(vec3(.15,.18,.25), vec3(.97), uDay) + uTw*vec3(.25,.10,.04) + uFlash*.3;
  float sunVis = (1.-smoothstep(.45,.9,uCover))*step(0.,uElev);
  if(p.y > ys){
    float d = clamp((uH-p.y)/(uH-ys), 0., 1.);
    vec2 q = vec2(p.x + (noise(vec2(p.x*40., d*90.-uT))-.5)*.03*d, uH + (uH-p.y)*.9 + .004);
    vec3 skyR = sky(q, a);
    vec3 deep = mix(vec3(.006,.016,.035), vec3(.015,.19,.31), uDay);
    vec3 shal = mix(vec3(.02,.05,.07), vec3(.15,.50,.54), uDay);
    deep = mix(deep, vec3(.10,.07,.12), uTw*.5); shal = mix(shal, vec3(.36,.24,.22), uTw*.5);
    vec3 w = mix(deep, shal, smoothstep(.5,1.,d));
    float l = dot(w, vec3(.3,.59,.11)); w = mix(w, vec3(l)*vec3(.85,.95,1.), uCover*.6);
    w = mix(w, skyR, mix(.66,.16,d));
    float ph = 4.4*log(1.+d*7.) - uT*(.09+.05*uWave) + (noise(vec2(p.x*1.3, d*3.))-.5)*.55;
    float wv = fract(ph);
    float crest = smoothstep(.80,.97,wv)*smoothstep(1.,.985,wv);
    w *= 1. - .24*smoothstep(.35,.8,wv)*d;
    float fn = fbm(vec2(p.x*26., d*40. - uT*.6));
    float foam = crest*smoothstep(.22,1.,d)*(.3+.7*uWave)*smoothstep(.28,.6,fn+d*.3);
    float surf = smoothstep(.84,1.,d)*smoothstep(.36,.7,fbm(vec2(p.x*18.+uT*.2, d*30.-uT*.9)))*(.35+.65*uSwash);
    w = mix(w, foamC, clamp(foam+surf,0.,1.)*.93);
    float gs = pow(noise(vec2(p.x*70., d*260.-uT*2.2)), 5.);
    w += gs*3.*(vec3(1.,.9,.7)*exp(-pow((p.x-uSun.x*a)/.14,2.))*sunVis + vec3(.6,.7,1.)*exp(-pow((p.x-uMoon.x*a)/.10,2.))*(1.-uDay)*(1.-uCover))*(1.-d*.5);
    float dr = hash2(floor(vec2(p.x*130., d*300.)) + floor(uT*14.));
    w += step(.985,dr)*uRain*.16*(horC+.1);
    return w;
  }
  vec3 sand = mix(vec3(.034,.040,.055), vec3(.80,.69,.52), uDay);
  sand = mix(sand, vec3(.44,.26,.19), uTw*.6);
  float l = dot(sand, vec3(.3,.59,.11)); sand = mix(sand, vec3(l)*vec3(.95,.97,1.), uCover*.45);
  sand *= .90 + .2*noise(p*vec2(160.,340.));
  sand *= 1. - .05*sin(p.y*520. + noise(p*9.)*9.);
  sand *= mix(.72, 1., smoothstep(0., uH*.3, p.y));
  float wet = smoothstep(ys0-uH*.17, ys0-uH*.10, p.y);
  sand = mix(sand, sand*.52 + skyCol(.35)*.26, wet*.9);
  float e = p.y-ys;
  float lace = smoothstep(-.014-.03*uSwash, 0., e)*smoothstep(.32,.62, fbm(vec2(p.x*34., e*130.+uT*.4)));
  sand = mix(sand, foamC, clamp(lace*.85 + smoothstep(-.0035,0.,e), 0., 1.));
  sand += uFlash*vec3(.1,.11,.16);
  return sand;
}

void main(){
  vec2 uv = gl_FragCoord.xy/uRes; float a = uRes.x/uRes.y; vec2 p = vec2(uv.x*a, uv.y);
  vec3 col; vec3 horC = skyCol(.03);
  if(uScene < .5){
    if(p.y >= uH){ col = mountains(sky(p,a), p); }
    else {
      float dy = uH-p.y; float pr = dy/uH; float k = .25+pr*2.2;
      float w = noise(vec2(p.x*22./k, dy*190./k - uT*(.5+uWave*1.6))) - .5;
      float w2 = noise(vec2(p.x*7./k + uT*.15, dy*60./k + uT*.3)) - .5;
      float ampl = (.0022 + .020*uWave + .006*uRain + .005*uWind)*k;
      vec2 q = vec2(p.x + w*ampl + w2*ampl*.35, uH + dy*(1.+ w*.35*(.3+uWave)) + .002);
      col = mountains(sky(q,a), q);
      vec3 deep = mix(vec3(.008,.014,.03), vec3(.03,.08,.11), uDay);
      col = mix(col*.82, deep, clamp(pr*.62 + .08,0.,1.));
      col += (horC*.5+.08)*smoothstep(.22,.5,w+w2*.6)*(.10+.35*uWave)*(1.-pr*.5);
      float dr = hash2(floor(vec2(p.x*120./k, dy*420./k)) + floor(uT*14.));
      col += step(.985,dr)*uRain*.16*(horC+.1);
    }
  } else if(uScene < 1.5){
    col = p.y >= uH ? sky(p,a) : coast(p,a);
  } else if(uScene < 2.5){
    col = firs(sky(p,a), p);
  } else {
    col = hills(sky(p,a), p);
  }

  // lanterns: afloat on water, or rising as sky lanterns
  for(int i=0;i<14;i++){
    if(float(i) >= uLant) break;
    float fi = float(i);
    float depth = hash(fi*3.17+1.);
    float lx = (.08 + .84*hash(fi*7.31+4.))*a + sin(uT*.05+fi)*.012;
    float ly = mix(uLantP.x, uLantP.y, depth) + sin(uT*.8+fi*2.)*.003*(1.+uWave*2.);
    float sz = mix(.006,.017,depth)*mix(.75,1.,uLantP.z);
    lx += (1.-uLantP.z)*sin(uT*.11+fi*1.9)*.03; ly += (1.-uLantP.z)*sin(uT*.07+fi*2.7)*.03;
    vec2 d = p-vec2(lx,ly);
    float body = smoothstep(sz, sz*.55, length(d*vec2(1.,.85)));
    float glow = exp(-dot(d,d)/(sz*sz*9.));
    float fl = .82+.18*sin(uT*5.+fi*11.)*sin(uT*3.1+fi);
    float below = max(-d.y,0.);
    float refl = exp(-abs(d.x)/(sz*.7))*exp(-below/(sz*3.2))*step(d.y,0.)*(.6+.4*noise(vec2(p.x*90.,p.y*500.-uT*3.)))*uLantP.z;
    col += vec3(1.,.62,.25)*(body*1.25 + glow*.5 + refl*.42)*fl;
  }

  // foreground layer: ground, trees, animals (drawn on a 2D canvas each frame)
  vec4 Lr = texture2D(uLayer, uv);
  col = col*(1.-Lr.a) + Lr.rgb + Lr.a*uFlash*vec3(.10,.11,.17);

  // campfire
  if(uFire>.01){
    vec2 fp0 = vec2(uFireP.x*a, uFireP.y);
    float fdist = length(p-fp0);
    float flick = .8+.2*sin(uT*9.)*sin(uT*5.7)+.1*sin(uT*23.);
    float fs = .085*(.6+.5*uFire);
    vec2 q = (p-fp0)/fs; q.x += (noise(vec2(q.y*2.6-uT*4.2, uT*.7))-.5)*.7*q.y + uWind*.35*q.y*q.y;
    float dd = abs(q.x)*(1.7+q.y*2.3);
    float fl = smoothstep(.55,.08,dd)*smoothstep(1.05,.15,q.y)*step(0.,q.y)*(.55+.75*noise(vec2(q.x*3.,q.y*2.6-uT*5.5)));
    vec3 fc = mix(vec3(1.,.28,.04), vec3(1.,.86,.45), smoothstep(.25,.9,fl));
    col = mix(col, fc*1.25, clamp(fl*1.3,0.,1.)*min(uFire*3.,1.));
    col += vec3(1.,.45,.14)*uFire*flick*(exp(-fdist*7.)*.36 + exp(-fdist*2.2)*.11);
    for(int k=0;k<9;k++){
      float fk = float(k); float ph = fract(uT*.11*(.6+hash(fk*3.3)) + hash(fk*9.1));
      vec2 ep = fp0 + vec2((hash(fk*5.7)-.5)*.05 + sin(ph*9.+fk)*.016 + uWind*ph*.16, .012 + ph*.30);
      float e = exp(-dot(p-ep,p-ep)/.0000085);
      col += vec3(1.,.55,.18)*e*(1.-ph)*uFire*1.4;
    }
  }

  float m = uMist*exp(-abs(p.y-uMistY)*9.)*(.45+.6*fbm(vec2(p.x*2.2+uT*.025, p.y*7.-uT*.01)));
  col = mix(col, horC*.9+.04, clamp(m,0.,.8));

  float rn = 0.;
  for(int l=0;l<3;l++){
    float fl = float(l); float sc = 34.+fl*26.;
    vec2 q = vec2((p.x + p.y*(.08+uWind*.55))*sc, p.y*sc*.055 + uT*(1.7+fl*.55));
    vec2 id = floor(q); vec2 f = fract(q); float r = hash2(id+fl*17.);
    float on = step(1.-(.14+.5*uRain), r);
    float xs = smoothstep(.09,0.,abs(f.x-.2-.6*fract(r*7.3)));
    float ys = smoothstep(0.,.25,f.y)*smoothstep(.75,.35,f.y);
    rn += on*xs*ys*(.55-.13*fl);
  }
  col += rn*uRain*(horC*.5+vec3(.22,.25,.3))*(.55+uFlash*2.);
  col = mix(col, horC*.75, uRain*.13);

  vec2 vq = uv-.5; col *= 1.-dot(vq,vq)*.62;
  col = col/(1.+col*.18);
  col = pow(max(col,0.), vec3(.92));
  col *= uFade;
  col += (hash2(gl_FragCoord.xy+fract(uT)*91.)-.5)/255.*2.2;
  gl_FragColor = vec4(col,1.);
}

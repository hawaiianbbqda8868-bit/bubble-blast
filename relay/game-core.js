// Bubble Blast — shared simulation core (runs in the browser for single-player
// AND on the Node server for authoritative online play). No DOM, no rendering.
// makeWorld() returns one independent game world.
(function (root) {
'use strict';

const COLS = 19, ROWS = 17;
const FUSE = 2.0, BLAST_TIME = 0.5, TRAP_TIME = 3.0, ESCAPE_NEED = 1.0, BASE_MOVE = 0.20;
const POWERUP_CHANCE = 0.36, BARREL_FILL = 0.78;
const FLOOR = 0, WALL = 1, BARREL = 2;
const PU_RANGE = 0, PU_BUBBLE = 1, PU_SPEED = 2;
const SKIN = '#fde7cf', SKIN_LT = '#fff8ee';
const PALETTE = ['#ff5b5b','#ff9d3a','#ffe24d','#5fe08a','#46c8ff','#7c8cff','#c77dff','#ff7ad1'];
const DIRV = { up:[0,-1], down:[0,1], left:[-1,0], right:[1,0] };
// up to 8 sailors: 4 corners + 4 edge-midpoints
const SPAWNS = [[1,1],[COLS-2,1],[1,ROWS-2],[COLS-2,ROWS-2],
                [(COLS-1)>>1,1],[(COLS-1)>>1,ROWS-2],[1,(ROWS-1)>>1],[COLS-2,(ROWS-1)>>1]];
const MAX_SLOTS = SPAWNS.length;
const MIDX = (COLS-1)>>1, MIDY = (ROWS-1)>>1;
// each map: a theme name + a layout(set) that places indestructible decor.
// set(x,y,type,opts) marks a WALL tile of a given decor type; ship sets shipCenter.
const MAPS = [
  { name:'Pirate Cove', theme:'pirate', fill:0.78, layout(set){
      for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) set(MIDX+dx,MIDY+dy,'ship');
      [[2,2],[COLS-3,2],[2,ROWS-3],[COLS-3,ROWS-3]].forEach(([x,y])=>set(x,y,'cannon'));
    } },
  { name:'Stone Maze', theme:'stone', fill:0.72, layout(set){
      for(let y=2;y<ROWS-1;y+=2) for(let x=2;x<COLS-1;x+=2) set(x,y,'pillar');   // classic grid
    } },
  { name:'Frozen Bay', theme:'ice', fill:0.74, layout(set){
      [[4,3],[COLS-6,3],[4,ROWS-5],[COLS-6,ROWS-5]].forEach(([cx,cy])=>{ for(let dy=0;dy<2;dy++) for(let dx=0;dx<2;dx++) set(cx+dx,cy+dy,'ice'); });
      set(MIDX,MIDY,'ice');
    } },
  { name:'Volcano', theme:'lava', fill:0.76, layout(set){
      for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) set(MIDX+dx,MIDY+dy,'lava');
      [[4,4],[COLS-6,4],[4,ROWS-6],[COLS-6,ROWS-6]].forEach(([cx,cy])=>{ for(let dy=0;dy<2;dy++) for(let dx=0;dx<2;dx++) set(cx+dx,cy+dy,'rock'); });
    } },
  { name:'Cross Reef', theme:'pirate', fill:0.74, layout(set){
      for(let y=4;y<=ROWS-5;y++) if(y%2===0) set(MIDX,y,'cannon');
      for(let x=4;x<=COLS-5;x++) if(x%2===0) set(x,MIDY,'cannon');
    } },
];
// render colour palettes per theme (used by the browser; harmless on the server)
const THEMES = {
  pirate:{ f1:'#d7a44b', f2:'#cb9a40', crate:'#e7b24e', crateIn:'#d29a3a', crateFrame:'#9c6a22', crateSheen:'rgba(255,242,205,.30)', hull:'#5d3a1b', hull2:'#6e4622', bg:'#1d3a5f' },
  stone:{  f1:'#9aa0ad', f2:'#8d93a1', crate:'#c3c9d6', crateIn:'#aab0bf', crateFrame:'#6b7280', crateSheen:'rgba(255,255,255,.28)', hull:'#454c5e', hull2:'#5a6275', bg:'#2a3550' },
  ice:{    f1:'#bfe3f2', f2:'#aed7ea', crate:'#e2f3fc', crateIn:'#c2e4f5', crateFrame:'#7fb6d6', crateSheen:'rgba(255,255,255,.55)', hull:'#6fa8c8', hull2:'#8ec6e2', bg:'#274a63' },
  lava:{   f1:'#5a4a42', f2:'#4f4039', crate:'#b5683a', crateIn:'#9c5530', crateFrame:'#6e3a22', crateSheen:'rgba(255,200,150,.25)', hull:'#3a2a24', hull2:'#4a352c', bg:'#3a221c' },
};

function makeWorld() {
  let grid, players, bubbles, blasts, powerups, decor, theme, shipCenter;
  let burstCounter = 0, gameState = 'lobby', winnerSlot = -1, diff = 'normal';
  let events = [];

  const inB = (x,y) => x>=0 && x<COLS && y>=0 && y<ROWS;
  const key = (x,y) => x+','+y;
  function bubbleAt(x,y){ return bubbles.find(b=>b.x===x&&b.y===y); }
  function passable(x,y){ return inB(x,y) && grid[y][x]===FLOOR && !bubbleAt(x,y); }
  function tileOf(p){ if(!p.moving) return {x:p.tx,y:p.ty}; return p.t<0.5?{x:p.fx,y:p.fy}:{x:p.tox,y:p.toy}; }
  function blastCells(x,y,range){
    const cells=[{x,y}], dirs=[[1,0],[-1,0],[0,1],[0,-1]];
    for(const [dx,dy] of dirs){
      for(let i=1;i<=range;i++){
        const nx=x+dx*i, ny=y+dy*i;
        if(!inB(nx,ny)||grid[ny][nx]===WALL) break;
        cells.push({x:nx,y:ny});
        if(grid[ny][nx]===BARREL) break;
      }
    }
    return cells;
  }

  function buildMap(mapId){
    grid = Array.from({length:ROWS}, ()=>Array(COLS).fill(FLOOR));
    decor = new Map(); shipCenter = null;
    for(let y=0;y<ROWS;y++) for(let x=0;x<COLS;x++)
      if(x===0||y===0||x===COLS-1||y===ROWS-1){ grid[y][x]=WALL; decor.set(key(x,y),'hull'); }
    const id = (mapId!=null) ? mapId : Math.floor(Math.random()*MAPS.length);
    const M = MAPS[id]; theme = M.theme;
    const set=(x,y,type)=>{ if(inB(x,y)){ grid[y][x]=WALL; decor.set(key(x,y),type); if(type==='ship') shipCenter={x:MIDX,y:MIDY}; } };
    M.layout(set);
    const safe=new Set();
    for(const [cx,cy] of SPAWNS) [[0,0],[1,0],[-1,0],[0,1],[0,-1]].forEach(([dx,dy])=>{ const x=cx+dx,y=cy+dy; if(inB(x,y)&&grid[y][x]!==WALL) safe.add(key(x,y)); });
    const fill = M.fill || BARREL_FILL;
    for(let y=1;y<ROWS-1;y++) for(let x=1;x<COLS-1;x++)
      if(grid[y][x]===FLOOR && !safe.has(key(x,y)) && Math.random()<fill) grid[y][x]=BARREL;
  }

  function makePlayer(tx,ty,isHuman,capColor,botDiff){
    return { tx,ty, fx:tx,fy:ty, tox:tx,toy:ty, t:0, moving:false, dir:'down',
      isHuman, color:SKIN, colorLight:SKIN_LT, capColor:capColor||'#1a1a1f', alive:true,
      range:1, maxBubbles:1, active:0, speed:0,
      trapped:false, trappedBy:null, trapTimer:0, struggle:0, escapeAt:0,
      botDiff, think:0, anim:0, target:null, targetTtl:0 };
  }
  function botPlan(i){
    const base = {easy:{move:0.27,trap:0.3,react:0.32,esc:0.12},
                  normal:{move:0.20,trap:0.55,react:0.6,esc:0.25},
                  hard:{move:0.15,trap:0.85,react:0.9,esc:0.4}}[diff];
    const spice=[{move:+0.05,trap:-0.15},{move:0,trap:0},{move:-0.03,trap:+0.1}][i];
    return { move:Math.max(0.1,base.move+spice.move), trap:Math.min(1,Math.max(0,base.trap+spice.trap)), react:base.react, esc:base.esc };
  }
  function reset(controls, colors, d){
    diff = d || 'normal';
    controls = controls || ['local','ai','ai','ai'];
    colors = colors || [];
    buildMap();
    bubbles=[]; blasts=[]; powerups=[]; burstCounter=0; gameState='playing'; winnerSlot=-1; events=[];
    const used=new Set(colors.filter(Boolean));
    const botPool=PALETTE.filter(c=>!used.has(c));
    let bi=0, bp=0;
    players=SPAWNS.map((s,i)=>{
      const ctrl=controls[i]||'ai';
      const cap=colors[i] || botPool[bp++ % botPool.length] || PALETTE[i%PALETTE.length];
      const aiLike=(ctrl==='ai'||ctrl==='none');
      const p=makePlayer(s[0],s[1], !aiLike, cap, aiLike?botPlan(bi++%3):null);
      p.control=ctrl; p.slot=i; p.captain=false; p.inHeld=[]; p.inBomb=false; p._lastHeld=null;
      if(ctrl==='none') p.alive=false;   // slot not in this match (player-count < 4)
      return p;
    });
  }

  function placeBubble(p){
    const {x,y}=tileOf(p);
    if(p.active>=p.maxBubbles || bubbleAt(x,y)) return;
    bubbles.push({x,y,fuse:FUSE,range:p.range,owner:p});
    p.active++; events.push('place');
  }
  function burst(b){
    const id=++burstCounter, cells=blastCells(b.x,b.y,b.range);
    for(const c of cells){
      if(grid[c.y][c.x]===BARREL){
        grid[c.y][c.x]=FLOOR;
        if(Math.random()<POWERUP_CHANCE) powerups.push({x:c.x,y:c.y,type:Math.floor(Math.random()*3)});
      }
      blasts.push({x:c.x,y:c.y,timer:BLAST_TIME,id,owner:b.owner});
      const chain=bubbleAt(c.x,c.y);
      if(chain && chain!==b && chain.fuse>0) chain.fuse=0;
    }
    events.push('burst');
  }

  // ---- AI ----
  function bfsStep(sx,sy,isGoal,canEnter){
    if(isGoal(sx,sy)) return null;
    const q=[[sx,sy]], seen=new Set([key(sx,sy)]), from=new Map();
    const dirs=[['up',0,-1],['down',0,1],['left',-1,0],['right',1,0]];
    while(q.length){
      const [cx,cy]=q.shift();
      for(const [name,dx,dy] of dirs){
        const nx=cx+dx, ny=cy+dy, k=key(nx,ny);
        if(seen.has(k)||!inB(nx,ny)) continue;
        if(!canEnter(nx,ny)) continue;
        seen.add(k); from.set(k,{px:cx,py:cy,dir:name});
        if(isGoal(nx,ny)){ let e=from.get(k); while(!(e.px===sx&&e.py===sy)) e=from.get(key(e.px,e.py)); return e.dir; }
        q.push([nx,ny]);
      }
    }
    return null;
  }
  function lineClear(x1,y1,x2,y2){
    if(x1===x2){ const a=Math.min(y1,y2),b=Math.max(y1,y2); for(let y=a+1;y<b;y++) if(grid[y][x1]!==FLOOR) return false; return true; }
    if(y1===y2){ const a=Math.min(x1,x2),b=Math.max(x1,x2); for(let x=a+1;x<b;x++) if(grid[y1][x]!==FLOOR) return false; return true; }
    return false;
  }
  function nearestTile(sx,sy,pred,canEnter){
    if(pred(sx,sy)) return {x:sx,y:sy};
    const q=[[sx,sy]], seen=new Set([key(sx,sy)]), dirs=[[0,-1],[0,1],[-1,0],[1,0]];
    while(q.length){
      const [cx,cy]=q.shift();
      for(const [dx,dy] of dirs){ const nx=cx+dx,ny=cy+dy,k=key(nx,ny);
        if(seen.has(k)||!inB(nx,ny)||!canEnter(nx,ny)) continue;
        seen.add(k); if(pred(nx,ny)) return {x:nx,y:ny}; q.push([nx,ny]); }
    }
    return null;
  }
  function escapeExists(p,x,y,danger){
    const cross=new Set(blastCells(x,y,p.range).map(c=>key(c.x,c.y)));
    return !!bfsStep(x,y,(gx,gy)=>!cross.has(key(gx,gy))&&!danger.has(key(gx,gy)),(nx,ny)=>passable(nx,ny)&&!danger.has(key(nx,ny)));
  }
  function adjacentBarrel(x,y){ return [[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy])=>{ const bx=x+dx,by=y+dy; return inB(bx,by)&&grid[by][bx]===BARREL; }); }
  function canEscapeInTime(p,x,y,danger){
    const cross=new Set(blastCells(x,y,p.range).map(c=>key(c.x,c.y)));
    const md=p.isHuman?moveDur(p):botMoveDur(p);
    const maxSteps=Math.max(2, Math.floor((FUSE-1.0)/md));
    const q=[[x,y,0]], seen=new Set([key(x,y)]), dirs=[[0,-1],[0,1],[-1,0],[1,0]];
    while(q.length){
      const [cx,cy,d]=q.shift();
      if(d>0 && !cross.has(key(cx,cy)) && !danger.has(key(cx,cy))) return true;
      if(d>=maxSteps) continue;
      for(const [dx,dy] of dirs){ const nx=cx+dx,ny=cy+dy,k=key(nx,ny);
        if(seen.has(k)||!passable(nx,ny)||danger.has(k)) continue; seen.add(k); q.push([nx,ny,d+1]); }
    }
    return false;
  }
  function pickTarget(p,x,y,danger){
    const canEnter=(nx,ny)=>passable(nx,ny)&&!danger.has(key(nx,ny));
    let t=nearestTile(x,y,(gx,gy)=>powerups.some(pu=>pu.x===gx&&pu.y===gy),canEnter);
    if(t) return t;
    t=nearestTile(x,y,(gx,gy)=>adjacentBarrel(gx,gy)&&escapeExists(p,gx,gy,danger),canEnter);
    if(t) return t;
    return null;
  }
  function digStep(sx,sy,tx,ty,danger){
    return bfsStep(sx,sy,(gx,gy)=>gx===tx&&gy===ty,(nx,ny)=>inB(nx,ny)&&grid[ny][nx]!==WALL&&!bubbleAt(nx,ny)&&!danger.has(key(nx,ny)));
  }
  function nearestHuman(p){
    const ht=tileOf(p); let best=null, bd=1e9;
    for(const q of players){ if(!q.alive||q===p||q.control==='ai') continue; const t=tileOf(q); const d=Math.abs(t.x-ht.x)+Math.abs(t.y-ht.y); if(d<bd){ bd=d; best=q; } }
    return best;
  }
  function botAct(p, danger){
    const here=tileOf(p), x=here.x, y=here.y;
    p.urgent=false;
    if(danger.has(key(x,y))){
      p.target=null; p.urgent=true;
      const ownCross=new Set();
      for(const b of bubbles) if(b.owner===p) for(const c of blastCells(b.x,b.y,b.range)) ownCross.add(key(c.x,c.y));
      let dir=bfsStep(x,y,(gx,gy)=>!danger.has(key(gx,gy)),(nx,ny)=>passable(nx,ny)&&(!danger.has(key(nx,ny))||ownCross.has(key(nx,ny))));
      if(!dir) dir=bfsStep(x,y,(gx,gy)=>!danger.has(key(gx,gy)),(nx,ny)=>passable(nx,ny));
      return { dir, bubble:false };
    }
    const me=nearestHuman(p);
    const mt = me ? tileOf(me) : null;
    const canBomb = p.active===0 && canEscapeInTime(p,x,y,danger);
    if(mt && canBomb && (mt.x===x||mt.y===y) && Math.abs(mt.x-x)+Math.abs(mt.y-y)<=p.range && lineClear(x,y,mt.x,mt.y) && Math.random()<p.botDiff.trap){
      p.target=null; return { dir:null, bubble:true };
    }
    if(mt && Math.random()<p.botDiff.react){
      const d=digStep(x,y,mt.x,mt.y,danger);
      if(d){ const [dx,dy]=DIRV[d], nx=x+dx, ny=y+dy;
        if(grid[ny][nx]===BARREL){ if(canBomb && Math.random()<p.botDiff.trap){ p.target=null; return { dir:null, bubble:true }; } }
        else { p.target=null; return { dir:d, bubble:false }; }
      }
    }
    if(canBomb && adjacentBarrel(x,y) && Math.random()<p.botDiff.trap){ p.target=null; return { dir:null, bubble:true }; }
    if(!p.target || (p.target.x===x&&p.target.y===y) || p.targetTtl<=0 || !passable(p.target.x,p.target.y)){ p.target=pickTarget(p,x,y,danger); p.targetTtl=50; }
    p.targetTtl--;
    let dir=null;
    if(p.target) dir=bfsStep(x,y,(gx,gy)=>gx===p.target.x&&gy===p.target.y,(nx,ny)=>passable(nx,ny)&&!danger.has(key(nx,ny)));
    if(!dir){ p.target=null; const opts=[[1,0,'right'],[-1,0,'left'],[0,1,'down'],[0,-1,'up']].filter(([dx,dy])=>passable(x+dx,y+dy)&&!danger.has(key(x+dx,y+dy))); if(opts.length) dir=opts[Math.floor(Math.random()*opts.length)][2]; }
    return { dir, bubble:false };
  }

  function moveDur(p){ return Math.max(0.08, BASE_MOVE - 0.022*p.speed); }
  function botMoveDur(p){ return Math.max(0.09, p.botDiff.move - 0.02*p.speed); }

  function update(dt){
    events=[];
    if(gameState!=='playing') return events;
    for(const b of bubbles) b.fuse-=dt;
    let popped=true;
    while(popped){ popped=false;
      for(let i=bubbles.length-1;i>=0;i--){ if(bubbles[i].fuse<=0){ const b=bubbles.splice(i,1)[0]; if(b.owner.active>0) b.owner.active--; burst(b); popped=true; } }
    }
    for(let i=blasts.length-1;i>=0;i--){ blasts[i].timer-=dt; if(blasts[i].timer<=0) blasts.splice(i,1); }
    const danger=new Set();
    for(const bl of blasts) danger.add(key(bl.x,bl.y));
    for(const b of bubbles) for(const c of blastCells(b.x,b.y,b.range)) danger.add(key(c.x,c.y));
    for(const p of players){
      if(!p.alive) continue;
      p.anim+=dt;
      if(p.trapped){
        p.trapTimer-=dt;
        const elapsed=TRAP_TIME-p.trapTimer;
        const freed = p.isHuman ? (p.struggle>=ESCAPE_NEED) : (elapsed>=p.escapeAt);
        if(freed){ p.trapped=false; p.trappedBy=null; p.struggle=0; }
        else if(p.trapTimer<=0){ p.alive=false; events.push('pop'); }
        continue;
      }
      if(!p.moving){
        let dir=null, bubble=false;
        if(p.control==='ai'){ p.think-=dt; if(p.think<=0){ p.think=0.05; const a=botAct(p,danger); dir=a.dir; bubble=a.bubble; p._dir=dir; } else dir=p._dir; }
        else { dir=(p.inHeld&&p.inHeld.length)?p.inHeld[p.inHeld.length-1]:null; if(p.inBomb){ bubble=true; p.inBomb=false; } }
        if(bubble) placeBubble(p);
        if(dir){ const [dx,dy]=DIRV[dir]; const nx=p.tx+dx, ny=p.ty+dy; if(passable(nx,ny)){ p.moving=true; p.fx=p.tx; p.fy=p.ty; p.tox=nx; p.toy=ny; p.t=0; p.dir=dir; } }
      }
      if(p.moving){
        p.t += dt/(p.isHuman?moveDur(p):(botMoveDur(p)*(p.urgent?0.55:1)));
        if(p.t>=1){
          p.t=0; p.moving=false; p.tx=p.tox; p.ty=p.toy;
          for(let i=powerups.length-1;i>=0;i--){ if(powerups[i].x===p.tx&&powerups[i].y===p.ty){ const t=powerups.splice(i,1)[0].type;
            if(t===PU_RANGE) p.range=Math.min(8,p.range+1); else if(t===PU_BUBBLE) p.maxBubbles=Math.min(8,p.maxBubbles+1); else p.speed=Math.min(5,p.speed+1);
            events.push('power'); } }
        }
      }
    }
    for(const p of players){
      if(!p.alive) continue;
      const {x,y}=tileOf(p);
      // a bubble traps everyone incl. its owner — but bots ignore their OWN blast so the AI doesn't suicide
      const hits=blasts.filter(bl=>bl.x===x&&bl.y===y&&(p.isHuman||bl.owner!==p));
      if(!hits.length) continue;
      if(p.trapped){ if(hits.some(h=>h.id!==p.trappedBy)){ p.alive=false; events.push('pop'); } }
      else { p.trapped=true; p.trappedBy=hits[0].id; p.trapTimer=TRAP_TIME; p.struggle=0;
        p.escapeAt = p.isHuman ? 999 : ((Math.random()<p.botDiff.esc) ? (0.7+Math.random()*1.5) : 999);
        p.moving=false; p.tx=x; p.ty=y; events.push('trap'); }
    }
    const alive=players.filter(p=>p.alive);
    if(alive.length<=1){ gameState='over'; winnerSlot=alive.length?alive[0].slot:-1; }
    return events;
  }

  function setInput(slot, inp){
    const p=players&&players[slot];
    if(!p || p.control==='ai') return;
    if(p.trapped && inp.dir && p._lastHeld!==inp.dir) p.struggle+=0.18;
    p.inHeld = inp.dir?[inp.dir]:[]; if(inp.bomb) p.inBomb=true; p._lastHeld=inp.dir||null;
  }
  function snapshot(){
    return { gs:gameState, win:winnerSlot, ev:events,
      grid: grid.map(r=>r.join('')),
      players: players.map(p=>({slot:p.slot,tx:p.tx,ty:p.ty,fx:p.fx,fy:p.fy,tox:p.tox,toy:p.toy,
        t:p.t,moving:p.moving,dir:p.dir,alive:p.alive,trapped:p.trapped,trapTimer:p.trapTimer,struggle:p.struggle,
        range:p.range,maxBubbles:p.maxBubbles,speed:p.speed,isHuman:p.isHuman,capColor:p.capColor,anim:p.anim,
        md:(p.isHuman?moveDur(p):botMoveDur(p)),color:SKIN,colorLight:SKIN_LT})),
      bubbles: bubbles.map(b=>({x:b.x,y:b.y,fuse:b.fuse,range:b.range})),
      blasts: blasts.map(b=>({x:b.x,y:b.y,timer:b.timer})),
      powerups: powerups.map(p=>({x:p.x,y:p.y,type:p.type})) };
  }
  function mapMsg(){ return { grid:grid.map(r=>r.join('')), decor:[...decor], theme, shipCenter }; }
  function read(){ return { grid, players, bubbles, blasts, powerups, decor, theme, shipCenter, gameState, winnerSlot, events }; }

  return { reset, update, setInput, snapshot, mapMsg, read,
    get gameState(){ return gameState; }, get winnerSlot(){ return winnerSlot; } };
}

const API = { makeWorld, COLS, ROWS, FUSE, BLAST_TIME, TRAP_TIME, ESCAPE_NEED, BASE_MOVE,
  FLOOR, WALL, BARREL, PALETTE, DIRV, SKIN, SKIN_LT, MAX_SLOTS, SPAWNS, MIDX, MIDY, MAPS, THEMES };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (root) root.BB = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));

// Bubble Blast — shared simulation core (runs in the browser for single-player
// AND on the Node server for authoritative online play). No DOM, no rendering.
// makeWorld() returns one independent game world.
//
// relay/game-core.js is a byte-identical copy of this file (the relay deploys
// on its own, so it cannot reach up a directory). After editing this file run
// `npm run sync-core` in relay/, or the server silently plays by older rules —
// that is how online team mode stayed broken for a release.
(function (root) {
'use strict';

// Bumped with the game rules. The relay reports it on its health URL, so you can
// check which rules the server is actually running: curl the relay's address.
const CORE_VERSION = 'v45';
const COLS = 19, ROWS = 17;
const FUSE = 3.0, BLAST_TIME = 0.5, TRAP_TIME = 3.0, ESCAPE_NEED = 1.0, BASE_MOVE = 0.20;
// How long a direction must be held before the sailor starts WALKING. Anything
// shorter is a tap and buys exactly one tile, however long the tile took — a
// thumb on the D-pad rests ~250ms, which used to bleed into a second tile (and
// a third with skates on, at 0.138s per tile). Holding past this walks on, so
// crossing the map is still one long press.
// How long a press has to last before it counts as walking rather than a tap —
// about as long as a thumb rests on a pad. The first tile of a press always
// runs at full speed; when it lands and the button is still down but the press
// is still this young, he LEANS into the next tile at TENTATIVE_SLOW pace
// instead of stopping dead. Hold, and he commits and speeds up; let go, and he
// leans back where he came from. So a press is one tile, he is never standing
// still while you are holding a direction, and the first tile is never slow.
const TAP_HOLD = 0.32;
const LEAN_MAX = 0.25;
// Rolling from one held direction to the next within this gap is the same
// walk: "tap or walk?" was already answered, so a corner is not a new lean.
const ROLL_GAP = 0.15;              // he never leans more than a quarter of a tile in
// A sailor leans the way he last walked, and always a little downwards. His
// bubble drops in the tile he leant AWAY from, and a blast catches him when
// that leaning point is inside its tile.
const DMG_OFF = 0.18;
// THE TIDE. A match used to drift once the barrels were gone: the board opened
// up, nobody wanted to commit, and the last minute was slower than the first.
// The bay floods now — one ring of the board turns to water every TIDE_STEP
// after TIDE_START, from the hull inwards. Water cannot be walked on, stops a
// blast, and drowns whoever it catches. Every match gets a shape.
const TIDE_START = 70, TIDE_STEP = 9, TIDE_WARN = 4;   // WARN: how long a ring is marked before it goes under
// GHOSTS. Being popped used to mean watching the rest of the match. A popped
// sailor comes back as a ghost: he drifts over walls and water, cannot be hurt
// and cannot win, and every GHOST_CD he can leave a ghost bubble that TRAPS
// whoever it catches but never pops them. Out of the running, still in the game.
const GHOST_MOVE = 0.16, GHOST_CD = 5.0, GHOST_RANGE = 1;
// Skates give diminishing returns: seconds shaved off a tile at each speed level.
// A flat bonus made top speed 11 tiles/s, which is impossible to steer or stop;
// this tops out at 0.138 s/tile (~7 tiles/s, 1.45x) while every pickup still helps.
const SPEED_GAIN = [0, 0.020, 0.036, 0.048, 0.056, 0.062];
const MAX_SPEED = SPEED_GAIN.length - 1;
const POWERUP_CHANCE = 0.36, BARREL_FILL = 0.78;
const MAX_RANGE = 8, MAX_BUBBLES = 8;   // pickup caps, shown in the HUD as x/max
const FLOOR = 0, WALL = 1, BARREL = 2, CRATE = 3, WATER = 4;   // CRATE: a barrel you can shove one tile; WATER: the tide got here
const CRATE_SHARE = 0.125;                          // one barrel in eight is pushable
const PU_RANGE = 0, PU_BUBBLE = 1, PU_SPEED = 2, PU_CAR = 3, PU_TURTLE = 4, PU_SURPRISE = 5;
// What a popped barrel drops, and what the surprise box rolls into (-1 = a dud).
// Weights, not percentages — rollFrom() normalises them.
// Water and bubbles are the bread and butter; a ride or a pair of skates is a
// treat. Rides used to be a quarter of every drop and the board was more
// vehicle than sailor, so they are roughly halved here and in the box.
const DROP_POOL     = [[PU_RANGE,32],[PU_BUBBLE,30],[PU_SPEED,11],[PU_CAR,7],[PU_TURTLE,5],[PU_SURPRISE,15]];
const SURPRISE_POOL = [[PU_RANGE,30],[PU_BUBBLE,30],[PU_SPEED,15],[PU_CAR,10],[PU_TURTLE,5],[-1,10]];
// Rides are mounted by walking onto them and lost when a bubble catches you.
// The car has a floor on its tile time so a maxed skater in one is still
// steerable; the turtle is a hazard you learn to walk around.
const RIDE = { car:{ mul:0.70, min:0.120 }, turtle:{ mul:1.90, min:0 } };
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

function rollFrom(pool){                            // weighted pick
  let total=0; for(const [,wt] of pool) total+=wt;
  let r=Math.random()*total;
  for(const [v,wt] of pool){ if((r-=wt)<0) return v; }
  return pool[pool.length-1][0];
}

function makeWorld() {
  let grid, players, bubbles, blasts, powerups, decor, theme, shipCenter;
  let burstCounter = 0, gameState = 'lobby', winnerSlot = -1, diff = 'normal';
  let teamMode = false, winnerTeam = -1, simTime = 0, mapIdx = 0;
  let tideRing = 0, tideNext = TIDE_START;      // rings flooded so far, and when the next one goes under
  let events = [];

  const inB = (x,y) => x>=0 && x<COLS && y>=0 && y<ROWS;
  const key = (x,y) => x+','+y;
  function bubbleAt(x,y){ return bubbles.find(b=>b.x===x&&b.y===y); }
  function passable(x,y){ return inB(x,y) && grid[y][x]===FLOOR && !bubbleAt(x,y); }
  const solid = v => v===WALL || v===WATER;                  // stops a blast as well as a sailor
  function areAllies(a,b){ return teamMode && a && b && a.team!=null && a.team===b.team; }
  function posOf(p){ return p.moving ? {x:p.fx+(p.tox-p.fx)*p.t, y:p.fy+(p.toy-p.fy)*p.t} : {x:p.tx,y:p.ty}; }
  // Which way his weight is: it decides the tile his bubble drops into and the
  // point a blast has to reach to catch him.
  function lean(p){ return { x: DMG_OFF*(p.faceX||1), y: DMG_OFF }; }
  function dmgPoint(p){ const q=posOf(p), l=lean(p); return {x:q.x+l.x, y:q.y+l.y}; }
  // The tile he counts as being in — where his bubble drops, and what the AI sees.
  function tileOf(p){ const q=posOf(p), l=lean(p); return {x:Math.round(q.x-l.x), y:Math.round(q.y-l.y)}; }
  function canStand(x,y){
    const xs = x%1 ? [Math.floor(x),Math.ceil(x)] : [x];
    const ys = y%1 ? [Math.floor(y),Math.ceil(y)] : [y];
    for(const X of xs) for(const Y of ys) if(!passable(X,Y)) return false;
    return true;
  }
  function inBlast(q,bl){ return Math.abs(q.x-bl.x)<0.5 && Math.abs(q.y-bl.y)<0.5; }
  function blastCells(x,y,range){
    const cells=[{x,y}], dirs=[[1,0],[-1,0],[0,1],[0,-1]];
    for(const [dx,dy] of dirs){
      for(let i=1;i<=range;i++){
        const nx=x+dx*i, ny=y+dy*i;
        if(!inB(nx,ny)||solid(grid[ny][nx])) break;
        cells.push({x:nx,y:ny});
        if(grid[ny][nx]===BARREL||grid[ny][nx]===CRATE) break;
      }
    }
    return cells;
  }

  function buildMap(mapId){
    grid = Array.from({length:ROWS}, ()=>Array(COLS).fill(FLOOR));
    decor = new Map(); shipCenter = null;
    for(let y=0;y<ROWS;y++) for(let x=0;x<COLS;x++)
      if(x===0||y===0||x===COLS-1||y===ROWS-1){ grid[y][x]=WALL; decor.set(key(x,y),'hull'); }
    const id = MAPS[mapId] ? mapId : 0;                 // the map is picked on the start screen; no roll
    const M = MAPS[id]; theme = M.theme; mapIdx = id;
    const set=(x,y,type)=>{ if(inB(x,y)){ grid[y][x]=WALL; decor.set(key(x,y),type); if(type==='ship') shipCenter={x:MIDX,y:MIDY}; } };
    M.layout(set);
    const safe=new Set();
    for(const [cx,cy] of SPAWNS) [[0,0],[1,0],[-1,0],[0,1],[0,-1]].forEach(([dx,dy])=>{ const x=cx+dx,y=cy+dy; if(inB(x,y)&&grid[y][x]!==WALL) safe.add(key(x,y)); });
    const fill = M.fill || BARREL_FILL;
    for(let y=1;y<ROWS-1;y++) for(let x=1;x<COLS-1;x++)
      if(grid[y][x]===FLOOR && !safe.has(key(x,y)) && Math.random()<fill)
        grid[y][x] = Math.random()<CRATE_SHARE ? CRATE : BARREL;
  }

  function makePlayer(tx,ty,isHuman,capColor,botDiff){
    return { tx,ty, fx:tx,fy:ty, tox:tx,toy:ty, t:0, moving:false, dir:'down',
      isHuman, color:SKIN, colorLight:SKIN_LT, capColor:capColor||'#1a1a1f', alive:true,
      range:1, maxBubbles:1, active:0, speed:0, ride:null, stepLen:1, tentative:false, ghost:false, ghostCd:0,
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
  // opts.tide === false holds the sea back: unit tests that run minutes of sim
  // time are about one rule each, and a flooding board is a second rule.
  function reset(controls, colors, d, teams, mapId, opts){
    diff = d || 'normal';
    controls = controls || ['local','ai','ai','ai'];
    colors = colors || [];
    teamMode = Array.isArray(teams) && teams.some(t=>t!=null);
    buildMap(mapId);
    bubbles=[]; blasts=[]; powerups=[]; burstCounter=0; gameState='playing'; winnerSlot=-1; winnerTeam=-1; events=[]; simTime=0;
    tideRing=0; tideNext=(opts && opts.tide===false) ? Infinity : TIDE_START;
    const used=new Set(colors.filter(Boolean));
    const botPool=PALETTE.filter(c=>!used.has(c));
    let bi=0, bp=0;
    players=SPAWNS.map((s,i)=>{
      const ctrl=controls[i]||'ai';
      const cap=colors[i] || botPool[bp++ % botPool.length] || PALETTE[i%PALETTE.length];
      const aiLike=(ctrl==='ai'||ctrl==='none');
      const p=makePlayer(s[0],s[1], !aiLike, cap, aiLike?botPlan(bi++%3):null);
      p.control=ctrl; p.slot=i; p.captain=false; p.inHeld=[]; p.inBomb=false; p._lastHeld=null;
      p.inTap=false; p.tapTtl=0; p.inSeq=0; p._stepSeq=0; p._doneSeq=0; p.faceX=1;
      p._pressSeq=-1; p.pressT=0; p.pressSteps=0; p.idleT=9;
      p.team = teamMode ? (teams[i]==null?null:teams[i]) : null;
      if(ctrl==='none') p.alive=false;   // slot not in this match (player-count < 4)
      return p;
    });
  }

  function placeBubble(p){
    const {x,y}=tileOf(p);
    if(!inB(x,y) || bubbleAt(x,y)) return;
    if(p.ghost){                                   // a ghost bubble only ever traps
      if(p.ghostCd>0 || grid[y][x]===WATER) return;
      bubbles.push({x,y,fuse:FUSE,range:GHOST_RANGE,owner:p,soft:true});
      p.ghostCd=GHOST_CD; events.push('place'); return;
    }
    if(p.active>=p.maxBubbles || grid[y][x]!==FLOOR) return;
    bubbles.push({x,y,fuse:FUSE,range:p.range,owner:p});
    p.active++; events.push('place');
  }
  function burst(b){
    const id=++burstCounter, cells=blastCells(b.x,b.y,b.range);
    for(const c of cells){
      // a ghost's splash breaks nothing and sets nothing else off — it only wets
      if(!b.soft && (grid[c.y][c.x]===BARREL||grid[c.y][c.x]===CRATE)){
        grid[c.y][c.x]=FLOOR;
        if(Math.random()<POWERUP_CHANCE) powerups.push({x:c.x,y:c.y,type:rollFrom(DROP_POOL)});
      }
      blasts.push({x:c.x,y:c.y,timer:BLAST_TIME,id,owner:b.owner,soft:!!b.soft});
      if(b.soft) continue;
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
  function adjacentBarrel(x,y){ return [[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy])=>{ const bx=x+dx,by=y+dy; return inB(bx,by)&&(grid[by][bx]===BARREL||grid[by][bx]===CRATE); }); }
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
  function nearestEnemy(p){   // team mode: hunt the closest opponent (not a teammate)
    const ht=tileOf(p); let best=null, bd=1e9;
    for(const q of players){ if(!q.alive||q===p||areAllies(p,q)) continue; const t=tileOf(q); const d=Math.abs(t.x-ht.x)+Math.abs(t.y-ht.y); if(d<bd){ bd=d; best=q; } }
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
    // opportunistic: step onto an adjacent trapped sailor to pop it (kill enemy / free teammate) when safe
    for(const dir in DIRV){ const [dx,dy]=DIRV[dir]; const nx=x+dx, ny=y+dy;
      const v=players.find(q=>q!==p&&q.alive&&q.trapped&&q.tx===nx&&q.ty===ny);
      if(v && passable(nx,ny) && !danger.has(key(nx,ny))){ p.target=null; return { dir, bubble:false }; } }
    const me = teamMode ? nearestEnemy(p) : nearestHuman(p);
    const mt = me ? tileOf(me) : null;
    const canBomb = p.active===0 && canEscapeInTime(p,x,y,danger);
    if(mt && canBomb && (mt.x===x||mt.y===y) && Math.abs(mt.x-x)+Math.abs(mt.y-y)<=p.range && lineClear(x,y,mt.x,mt.y) && Math.random()<p.botDiff.trap){
      p.target=null; return { dir:null, bubble:true };
    }
    if(mt && Math.random()<p.botDiff.react){
      const d=digStep(x,y,mt.x,mt.y,danger);
      if(d){ const [dx,dy]=DIRV[d], nx=x+dx, ny=y+dy;
        if(grid[ny][nx]===BARREL||grid[ny][nx]===CRATE){ if(canBomb && Math.random()<p.botDiff.trap){ p.target=null; return { dir:null, bubble:true }; } }
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

  function speedGain(s){ return SPEED_GAIN[Math.max(0, Math.min(MAX_SPEED, s|0))]; }
  function rideDur(p, base){ const rd=RIDE[p.ride]; return rd ? Math.max(rd.min, base*rd.mul) : base; }
  function moveDur(p){ return rideDur(p, BASE_MOVE - speedGain(p.speed)); }
  function botMoveDur(p){ return rideDur(p, Math.max(0.12, p.botDiff.move - speedGain(p.speed))); }

  // How long the step in progress takes — except for the first tile of a press,
  // which waits out the thumb (see TAP_HOLD).
  function stepDur(p){
    if(p.ghost) return GHOST_MOVE;
    const base = (p.isHuman ? moveDur(p) : botMoveDur(p)*(p.urgent?0.55:1)) * (p.stepLen||1);
    if(!p.tentative) return base;                    // walking, and leaning back, run at full speed
    // The lean has to last until the press is old enough to judge, and cover no
    // more than LEAN_MAX of a tile in that time — so it looks the same whether
    // he is on foot, on skates or in a car.
    const window = Math.max(0.05, TAP_HOLD - base);
    return Math.max(base, window/LEAN_MAX);
  }
  const stillPressing = p => p.inHeld && p.inHeld.length && !p.inTap && p.inHeld[p.inHeld.length-1]===p.dir;

  // Walking into a crate shoves it one tile and you take its place — but only
  // into empty floor, so a crate can never bury a sailor, a bubble or an item.
  function pushCrate(p, cx, cy, dx, dy){
    const tx=cx+dx, ty=cy+dy;
    if(!inB(tx,ty) || grid[ty][tx]!==FLOOR || bubbleAt(tx,ty)) return false;
    if(powerups.some(pu=>pu.x===tx&&pu.y===ty)) return false;
    for(const q of players){
      if(!q.alive) continue;
      const t=tileOf(q);
      if((t.x===tx&&t.y===ty) || (q.moving&&q.tox===tx&&q.toy===ty)) return false;
    }
    grid[cy][cx]=FLOOR; grid[ty][tx]=CRATE; events.push('push');
    return true;
  }

  // One pickup. The surprise box rolls here, inside the sim, so everyone online
  // sees the same result. It can roll a dud, and never another surprise box.
  function applyItem(p, type){
    if(type===PU_CAR||type===PU_TURTLE){ p.ride = type===PU_CAR?'car':'turtle'; events.push('ride'); return; }
    if(type===PU_SURPRISE){ events.push('surprise'); const r=rollFrom(SURPRISE_POOL); if(r>=0) applyItem(p,r); return; }
    if(type===PU_RANGE) p.range=Math.min(MAX_RANGE,p.range+1);
    else if(type===PU_BUBBLE) p.maxBubbles=Math.min(MAX_BUBBLES,p.maxBubbles+1);
    else p.speed=Math.min(MAX_SPEED,p.speed+1);
    events.push('power');
  }

  // Standing on a tile (or a line): decide what to do next and, if there is
  // somewhere to go, set off. Called when he is not moving — and again in the
  // very tick a tile lands, so a walk is one continuous motion (see update).
  function startStep(p, danger, dt){
      let dir=null, bubble=false;
    if(p.control==='ai'){ p.think-=dt;
      // A bot keeps its last direction between thinks, which is fine mid-tile but
      // used to walk it into a blast cross — or, once the sea started rising,
      // straight back onto the ring it had just fled. A cached step into danger
      // always earns a fresh think.
      let cached = p.think>0 ? p._dir : null;
      if(cached){ const [cx,cy]=DIRV[cached]; if(danger.has(key(p.tx+cx,p.ty+cy))) cached=null, p.think=0; }
      if(p.think<=0){ p.think=0.05; const a=botAct(p,danger); dir=a.dir; bubble=a.bubble; p._dir=dir; } else dir=cached; }
    else { dir=(p.inHeld&&p.inHeld.length)?p.inHeld[p.inHeld.length-1]:null; if(p.inBomb){ bubble=true; p.inBomb=false; } }
    if(bubble) placeBubble(p);
    // One press = one tile. The first tile of a press always goes; a second
    // one only once the press has lasted TAP_HOLD, and never off a tap the
    // player has already let go of (p.inTap), whose direction the client is
    // only replaying. In between he may LEAN into the next tile — slowly,
    // and ready to lean back — so that holding never looks like a stall.
    const committed = p.control==='ai' || p.pressSteps===0 || (p.pressT>=TAP_HOLD && !p.inTap);
    const leaning = !committed && p.control!=='ai' && p.pressSteps>0 && stillPressing(p);
    if(dir && (committed || leaning)){ const [dx,dy]=DIRV[dir];
      const nx = p.tx+dx, ny = p.ty+dy;
      if(!leaning && !p.ghost && p.control!=='ai' && inB(nx,ny) && grid[ny][nx]===CRATE) pushCrate(p,nx,ny,dx,dy);
      if(p.ghost ? inB(nx,ny) : canStand(nx,ny)){                            // a ghost drifts through anything
        p.moving=true; p.fx=p.tx; p.fy=p.ty; p.tox=nx; p.toy=ny; p.t=0; p.dir=dir;
        p.stepLen=1; p.tentative=leaning;
        if(dx) p.faceX=dx;                                                   // which way he leans
        p._stepSeq=p.inSeq; p.pressSteps++;                                  // which press this step belongs to
        if(p.inTap){ p.inHeld=[]; p.inTap=false; p._doneSeq=p.inSeq; } } }   // a tap buys one step
  }

  const onRing = (x,y,r) => { const x1=COLS-1-r, y1=ROWS-1-r;
    return x>=r && x<=x1 && y>=r && y<=y1 && (x===r || x===x1 || y===r || y===y1); };
  // The ring that goes under next, once it is close enough to matter. Everyone
  // gets TIDE_WARN to walk off it: it is drawn as rising water, and the bots
  // treat it as somewhere they must not be.
  function doomedRing(){ return (tideNext!==Infinity && tideNext-simTime<=TIDE_WARN) ? tideRing+1 : -1; }
  // One ring of the bay goes under: everything on it is water now, and anyone
  // standing there drowns. Ghosts float over it.
  function floodRing(r){
    const x0=r, x1=COLS-1-r, y0=r, y1=ROWS-1-r;
    if(x0>x1 || y0>y1) return false;
    for(let y=y0;y<=y1;y++) for(let x=x0;x<=x1;x++){
      if(x!==x0 && x!==x1 && y!==y0 && y!==y1) continue;                        // the ring, not the whole rectangle
      if(grid[y][x]===WATER) continue;
      grid[y][x]=WATER; decor.delete(key(x,y));
      for(let i=bubbles.length-1;i>=0;i--) if(bubbles[i].x===x&&bubbles[i].y===y){
        const b=bubbles.splice(i,1)[0]; if(!b.soft && b.owner.active>0) b.owner.active--; }
      for(let i=powerups.length-1;i>=0;i--) if(powerups[i].x===x&&powerups[i].y===y) powerups.splice(i,1);
    }
    events.push('tide');
    return true;
  }
  function drown(p){ p.alive=false; p.trapped=false; p.ride=null; events.push('pop'); if(p.isHuman) becomeGhost(p); }
  // Out of the running, still in the game.
  function becomeGhost(p){
    p.ghost=true; p.ghostCd=GHOST_CD; p.moving=false; p.tentative=false; p.stepLen=1;
    p.inHeld=[]; p.inTap=false; p.inBomb=false; p.active=0; p.ride=null; p.trapped=false; p.trappedBy=null;
    const t=tileOf(p); p.tx=p.fx=p.tox=t.x; p.ty=p.fy=p.toy=t.y;
    events.push('ghost');
  }
  function update(dt){
    events=[];
    if(gameState!=='playing') return events;
    simTime+=dt;
    if(simTime>=tideNext){ if(floodRing(++tideRing)) tideNext=simTime+TIDE_STEP; else tideNext=Infinity; }                                    // stamps snapshots, so a client can draw them evenly however they arrive
    for(const b of bubbles) b.fuse-=dt;
    let popped=true;
    while(popped){ popped=false;
      for(let i=bubbles.length-1;i>=0;i--){ if(bubbles[i].fuse<=0){ const b=bubbles.splice(i,1)[0]; if(!b.soft && b.owner.active>0) b.owner.active--; burst(b); popped=true; } }
    }
    for(let i=blasts.length-1;i>=0;i--){ blasts[i].timer-=dt; if(blasts[i].timer<=0) blasts.splice(i,1); }
    const danger=new Set();
    const doom=doomedRing();                        // the sea is as dangerous as a fuse
    if(doom>0) for(let y=doom;y<=ROWS-1-doom;y++) for(let x=doom;x<=COLS-1-doom;x++)
      if(onRing(x,y,doom) && grid[y][x]===FLOOR) danger.add(key(x,y));
    for(const bl of blasts) danger.add(key(bl.x,bl.y));
    for(const b of bubbles) for(const c of blastCells(b.x,b.y,b.range)) danger.add(key(c.x,c.y));
    for(const p of players){
      if(!p.alive && !p.ghost) continue;
      p.anim+=dt;
      if(p.ghost){                                   // drifts anywhere, picks nothing up, cannot be hurt
        if(p.ghostCd>0) p.ghostCd=Math.max(0,p.ghostCd-dt);
        if(p.inSeq!==p._pressSeq){ p._pressSeq=p.inSeq; p.pressT=dt; p.pressSteps=0; } else p.pressT+=dt;
        p.idleT = (p.inHeld && p.inHeld.length && !p.inTap) ? 0 : p.idleT+dt;
        if(p.inTap && (p.tapTtl-=dt)<=0){ p.inHeld=[]; p.inTap=false; }
        if(!p.moving) startStep(p, danger, dt);
        if(p.moving){
          const dur=stepDur(p); p.t+=dt/dur;
          if(p.t>=1){ const spare=(p.t-1)*dur; p.t=0; p.moving=false; p.tx=p.tox; p.ty=p.toy;
            startStep(p, danger, dt); if(p.moving) p.t=Math.min(0.999, spare/stepDur(p)); }
        }
        continue;
      }
      // How long the CURRENT press has lasted. inSeq identifies one press of one
      // direction (the client bumps it on every new press), so releasing and
      // pressing again starts a fresh press even in the same direction.
      if(p.control!=='ai'){
        const pressing = p.inHeld && p.inHeld.length && !p.inTap;
        if(p.inSeq!==p._pressSeq){
          const rolling = p.pressT>=TAP_HOLD && p.idleT<=ROLL_GAP;   // a corner taken mid-walk keeps the walk
          p._pressSeq=p.inSeq; p.pressT=rolling?TAP_HOLD:dt; p.pressSteps=0; }
        else p.pressT+=dt;
        p.idleT = pressing ? 0 : p.idleT+dt;
      }
      // an owed tap that never found a free tile (walled in, or trapped in a
      // bubble meanwhile) must not fire minutes later
      if(p.inTap && (p.tapTtl-=dt)<=0){ p.inHeld=[]; p.inTap=false; }
      if(p.trapped){
        p.trapTimer-=dt;
        const elapsed=TRAP_TIME-p.trapTimer;
        const freed = p.isHuman ? (p.struggle>=ESCAPE_NEED) : (elapsed>=p.escapeAt);
        if(freed){ p.trapped=false; p.trappedBy=null; p.struggle=0; }
        else if(p.trapTimer<=0){ p.alive=false; events.push('pop'); if(p.isHuman) becomeGhost(p); }
        continue;
      }
      if(!p.moving) startStep(p, danger, dt);
      if(p.moving){
        if(p.tentative){                            // commit, or lean back
          if(p.pressT>=TAP_HOLD && stillPressing(p)) p.tentative=false;
          else if(!stillPressing(p)){
            const bx=p.fx, by=p.fy;                 // walk the step backwards from where he got to
            p.fx=p.tox; p.fy=p.toy; p.tox=bx; p.toy=by;
            p.t=1-p.t; p.tentative=false; p.pressSteps--;
          }
        }
        const dur=stepDur(p);
        p.t += dt/dur;
        if(p.t>=1){
          const spare=(p.t-1)*dur;                      // the part of this tick left over after landing
          p.t=0; p.moving=false; p.tx=p.tox; p.ty=p.toy;
          for(let i=powerups.length-1;i>=0;i--){        // on a line he covers two tiles
            const pu=powerups[i];
            if(Math.abs(pu.x-p.tx)<0.75 && Math.abs(pu.y-p.ty)<0.75) applyItem(p, powerups.splice(i,1)[0].type); }
          // Carry the leftover into the next tile instead of dropping it: waiting
          // for the next tick lost up to a whole tick per tile (14% slower at
          // 30Hz online) and put a standing frame in every snapshot stream, which
          // is what the client drew as a stutter at every tile.
          startStep(p, danger, dt);
          if(p.moving) p.t=Math.min(0.999, spare/stepDur(p));
        }
      }
    }
    for(const p of players){                         // the tide takes whoever it finds, mid-step or not
      if(!p.alive || p.ghost) continue;
      const t=tileOf(p);
      if(inB(t.x,t.y) && grid[t.y][t.x]===WATER) drown(p);
    }
    for(const p of players){
      if(!p.alive) continue;
      const q=dmgPoint(p);
      // a bubble traps everyone incl. its owner — but bots ignore their OWN blast so the AI doesn't suicide
      const hits=blasts.filter(bl=>inBlast(q,bl)&&(p.isHuman||bl.owner!==p));
      if(!hits.length) continue;
      if(p.trapped){
        const popper=hits.find(h=>h.id!==p.trappedBy && !h.soft);   // a ghost's splash cannot finish anyone off
        if(popper){ if(popper.owner && areAllies(popper.owner,p)){ p.trapped=false; p.trappedBy=null; p.struggle=0; events.push('free'); }
                    else { p.alive=false; events.push('pop'); if(p.isHuman) becomeGhost(p); } }
      }
      else { p.trapped=true; p.trappedBy=hits[0].id; p.trapTimer=TRAP_TIME; p.struggle=0; p.ride=null;
        p.escapeAt = p.isHuman ? 999 : ((Math.random()<p.botDiff.esc) ? (0.7+Math.random()*1.5) : 999);
        if(p.moving){ const t=tileOf(p); p.tx=t.x; p.ty=t.y; }   // caught mid-step: settle on a tile
        p.moving=false; events.push('trap'); }
    }
    // contact pop: a sailor standing on a trapped sailor pops the bubble (enemy=out, teammate=freed)
    for(const pt of players){
      if(!pt.alive || !pt.trapped) continue;
      for(const q of players){
        if(q===pt || !q.alive || q.trapped) continue;
        const tq=posOf(q);
        if(Math.abs(tq.x-pt.tx)<0.5 && Math.abs(tq.y-pt.ty)<0.5){
          if(areAllies(q,pt)){ pt.trapped=false; pt.trappedBy=null; pt.struggle=0; events.push('free'); }
          else { pt.alive=false; events.push('pop'); if(pt.isHuman) becomeGhost(pt); }
          break;
        }
      }
    }
    const alive=players.filter(p=>p.alive);
    if(teamMode){ const ts=new Set(alive.map(p=>p.team)); if(ts.size<=1){ gameState='over'; winnerTeam=alive.length?alive[0].team:-1; winnerSlot=alive.length?alive[0].slot:-1; } }
    else if(alive.length<=1){ gameState='over'; winnerSlot=alive.length?alive[0].slot:-1; }
    return events;
  }

  function setInput(slot, inp){
    const p=players&&players[slot];
    if(!p || p.control==='ai') return;
    if(p.trapped && inp.dir && p._lastHeld!==inp.dir) p.struggle+=0.18;
    // inp.tap means the key is already up and the client is only replaying its
    // tap buffer: that press is worth exactly ONE step, however long the round
    // trip took. inp.seq identifies the press, so we can tell "the step already
    // running IS this press" (spend it, stop after) from "the running step
    // belongs to an earlier press" (this one is still owed a step) — a fast
    // double tap must not be swallowed. Older clients send neither field and
    // keep the previous behaviour.
    const seq = inp.seq|0;
    if(inp.dir && inp.tap){
      if(seq && (seq===p._doneSeq || (p.moving && seq===p._stepSeq))){
        p.inHeld=[]; p.inTap=false; p._doneSeq=seq;   // this press already got its step
      } else {
        p.inHeld=[inp.dir]; p.inSeq=seq; p.inTap=true; p.tapTtl=0.4; // still owed exactly one
      }
    } else if(!inp.dir && p.inTap && seq && seq===p.inSeq){
      // "all keys up" for the very press we still owe a step to — it arrives
      // when the client's tap buffer expires, which can beat the step out of the
      // gate if the sailor was busy. Keep the debt instead of cancelling it.
    } else {
      p.inHeld = inp.dir?[inp.dir]:[]; p.inSeq=seq; p.inTap=false;
    }
    if(inp.bomb) p.inBomb=true; p._lastHeld=inp.dir||null;
  }
  function snapshot(){
    return { gs:gameState, win:winnerSlot, ev:events, tm:teamMode, wt:winnerTeam, st:Math.round(simTime*1000),
      tr:tideRing, tt:(tideNext===Infinity ? -1 : Math.max(0, Math.round((tideNext-simTime)*1000))), tw:doomedRing(),
      grid: grid.map(r=>r.join('')),
      players: players.map(p=>({slot:p.slot,tx:p.tx,ty:p.ty,fx:p.fx,fy:p.fy,tox:p.tox,toy:p.toy,
        t:p.t,moving:p.moving,dir:p.dir,faceX:p.faceX,alive:p.alive,ghost:p.ghost,ghostCd:Math.round(p.ghostCd*10)/10,
        trapped:p.trapped,trapTimer:p.trapTimer,struggle:p.struggle,
        range:p.range,maxBubbles:p.maxBubbles,speed:p.speed,ride:p.ride,isHuman:p.isHuman,capColor:p.capColor,anim:p.anim,team:p.team,
        md:(p.isHuman?moveDur(p):botMoveDur(p)),color:SKIN,colorLight:SKIN_LT})),
      bubbles: bubbles.map(b=>({x:b.x,y:b.y,fuse:b.fuse,range:b.range,o:b.owner?b.owner.slot:-1,soft:!!b.soft})),   // o: whose, so a client can count its own
      blasts: blasts.map(b=>({x:b.x,y:b.y,timer:b.timer,soft:!!b.soft})),
      powerups: powerups.map(p=>({x:p.x,y:p.y,type:p.type})) };
  }
  function mapMsg(){ return { grid:grid.map(r=>r.join('')), decor:[...decor], theme, shipCenter, map:mapIdx }; }
  function read(){ return { grid, players, bubbles, blasts, powerups, decor, theme, shipCenter, gameState, winnerSlot, events }; }

  return { reset, update, setInput, snapshot, mapMsg, read,
    get gameState(){ return gameState; }, get winnerSlot(){ return winnerSlot; } };
}

const API = { makeWorld, CORE_VERSION, COLS, ROWS, FUSE, BLAST_TIME, TRAP_TIME, ESCAPE_NEED, BASE_MOVE, TAP_HOLD, DMG_OFF, SPEED_GAIN, MAX_SPEED, MAX_RANGE, MAX_BUBBLES,
  FLOOR, WALL, BARREL, CRATE, WATER, TIDE_START, TIDE_STEP, TIDE_WARN, GHOST_CD, GHOST_RANGE, PU_RANGE, PU_BUBBLE, PU_SPEED, PU_CAR, PU_TURTLE, PU_SURPRISE, PALETTE, DIRV, SKIN, SKIN_LT, MAX_SLOTS, SPAWNS, MIDX, MIDY, MAPS, THEMES,
  DROP_POOL, SURPRISE_POOL };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (root) root.BB = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));

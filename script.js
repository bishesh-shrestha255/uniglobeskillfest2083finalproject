// ════════════════════════════════════════════════════════════════════════
//  FALLING ARSENAL — Rocket Shooter  |  Complete Overhaul
//
//  Architecture overview (sections):
//    1.  DOM references
//    2.  Difficulty configuration
//    3.  Web Audio Manager  (procedural SFX + bg drone + mute)
//    4.  Animated menu starfield
//    5.  Screen manager  (home / game / pause / game-over)
//    6.  Screen shake helper
//    7.  Particle engine  (exhaust + explosions + score popups)
//    8.  Canvas sprite drawing helpers
//    9.  Collision detection
//    10. Game entity classes  (Bullet, Enemy, PowerUp)
//    11. Power-up state machine
//    12. Game-state variables + init
//    13. Input handler  (keyboard + touch)
//    14. In-game HUD drawing
//    15. Spawn helpers
//    16. Main game loop
//    17. Responsive canvas scaling
//    18. Bootstrap
// ════════════════════════════════════════════════════════════════════════

'use strict';

// ════════════════════════════════════════════════════════════════════════
//  1. DOM REFERENCES
// ════════════════════════════════════════════════════════════════════════

const homeScreen      = document.getElementById('home-screen');
const menuCanvas      = document.getElementById('menuCanvas');

const gameWrapper     = document.getElementById('game-wrapper');
const gameCanvas      = document.getElementById('gameCanvas');
const ctx             = gameCanvas.getContext('2d');

const pauseScreen     = document.getElementById('pause-screen');
const gameoverScreen  = document.getElementById('gameover-screen');
const hudBtns         = document.getElementById('hud-btns');

// Home-screen controls
const homeStartBtn    = document.getElementById('home-start-btn');
const homeMuteBtn     = document.getElementById('home-mute-btn');
const homeMuteIcon    = document.getElementById('home-mute-icon');
const diffBtns        = document.querySelectorAll('.diff-btn');

// In-game HUD buttons
const pauseBtn        = document.getElementById('pause-btn');
const ingameMuteBtn   = document.getElementById('ingame-mute');

// Pause-screen buttons
const resumeBtn       = document.getElementById('resume-btn');
const quitBtn         = document.getElementById('quit-btn');

// Game-over screen
const goScore         = document.getElementById('go-score');
const goHighscore     = document.getElementById('go-highscore');
const goHsBlock       = document.getElementById('go-hs-block');
const newHsBadge      = document.getElementById('new-hs-badge');
const restartBtn      = document.getElementById('restart-btn');
const goMenuBtn       = document.getElementById('go-menu-btn');

// Touch controls
const touchZone       = document.getElementById('touch-zone');
const touchFireBtn    = document.getElementById('touch-fire');

// Canvas logical dimensions (never changes — CSS scales the display)
const W = gameCanvas.width;   // 1080
const H = gameCanvas.height;  // 675

// ════════════════════════════════════════════════════════════════════════
//  2. DIFFICULTY CONFIGURATION
//
//  Each property scales a different game system.
//  scoreMultiplier is baked into the score-award logic.
// ════════════════════════════════════════════════════════════════════════

const DIFFICULTIES = {
  easy: {
    label:          'EASY',
    color:          '#4cff91',
    maxHealth:      5,
    baseSpeed:      200,          // player speed px/s
    enemySpeedBase: 65,           // enemy base speed px/s
    enemySpeedRand: 25,           // extra random speed per enemy
    enemyInterval:  2400,         // ms between enemy spawns
    maxEnemies:     4,
    bulletSpeed:    500,
    bulletInterval: 160,          // ms between auto-shots
    powerUpInterval:10000,
    scoreMultiplier:1.5,
    speedCreepRate: 4,            // px/s increase per second of play
    speedCreepCap:  380,
  },
  medium: {
    label:          'MEDIUM',
    color:          '#3df0ff',
    maxHealth:      3,
    baseSpeed:      280,
    enemySpeedBase: 95,
    enemySpeedRand: 40,
    enemyInterval:  1800,
    maxEnemies:     6,
    bulletSpeed:    520,
    bulletInterval: 140,
    powerUpInterval:12000,
    scoreMultiplier:1,
    speedCreepRate: 8,
    speedCreepCap:  500,
  },
  hard: {
    label:          'HARD',
    color:          '#ff4f8b',
    maxHealth:      2,
    baseSpeed:      320,
    enemySpeedBase: 130,
    enemySpeedRand: 60,
    enemyInterval:  1200,
    maxEnemies:     8,
    bulletSpeed:    560,
    bulletInterval: 120,
    powerUpInterval:15000,
    scoreMultiplier:2,
    speedCreepRate: 14,
    speedCreepCap:  650,
  },
};

// Active difficulty key ('easy' | 'medium' | 'hard')
let currentDifficulty = 'medium';

// Convenience getter
function diff() { return DIFFICULTIES[currentDifficulty]; }

// ════════════════════════════════════════════════════════════════════════
//  3. WEB AUDIO MANAGER
//
//  All SFX are synthesised on-the-fly with the Web Audio API — no files,
//  no load lag, instant playback at any time.
//
//  Architecture:
//    AudioContext (lazy — created on first gesture)
//      └─ masterGain (overall volume / mute)
//           ├─ sfxGain  (sound effects)
//           └─ bgGain   (background drone)
//
//  Mute works by setting masterGain.gain to 0 (smooth 50ms fade).
// ════════════════════════════════════════════════════════════════════════

const AudioMgr = (() => {
  let actx = null;      // AudioContext (lazy init)
  let masterGain = null;
  let sfxGain    = null;
  let bgGain     = null;
  let bgDrone    = null; // oscillator node for ambient background tone
  let muted      = false;

  // ── Lazily initialise the AudioContext on first user gesture
  function ensure() {
    if (actx) return;
    actx = new (window.AudioContext || window.webkitAudioContext)();

    masterGain = actx.createGain();
    masterGain.gain.value = 0.55;
    masterGain.connect(actx.destination);

    sfxGain = actx.createGain();
    sfxGain.gain.value = 1;
    sfxGain.connect(masterGain);

    bgGain = actx.createGain();
    bgGain.gain.value = 0;   // starts silent, fades in when game starts
    bgGain.connect(masterGain);

    // Restore saved mute preference
    try {
      if (localStorage.getItem('fa_muted') === '1') setMuted(true, false);
    } catch { /* ignore */ }
  }

  // ── Smooth gain envelope helper
  function envelope(gainNode, attack, sustain, decay, t) {
    gainNode.gain.setValueAtTime(0, t);
    gainNode.gain.linearRampToValueAtTime(sustain, t + attack);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  // ── SFX: Rocket zap — sawtooth frequency sweep downward
  function playShoot() {
    if (muted) return;
    ensure();
    const t = actx.currentTime;
    const osc = actx.createOscillator();
    const g   = actx.createGain();
    osc.connect(g); g.connect(sfxGain);
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(820, t);
    osc.frequency.exponentialRampToValueAtTime(210, t + 0.09);
    envelope(g, 0.002, 0.22, 0.09, t);
    osc.start(t); osc.stop(t + 0.13);
  }

  // ── SFX: Explosion — noise burst + sub-bass thud
  function playExplosion() {
    if (muted) return;
    ensure();
    const t = actx.currentTime;

    // White-noise buffer
    const len    = actx.sampleRate * 0.28;
    const buf    = actx.createBuffer(1, len, actx.sampleRate);
    const data   = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    const src = actx.createBufferSource();
    src.buffer = buf;
    const bp  = actx.createBiquadFilter();
    bp.type   = 'bandpass'; bp.frequency.value = 175; bp.Q.value = 0.5;
    const ng  = actx.createGain();
    src.connect(bp); bp.connect(ng); ng.connect(sfxGain);
    envelope(ng, 0.001, 0.5, 0.24, t);
    src.start(t); src.stop(t + 0.32);

    // Sub-bass thud
    const sub = actx.createOscillator();
    const sg  = actx.createGain();
    sub.connect(sg); sg.connect(sfxGain);
    sub.type = 'sine';
    sub.frequency.setValueAtTime(130, t);
    sub.frequency.exponentialRampToValueAtTime(28, t + 0.18);
    envelope(sg, 0.001, 0.55, 0.2, t);
    sub.start(t); sub.stop(t + 0.25);
  }

  // ── SFX: Player hit — dissonant buzz with vibrato
  function playHit() {
    if (muted) return;
    ensure();
    const t = actx.currentTime;
    const osc = actx.createOscillator();
    const g   = actx.createGain();
    osc.connect(g); g.connect(sfxGain);
    osc.type = 'square';
    osc.frequency.setValueAtTime(300, t);
    osc.frequency.exponentialRampToValueAtTime(75, t + 0.28);
    const lfo  = actx.createOscillator();
    const lg   = actx.createGain();
    lfo.frequency.value = 20; lg.gain.value = 28;
    lfo.connect(lg); lg.connect(osc.frequency);
    envelope(g, 0.005, 0.38, 0.28, t);
    osc.start(t); osc.stop(t + 0.35);
    lfo.start(t); lfo.stop(t + 0.35);
  }

  // ── SFX: Power-up collect — ascending 4-note chime
  function playPowerUp() {
    if (muted) return;
    ensure();
    const t = actx.currentTime;
    [523, 659, 784, 1047].forEach((f, i) => {
      const osc = actx.createOscillator();
      const g   = actx.createGain();
      osc.connect(g); g.connect(sfxGain);
      osc.type = 'triangle';
      osc.frequency.value = f;
      const ti = t + i * 0.07;
      envelope(g, 0.005, 0.2, 0.16, ti);
      osc.start(ti); osc.stop(ti + 0.24);
    });
  }

  // ── SFX: UI click — brief sine tick
  function playClick() {
    if (muted) return;
    ensure();
    const t = actx.currentTime;
    const osc = actx.createOscillator();
    const g   = actx.createGain();
    osc.connect(g); g.connect(sfxGain);
    osc.type = 'sine'; osc.frequency.value = 1100;
    envelope(g, 0.001, 0.16, 0.07, t);
    osc.start(t); osc.stop(t + 0.09);
  }

  // ── Background drone: a low-pitched two-oscillator pad
  function startBgDrone() {
    ensure();
    if (bgDrone) return; // already running
    const osc1 = actx.createOscillator();
    const osc2 = actx.createOscillator();
    bgDrone = { osc1, osc2 };
    osc1.type = 'sine'; osc1.frequency.value = 55;
    osc2.type = 'sine'; osc2.frequency.value = 82;
    osc1.connect(bgGain); osc2.connect(bgGain);
    osc1.start(); osc2.start();
    // Fade drone in
    bgGain.gain.setValueAtTime(0, actx.currentTime);
    bgGain.gain.linearRampToValueAtTime(muted ? 0 : 0.18, actx.currentTime + 1.5);
  }

  function stopBgDrone() {
    if (!bgDrone || !actx) return;
    bgGain.gain.setValueAtTime(bgGain.gain.value, actx.currentTime);
    bgGain.gain.linearRampToValueAtTime(0, actx.currentTime + 0.6);
    const { osc1, osc2 } = bgDrone;
    osc1.stop(actx.currentTime + 0.7);
    osc2.stop(actx.currentTime + 0.7);
    bgDrone = null;
  }

  // ── Mute / unmute with optional fade
  function setMuted(state, save = true) {
    ensure();
    muted = state;
    const targetVol = muted ? 0 : 0.55;
    masterGain.gain.setValueAtTime(masterGain.gain.value, actx.currentTime);
    masterGain.gain.linearRampToValueAtTime(targetVol, actx.currentTime + 0.05);
    if (save) {
      try { localStorage.setItem('fa_muted', muted ? '1' : '0'); } catch { }
    }
  }

  function toggleMute() { setMuted(!muted); return muted; }
  function isMuted() { return muted; }

  return { playShoot, playExplosion, playHit, playPowerUp, playClick,
           startBgDrone, stopBgDrone, toggleMute, isMuted };
})();

// ════════════════════════════════════════════════════════════════════════
//  4. ANIMATED MENU STARFIELD
//
//  Drawn on its own <canvas> behind the home-screen card.
//  Stars have randomised depth (size + speed) for a parallax feel.
// ════════════════════════════════════════════════════════════════════════

const MenuStarfield = (() => {
  const mctx  = menuCanvas.getContext('2d');
  const stars = [];
  let rafId   = null;

  function resize() {
    menuCanvas.width  = window.innerWidth;
    menuCanvas.height = window.innerHeight;
  }

  function init(count = 200) {
    resize();
    stars.length = 0;
    for (let i = 0; i < count; i++) {
      stars.push({
        x:     Math.random() * menuCanvas.width,
        y:     Math.random() * menuCanvas.height,
        r:     0.4 + Math.random() * 1.6,          // radius
        speed: 0.3 + Math.random() * 1.0,           // px/frame
        alpha: 0.2 + Math.random() * 0.7,
        twinkle: Math.random() * Math.PI * 2,       // phase offset
      });
    }
  }

  function draw() {
    const W = menuCanvas.width, H = menuCanvas.height;
    mctx.clearRect(0, 0, W, H);

    const t = performance.now() / 1000;
    for (const s of stars) {
      // Drift downward (parallax scroll effect)
      s.y += s.speed * 0.4;
      if (s.y > H) { s.y = -2; s.x = Math.random() * W; }

      const alpha = s.alpha * (0.7 + 0.3 * Math.sin(t * 1.5 + s.twinkle));
      mctx.fillStyle = `rgba(200,225,255,${alpha.toFixed(2)})`;
      mctx.beginPath();
      mctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      mctx.fill();
    }
    rafId = requestAnimationFrame(draw);
  }

  function start() { if (!rafId) { init(); draw(); } }
  function stop()  { if (rafId)  { cancelAnimationFrame(rafId); rafId = null; } }

  window.addEventListener('resize', resize);

  return { start, stop };
})();

// ════════════════════════════════════════════════════════════════════════
//  5. SCREEN MANAGER
//
//  Controls which "screen" is visible at any time.
//  States: 'home' | 'playing' | 'paused' | 'gameover'
// ════════════════════════════════════════════════════════════════════════

const ScreenMgr = (() => {
  let current = 'home';

  function show(name) {
    // Hide everything first
    homeScreen.classList.add('hidden');
    gameWrapper.classList.remove('hidden');
    pauseScreen.classList.add('hidden');
    gameoverScreen.classList.add('hidden');

    current = name;

    switch (name) {
      case 'home':
        homeScreen.classList.remove('hidden');
        gameWrapper.classList.add('hidden');
        MenuStarfield.start();
        AudioMgr.stopBgDrone();
        break;
      case 'playing':
        MenuStarfield.stop();
        AudioMgr.startBgDrone();
        break;
      case 'paused':
        pauseScreen.classList.remove('hidden');
        AudioMgr.stopBgDrone();
        break;
      case 'gameover':
        gameoverScreen.classList.remove('hidden');
        AudioMgr.stopBgDrone();
        break;
    }
  }

  function get() { return current; }
  return { show, get };
})();

// ════════════════════════════════════════════════════════════════════════
//  6. SCREEN SHAKE
// ════════════════════════════════════════════════════════════════════════

function triggerShake() {
  gameWrapper.classList.remove('shake');
  void gameWrapper.offsetWidth;   // force reflow so animation restarts
  gameWrapper.classList.add('shake');
  gameWrapper.addEventListener('animationend',
    () => gameWrapper.classList.remove('shake'), { once: true });
}

// ════════════════════════════════════════════════════════════════════════
//  7. PARTICLE ENGINE
//
//  Three particle types:
//    'exhaust'  — engine trail from player nozzles
//    'explode'  — burst on enemy kill / player hit
//    'score'    — floating +N text popup on enemy kill
// ════════════════════════════════════════════════════════════════════════

const particles = [];  // shared pool — cleared on game reset

function spawnExplosion(cx, cy, count = 20) {
  const palette = ['#ff7043','#ffca28','#fff176','#ffffff','#ff5252','#ff4f8b'];
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 55 + Math.random() * 230;
    const life  = 0.3 + Math.random() * 0.5;
    particles.push({
      type: 'explode',
      x: cx, y: cy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life, maxLife: life,
      radius: 2 + Math.random() * 4.5,
      color: palette[Math.floor(Math.random() * palette.length)],
    });
  }
}

function spawnExhaust(cx, cy) {
  const life = 0.16 + Math.random() * 0.14;
  particles.push({
    type: 'exhaust',
    x: cx + (Math.random() - 0.5) * 18, y: cy,
    vx: (Math.random() - 0.5) * 20,
    vy: 55 + Math.random() * 85,
    life, maxLife: life,
    radius: 2 + Math.random() * 3.5,
    color: '#ffca28',
  });
  // Inner blue-white hot core
  const life2 = life * 0.5;
  particles.push({
    type: 'exhaust',
    x: cx + (Math.random() - 0.5) * 8, y: cy,
    vx: (Math.random() - 0.5) * 8,
    vy: 38 + Math.random() * 50,
    life: life2, maxLife: life2,
    radius: 1 + Math.random() * 2,
    color: '#ddf4ff',
  });
}

// Score popup text — floats upward and fades
function spawnScorePopup(cx, cy, value) {
  particles.push({
    type: 'score',
    x: cx, y: cy,
    vy: -70,          // float upward
    life: 1.1, maxLife: 1.1,
    text: `+${value}`,
    color: value >= 4 ? '#ffd740' : '#ffffff',
  });
}

function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.y   += p.vy * dt;
    if (p.vx !== undefined) p.x += p.vx * dt;
    p.life -= dt;
    if (p.type === 'explode') p.vy += 130 * dt;  // gravity
    if (p.life <= 0) { particles.splice(i, 1); }
  }
}

function drawParticles() {
  for (const p of particles) {
    const alpha = Math.max(0, p.life / p.maxLife);

    if (p.type === 'score') {
      // Floating score text
      ctx.globalAlpha   = alpha;
      ctx.fillStyle     = p.color;
      ctx.font          = `bold 20px "Orbitron", sans-serif`;
      ctx.textAlign     = 'center';
      ctx.shadowColor   = p.color;
      ctx.shadowBlur    = 8;
      ctx.fillText(p.text, p.x, p.y);
      ctx.shadowBlur    = 0;
      ctx.textAlign     = 'left';
    } else {
      ctx.globalAlpha   = alpha;
      ctx.fillStyle     = p.color;
      if (p.type === 'explode') {
        ctx.shadowColor = p.color;
        ctx.shadowBlur  = 10;
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius * Math.max(0.1, alpha), 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }
  ctx.globalAlpha = 1;
}

// ════════════════════════════════════════════════════════════════════════
//  8. CANVAS SPRITE HELPERS
//
//  All sprites are procedurally drawn — no external image files needed.
//  External images are loaded optionally and used if available.
// ════════════════════════════════════════════════════════════════════════

const playerImg = new Image();
playerImg.src   = 'images/player_rocket.png';
let playerImgLoaded = false;
playerImg.onload = () => { playerImgLoaded = true; };

const enemyImg = new Image();
enemyImg.src   = 'images/enemy_rocket.png';
let enemyImgLoaded = false;
enemyImg.onload = () => { enemyImgLoaded = true; };

function drawPlayerRocket(cx, cy, w, h) {
  const s = w / 70;
  ctx.save();
  ctx.translate(cx, cy);

  // Fuselage body
  ctx.fillStyle = '#dce8f0';
  ctx.beginPath();
  ctx.moveTo(0, -h * 0.48);
  ctx.lineTo(w * 0.18, -h * 0.28); ctx.lineTo(w * 0.22,  h * 0.30);
  ctx.lineTo(-w * 0.22, h * 0.30); ctx.lineTo(-w * 0.18, -h * 0.28);
  ctx.closePath(); ctx.fill();

  // Nose cone
  ctx.fillStyle = '#e8803a';
  ctx.beginPath();
  ctx.moveTo(0, -h * 0.50);
  ctx.lineTo(w * 0.12, -h * 0.22); ctx.lineTo(-w * 0.12, -h * 0.22);
  ctx.closePath(); ctx.fill();

  // Side boosters
  ctx.fillStyle = '#b0bec5';
  [[-1],[1]].forEach(([side]) => {
    ctx.beginPath();
    ctx.moveTo(side * w * 0.28, -h * 0.10);
    ctx.lineTo(side * w * 0.38,  h * 0.05);
    ctx.lineTo(side * w * 0.35,  h * 0.30);
    ctx.lineTo(side * w * 0.22,  h * 0.30);
    ctx.lineTo(side * w * 0.20,  h * 0.05);
    ctx.closePath(); ctx.fill();
  });

  // Cockpit window
  ctx.fillStyle = '#90caf9';
  ctx.beginPath();
  ctx.ellipse(0, -h * 0.15, w * 0.08, h * 0.07, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#546e7a'; ctx.lineWidth = s; ctx.stroke();

  // Flame (animated flicker)
  const fy = h * 0.30, flk = 0.82 + Math.random() * 0.36;
  ctx.fillStyle = '#ffca28';
  ctx.beginPath(); ctx.moveTo(-w*0.10, fy); ctx.lineTo(0, fy+h*0.22*flk); ctx.lineTo(w*0.10, fy); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#ff7043';
  ctx.beginPath(); ctx.moveTo(-w*0.06, fy); ctx.lineTo(0, fy+h*0.15*flk); ctx.lineTo(w*0.06, fy); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#ffca28';
  [[(-w*0.35),(-w*0.285),(-w*0.22)],[(w*0.22),(w*0.285),(w*0.35)]].forEach(([a,b,c]) => {
    ctx.beginPath(); ctx.moveTo(a, fy); ctx.lineTo(b, fy+h*0.14*flk); ctx.lineTo(c, fy); ctx.closePath(); ctx.fill();
  });

  ctx.restore();
}

function drawEnemyRocket(cx, cy, w, h) {
  const s = w / 70;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, -1);  // flip so it faces down

  ctx.fillStyle = '#263238';
  ctx.beginPath();
  ctx.moveTo(0, -h*0.48); ctx.lineTo(w*0.20,-h*0.20); ctx.lineTo(w*0.20,h*0.28); ctx.lineTo(-w*0.20,h*0.28); ctx.lineTo(-w*0.20,-h*0.20);
  ctx.closePath(); ctx.fill();

  ctx.fillStyle = '#eceff1';
  ctx.beginPath();
  ctx.moveTo(-w*0.10,-h*0.44); ctx.lineTo(w*0.10,-h*0.44); ctx.lineTo(w*0.10,h*0.26); ctx.lineTo(-w*0.10,h*0.26);
  ctx.closePath(); ctx.fill();

  ctx.fillStyle = '#37474f';
  ctx.beginPath(); ctx.moveTo(0,-h*0.52); ctx.lineTo(w*0.14,-h*0.22); ctx.lineTo(-w*0.14,-h*0.22); ctx.closePath(); ctx.fill();

  ctx.fillStyle = '#455a64';
  [[-1],[1]].forEach(([side]) => {
    ctx.beginPath();
    ctx.moveTo(side*w*0.20,h*0.05); ctx.lineTo(side*w*0.40,h*0.28); ctx.lineTo(side*w*0.20,h*0.28);
    ctx.closePath(); ctx.fill();
  });

  ctx.strokeStyle = '#eceff1'; ctx.lineWidth = 2*s;
  ctx.beginPath(); ctx.moveTo(-w*0.08,-h*0.36); ctx.lineTo(0,-h*0.44); ctx.lineTo(w*0.08,-h*0.36); ctx.stroke();

  const flk = 0.82 + Math.random() * 0.36;
  ctx.fillStyle = '#ffca28';
  ctx.beginPath(); ctx.moveTo(-w*0.12,h*0.28); ctx.lineTo(0,h*0.44*flk); ctx.lineTo(w*0.12,h*0.28); ctx.closePath(); ctx.fill();

  ctx.restore();
}

// Pre-computed static star data for in-game background
const BG_STARS = (() => {
  const s = [];
  // Seeded deterministic positions so they don't jump on resize
  const seed = [60,40,200,120,340,30,490,90,650,55,800,130,950,40,
    120,200,280,320,430,180,580,260,730,310,900,220,
    50,380,220,440,370,510,520,420,680,490,840,380,
    100,580,300,600,500,560,700,620,920,540];
  for (let i = 0; i < seed.length - 1; i += 2)
    s.push([seed[i], seed[i+1], 0.5 + Math.random()]);
  return s;
})();

function drawBgStars() {
  for (const [x, y, r] of BG_STARS) {
    ctx.fillStyle = 'rgba(200,225,255,0.3)';
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
}

// ════════════════════════════════════════════════════════════════════════
//  9. COLLISION DETECTION
// ════════════════════════════════════════════════════════════════════════

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x &&
         a.y < b.y + b.h && a.y + a.h > b.y;
}

// ════════════════════════════════════════════════════════════════════════
//  10. GAME ENTITY CLASSES
// ════════════════════════════════════════════════════════════════════════

class Bullet {
  constructor(x, y, speedOverride) {
    this.x = x - 3; this.y = y;
    this.w = 6;  this.h = 15;
    this.speed = speedOverride ?? diff().bulletSpeed;
  }
  update(dt) { this.y -= this.speed * dt; }
  draw() {
    ctx.shadowColor = '#ff5252'; ctx.shadowBlur = 10;
    ctx.fillStyle   = 'rgba(255,100,100,0.3)';
    ctx.fillRect(this.x-2, this.y-2, this.w+4, this.h+4);
    ctx.fillStyle = '#ff8a80';
    ctx.fillRect(this.x+1, this.y, this.w-2, this.h*0.4);
    ctx.fillStyle = '#ff1744';
    ctx.fillRect(this.x, this.y+this.h*0.4, this.w, this.h*0.6);
    ctx.shadowBlur = 0;
  }
  isOffScreen() { return this.y + this.h < 0; }
  get rect() { return { x:this.x, y:this.y, w:this.w, h:this.h }; }
}

class Enemy {
  // speedMult scales with time-based difficulty creep
  constructor(speedMult = 1) {
    const d    = diff();
    this.w     = 60; this.h = 70;
    this.x     = Math.random() * (W - this.w - 80) + 40;
    this.y     = -this.h;
    this.speed = (d.enemySpeedBase + Math.random() * d.enemySpeedRand) * speedMult;
  }
  update(dt) { this.y += this.speed * dt; }
  draw() {
    if (enemyImgLoaded) {
      ctx.drawImage(enemyImg, this.x, this.y, this.w, this.h);
    } else {
      drawEnemyRocket(this.x + this.w/2, this.y + this.h/2, this.w, this.h);
    }
  }
  isOffScreen() { return this.y > H; }
  // Tighter hitbox — sprite edges are decorative fins
  get rect() { return { x:this.x+10, y:this.y+6, w:this.w-20, h:this.h-12 }; }
  get cx()   { return this.x + this.w/2; }
  get cy()   { return this.y + this.h/2; }
}

const POWERUP_TYPES = [
  { id:'shield',     color:'#2196f3', label:'SHIELD',     duration:5000  },
  { id:'turbo',      color:'#ffd600', label:'TURBO',      duration:8000  },
  { id:'multiplier', color:'#4caf50', label:'MULTI',      duration:10000 },
];

class PowerUp {
  constructor() {
    const t = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
    Object.assign(this, t);
    this.w = 36; this.h = 36;
    this.x = 40 + Math.random() * (W - 80 - this.w);
    this.y = -this.h;
    this.speed = 72;
    this._ph = Math.random() * Math.PI * 2;  // bobbing phase
  }
  update(dt) { this.y += this.speed * dt; this._ph += dt * 3; }
  draw() {
    const cx = this.x + this.w/2;
    const cy = this.y + this.h/2 + Math.sin(this._ph) * 3;
    const r  = this.w/2;
    ctx.shadowColor = this.color; ctx.shadowBlur = 16;
    ctx.strokeStyle = this.color; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2); ctx.stroke();
    ctx.fillStyle = this.color + '25';
    ctx.beginPath(); ctx.arc(cx, cy, r-2, 0, Math.PI*2); ctx.fill();
    ctx.shadowBlur = 0; ctx.fillStyle = this.color;
    ctx.font = 'bold 13px "Share Tech Mono",monospace';
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(this.label[0], cx, cy);
    ctx.textAlign='left'; ctx.textBaseline='alphabetic';
  }
  isOffScreen() { return this.y > H; }
  get rect() { return { x:this.x, y:this.y, w:this.w, h:this.h }; }
}

// ════════════════════════════════════════════════════════════════════════
//  11. POWER-UP STATE MACHINE
// ════════════════════════════════════════════════════════════════════════

let activeEffects = {};  // { id: { endsAt } }

function applyPowerUp(id, duration) {
  activeEffects[id] = { endsAt: performance.now() + duration };
  if (id === 'turbo') playerSpeed = baseTurboSpeed;
}

function tickEffects(now) {
  for (const [id, ef] of Object.entries(activeEffects)) {
    if (now >= ef.endsAt) {
      delete activeEffects[id];
      if (id === 'turbo') playerSpeed = baseSpeed;
    }
  }
}

function hasEffect(id) {
  return !!(activeEffects[id] && performance.now() < activeEffects[id].endsAt);
}

// ════════════════════════════════════════════════════════════════════════
//  12. GAME STATE VARIABLES + INIT
// ════════════════════════════════════════════════════════════════════════

let playerPos, playerSpeed, baseSpeed, baseTurboSpeed;
let health, maxHealth;
let bullets, enemies, powerUps;
let score, highScore;
let running, paused, lastTime;
let enemySpawnTimer, powerUpSpawnTimer, bulletTimer;
let difficultyTimer;   // seconds in-game — drives enemy speed creep
let rafId = null;      // requestAnimationFrame handle

function loadHighScore() {
  try { return parseInt(localStorage.getItem(`fa_hs_${currentDifficulty}`) || '0', 10); }
  catch { return 0; }
}
function saveHighScore(s) {
  try { localStorage.setItem(`fa_hs_${currentDifficulty}`, String(s)); }
  catch { }
}

function initState() {
  const d          = diff();
  baseSpeed        = d.baseSpeed;
  baseTurboSpeed   = d.baseSpeed * 1.5;
  playerSpeed      = baseSpeed;
  playerPos        = { x: W/2 - 30, y: H * 0.65 };
  health           = d.maxHealth;
  maxHealth        = d.maxHealth;
  bullets          = [];
  enemies          = [];
  powerUps         = [];
  particles.length = 0;
  score            = 0;
  highScore        = loadHighScore();
  activeEffects    = {};
  running          = true;
  paused           = false;
  lastTime         = null;
  enemySpawnTimer  = 0;
  powerUpSpawnTimer= 0;
  bulletTimer      = 0;
  difficultyTimer  = 0;
}

// ════════════════════════════════════════════════════════════════════════
//  13. INPUT HANDLER  (keyboard + touch)
// ════════════════════════════════════════════════════════════════════════

const keys = {};

document.addEventListener('keydown', e => {
  keys[e.code] = true;

  if (e.code === 'Space' && running && !paused) {
    e.preventDefault();
    fireBurst();
  }
  if ((e.code === 'KeyP' || e.code === 'Escape') && ScreenMgr.get() !== 'home') {
    togglePause();
  }
});
document.addEventListener('keyup', e => { keys[e.code] = false; });

// ── Touch D-Pad: press → set virtual key, release → clear it
document.querySelectorAll('.dp').forEach(btn => {
  const key = btn.dataset.key;
  btn.addEventListener('touchstart', e => { e.preventDefault(); keys[key] = true;  }, { passive:false });
  btn.addEventListener('touchend',   e => { e.preventDefault(); keys[key] = false; }, { passive:false });
});
touchFireBtn.addEventListener('touchstart', e => { e.preventDefault(); if (running && !paused) fireBurst(); }, { passive:false });

// ── Fire burst shot (manual + auto share this function)
function fireBurst() {
  const bx = playerPos.x + 30;
  const by = playerPos.y + 5;
  const spd = diff().bulletSpeed;
  bullets.push(new Bullet(bx, by, spd));
  if (hasEffect('multiplier')) {
    bullets.push(new Bullet(bx+18, by, spd));
    bullets.push(new Bullet(bx-18, by, spd));
  }
  AudioMgr.playShoot();
}

// ── Award score, respecting difficulty multiplier, and spawn popup
function awardScore(cx, cy, base = 1) {
  const pts = Math.round(base * diff().scoreMultiplier * (hasEffect('multiplier') ? 2 : 1));
  score += pts;
  spawnScorePopup(cx, cy - 10, pts);
}

// ════════════════════════════════════════════════════════════════════════
//  14. IN-GAME HUD
//
//  Drawn on top of all canvas content each frame.
//  Includes: score, high score, hull segments, difficulty badge,
//            power-up countdown bars, shield ring, pause hint.
// ════════════════════════════════════════════════════════════════════════

function drawHUD(now) {
  const P = 18;  // padding

  // ── Score
  ctx.font      = `bold 14px "Share Tech Mono",monospace`;
  ctx.fillStyle = 'rgba(180,220,255,0.5)';
  ctx.shadowBlur = 0;
  ctx.fillText('SCORE', P, 30);

  ctx.font      = `bold 34px "Orbitron",sans-serif`;
  ctx.fillStyle = '#3df0ff';
  ctx.shadowColor = 'rgba(61,240,255,0.6)'; ctx.shadowBlur = 10;
  ctx.fillText(`${score}`, P, 64);
  ctx.shadowBlur = 0;

  // ── High score (top-right)
  ctx.font      = `12px "Share Tech Mono",monospace`;
  ctx.fillStyle = 'rgba(180,220,255,0.4)';
  ctx.textAlign = 'right';
  ctx.fillText(`BEST ${Math.max(score, highScore)}`, W - P, 28);
  ctx.textAlign = 'left';

  // ── Difficulty badge (top-right, below HS)
  const dc = diff().color;
  ctx.font      = `bold 11px "Orbitron",sans-serif`;
  ctx.fillStyle = dc;
  ctx.shadowColor = dc; ctx.shadowBlur = 6;
  ctx.textAlign = 'right';
  ctx.fillText(diff().label, W - P, 46);
  ctx.textAlign = 'left'; ctx.shadowBlur = 0;

  // ── Hull / Health bar (segmented)
  const hpY = 82, segW = 28, segH = 14, segGap = 5;
  ctx.font = '11px "Share Tech Mono",monospace';
  ctx.fillStyle = 'rgba(180,220,255,0.45)';
  ctx.fillText('HULL', P, hpY);
  for (let i = 0; i < maxHealth; i++) {
    const sx = P + i*(segW+segGap), sy = hpY+5;
    const filled = i < health;
    ctx.fillStyle = '#090e28'; ctx.fillRect(sx, sy, segW, segH);
    if (filled) {
      const ratio = health / maxHealth;
      ctx.fillStyle = ratio>0.66 ? '#4cff91' : ratio>0.33 ? '#ffc107' : '#ff4f8b';
      ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 6;
      ctx.fillRect(sx+1, sy+1, segW-2, segH-2);
      ctx.shadowBlur = 0;
    }
    ctx.strokeStyle = filled ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1; ctx.strokeRect(sx, sy, segW, segH);
  }

  // ── Power-up countdown bars
  let pY = 130;
  for (const [id, ef] of Object.entries(activeEffects)) {
    const def = POWERUP_TYPES.find(t => t.id === id);
    if (!def) continue;
    const rem  = Math.max(0, ef.endsAt - now);
    const frac = rem / def.duration;
    const bW   = 140, bH = 8;

    ctx.font = '10px "Share Tech Mono",monospace';
    ctx.fillStyle = def.color;
    ctx.shadowColor = def.color; ctx.shadowBlur = 4;
    ctx.fillText(`▸ ${def.label}`, P, pY);
    ctx.shadowBlur = 0;

    ctx.fillStyle = '#090e28'; ctx.fillRect(P, pY+3, bW, bH);
    ctx.fillStyle = def.color;
    ctx.shadowColor = def.color; ctx.shadowBlur = 5;
    ctx.fillRect(P, pY+3, bW*frac, bH);
    ctx.shadowBlur = 0;

    ctx.font = '9px "Share Tech Mono",monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText(`${(rem/1000).toFixed(1)}s`, P+bW+6, pY+11);
    pY += 25;
  }

  // ── Shield aura around player
  if (hasEffect('shield')) {
    ctx.strokeStyle = '#2196f3'; ctx.lineWidth = 2.2;
    ctx.shadowColor = '#2196f3'; ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.arc(playerPos.x+30, playerPos.y+35, 46, 0, Math.PI*2);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
}

// ════════════════════════════════════════════════════════════════════════
//  15. SPAWN HELPERS
// ════════════════════════════════════════════════════════════════════════

function trySpawnEnemy(elapsedMs) {
  enemySpawnTimer += elapsedMs;
  const d = diff();
  if (enemySpawnTimer >= d.enemyInterval && enemies.length < d.maxEnemies) {
    enemySpawnTimer -= d.enemyInterval;
    // Speed creep: enemies get faster as the session progresses
    const mult = 1 + difficultyTimer * 0.012;
    enemies.push(new Enemy(mult));
  }
}

function trySpawnPowerUp(elapsedMs) {
  powerUpSpawnTimer += elapsedMs;
  if (powerUpSpawnTimer >= diff().powerUpInterval) {
    powerUpSpawnTimer -= diff().powerUpInterval;
    powerUps.push(new PowerUp());
  }
}

// ════════════════════════════════════════════════════════════════════════
//  16. MAIN GAME LOOP
// ════════════════════════════════════════════════════════════════════════

function gameLoop(timestamp) {
  if (!running) return;

  if (paused) {
    // While paused, keep requesting frames so we can un-pause smoothly,
    // but don't update any game state.
    rafId = requestAnimationFrame(gameLoop);
    return;
  }

  // ── Delta time (capped to prevent huge jumps after tab switch)
  if (lastTime === null) lastTime = timestamp;
  const dt  = Math.min((timestamp - lastTime) / 1000, 0.05);
  lastTime  = timestamp;
  const now = timestamp;

  difficultyTimer += dt;

  tickEffects(now);

  // ── Background
  ctx.fillStyle = '#080820'; ctx.fillRect(0, 0, W, H);
  drawBgStars();

  // ── Player movement (clamped to canvas)
  const spd = playerSpeed;
  if (keys['ArrowUp']    || keys['KeyW']) playerPos.y = Math.max(0,       playerPos.y - spd*dt);
  if (keys['ArrowDown']  || keys['KeyS']) playerPos.y = Math.min(H-70,    playerPos.y + spd*dt);
  if (keys['ArrowLeft']  || keys['KeyA']) playerPos.x = Math.max(0,       playerPos.x - spd*dt);
  if (keys['ArrowRight'] || keys['KeyD']) playerPos.x = Math.min(W-60,    playerPos.x + spd*dt);

  // Exhaust trail from three nozzles
  const ex = playerPos.x + 30, ey = playerPos.y + 72;
  spawnExhaust(ex, ey);
  spawnExhaust(ex-19, ey-4);
  spawnExhaust(ex+19, ey-4);

  const playerRect = { x:playerPos.x+8, y:playerPos.y+5, w:44, h:60 };

  // ── Spawn
  trySpawnEnemy(dt * 1000);
  trySpawnPowerUp(dt * 1000);

  // ── Auto-fire
  bulletTimer += dt * 1000;
  if (bulletTimer >= diff().bulletInterval) {
    bulletTimer -= diff().bulletInterval;
    fireBurst();
  }

  // ── Update entities
  for (const b of bullets)  b.update(dt);
  for (const e of enemies)  e.update(dt);
  for (const p of powerUps) p.update(dt);
  updateParticles(dt);

  // ── Cull off-screen objects (memory leak prevention)
  bullets  = bullets.filter(b  => !b.isOffScreen());
  enemies  = enemies.filter(e  => !e.isOffScreen());
  powerUps = powerUps.filter(p => !p.isOffScreen());

  // ── Collision: bullet ↔ enemy
  const hitBullets = new Set();
  const hitEnemies = new Set();
  for (let bi = 0; bi < bullets.length; bi++) {
    for (let ei = 0; ei < enemies.length; ei++) {
      if (!hitEnemies.has(ei) && !hitBullets.has(bi) &&
          rectsOverlap(bullets[bi].rect, enemies[ei].rect)) {
        hitBullets.add(bi);
        hitEnemies.add(ei);
        awardScore(enemies[ei].cx, enemies[ei].cy, 1);
        spawnExplosion(enemies[ei].cx, enemies[ei].cy, 22);
        AudioMgr.playExplosion();
      }
    }
  }
  bullets = bullets.filter((_, i) => !hitBullets.has(i));
  enemies = enemies.filter((_, i) => !hitEnemies.has(i));

  // ── Collision: player ↔ power-up
  const collected = new Set();
  for (let pi = 0; pi < powerUps.length; pi++) {
    if (rectsOverlap(playerRect, powerUps[pi].rect)) {
      applyPowerUp(powerUps[pi].id, powerUps[pi].duration);
      collected.add(pi);
      AudioMgr.playPowerUp();
    }
  }
  powerUps = powerUps.filter((_, i) => !collected.has(i));

  // ── Collision: player ↔ enemy
  for (let i = enemies.length - 1; i >= 0; i--) {
    if (rectsOverlap(enemies[i].rect, playerRect)) {
      spawnExplosion(enemies[i].cx, enemies[i].cy, 14);
      enemies.splice(i, 1);
      if (!hasEffect('shield')) {
        health -= 1;
        AudioMgr.playHit();
        triggerShake();
        if (health < 1) { endGame(); return; }
      }
    }
  }

  // ── Draw order (back → front)
  drawParticles();
  for (const p of powerUps) p.draw();
  for (const e of enemies)  e.draw();
  for (const b of bullets)  b.draw();

  // Player rocket
  if (playerImgLoaded) {
    ctx.drawImage(playerImg, playerPos.x, playerPos.y, 60, 70);
  } else {
    drawPlayerRocket(playerPos.x+30, playerPos.y+35, 60, 70);
  }

  // HUD on top
  drawHUD(now);

  // ── Difficulty speed creep (capped per difficulty setting)
  baseSpeed      = Math.min(diff().speedCreepCap, diff().baseSpeed + difficultyTimer * diff().speedCreepRate);
  baseTurboSpeed = baseSpeed * 1.5;
  if (!hasEffect('turbo')) playerSpeed = baseSpeed;

  rafId = requestAnimationFrame(gameLoop);
}

// ════════════════════════════════════════════════════════════════════════
//  PAUSE / RESUME
// ════════════════════════════════════════════════════════════════════════

function togglePause() {
  if (!running) return;
  paused = !paused;
  if (paused) {
    ScreenMgr.show('paused');
    AudioMgr.stopBgDrone();
  } else {
    pauseScreen.classList.add('hidden');
    ScreenMgr.show('playing');
    lastTime = null;   // reset dt so we don't get a huge jump
  }
}

// ════════════════════════════════════════════════════════════════════════
//  GAME OVER
// ════════════════════════════════════════════════════════════════════════

function endGame() {
  running = false;
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }

  const isNewBest = score > highScore;
  if (isNewBest) { highScore = score; saveHighScore(highScore); }

  goScore.textContent     = score;
  goHighscore.textContent = highScore;
  newHsBadge.classList.toggle('hidden', !isNewBest);

  ScreenMgr.show('gameover');
}

// ════════════════════════════════════════════════════════════════════════
//  GAME START / RESTART
// ════════════════════════════════════════════════════════════════════════

function startGame() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  initState();
  ScreenMgr.show('playing');
  rafId = requestAnimationFrame(gameLoop);
}

// ════════════════════════════════════════════════════════════════════════
//  MUTE SYNC  (keeps both buttons in sync with AudioMgr state)
// ════════════════════════════════════════════════════════════════════════

function syncMuteUI() {
  const muted = AudioMgr.isMuted();
  const icon  = muted ? '🔇' : '🔊';
  const label = muted ? ' AUDIO OFF' : ' AUDIO ON';
  homeMuteIcon.textContent = icon;
  homeMuteBtn.textContent  = icon + label;
  ingameMuteBtn.textContent = icon;
}

// ════════════════════════════════════════════════════════════════════════
//  17. RESPONSIVE CANVAS SCALING
//
//  The canvas logical size stays fixed at 1080×675. We scale the
//  game-wrapper element to fill the viewport while preserving aspect ratio.
// ════════════════════════════════════════════════════════════════════════

function fitCanvas() {
  const vw = window.innerWidth, vh = window.innerHeight;
  gameWrapper.style.width  = `${vw}px`;
  gameWrapper.style.height = `${vh}px`;
}

window.addEventListener('resize', fitCanvas);

// ════════════════════════════════════════════════════════════════════════
//  18. BOOTSTRAP — wire up all UI event listeners and launch home screen
// ════════════════════════════════════════════════════════════════════════

// ── Difficulty buttons
diffBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    AudioMgr.playClick();
    diffBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentDifficulty = btn.dataset.diff;
  });
});

// ── Home screen Launch
homeStartBtn.addEventListener('click', () => {
  AudioMgr.playClick();
  startGame();
});

// ── Home mute button
homeMuteBtn.addEventListener('click', () => {
  AudioMgr.toggleMute();
  syncMuteUI();
});

// ── In-game mute button
ingameMuteBtn.addEventListener('click', () => {
  AudioMgr.toggleMute();
  syncMuteUI();
});

// ── Pause / Resume
pauseBtn.addEventListener('click',  () => { AudioMgr.playClick(); togglePause(); });
resumeBtn.addEventListener('click', () => { AudioMgr.playClick(); togglePause(); });

// ── Quit to menu
quitBtn.addEventListener('click', () => {
  AudioMgr.playClick();
  running = false; paused = false;
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  ScreenMgr.show('home');
});

// ── Game-over: play again
restartBtn.addEventListener('click', () => {
  AudioMgr.playClick();
  startGame();
});

// ── Game-over: main menu
goMenuBtn.addEventListener('click', () => {
  AudioMgr.playClick();
  ScreenMgr.show('home');
});

// ── Keyboard pause shortcut works from anywhere in the game
document.addEventListener('keydown', e => {
  if ((e.code === 'KeyP' || e.code === 'Escape') && ScreenMgr.get() === 'playing') togglePause();
  if ((e.code === 'KeyP' || e.code === 'Escape') && ScreenMgr.get() === 'paused')  togglePause();
});

// ── Initial setup
fitCanvas();
ScreenMgr.show('home');
MenuStarfield.start();
syncMuteUI();

// Render a static attract frame on the game canvas so it isn't blank
(function attractFrame() {
  ctx.fillStyle = '#080820'; ctx.fillRect(0, 0, W, H);
  drawBgStars();
  drawPlayerRocket(W/2, H/2 - 20, 80, 95);
})();

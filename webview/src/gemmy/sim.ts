// Gemmy's simulation: port of the app's ui/components/FloatingMascot.kt (Spring1, MascotSim, runMascotLoop).
// Plain TS: springs, fling physics, bounce, dizzy, particles, moods, tricks, wander, sleep, blink. Positions are px in
// the view's coordinates, (x, y) = the body center; `d` = px per dp (1 here: the webview's CSS px play the app's dp).
//
// Power (as the app): full frame rate only while something moves, ~30 fps while just hovering, ~20 fps asleep. After
// 5 s without interaction it eases into a still pose and the loop requests no frames at all, waking on a timer for the
// next blink (every 3–7 s), idle trick (every 18–42 s), snore while asleep or glint while the agent works; a pointer,
// an agent state change or a resize wakes it at once. GemmyLoop.stop() parks it while the document is hidden.

export const MAX_PARTICLES = 40;
export const P_HEART = 0;
export const P_SPARKLE = 1;
export const P_Z = 2;
export const P_GLINT = 3; // slow sparkle rising from the antenna while the agent works
const SLEEP_AFTER_S = 50; // falls asleep after this long untouched
const PI = Math.PI;

const HELLO_LINES = ['Hi! 👋', 'Hey there! 😊', 'Hello, friend! ✨'];
const TAP_LINES = [
  'Hehe, that tickles! 😆', 'Need a hand? ✨', "I'm Gemmy! 💜", "Let's build something cool 🚀",
  'Bugs? Where?! 🐛', "You're doing great! 🌟", 'Coffee break? ☕', 'Boop! 👉',
];
const GRAB_LINES = ['Woah! 😲', 'Where are we going?', 'Up we go! 🎈', 'Careful with me!'];
const FLING_LINES = ['Wheeee! 🚀', 'Yaaay! 🎢', 'Woohoo!'];
const OUCH_LINES = ['Ouch! 💫', 'Oof!', 'Bonk! 🤕'];
const DIZZY_LINES = ['Woah… dizzy… 😵‍💫', 'The room is spinning… 💫'];
const ANGRY_LINES = ["Hey! Stop poking! 😤", "Grr… that's enough! 😠"];
const WAKE_LINES = ["Huh?! I'm awake! 😳", 'Five more minutes… 😪', "Wha— oh, hi! 👀"];
const WORK_LINES = ['On it! 🛠️', 'Thinking… 🤔', 'Agent is cooking 🍳'];
const DONE_LINES = ['Done! ✨', 'Ta-da! 🎉', 'All finished! 🙌'];

export type Mood = 'NORMAL' | 'HAPPY' | 'LOVE' | 'SURPRISED' | 'DIZZY' | 'SLEEP' | 'ANGRY' | 'THINKING';
export type Trick = 'NONE' | 'WANDER' | 'WAVE' | 'HOP' | 'SPIN' | 'DANCE' | 'LOOK_AROUND' | 'YAWN';

const rnd = Math.random;
const rndInt = (n: number) => Math.floor(Math.random() * n);
const pick = <T>(list: readonly T[]): T => list[rndInt(list.length)];
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const now = () => performance.now();

/** A damped spring on one value (semi-implicit Euler). */
export class Spring1 {
  v = 0;
  vel = 0;
  private target = 0;

  step(target: number, k: number, c: number, dt: number) {
    this.target = target;
    this.vel += (k * (target - this.v) - c * this.vel) * dt;
    this.v += this.vel * dt;
  }

  settled(eps: number) {
    return Math.abs(this.vel) < eps * 4 && Math.abs(this.v - this.target) < eps;
  }
}

/** All of Gemmy's state (MascotSim). The view reads the plain fields after each frame (GemmyLoop's onFrame). */
export class MascotSim {
  speechText = '';
  speechVisible = false;
  menuOpen = false;
  hideRequested = false;

  /** Set by GemmyLoop: ends a deep rest (the app's wakeSignal). */
  onWake: () => void = () => {};

  readonly r: number; // body radius
  readonly half: number; // half of the 64dp touch box

  boundsW = 0;
  boundsH = 0;

  x = -1;
  y = -1;
  vx = 0;
  vy = 0;
  time = 0; // real seconds; drives timers (kept exact across rests, see syncClock)

  /** Clock for cosmetic motion (bob, breathing, glow...). Advances at `liveliness` speed, so it eases to a halt
   *  before a rest and resumes from the same phase afterwards: the still pose never jumps. */
  animT = 0;
  private liveliness = 1;

  // Deep rest: the frame loop requests no frames until a timer or a poke.
  private resting = false;
  private restStartMs = 0;
  private restStartTime = 0;
  private aliveParticles = 0;

  held = false;
  private heldTime = 0;
  private prevX = 0;
  private prevY = 0;
  private dragVx = 0;
  private dragVy = 0;
  private shakeFlips = 0;
  private lastDragSign = 0;

  readonly squash = new Spring1(); // >0 flatter/wider, <0 thinner/taller
  readonly tilt = new Spring1(); // degrees
  readonly antenna = new Spring1(); // degrees
  readonly legs = new Spring1(); // degrees
  hop = 0; // visual vertical offset (px, negative = up)
  private hopV = 0;
  spin = 0;
  wave = 0; // 0..1 right arm raised and waving
  yawn = 0;

  lookX = 0;
  lookY = 0;
  private lookTX = 0;
  private lookTY = 0;
  private nextGlance = 1.5;
  blink = 0;
  private blinkT = -1;
  private nextBlink = 2.5;

  private tempMood: Mood = 'NORMAL';
  private tempMoodUntil = 0;
  sleeping = false;
  private agentWorking = false;
  private workStartedAt = 0;
  trick: Trick = 'NONE';
  trickT = 0;
  private trickDur = 0;
  private lastBeat = -1;
  private wanderTX = 0;
  private wanderTY = 0;
  private nextTrickAt = 8;
  private lastInteraction = 0;
  private wokeAt = -10;
  private pokes = 0;
  private lastPokeAt = -10;
  private speechUntil = 0;
  private menuUntil = 0;
  private nextFx = 0;

  // Particle pool (view coordinates), reused round-robin: no allocations while animating.
  readonly pX = new Float32Array(MAX_PARTICLES);
  readonly pY = new Float32Array(MAX_PARTICLES);
  private readonly pVX = new Float32Array(MAX_PARTICLES);
  private readonly pVY = new Float32Array(MAX_PARTICLES);
  readonly pLife = new Float32Array(MAX_PARTICLES);
  readonly pMax = new Float32Array(MAX_PARTICLES);
  readonly pRot = new Float32Array(MAX_PARTICLES);
  readonly pSize = new Float32Array(MAX_PARTICLES);
  readonly pType = new Int8Array(MAX_PARTICLES);
  private nextSlot = 0;
  private busyParticles = 0;

  constructor(private readonly d: number) {
    this.r = 24 * d;
    this.half = 32 * d;
  }

  mood(): Mood {
    if (this.time < this.tempMoodUntil) return this.tempMood;
    if (this.held) return this.heldTime < 0.9 || Math.hypot(this.dragVx, this.dragVy) > 900 * this.d ? 'SURPRISED' : 'HAPPY';
    if (this.sleeping) return 'SLEEP';
    if (this.trick === 'DANCE') return 'HAPPY';
    if (this.agentWorking) return 'THINKING';
    return 'NORMAL';
  }

  private minX() {
    return this.r * 1.3;
  }
  private maxX() {
    return Math.max(this.minX(), this.boundsW - this.r * 1.3);
  }
  private minY() {
    return this.r * 1.9; // room for the antenna
  }
  private maxY() {
    return Math.max(this.minY(), this.boundsH - this.r * 1.5);
  }

  // ---- frame step

  step(dt: number) {
    this.time += dt;
    if (this.boundsW <= 0 || this.boundsH <= 0) return;
    if (this.x < 0) {
      this.x = this.maxX() - 6 * this.d;
      this.y = clamp(this.boundsH * 0.62, this.minY(), this.maxY());
      this.prevX = this.x;
      this.prevY = this.y;
      this.lastInteraction = this.time;
      this.nextTrickAt = this.time + 6;
      this.setMood('HAPPY', 1.2);
      this.say(pick(HELLO_LINES), 2);
      this.jump(240);
    }

    if (this.speechVisible && this.time > this.speechUntil) this.speechVisible = false;
    if (this.menuOpen && this.time > this.menuUntil) this.menuOpen = false;

    this.stepBody(dt);
    this.stepFace(dt);
    this.stepBehaviour(dt);
    this.stepParticles(dt);

    const targetLife = this.restEligible() ? 0 : 1;
    this.liveliness =
      this.liveliness < targetLife ? Math.min(targetLife, this.liveliness + dt * 2.5) : Math.max(targetLife, this.liveliness - dt * 2.5);
    this.animT += dt * this.liveliness;
  }

  // ---- low-power rest

  /** Untouched for 5 s and nothing moving or flying around. */
  private restEligible(): boolean {
    return (
      this.time - this.lastInteraction > 5 && !this.held && !this.menuOpen && this.trick === 'NONE' &&
      this.hop === 0 && this.hopV === 0 && this.vx === 0 && this.vy === 0 && this.wave === 0 && this.aliveParticles === 0 &&
      this.squash.settled(0.004) && this.tilt.settled(0.3) && this.antenna.settled(0.3) && this.legs.settled(0.3)
    );
  }

  /** Rest eligible, motion fully eased out, and no blink or glance in progress. */
  canDeepRest(): boolean {
    return (
      this.liveliness <= 0 && this.blinkT < 0 && this.restEligible() &&
      Math.abs(this.lookTX - this.lookX) < 0.01 && Math.abs(this.lookTY - this.lookY) < 0.01
    );
  }

  /** How long the loop may sleep: until the next blink, trick, snore/glint, falling asleep, bubble or mood change. */
  msUntilNextWake(): number {
    let wake = this.time + 60;
    if (!this.sleeping) wake = Math.min(wake, this.nextBlink);
    if (!this.sleeping && !this.agentWorking) {
      wake = Math.min(wake, this.nextTrickAt);
      wake = Math.min(wake, this.lastInteraction + SLEEP_AFTER_S);
    }
    if (this.sleeping || this.agentWorking) wake = Math.min(wake, this.nextFx);
    if (this.speechVisible) wake = Math.min(wake, this.speechUntil);
    if (this.tempMoodUntil > this.time) wake = Math.min(wake, this.tempMoodUntil);
    return clamp(Math.floor((wake - this.time) * 1000), 30, 60_000);
  }

  beginRest() {
    if (this.resting) return;
    this.resting = true;
    this.restStartMs = now();
    this.restStartTime = this.time;
  }

  endRest() {
    this.syncClock();
    this.resting = false;
  }

  /** While resting no frames run, so bring `time` up to the real clock before anything reads it. */
  private syncClock() {
    if (this.resting) this.time = this.restStartTime + (now() - this.restStartMs) / 1000;
  }

  /** Wakes the loop from a rest (pointer, agent state, bounds change). */
  poke() {
    this.syncClock();
    this.onWake();
  }

  private stepBody(dt: number) {
    const d = this.d;
    if (this.held) {
      this.heldTime += dt;
      const k = Math.min(1, dt * 14);
      this.dragVx += ((this.x - this.prevX) / dt - this.dragVx) * k;
      this.dragVy += ((this.y - this.prevY) / dt - this.dragVy) * k;
      this.prevX = this.x;
      this.prevY = this.y;
      // Quick left/right reversals = being shaken.
      const sign = this.dragVx > 350 * d ? 1 : this.dragVx < -350 * d ? -1 : 0;
      if (sign !== 0 && sign !== this.lastDragSign) {
        if (this.lastDragSign !== 0) this.shakeFlips += 1;
        this.lastDragSign = sign;
      }
      this.shakeFlips = Math.max(0, this.shakeFlips - dt * 1.2);
      if (this.shakeFlips >= 4) this.setMood('DIZZY', 2.6);
      this.tilt.step(clamp((this.dragVx / d) * 0.05, -32, 32), 160, 9, dt);
      this.legs.step(clamp((this.dragVx / d) * 0.08, -45, 45), 120, 6, dt);
      this.antenna.step(clamp((-this.dragVx / d) * 0.06, -40, 40), 90, 4, dt);
    } else {
      if (this.trick === 'WANDER') {
        const dx = this.wanderTX - this.x;
        const dy = this.wanderTY - this.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 5 * d) {
          this.endTrick();
        } else {
          const sp = Math.min(70 * d, dist * 1.8);
          const k = Math.min(1, dt * 4);
          this.vx += ((dx / dist) * sp - this.vx) * k;
          this.vy += ((dy / dist) * sp - this.vy) * k;
        }
      }
      if (this.trick !== 'WANDER') {
        const f = Math.exp(-2.2 * dt);
        this.vx *= f;
        this.vy *= f;
        if (Math.abs(this.vx) < 3 * d && Math.abs(this.vy) < 3 * d) {
          this.vx = 0;
          this.vy = 0;
        }
      }
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      this.collide();
      this.dragVx = 0;
      this.dragVy = 0;
      this.prevX = this.x;
      this.prevY = this.y;
      const tiltTarget = this.trick === 'DANCE' ? Math.sin(this.trickT * 9) * 14 : clamp((this.vx / d) * 0.045, -22, 22);
      this.tilt.step(tiltTarget, 140, 10, dt);
      this.legs.step(0, 90, 5, dt);
      this.antenna.step(clamp((-this.vx / d) * 0.06, -35, 35), 90, 4, dt);
    }
    this.squash.step(0, 320, 13, dt);

    // Little hop: a visual offset with gravity, independent of the world position.
    if (this.hop < 0 || this.hopV !== 0) {
      this.hopV += 2200 * d * dt;
      this.hop += this.hopV * dt;
      if (this.hop >= 0) {
        if (this.hopV > 150 * d) this.squash.vel += Math.min(this.hopV / d / 110, 5);
        this.hop = 0;
        this.hopV = 0;
      }
    }
  }

  private collide() {
    const lx = this.minX();
    const hx = this.maxX();
    const ly = this.minY();
    const hy = this.maxY();
    if (this.x < lx) {
      this.x = lx;
      if (this.vx < 0) {
        this.impact(-this.vx, true);
        this.vx = -this.vx * 0.55;
      }
    } else if (this.x > hx) {
      this.x = hx;
      if (this.vx > 0) {
        this.impact(this.vx, true);
        this.vx = -this.vx * 0.55;
      }
    }
    if (this.y < ly) {
      this.y = ly;
      if (this.vy < 0) {
        this.impact(-this.vy, false);
        this.vy = -this.vy * 0.55;
      }
    } else if (this.y > hy) {
      this.y = hy;
      if (this.vy > 0) {
        this.impact(this.vy, false);
        this.vy = -this.vy * 0.55;
      }
    }
  }

  private impact(speed: number, sideWall: boolean) {
    const s = speed / this.d;
    if (s < 120) return;
    const amt = Math.min(s / 280, 8);
    if (sideWall) this.squash.vel -= amt;
    else this.squash.vel += amt;
    this.antenna.vel += (sideWall ? amt : -amt) * 28;
    if (s > 700) this.burst(P_SPARKLE, 3);
    if (s > 1700) {
      this.setMood('DIZZY', 2.2);
      if (!this.speechVisible) this.say(pick(OUCH_LINES), 1.4);
    }
  }

  private stepFace(dt: number) {
    if (this.held) {
      this.lookTX = clamp(this.dragVx / (500 * this.d), -1, 1);
      this.lookTY = clamp(this.dragVy / (500 * this.d), -1, 1);
    } else if (this.mood() === 'THINKING') {
      this.lookTX = 0.55 + Math.sin(this.animT * 1.3) * 0.3; // eased clock: settles when resting
      this.lookTY = -0.85;
    } else if (this.trick === 'LOOK_AROUND') {
      this.lookTX = this.trickT < 0.7 ? -1 : this.trickT < 1.5 ? 1 : 0;
      this.lookTY = 0.1;
    } else if (this.vx !== 0 || this.vy !== 0) {
      const sp = Math.hypot(this.vx, this.vy);
      this.lookTX = this.vx / sp;
      this.lookTY = (this.vy / sp) * 0.7;
    } else if (this.time > this.nextGlance) {
      if (rndInt(3) === 0) {
        this.lookTX = 0;
        this.lookTY = 0.15;
      } else {
        this.lookTX = rnd() * 1.6 - 0.8;
        this.lookTY = rnd() - 0.4;
      }
      this.nextGlance = this.time + 1.2 + rnd() * 2.8;
    }
    const k = Math.min(1, dt * 10);
    this.lookX += (this.lookTX - this.lookX) * k;
    this.lookY += (this.lookTY - this.lookY) * k;

    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const halfBlink = 0.075;
      this.blink = clamp(this.blinkT < halfBlink ? this.blinkT / halfBlink : 1 - (this.blinkT - halfBlink) / halfBlink, 0, 1);
      if (this.blinkT >= halfBlink * 2) {
        this.blinkT = -1;
        this.blink = 0;
      }
    } else if (this.time > this.nextBlink && !this.sleeping) {
      this.blinkT = 0;
      const idle = this.time - this.lastInteraction > 5;
      this.nextBlink =
        this.time +
        (rndInt(5) === 0
          ? 0.3 // double blink
          : idle
            ? 3 + rnd() * 4 // rarer while resting: each blink is a short wake
            : 2 + rnd() * 3.5);
    }
  }

  private stepBehaviour(dt: number) {
    if (this.trick !== 'NONE') {
      this.trickT += dt;
      switch (this.trick) {
        case 'WAVE':
          this.wave = Math.min(1, this.trickT * 5) * clamp((this.trickDur - this.trickT) / 0.3, 0, 1);
          break;
        case 'SPIN': {
          const p = clamp(this.trickT / this.trickDur, 0, 1);
          this.spin = 360 * p * p * (3 - 2 * p);
          break;
        }
        case 'DANCE': {
          const beat = Math.floor(this.trickT / 0.42);
          if (beat !== this.lastBeat) {
            this.lastBeat = beat;
            this.jump(160);
            if (beat % 2 === 0) this.burst(P_SPARKLE, 2);
          }
          break;
        }
        case 'HOP': {
          const beat = Math.floor(this.trickT / 0.36);
          if (beat !== this.lastBeat && beat < 3) {
            this.lastBeat = beat;
            this.jump(210);
          }
          break;
        }
        case 'YAWN':
          this.yawn = Math.sin(clamp(this.trickT / this.trickDur, 0, 1) * PI);
          break;
      }
      if (this.trickT >= this.trickDur) this.endTrick();
    } else if (this.wave > 0) {
      this.wave = Math.max(0, this.wave - dt * 4);
    }

    if (!this.held && !this.sleeping && !this.agentWorking && this.trick === 'NONE') {
      if (this.time - this.lastInteraction > SLEEP_AFTER_S) {
        this.sleeping = true;
        this.nextFx = this.time + 0.4;
      } else if (this.time > this.nextTrickAt) {
        const roll = rndInt(100);
        this.startTrick(
          roll < 34 ? 'WANDER' : roll < 52 ? 'LOOK_AROUND' : roll < 64 ? 'WAVE' : roll < 75 ? 'HOP' : roll < 84 ? 'SPIN' : roll < 93 ? 'YAWN' : 'DANCE',
        );
        this.nextTrickAt = this.time + 18 + rnd() * 24;
      }
    }

    if (this.time > this.nextFx) {
      const idle = this.time - this.lastInteraction > 5;
      if (this.sleeping) {
        this.spawn(P_Z, this.x + this.r * 0.55, this.y - this.r * 1.1);
        this.nextFx = this.time + (idle ? 8 + rnd() * 4 : 1.1);
      } else if (this.agentWorking && !this.held) {
        this.spawn(P_GLINT, this.x, this.y - this.r * 1.7);
        this.nextFx = this.time + (idle ? 4 : 0.75);
      }
    }
  }

  private stepParticles(dt: number) {
    let busy = 0;
    let alive = 0;
    const damp = Math.exp(-3 * dt);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.pLife[i] <= 0) continue;
      this.pLife[i] -= dt;
      const type = this.pType[i];
      if (type === P_SPARKLE || type === P_GLINT) {
        this.pVX[i] *= damp;
        this.pVY[i] *= damp;
        this.pRot[i] += 200 * dt;
      } else {
        this.pX[i] += Math.sin((this.pMax[i] - this.pLife[i]) * 5 + i) * 14 * this.d * dt;
      }
      this.pX[i] += this.pVX[i] * dt;
      this.pY[i] += this.pVY[i] * dt;
      if (this.pLife[i] > 0) {
        alive++;
        if (type === P_HEART || type === P_SPARKLE) busy++;
      }
    }
    this.busyParticles = busy;
    this.aliveParticles = alive;
  }

  /** Frame pacing: full rate while anything moves, ~30 fps when just hovering, ~20 fps asleep. */
  calmDelayMs(): number {
    const busy =
      this.held || this.trick !== 'NONE' || this.hop !== 0 || this.hopV !== 0 || this.vx !== 0 || this.vy !== 0 ||
      !this.squash.settled(0.004) || !this.tilt.settled(0.3) || !this.antenna.settled(0.3) || !this.legs.settled(0.3) ||
      this.busyParticles > 0;
    if (busy) return 0;
    return this.sleeping ? 50 : 16;
  }

  // ---- helpers

  private setMood(m: Mood, dur: number) {
    this.tempMood = m;
    this.tempMoodUntil = this.time + dur;
  }

  private say(text: string, dur = 2.4) {
    this.speechText = text;
    this.speechVisible = true;
    this.speechUntil = this.time + dur;
    this.menuOpen = false;
  }

  private jump(power: number) {
    if (this.hop > -4 * this.d) this.hopV = -power * this.d;
  }

  private touched() {
    this.lastInteraction = this.time;
    if (this.sleeping) {
      this.sleeping = false;
      this.wokeAt = this.time;
      this.setMood('SURPRISED', 0.9);
      this.jump(240);
      this.say(pick(WAKE_LINES), 1.8);
    }
  }

  private startTrick(t: Trick) {
    this.trick = t;
    this.trickT = 0;
    this.lastBeat = -1;
    this.spin = 0;
    this.trickDur = { NONE: 0, WANDER: 7, WAVE: 1.8, HOP: 1.2, SPIN: 0.75, DANCE: 3.4, LOOK_AROUND: 2.2, YAWN: 1.8 }[t];
    if (t === 'WANDER') this.pickWanderTarget();
    else if (t === 'WAVE') {
      if (!this.speechVisible && rndInt(2) === 0) this.say(pick(HELLO_LINES), 1.8);
    } else if (t === 'YAWN') {
      if (!this.speechVisible) this.say('*yawn* 🥱', 1.6);
    }
  }

  private endTrick() {
    this.trick = 'NONE';
    this.trickT = 0;
    this.spin = 0;
    this.yawn = 0;
    this.lastBeat = -1;
  }

  private pickWanderTarget() {
    const ang = rnd() * 2 * PI;
    const dist = (80 + rnd() * 140) * this.d;
    const loY = Math.min(Math.max(this.minY(), this.boundsH * 0.15), this.maxY());
    const hiY = Math.max(Math.min(this.maxY(), this.boundsH * 0.85), loY);
    this.wanderTX = clamp(this.x + Math.cos(ang) * dist, this.minX(), this.maxX());
    this.wanderTY = clamp(this.y + Math.sin(ang) * dist, loY, hiY);
  }

  private spawn(type: number, px: number, py: number) {
    const d = this.d;
    const i = this.nextSlot;
    this.nextSlot = (this.nextSlot + 1) % MAX_PARTICLES;
    this.pType[i] = type;
    this.pX[i] = px;
    this.pY[i] = py;
    if (type === P_HEART) {
      this.pVX[i] = (rnd() - 0.5) * 70 * d;
      this.pVY[i] = -(60 + rnd() * 50) * d;
      this.pLife[i] = 1.2 + rnd() * 0.4;
      this.pSize[i] = (6 + rnd() * 3) * d;
      this.pRot[i] = (rnd() - 0.5) * 30;
    } else if (type === P_SPARKLE || type === P_GLINT) {
      const slow = type === P_GLINT;
      const a = rnd() * 2 * PI;
      const sp = (slow ? 20 + rnd() * 25 : 90 + rnd() * 140) * d;
      this.pVX[i] = Math.cos(a) * sp;
      this.pVY[i] = Math.sin(a) * sp - (slow ? 30 * d : 0);
      this.pLife[i] = slow ? 1.1 : 0.5 + rnd() * 0.3;
      this.pSize[i] = (slow ? 3.5 : 4.5 + rnd() * 3) * d;
      this.pRot[i] = rnd() * 90;
    } else {
      this.pVX[i] = 14 * d;
      this.pVY[i] = -24 * d;
      this.pLife[i] = 2.4;
      this.pSize[i] = 5 * d;
      this.pRot[i] = -12;
    }
    this.pMax[i] = this.pLife[i];
  }

  private burst(type: number, n: number) {
    for (let k = 0; k < n; k++) this.spawn(type, this.x + (rnd() - 0.5) * this.r, this.y - this.r * 0.6 + this.hop);
  }

  // ---- outside events

  /** The chat on screen started / stopped running. `celebrate` false: it changed because another chat came up. */
  setAgentWorking(working: boolean, celebrate = true) {
    if (working === this.agentWorking) return;
    this.poke();
    this.agentWorking = working;
    this.lastInteraction = this.time;
    if (working) {
      this.workStartedAt = this.time;
      this.sleeping = false;
      if (this.trick === 'WANDER' || this.trick === 'YAWN') this.endTrick();
      if (rndInt(2) === 0) this.say(pick(WORK_LINES), 1.8);
    } else if (celebrate && this.time - this.workStartedAt > 3) {
      this.setMood('HAPPY', 2);
      this.jump(300);
      this.burst(P_SPARKLE, 10);
      this.say(pick(DONE_LINES), 2.2);
    }
  }

  // ---- gestures

  onPress() {
    this.poke();
    this.touched();
    this.squash.vel += 3.5;
    this.lookTX = 0;
    this.lookTY = 0.2;
    this.nextGlance = this.time + 1.5;
  }

  onTap() {
    this.poke();
    if (this.menuOpen) {
      this.menuOpen = false;
      return;
    }
    if (this.time - this.wokeAt < 1) return; // this tap just woke it up
    this.pokes = this.time - this.lastPokeAt < 1.3 ? this.pokes + 1 : 1;
    this.lastPokeAt = this.time;
    if (this.pokes >= 5) {
      this.pokes = 0;
      this.setMood('ANGRY', 2.4);
      this.say(pick(ANGRY_LINES));
      this.tilt.vel += 260;
      this.squash.vel -= 4;
      return;
    }
    switch (rndInt(4)) {
      case 0:
        this.setMood('HAPPY', 1.4);
        this.jump(260);
        this.burst(P_HEART, 3);
        break;
      case 1:
        this.setMood('HAPPY', 1.6);
        this.jump(200);
        this.say(pick(TAP_LINES));
        break;
      case 2:
        this.setMood('SURPRISED', 0.8);
        this.squash.vel -= 6;
        this.say('Boop! 👉', 1.4);
        break;
      default:
        this.setMood('LOVE', 1.4);
        this.burst(P_HEART, 5);
    }
  }

  onDoubleTap() {
    this.poke();
    this.touched();
    this.menuOpen = false;
    this.startTrick('SPIN');
    this.burst(P_SPARKLE, 8);
    this.say('Wheee! ✨', 1.4);
  }

  onLongPress() {
    this.poke();
    this.touched();
    this.speechVisible = false;
    this.menuOpen = true;
    this.menuUntil = this.time + 5;
    this.setMood('LOVE', 1.2);
    this.burst(P_HEART, 2);
  }

  onDragStart() {
    this.poke();
    this.touched();
    this.held = true;
    this.heldTime = 0;
    this.vx = 0;
    this.vy = 0;
    if (this.trick !== 'NONE') this.endTrick();
    this.menuOpen = false;
    this.shakeFlips = 0;
    this.lastDragSign = 0;
    this.prevX = this.x;
    this.prevY = this.y;
    this.dragVx = 0;
    this.dragVy = 0;
    if (rndInt(3) === 0) this.say(pick(GRAB_LINES), 1.6);
  }

  onDrag(dx: number, dy: number) {
    if (!this.held) return;
    this.poke();
    this.x = clamp(this.x + dx, this.minX(), this.maxX());
    this.y = clamp(this.y + dy, this.minY(), this.maxY());
    this.lastInteraction = this.time;
  }

  onDragEnd(velX: number, velY: number) {
    if (!this.held) return;
    this.poke();
    this.held = false;
    this.lastInteraction = this.time;
    const maxV = 4200 * this.d;
    this.vx = clamp(velX, -maxV, maxV);
    this.vy = clamp(velY, -maxV, maxV);
    const speed = Math.hypot(this.vx, this.vy) / this.d;
    if (this.time < this.tempMoodUntil && this.tempMood === 'DIZZY') this.say(pick(DIZZY_LINES), 2);
    else if (speed > 1400) this.say(pick(FLING_LINES), 1.4);
    else if (speed < 150) {
      this.vx = 0;
      this.vy = 0;
      this.squash.vel += 5;
      this.setMood('HAPPY', 0.7);
    }
    this.shakeFlips = 0;
    this.lastDragSign = 0;
  }

  // ---- long-press menu

  dance() {
    this.poke();
    this.touched();
    this.startTrick('DANCE');
    this.say("Let's dance! 💃", 1.8);
  }

  nap() {
    this.poke();
    this.menuOpen = false;
    this.endTrick();
    this.sleeping = true;
    this.nextFx = this.time + 0.4;
    this.lastInteraction = this.time;
    this.say('Nap time… 😴', 1.6);
  }

  hide() {
    this.poke();
    this.touched();
    this.startTrick('WAVE');
    this.say('Bye bye! 👋', 1.2);
    this.hideRequested = true;
  }
}

/**
 * The single frame loop (runMascotLoop): fixed 1/60 s sub-steps per animation frame, then `onFrame` draws. Parks with
 * no frames at all while Gemmy rests; stop() parks it entirely (document hidden) with the sim's clock still running.
 */
export class GemmyLoop {
  private raf = 0;
  private timer: number | undefined;
  private last = 0;
  private resting = false;
  private running = false;

  constructor(
    private readonly sim: MascotSim,
    private readonly onFrame: () => void,
    /** Called each time Gemmy settles into a deep rest. */
    private readonly onRest: () => void = () => {},
  ) {
    sim.onWake = this.wake;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.resting = false;
    this.sim.endRest();
    this.last = 0;
    this.request();
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.resting = false;
    this.sim.beginRest(); // the clock keeps running (synced in start)
  }

  private request() {
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (t: number) => {
    this.raf = 0;
    if (!this.running) return;
    let dt = this.last === 0 ? 1 / 60 : clamp((t - this.last) / 1000, 0, 0.25);
    this.last = t;
    while (dt > 0.0005) {
      const h = Math.min(dt, 1 / 60);
      this.sim.step(h);
      dt -= h;
    }
    this.onFrame();
    if (this.sim.canDeepRest()) {
      // Still pose: request no frames at all until the next scheduled wake or a pointer / agent event.
      this.sim.beginRest();
      this.resting = true;
      this.timer = window.setTimeout(this.wake, this.sim.msUntilNextWake());
      this.onRest();
    } else {
      const rest = this.sim.calmDelayMs();
      if (rest > 0) {
        this.timer = window.setTimeout(() => {
          this.timer = undefined;
          this.request();
        }, rest);
      } else this.request();
    }
  };

  private wake = () => {
    if (!this.running || !this.resting) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.sim.endRest();
    this.resting = false;
    this.last = 0;
    this.request();
  };
}

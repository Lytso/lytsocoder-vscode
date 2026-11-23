// Gemmy's drawing: port of FloatingMascot.kt's MascotArt, drawMascot, drawLimbs, drawAntenna, drawFace and
// drawParticles on a canvas 2D context. Shapes are built once (Path2D); nothing is allocated per frame.
// Compose's withTransform(translate, rotate, scale) = save + the same calls in the same order + restore.
import { MAX_PARTICLES, P_HEART, P_Z, type MascotSim, type Mood } from './sim';

const PI = Math.PI;
const TAU = 2 * PI;
const DEG = PI / 180;

const INK = '#2E2A6B'; // MascotInk

// Unit-size shapes (about -1..1), drawn with a scale transform; their strokes are in unit space.
const heart = new Path2D();
heart.moveTo(0, 0.9);
heart.bezierCurveTo(-0.5, 0.5, -1, 0.15, -1, -0.3);
heart.bezierCurveTo(-1, -0.75, -0.45, -1, 0, -0.55);
heart.bezierCurveTo(0.45, -1, 1, -0.75, 1, -0.3);
heart.bezierCurveTo(1, 0.15, 0.5, 0.5, 0, 0.9);
heart.closePath();

const sparkle = new Path2D();
sparkle.moveTo(0, -1);
sparkle.quadraticCurveTo(0.12, -0.12, 1, 0);
sparkle.quadraticCurveTo(0.12, 0.12, 0, 1);
sparkle.quadraticCurveTo(-0.12, 0.12, -1, 0);
sparkle.quadraticCurveTo(-0.12, -0.12, 0, -1);
sparkle.closePath();

const star = new Path2D();
for (let i = 0; i < 10; i++) {
  const rad = i % 2 === 0 ? 1 : 0.45;
  const ang = -PI / 2 + (i * PI) / 5;
  if (i === 0) star.moveTo(Math.cos(ang) * rad, Math.sin(ang) * rad);
  else star.lineTo(Math.cos(ang) * rad, Math.sin(ang) * rad);
}
star.closePath();

const zPath = new Path2D();
zPath.moveTo(-0.55, -0.55);
zPath.lineTo(0.55, -0.55);
zPath.lineTo(-0.55, 0.55);
zPath.lineTo(0.55, 0.55);

/** Shapes and colors of one canvas (MascotArt): the body path and gradient are built for its context. */
export class MascotArt {
  readonly r: number;
  readonly bodyPath = new Path2D();
  readonly bodyBrush: CanvasGradient;

  readonly outline = INK;
  readonly limb = '#5B52D6';
  readonly pupil = '#1B1840';
  readonly cheek = '#FF8FB8';
  readonly tongue = '#FF7A9A';
  readonly gem = '#FFD45E';
  readonly heartColor = '#FF5C8A';
  readonly sparkleColor = '#FFE27A';
  readonly zColor = '#A9B4FF';

  readonly outlineW: number; // Stroke(2.2dp, join = Round)
  readonly thinW: number; // Stroke(1.3dp, cap = Round)
  readonly featureW: number; // Stroke(2.2dp, cap = Round)

  constructor(
    ctx: CanvasRenderingContext2D,
    readonly d: number,
  ) {
    const r = (this.r = 24 * d);
    // Gumdrop body, centered on (0, 0).
    const p = this.bodyPath;
    p.moveTo(0, -1.05 * r);
    p.bezierCurveTo(0.62 * r, -1.05 * r, 1.02 * r, -0.45 * r, 1.02 * r, 0.15 * r);
    p.bezierCurveTo(1.02 * r, 0.7 * r, 0.6 * r, 0.98 * r, 0, 0.98 * r);
    p.bezierCurveTo(-0.6 * r, 0.98 * r, -1.02 * r, 0.7 * r, -1.02 * r, 0.15 * r);
    p.bezierCurveTo(-1.02 * r, -0.45 * r, -0.62 * r, -1.05 * r, 0, -1.05 * r);
    p.closePath();
    const g = ctx.createLinearGradient(0, -r, 0, r);
    g.addColorStop(0, '#C9BCFF');
    g.addColorStop(0.5, '#8F7DFF');
    g.addColorStop(1, '#5B57E0');
    this.bodyBrush = g;
    this.outlineW = 2.2 * d;
    this.thinW = 1.3 * d;
    this.featureW = 2.2 * d;
  }
}

// ---- small helpers (Compose DrawScope calls)

function ovalPath(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  c.beginPath();
  c.ellipse(x + w / 2, y + h / 2, Math.max(0, w / 2), Math.max(0, h / 2), 0, 0, TAU);
}

function fillOval(c: CanvasRenderingContext2D, color: string, x: number, y: number, w: number, h: number) {
  ovalPath(c, x, y, w, h);
  c.fillStyle = color;
  c.fill();
}

function strokeOval(c: CanvasRenderingContext2D, color: string, x: number, y: number, w: number, h: number, width: number) {
  ovalPath(c, x, y, w, h);
  stroke(c, color, width, 'round');
}

function fillCircle(c: CanvasRenderingContext2D, color: string, cx: number, cy: number, radius: number) {
  c.beginPath();
  c.arc(cx, cy, Math.max(0, radius), 0, TAU);
  c.fillStyle = color;
  c.fill();
}

function stroke(c: CanvasRenderingContext2D, color: string, width: number, cap: CanvasLineCap, join: CanvasLineJoin = 'miter', path?: Path2D) {
  c.strokeStyle = color;
  c.lineWidth = width;
  c.lineCap = cap;
  c.lineJoin = join;
  if (path) c.stroke(path);
  else c.stroke();
}

/** drawArc: degrees, clockwise from 3 o'clock, inside the oval (x, y, w, h); useCenter = a filled wedge. */
function arcPath(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, startDeg: number, sweepDeg: number, useCenter: boolean) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  c.beginPath();
  if (useCenter) c.moveTo(cx, cy);
  c.ellipse(cx, cy, w / 2, h / 2, 0, startDeg * DEG, (startDeg + sweepDeg) * DEG);
  if (useCenter) c.closePath();
}

function strokeArc(c: CanvasRenderingContext2D, color: string, x: number, y: number, w: number, h: number, startDeg: number, sweepDeg: number, width: number) {
  arcPath(c, x, y, w, h, startDeg, sweepDeg, false);
  stroke(c, color, width, 'round');
}

function line(c: CanvasRenderingContext2D, color: string, x0: number, y0: number, x1: number, y1: number, width: number) {
  c.beginPath();
  c.moveTo(x0, y0);
  c.lineTo(x1, y1);
  stroke(c, color, width, 'round');
}

/** A unit shape at (x, y), rotated and scaled by `size`. */
function unitShape(c: CanvasRenderingContext2D, path: Path2D, x: number, y: number, rotDeg: number, size: number, fill: string | null, outline: string | null, outlineW: number, isZ = false) {
  c.save();
  c.translate(x, y);
  if (rotDeg) c.rotate(rotDeg * DEG);
  c.scale(size, size);
  if (fill) {
    c.fillStyle = fill;
    c.fill(path);
  }
  if (outline) stroke(c, outline, outlineW, isZ ? 'round' : 'butt', 'round', path);
  c.restore();
}

// ---- the mascot

/**
 * Draws Gemmy with its body center at (cx, cy) on the canvas (before bob and hop). Particles live in the sim's (view)
 * coordinates, drawn shifted by the body's offset: the overlay passes (sim.x, sim.y), a preview its own center.
 */
export function drawMascot(c: CanvasRenderingContext2D, s: MascotSim, a: MascotArt, cx: number, cy0: number) {
  const d = a.d;
  const r = a.r;
  const t = s.animT;
  const mood = s.mood();
  const sleeping = mood === 'SLEEP';
  const bobSpeed = mood === 'SLEEP' ? 1.3 : mood === 'THINKING' ? 3.2 : 2.1;
  const bob = s.held ? 0 : Math.sin(t * bobSpeed) * (sleeping ? 1.5 : 3) * d;
  const breathe = Math.sin(t * bobSpeed + 1.1) * (sleeping ? 0.035 : 0.018);
  const cy = cy0 + bob + s.hop;

  // Soft shadow on the "ground" line: shrinks while it hops, faint while held.
  const lift = Math.min(1, Math.max(0, -(bob + s.hop) / (40 * d)));
  const shadowW = r * 1.5 * (1 - 0.35 * lift);
  c.globalAlpha = 0.16 * (1 - 0.5 * lift) * (s.held ? 0.4 : 1);
  fillOval(c, '#000', cx - shadowW / 2, cy0 + r * 1.18, shadowW, r * 0.32);
  c.globalAlpha = 1;

  const sq = Math.min(0.35, Math.max(-0.35, s.squash.v));
  const sx = (1 + sq) * (1 - breathe * 0.5);
  const sy = (1 - sq) * (1 + breathe);
  c.save();
  c.translate(cx, cy);
  c.rotate((s.tilt.v + s.spin) * DEG);
  c.scale(sx, sy);
  drawLimbs(c, s, a, mood);
  c.fillStyle = a.bodyBrush;
  c.fill(a.bodyPath);
  if (mood === 'ANGRY') {
    c.globalAlpha = 0.28;
    c.fillStyle = '#FF3B3B';
    c.fill(a.bodyPath);
    c.globalAlpha = 1;
  }
  c.globalAlpha = 0.16;
  fillOval(c, '#fff', -0.55 * r, 0.18 * r, 1.1 * r, 0.66 * r);
  c.globalAlpha = 1;
  stroke(c, a.outline, a.outlineW, 'butt', 'round', a.bodyPath);
  c.globalAlpha = 0.6;
  fillOval(c, '#fff', -0.68 * r, -0.82 * r, 0.36 * r, 0.2 * r);
  c.globalAlpha = 1;
  drawAntenna(c, s, a, mood);
  drawFace(c, s, a, mood);
  c.restore();

  drawParticles(c, s, a, s.x - cx, s.y - cy0);
}

function drawLimbs(c: CanvasRenderingContext2D, s: MascotSim, a: MascotArt, mood: Mood) {
  const r = a.r;
  const t = s.animT;

  // Feet: paddle while wandering, dangle and swing while held.
  for (let side = 0; side <= 1; side++) {
    const sgn = side === 0 ? -1 : 1;
    const lift = s.trick === 'WANDER' ? Math.max(0, Math.sin(t * 11 + side * PI)) * 0.14 * r : 0;
    const dangle = s.held ? 0.12 * r : 0;
    const swing = s.legs.v + (s.held ? Math.sin(t * 9 + side * PI) * 6 : 0);
    c.save();
    c.translate(sgn * 0.42 * r, 0.84 * r + dangle - lift);
    // rotate(swing, pivot = (0, -0.35r))
    c.translate(0, -0.35 * r);
    c.rotate(swing * DEG);
    c.translate(0, 0.35 * r);
    fillOval(c, a.limb, -0.21 * r, -0.12 * r, 0.42 * r, 0.3 * r);
    strokeOval(c, a.outline, -0.21 * r, -0.12 * r, 0.42 * r, 0.3 * r, a.thinW);
    c.restore();
  }

  // Arms: drawn pointing right, mirrored for the left one. Angle > 0 = down, < 0 = up.
  for (let side = 0; side <= 1; side++) {
    const sgn = side === 0 ? -1 : 1;
    let ang = 28 + Math.sin(t * 2.1 + side) * 4;
    if (s.held) ang = -55 + Math.sin(t * 16 + side * PI) * 14;
    else if (s.trick === 'DANCE') ang = -60 + Math.sin(t * 9 + side * PI) * 45;
    else if (mood === 'ANGRY') ang = 60;
    else if (mood === 'HAPPY' || mood === 'LOVE') ang = -20 + Math.sin(t * 10 + side * PI) * 10;
    if (side === 1 && s.wave > 0) ang += (-125 + Math.sin(t * 15) * 22 - ang) * s.wave;
    c.save();
    c.translate(sgn * 0.88 * r, 0.12 * r);
    c.scale(sgn, 1);
    c.rotate(ang * DEG);
    fillOval(c, a.limb, -0.06 * r, -0.13 * r, 0.46 * r, 0.26 * r);
    strokeOval(c, a.outline, -0.06 * r, -0.13 * r, 0.46 * r, 0.26 * r, a.thinW);
    c.restore();
  }
}

function drawAntenna(c: CanvasRenderingContext2D, s: MascotSim, a: MascotArt, mood: Mood) {
  const r = a.r;
  const t = s.animT;
  const baseY = -1.02 * r;
  const len = 0.62 * r;
  const ang = s.antenna.v * DEG;
  const tipX = Math.sin(ang) * len;
  const tipY = baseY - Math.cos(ang) * len;
  c.beginPath();
  c.moveTo(0, baseY);
  c.quadraticCurveTo(Math.sin(ang * 0.4) * len * 0.5, baseY - len * 0.55, tipX, tipY);
  stroke(c, a.outline, a.featureW, 'round');

  const pulse = mood === 'THINKING' ? 0.55 + 0.45 * Math.sin(t * 7) : mood === 'SLEEP' ? 0.15 : 0.35 + 0.1 * Math.sin(t * 2);
  c.globalAlpha = 0.35 * pulse;
  fillCircle(c, a.gem, tipX, tipY, 0.42 * r * (0.8 + pulse * 0.4));
  c.globalAlpha = 1;
  unitShape(c, star, tipX, tipY, t * 40, 0.24 * r, a.gem, a.outline, 0.16);

  if (mood === 'THINKING') {
    for (let i = 0; i <= 2; i++) {
      const o = t * 3 + i * 2.094;
      fillCircle(c, '#fff', tipX + Math.cos(o) * 0.5 * r, tipY + Math.sin(o) * 0.22 * r, 0.07 * r);
    }
  }
}

function drawFace(c: CanvasRenderingContext2D, s: MascotSim, a: MascotArt, mood: Mood) {
  const d = a.d;
  const r = a.r;
  const t = s.animT;
  const eyeY = -0.12 * r;
  const eyeDX = 0.36 * r;

  const blush = mood === 'HAPPY' || mood === 'LOVE' ? 0.75 : mood === 'ANGRY' ? 0 : 0.45;
  if (blush > 0) {
    c.globalAlpha = blush;
    for (let side = 0; side <= 1; side++) {
      const sgn = side === 0 ? -1 : 1;
      fillOval(c, a.cheek, sgn * 0.6 * r - 0.15 * r, 0.11 * r, 0.3 * r, 0.18 * r);
    }
    c.globalAlpha = 1;
  }

  for (let side = 0; side <= 1; side++) {
    const sgn = side === 0 ? -1 : 1;
    const ex = sgn * eyeDX;
    if (mood === 'HAPPY') {
      strokeArc(c, a.pupil, ex - 0.17 * r, eyeY - 0.08 * r, 0.34 * r, 0.3 * r, 180, 180, a.featureW);
    } else if (mood === 'LOVE') {
      const hs = 0.2 * r * (1 + 0.12 * Math.sin(t * 10));
      unitShape(c, heart, ex, eyeY, 0, hs, a.heartColor, a.outline, 0.16);
    } else if (mood === 'SLEEP') {
      strokeArc(c, a.pupil, ex - 0.16 * r, eyeY - 0.12 * r, 0.32 * r, 0.22 * r, 0, 180, a.featureW);
    } else if (mood === 'DIZZY') {
      const rot = t * 600;
      fillCircle(c, '#fff', ex, eyeY, 0.24 * r);
      strokeArc(c, a.pupil, ex - 0.19 * r, eyeY - 0.19 * r, 0.38 * r, 0.38 * r, rot, 280, a.thinW);
      strokeArc(c, a.pupil, ex - 0.09 * r, eyeY - 0.09 * r, 0.18 * r, 0.18 * r, rot + 180, 260, a.thinW);
    } else {
      const big = mood === 'SURPRISED';
      const ew = big ? 0.27 * r : 0.23 * r;
      const eh0 = big ? 0.3 * r : 0.27 * r;
      const open = (1 - s.blink) * (1 - s.yawn * 0.6);
      if (open < 0.18) {
        line(c, a.pupil, ex - ew * 0.8, eyeY, ex + ew * 0.8, eyeY, 2.2 * d);
      } else {
        const eh = eh0 * open;
        fillOval(c, '#fff', ex - ew, eyeY - eh, 2 * ew, 2 * eh);
        const pr = Math.min(big ? 0.1 * r : mood === 'ANGRY' ? 0.12 * r : 0.15 * r, eh * 0.9);
        const px = ex + s.lookX * (ew - pr) * 0.7;
        const py = eyeY + s.lookY * (eh - pr) * 0.6;
        fillCircle(c, a.pupil, px, py, pr);
        fillCircle(c, '#fff', px - pr * 0.35, py - pr * 0.4, pr * 0.38);
        strokeOval(c, a.outline, ex - ew, eyeY - eh, 2 * ew, 2 * eh, a.thinW);
      }
      if (mood === 'ANGRY') {
        line(c, a.outline, ex + sgn * 0.22 * r, eyeY - 0.4 * r, ex - sgn * 0.18 * r, eyeY - 0.26 * r, 2.4 * d);
      } else if (mood === 'THINKING' && side === 1) {
        line(c, a.outline, ex - 0.16 * r, eyeY - 0.44 * r, ex + 0.18 * r, eyeY - 0.4 * r, 2.2 * d);
      }
    }
  }

  // Mouth
  const my = 0.3 * r;
  if (s.yawn > 0.05) {
    const h = 0.12 * r + 0.28 * r * s.yawn;
    fillOval(c, a.pupil, -0.13 * r, my - h * 0.4, 0.26 * r, h);
  } else if (mood === 'HAPPY' || mood === 'LOVE') {
    arcPath(c, -0.22 * r, my - 0.2 * r, 0.44 * r, 0.4 * r, 0, 180, true);
    c.fillStyle = a.pupil;
    c.fill();
    fillOval(c, a.tongue, -0.1 * r, my + 0.07 * r, 0.2 * r, 0.1 * r);
  } else if (mood === 'SURPRISED') {
    fillOval(c, a.pupil, -0.08 * r, my - 0.06 * r, 0.16 * r, 0.2 * r);
  } else if (mood === 'SLEEP') {
    const h = 0.07 * r + 0.05 * r * (0.5 + 0.5 * Math.sin(t * 1.3));
    fillOval(c, a.pupil, -0.06 * r, my, 0.12 * r, h);
  } else if (mood === 'DIZZY') {
    strokeArc(c, a.pupil, -0.2 * r, my - 0.06 * r, 0.2 * r, 0.12 * r, 180, 180, a.featureW);
    strokeArc(c, a.pupil, 0, my - 0.06 * r, 0.2 * r, 0.12 * r, 0, 180, a.featureW);
  } else if (mood === 'ANGRY') {
    strokeArc(c, a.pupil, -0.18 * r, my, 0.36 * r, 0.24 * r, 200, 140, a.featureW);
  } else if (mood === 'THINKING') {
    line(c, a.pupil, -0.06 * r, my + 0.04 * r, 0.14 * r, my, 2.2 * d);
  } else {
    strokeArc(c, a.pupil, -0.2 * r, my - 0.14 * r, 0.4 * r, 0.28 * r, 20, 140, a.featureW);
  }

  // Dizzy: little stars circling the head.
  if (mood === 'DIZZY') {
    for (let i = 0; i <= 2; i++) {
      const o = t * 4 + i * 2.094;
      unitShape(c, star, Math.cos(o) * 0.95 * r, -0.95 * r + Math.sin(o) * 0.22 * r, 0, 0.13 * r, a.gem, a.outline, 0.16);
    }
  }

  // Asleep: a small static "z" by the head, so the still (resting) pose still reads as sleeping between snores.
  if (mood === 'SLEEP') unitShape(c, zPath, 0.95 * r, -1.2 * r, -12, 0.16 * r, null, a.zColor, 0.32, true);
}

/** (ox, oy): how far the sim's coordinates are from this canvas' (particles live in the sim's coordinates). */
function drawParticles(c: CanvasRenderingContext2D, s: MascotSim, a: MascotArt, ox: number, oy: number) {
  for (let i = 0; i < MAX_PARTICLES; i++) {
    const life = s.pLife[i];
    if (life <= 0) continue;
    const k = life / s.pMax[i]; // 1 -> 0
    const alpha = Math.min(1, k * 2.5);
    const type = s.pType[i];
    const grow = type === P_HEART ? 0.6 + 0.4 * Math.min(1, (1 - k) * 4) : type === P_Z ? 0.6 + 0.6 * (1 - k) : k;
    const sz = s.pSize[i] * grow;
    c.globalAlpha = alpha;
    if (type === P_HEART) unitShape(c, heart, s.pX[i] - ox, s.pY[i] - oy, s.pRot[i], sz, a.heartColor, null, 0);
    else if (type === P_Z) unitShape(c, zPath, s.pX[i] - ox, s.pY[i] - oy, s.pRot[i], sz, null, a.zColor, 0.32, true);
    else unitShape(c, sparkle, s.pX[i] - ox, s.pY[i] - oy, s.pRot[i], sz, a.sparkleColor, null, 0);
  }
  c.globalAlpha = 1;
}

/**
 * The area the last drawMascot (overlay: body at the sim's x / y) painted, in view px, so the next frame clears only
 * that: the body box (antenna, glow, arms, shadow; squash and spin included) plus every live particle.
 */
export function mascotBounds(s: MascotSim, out: { x0: number; y0: number; x1: number; y1: number }) {
  const r = s.r;
  const reach = 3.4 * r;
  const cy = s.y + s.hop;
  out.x0 = s.x - reach;
  out.x1 = s.x + reach;
  out.y0 = cy - reach;
  out.y1 = Math.max(cy + reach, s.y + 1.6 * r);
  for (let i = 0; i < MAX_PARTICLES; i++) {
    if (s.pLife[i] <= 0) continue;
    const m = s.pSize[i] * 1.6 + 2;
    const px = s.pX[i];
    const py = s.pY[i];
    if (px - m < out.x0) out.x0 = px - m;
    if (px + m > out.x1) out.x1 = px + m;
    if (py - m < out.y0) out.y0 = py - m;
    if (py + m > out.y1) out.y1 = py + m;
  }
  return out;
}

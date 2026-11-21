// Gemmy, the floating buddy: port of the app's ui/components/FloatingMascot.kt (GemmyOverlay, FloatingMascot, the
// speech bubble, the long-press menu, GemmyPreview) and ui/onboarding/GemmyIntroDialog.kt. The simulation is
// gemmy/sim.ts, the drawing gemmy/draw.ts.
//
// GemmyLayer is mounted once at the app root and floats over every screen of the view, like the app's overlay in
// MainActivity. Gemmy shows once the one-time "Meet Gemmy" intro was answered and while it is on in Settings →
// Appearance: both are shared view prefs (uiPrefs gemmyEnabled / gemmyIntroSeen), so every view agrees and the intro is
// asked once for all of them. The intro waits for the first-run agent picker (ChatScreen: after the setup steps).
// Only the body and the menu take pointer events (the bubble lets them through): the UI under it keeps working.
import { createEffect, createSignal, on, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { host } from '../host';
import { uiPrefs } from '../theme';
import { setUiPref } from '../state/settings';
import { awaitingReply, firstRun, state } from '../state/store';
import { GemmyLoop, MascotSim } from '../gemmy/sim';
import { drawMascot, MascotArt, mascotBounds } from '../gemmy/draw';
import { nextFrame } from '../ui/primitives';
import { MSwitch } from './Settings';
import '../styles/gemmy.css';

// ------------------------------------------------------------------------------------------------ prefs

/** Settings → Appearance → Gemmy (AuthPreferences.isGemmyEnabled): on by default. */
export const gemmyEnabled = () => uiPrefs()?.gemmyEnabled !== false;

/** The one-time "Meet Gemmy" dialog was answered (hasSeenGemmyIntro): Gemmy only appears after that. */
export const gemmyIntroSeen = () => uiPrefs()?.gemmyIntroSeen === true;

/** Turns Gemmy on or off; that decides it, so the intro is not needed anymore. Two prefs = two messages, and the
 *  host echoes all prefs after each: this order keeps the state in between from flashing Gemmy on or off. */
export function setGemmyEnabled(enabled: boolean) {
  if (enabled) {
    setUiPref('gemmyIntroSeen', true);
    setUiPref('gemmyEnabled', true);
  } else {
    setUiPref('gemmyEnabled', false);
    setUiPref('gemmyIntroSeen', true);
  }
}

/** This view's Gemmy, kept in the webview state (it survives the view being hidden or reloaded): where it is, and
 *  whether "Hide" sent it away. */
interface ViewGemmy {
  x?: number;
  y?: number;
  hidden?: boolean;
}

function viewGemmy(): ViewGemmy {
  return host.getState<{ gemmy?: ViewGemmy }>()?.gemmy ?? {};
}

function saveViewGemmy(patch: ViewGemmy) {
  const st = host.getState<Record<string, unknown>>() ?? {};
  host.setState({ ...st, gemmy: { ...(st.gemmy as ViewGemmy | undefined), ...patch } });
}

/** "Hide" (the long-press menu): gone from this view until it restarts, or until Gemmy is turned off and on again
 *  (the app keeps it in rememberSaveable state that the setting resets). */
const [hidden, setHidden] = createSignal(!!viewGemmy().hidden);

// ------------------------------------------------------------------------------------------------ root layer

/** The overlay and the intro (GemmyOverlay + ChatScreen's "Meet Gemmy"). */
export function GemmyLayer() {
  const ready = () => state.initialized && uiPrefs() != null;

  // turned off: "Hide" is forgotten and it starts afresh next time (the app drops FloatingMascot and its state)
  createEffect(
    on(
      gemmyEnabled,
      (enabled) => {
        if (enabled) return;
        setHidden(false);
        saveViewGemmy({ hidden: false, x: -1, y: -1 });
      },
      { defer: true },
    ),
  );

  // "Meet Gemmy": once the first-run setup is done, ask once whether to show the buddy (on by default, can be turned
  // off right there); Gemmy itself only appears after this is answered
  const introDue = () => ready() && !firstRun() && !gemmyIntroSeen();
  const [showIntro, setShowIntro] = createSignal(false);
  let introTimer: number | undefined;
  createEffect(
    on(introDue, (due) => {
      clearTimeout(introTimer);
      if (due) introTimer = window.setTimeout(() => setShowIntro(true), 700); // let the chat settle after the setup steps
      else setShowIntro(false);
    }),
  );
  onCleanup(() => clearTimeout(introTimer));

  // the chat on screen is running (isCurrentChatActivelyRunning; a prompt just sent counts, like agy's optimistic send)
  const working = () => state.chat.isStreaming || awaitingReply();

  return (
    <>
      <Show when={ready() && gemmyEnabled() && gemmyIntroSeen() && !hidden()}>
        <FloatingGemmy
          working={working}
          onHidden={() => {
            setHidden(true);
            saveViewGemmy({ hidden: true });
          }}
        />
      </Show>
      <Show when={showIntro() && introDue()}>
        <GemmyIntroDialog
          onConfirm={(enabled) => {
            setShowIntro(false);
            setGemmyEnabled(enabled);
          }}
        />
      </Show>
    </>
  );
}

// ------------------------------------------------------------------------------------------------ the overlay

/** FloatingMascot: the full-view canvas, the 64dp touch box around the body, the speech bubble and the menu. */
function FloatingGemmy(props: { working: () => boolean; onHidden: () => void }) {
  let layer!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  let body!: HTMLDivElement;
  let bubbleBox!: HTMLDivElement;
  let menuBox!: HTMLDivElement;

  const sim = new MascotSim(1);
  const kept = viewGemmy();
  if (typeof kept.x === 'number' && typeof kept.y === 'number' && kept.x >= 0) {
    // back where it was in this view (no first-frame greeting); collide() pushes it inside a smaller view
    sim.x = kept.x;
    sim.y = kept.y;
  }
  let savedX = sim.x;
  let savedY = sim.y;
  const savePosition = () => {
    if (sim.x < 0 || (sim.x === savedX && sim.y === savedY) || !gemmyEnabled()) return;
    savedX = sim.x;
    savedY = sim.y;
    saveViewGemmy({ x: Math.round(sim.x), y: Math.round(sim.y) });
  };

  const [speech, setSpeech] = createSignal('');
  const [speechOn, setSpeechOn] = createSignal(false);
  const [menuOn, setMenuOn] = createSignal(false);
  const [menuEver, setMenuEver] = createSignal(false);

  let ctx: CanvasRenderingContext2D | null = null;
  let art: MascotArt | null = null;
  let dpr = 1;
  const dirty = { x0: 0, y0: 0, x1: 0, y1: 0 };
  let hasDirty = false;
  let bubbleW = 0;
  let bubbleH = 0;
  let menuW = 0;
  let menuH = 0;
  let hideTimer: number | undefined;
  let placed = false;

  /** Centers a popup above the head, kept in the view; drops below it when there is no room above (anchorAboveHead). */
  const PAD = 6;
  const anchor = (el: HTMLElement, w: number, h: number) => {
    const px = Math.round(Math.min(Math.max(sim.x - w / 2, PAD), Math.max(PAD, sim.boundsW - w - PAD)));
    let py = Math.round(sim.y - sim.r * 1.8 - h);
    if (py < PAD) py = Math.round(sim.y + sim.r * 1.45);
    el.style.transform = `translate(${px}px, ${py}px)`;
  };

  const draw = () => {
    if (!ctx || !art) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // only what the last frame painted (the canvas covers the whole view)
    if (hasDirty) ctx.clearRect(dirty.x0 - 2, dirty.y0 - 2, dirty.x1 - dirty.x0 + 4, dirty.y1 - dirty.y0 + 4);
    drawMascot(ctx, sim, art, sim.x, sim.y);
    mascotBounds(sim, dirty);
    hasDirty = true;
  };

  const onFrame = () => {
    if (sim.x < 0) return; // position not chosen yet (no bounds)
    if (!placed) {
      placed = true;
      body.style.visibility = '';
    }
    body.style.transform = `translate(${sim.x - sim.half}px, ${sim.y - sim.half}px)`;
    if (sim.speechVisible && (sim.speechText !== speech() || !speechOn())) {
      setSpeech(sim.speechText);
      bubbleW = bubbleBox.offsetWidth;
      bubbleH = bubbleBox.offsetHeight;
    }
    setSpeechOn(sim.speechVisible);
    if (sim.menuOpen && !menuOn()) {
      setMenuEver(true);
      menuW = menuBox.offsetWidth;
      menuH = menuBox.offsetHeight;
    }
    setMenuOn(sim.menuOpen);
    anchor(bubbleBox, bubbleW, bubbleH);
    anchor(menuBox, menuW, menuH);
    if (sim.hideRequested && hideTimer === undefined) hideTimer = window.setTimeout(props.onHidden, 1100);
    draw();
  };

  const loop = new GemmyLoop(sim, onFrame, savePosition);

  /** The view's size (and the screen's pixel ratio) changed: new bounds, a sharp canvas, and a wake so it gets pushed
   *  back inside (the sidebar is narrow and resizable). */
  const resize = () => {
    const w = layer.clientWidth;
    const h = layer.clientHeight;
    dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, Math.round(w * dpr));
    const ch = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
      hasDirty = false; // a resized canvas starts empty
    }
    sim.boundsW = w;
    sim.boundsH = h;
    sim.poke();
  };

  // the chat on screen started or stopped (switching to another chat is not a finished turn: no cheering)
  createEffect(
    on([props.working, () => state.chat.conversationId], ([w, id], prev) => sim.setAgentWorking(w, !prev || prev[1] === id)),
  );

  // fling velocity: the positions of the last 100 ms (the app adds the clamped sim position to a VelocityTracker)
  const samples: { t: number; x: number; y: number }[] = [];

  onMount(() => {
    ctx = canvas.getContext('2d');
    if (ctx) art = new MascotArt(ctx, 1);
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(layer);
    // a screen with another pixel ratio (the window moved, VS Code zoom): redraw sharp
    let dprQuery: MediaQueryList | null = null;
    const onDpr = () => {
      resize();
      watchDpr();
    };
    const watchDpr = () => {
      dprQuery?.removeEventListener('change', onDpr);
      dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      dprQuery.addEventListener('change', onDpr);
    };
    watchDpr();
    const onVisibility = () => (document.hidden ? loop.stop() : loop.start());
    document.addEventListener('visibilitychange', onVisibility);
    if (!document.hidden) loop.start();

    const unbind = bindGestures(body, {
      onPress: () => sim.onPress(),
      onTap: () => sim.onTap(),
      onDoubleTap: () => sim.onDoubleTap(),
      onLongPress: () => sim.onLongPress(),
      onDragStart: () => {
        samples.length = 0;
        body.classList.add('held');
        sim.onDragStart();
      },
      onDrag: (dx, dy, t) => {
        sim.onDrag(dx, dy);
        samples.push({ t, x: sim.x, y: sim.y });
        if (samples.length > 20) samples.shift();
      },
      onDragEnd: (cancelled, t) => {
        body.classList.remove('held');
        const [vx, vy] = cancelled ? [0, 0] : fitVelocity(samples, t);
        sim.onDragEnd(vx, vy);
      },
    });
    // the wheel over the body still scrolls what is under it
    const onWheel = (e: WheelEvent) => {
      body.style.pointerEvents = 'none';
      let el = document.elementFromPoint(e.clientX, e.clientY);
      body.style.pointerEvents = '';
      for (; el; el = el.parentElement) {
        if (el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) {
          el.scrollBy({ top: e.deltaY, left: e.deltaX });
          return;
        }
      }
    };
    body.addEventListener('wheel', onWheel, { passive: true });

    onCleanup(() => {
      unbind();
      body.removeEventListener('wheel', onWheel);
      ro.disconnect();
      dprQuery?.removeEventListener('change', onDpr);
      document.removeEventListener('visibilitychange', onVisibility);
      loop.stop();
      clearTimeout(hideTimer);
      savePosition();
    });
  });

  const menuPick = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    fn();
  };

  return (
    <div class="gemmy-layer" ref={layer}>
      <canvas class="gemmy-canvas" ref={canvas} />
      <div class="gemmy-body" ref={body} style={{ visibility: 'hidden' }} role="img" aria-label="Gemmy" />
      <div class="gemmy-anchor" ref={bubbleBox}>
        <div class="gemmy-pop gemmy-bubble" classList={{ in: speechOn(), out: !speechOn() && speech() !== '' }}>
          {speech()}
        </div>
      </div>
      <div class="gemmy-anchor" ref={menuBox}>
        <div class="gemmy-pop gemmy-menu" classList={{ in: menuOn(), out: !menuOn() && menuEver() }}>
          <button class="gemmy-chip" tabIndex={menuOn() ? 0 : -1} onClick={menuPick(() => sim.dance())}>
            <span class="gemmy-chip-emoji">💃</span>Dance
          </button>
          <button class="gemmy-chip" tabIndex={menuOn() ? 0 : -1} onClick={menuPick(() => sim.nap())}>
            <span class="gemmy-chip-emoji">😴</span>Nap
          </button>
          <button class="gemmy-chip" tabIndex={menuOn() ? 0 : -1} onClick={menuPick(() => sim.hide())}>
            <span class="gemmy-chip-emoji">👋</span>Hide
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Fling velocity in px/s: a straight-line fit of the samples in the last 100 ms, stopping at a 40 ms gap (Compose's
 * VelocityTracker horizon and "pointer stopped" time). Held still before letting go = no fling.
 */
function fitVelocity(samples: { t: number; x: number; y: number }[], upAt: number): [number, number] {
  const n = samples.length;
  if (n < 2 || upAt - samples[n - 1].t > 40) return [0, 0];
  const newest = samples[n - 1].t;
  let i = n - 1;
  while (i > 0 && newest - samples[i - 1].t <= 100 && samples[i].t - samples[i - 1].t <= 40) i--;
  const count = n - i;
  if (count < 2) return [0, 0];
  let mt = 0;
  let mx = 0;
  let my = 0;
  for (let k = i; k < n; k++) {
    mt += samples[k].t;
    mx += samples[k].x;
    my += samples[k].y;
  }
  mt /= count;
  mx /= count;
  my /= count;
  let den = 0;
  let nx = 0;
  let ny = 0;
  for (let k = i; k < n; k++) {
    const dt = samples[k].t - mt;
    den += dt * dt;
    nx += dt * (samples[k].x - mx);
    ny += dt * (samples[k].y - my);
  }
  if (den === 0) return [0, 0];
  return [(nx / den) * 1000, (ny / den) * 1000];
}

// ------------------------------------------------------------------------------------------------ gestures

interface GestureHandlers {
  onPress: () => void;
  onTap: () => void;
  onDoubleTap: () => void;
  onLongPress?: () => void;
  onDragStart?: () => void;
  /** Movement in px since the last call; t = the event's time (ms). */
  onDrag?: (dx: number, dy: number, t: number) => void;
  onDragEnd?: (cancelled: boolean, t: number) => void;
}

const LONG_PRESS_MS = 400; // ViewConfiguration.longPressTimeoutMillis
const DOUBLE_TAP_MS = 300; // doubleTapTimeoutMillis
const DOUBLE_TAP_MIN_MS = 40; // doubleTapMinTimeMillis

/**
 * Compose's detectTapGestures (onPress / onTap / onDoubleTap / onLongPress) + detectDragGestures on pointer events.
 * A drag starts past the touch slop and cancels the tap and the long press; a tap waits for a possible second one;
 * the right mouse button opens the long-press menu.
 */
function bindGestures(el: HTMLElement, h: GestureHandlers): () => void {
  let id: number | null = null;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let dragging = false;
  let longFired = false;
  let second = false;
  let longTimer: number | undefined;
  let tapTimer: number | undefined;
  let firstUpAt = 0;

  const reset = () => {
    id = null;
    dragging = false;
    clearTimeout(longTimer);
    longTimer = undefined;
  };

  const down = (e: PointerEvent) => {
    if (id !== null || e.button !== 0) return;
    e.preventDefault();
    id = e.pointerId;
    try {
      el.setPointerCapture(id);
    } catch {
      /* the pointer is already gone */
    }
    startX = lastX = e.clientX;
    startY = lastY = e.clientY;
    dragging = false;
    longFired = false;
    second = false;
    if (tapTimer !== undefined) {
      clearTimeout(tapTimer);
      tapTimer = undefined;
      if (performance.now() - firstUpAt >= DOUBLE_TAP_MIN_MS) second = true;
      else h.onTap(); // too quick for a double tap: the first one was a tap, this is a new press
    }
    h.onPress();
    if (h.onLongPress) {
      longTimer = window.setTimeout(() => {
        longTimer = undefined;
        longFired = true;
        if (second) {
          // a long second press: the first was a single tap
          second = false;
          h.onTap();
        }
        h.onLongPress!();
      }, LONG_PRESS_MS);
    }
  };

  const move = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    if (!dragging) {
      if (!h.onDragStart || longFired) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const dist = Math.hypot(dx, dy);
      const slop = e.pointerType === 'mouse' ? 3 : 8;
      if (dist <= slop) return;
      dragging = true;
      clearTimeout(longTimer);
      longTimer = undefined;
      if (second) {
        // the second press turned into a drag: the first was a single tap
        second = false;
        h.onTap();
      }
      h.onDragStart();
      // the movement past the slop (Compose's overSlop)
      const k = (dist - slop) / dist;
      lastX = e.clientX;
      lastY = e.clientY;
      h.onDrag?.(dx * k, dy * k, e.timeStamp);
      return;
    }
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    h.onDrag?.(dx, dy, e.timeStamp);
  };

  const up = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    const wasDragging = dragging;
    reset();
    if (wasDragging) {
      h.onDragEnd?.(false, e.timeStamp);
      return;
    }
    if (longFired) return;
    // let go outside the target (the preview, which has no drag): no tap
    const r = el.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) {
      if (second) h.onTap();
      second = false;
      return;
    }
    if (second) {
      second = false;
      h.onDoubleTap();
      return;
    }
    firstUpAt = performance.now();
    tapTimer = window.setTimeout(() => {
      tapTimer = undefined;
      h.onTap();
    }, DOUBLE_TAP_MS);
  };

  const cancel = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    const wasDragging = dragging;
    reset();
    if (wasDragging) h.onDragEnd?.(true, e.timeStamp);
    else if (second) h.onTap();
    second = false;
  };

  // right-click: the long-press menu
  const contextMenu = (e: MouseEvent) => {
    if (!h.onLongPress) return;
    e.preventDefault();
    if (id !== null || longFired) return;
    h.onLongPress();
  };

  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('lostpointercapture', cancel);
  el.addEventListener('contextmenu', contextMenu);
  return () => {
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', cancel);
    el.removeEventListener('lostpointercapture', cancel);
    el.removeEventListener('contextmenu', contextMenu);
    clearTimeout(longTimer);
    clearTimeout(tapTimer);
  };
}

// ------------------------------------------------------------------------------------------------ preview

/**
 * Gemmy in place (GemmyPreview, for the intro and Settings → Appearance): same drawing and behaviour, drawn `zoom`×
 * bigger, stays put. Tap, double-tap and poke it; it blinks, hops, waves and dozes off like the real one.
 */
export function GemmyPreview(props: { zoom?: number; dim?: boolean }) {
  const zoom = props.zoom ?? 1;
  // Taller than wide: the antenna and the ground shadow reach well past the 48dp body. The canvas reaches past this
  // box (a Compose Canvas doesn't clip), mostly upwards, so hearts, sparkles and z's can float out of it.
  const w = 72 * zoom;
  const h = 96 * zoom;
  const mTop = 90 * zoom;
  const mSide = 50 * zoom;
  const mBottom = 24 * zoom;
  const cw = w + 2 * mSide;
  const ch = h + mTop + mBottom;

  // A huge virtual area with Gemmy in the middle: it never hits an edge, and the first-frame greeting is skipped.
  const sim = new MascotSim(1);
  sim.boundsW = 100_000;
  sim.boundsH = 100_000;
  sim.x = 50_000;
  sim.y = 50_000;

  let box!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D | null = null;
  let art: MascotArt | null = null;
  let dpr = 1;

  const draw = () => {
    if (!ctx || !art) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.translate(mSide + w / 2, mTop + h / 2);
    ctx.scale(zoom, zoom);
    drawMascot(ctx, sim, art, 0, 0);
  };
  const loop = new GemmyLoop(sim, draw);

  onMount(() => {
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    ctx = canvas.getContext('2d');
    if (ctx) art = new MascotArt(ctx, 1);
    const onVisibility = () => (document.hidden ? loop.stop() : loop.start());
    document.addEventListener('visibilitychange', onVisibility);
    if (!document.hidden) loop.start();
    const unbind = bindGestures(box, {
      onPress: () => sim.onPress(),
      onTap: () => sim.onTap(),
      onDoubleTap: () => sim.onDoubleTap(),
    });
    onCleanup(() => {
      unbind();
      document.removeEventListener('visibilitychange', onVisibility);
      loop.stop();
    });
  });

  return (
    <div
      class="gemmy-preview"
      ref={box}
      style={{ width: `${w}px`, height: `${h}px`, opacity: props.dim ? 0.4 : 1 }}
      onClick={(e) => e.stopPropagation()}
    >
      <canvas ref={canvas} style={{ left: `${-mSide}px`, top: `${-mTop}px`, width: `${cw}px`, height: `${ch}px` }} />
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ intro

/**
 * One-time "Meet Gemmy" dialog (GemmyIntroDialog.kt). The switch starts on (Gemmy is on by default), so the user sees
 * it exists and can turn it off right here; it is never asked again (Settings → Appearance has the switch). Escape
 * (the app's back) confirms the current choice; a click outside does nothing.
 */
function GemmyIntroDialog(props: { onConfirm: (enabled: boolean) => void }) {
  const [enabled, setEnabled] = createSignal(true);
  const [shown, setShown] = createSignal(false);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') props.onConfirm(enabled());
  };
  onMount(() => {
    nextFrame(() => setShown(true));
    document.addEventListener('keydown', onKey);
  });
  onCleanup(() => document.removeEventListener('keydown', onKey));

  return (
    <Portal>
      <div class="dialog-scrim" classList={{ shown: shown() }}>
        <div class="dialog gemmy-intro" role="dialog" aria-label="Meet Gemmy">
          {/* live, tappable Gemmy (dimmed while the switch is off) on a soft glow */}
          <div class="gemmy-intro-hero">
            <div class="gemmy-intro-glow" />
            <GemmyPreview zoom={1.5} dim={!enabled()} />
          </div>
          <div class="gemmy-intro-psst">psst… tap it!</div>
          <div class="gemmy-intro-title">Meet Gemmy 👋</div>
          <div class="gemmy-intro-text">
            A little buddy that floats over the app. Drag it around or fling it, tap or double-tap it, long-press (or
            right-click) it for its menu. It thinks while your agent works and cheers when it's done.
          </div>
          <div class="gemmy-intro-switch" onClick={() => setEnabled(!enabled())}>
            <div class="item-label">
              <div class="item-title">Show Gemmy</div>
              <div class="hint">{enabled() ? 'It will float on your screens' : 'It stays hidden'}</div>
            </div>
            <MSwitch checked={enabled()} onChange={setEnabled} label="Show Gemmy" />
          </div>
          <button class="filled-btn wide gemmy-intro-go" onClick={() => props.onConfirm(enabled())}>
            {enabled() ? "Let's go!" : 'Continue without Gemmy'}
          </button>
          <div class="gemmy-intro-foot">You can change this anytime in Settings → Appearance.</div>
        </div>
      </div>
    </Portal>
  );
}

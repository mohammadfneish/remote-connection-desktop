import { createRequire } from 'node:module';
import { screen, systemPreferences } from 'electron';
import { toNutKey } from './keymap.js';

const require = createRequire(import.meta.url);

/**
 * Replays the viewer's mouse/keyboard events on this machine (host side).
 *
 * Event format (sent by the viewer over the WebRTC data channel):
 *   { t: 'mm', x, y }          mouse move, x/y normalized 0..1 over the shared display
 *   { t: 'md'|'mu', b, x, y }  mouse button down/up (0 left, 1 middle, 2 right)
 *   { t: 'wh', dx, dy }        wheel, DOM pixel deltas (dy > 0 scrolls down)
 *   { t: 'kd'|'ku', c }        key down/up, KeyboardEvent.code
 */
export class InputInjector {
  constructor() {
    this.nut = null;
    this.loadError = null;
    this.active = false;
    this.display = null;
    this.queue = [];
    this.running = false;
    this.pressedKeys = new Set();
    this.pressedButtons = new Set();
    this.wheelRemainder = { x: 0, y: 0 };

    try {
      this.nut = require('@nut-tree-fork/nut-js');
      this.nut.mouse.config.autoDelayMs = 0;
      this.nut.keyboard.config.autoDelayMs = 0;
    } catch (err) {
      this.loadError = err;
      console.error('[input] remote control unavailable:', err.message);
    }
  }

  status() {
    if (!this.nut) return { available: false, reason: `Input library failed to load: ${this.loadError?.message}` };
    if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(false)) {
      return { available: false, reason: 'Grant Accessibility permission in System Settings > Privacy & Security.' };
    }
    return { available: true };
  }

  start(displayId) {
    this.active = true;
    this.setDisplay(displayId);
    if (process.platform === 'darwin') systemPreferences.isTrustedAccessibilityClient(true); // prompts once
    return this.status();
  }

  setDisplay(displayId) {
    const displays = screen.getAllDisplays();
    this.display = displays.find((d) => String(d.id) === String(displayId)) ?? screen.getPrimaryDisplay();
  }

  async stop() {
    this.active = false;
    this.queue = [];
    await this.releaseAll();
  }

  handle(event) {
    if (!this.active || !this.nut || !event || typeof event.t !== 'string') return;

    // Coalesce mouse moves so a slow injection never builds up a backlog of stale positions.
    const last = this.queue.at(-1);
    if (event.t === 'mm' && last?.t === 'mm') this.queue[this.queue.length - 1] = event;
    else this.queue.push(event);

    if (!this.running) this.drain();
  }

  async drain() {
    this.running = true;
    while (this.queue.length) {
      const event = this.queue.shift();
      try {
        await this.apply(event);
      } catch (err) {
        console.error('[input] failed to apply', event.t, err.message);
      }
    }
    this.running = false;
  }

  async apply(event) {
    const { mouse, keyboard, Button, Key } = this.nut;

    switch (event.t) {
      case 'mm':
        return this.moveTo(event);

      case 'md':
      case 'mu': {
        const button = [Button.LEFT, Button.MIDDLE, Button.RIGHT][event.b];
        if (button === undefined) return;
        if (Number.isFinite(event.x)) await this.moveTo(event);
        if (event.t === 'md') {
          this.pressedButtons.add(button);
          return mouse.pressButton(button);
        }
        this.pressedButtons.delete(button);
        return mouse.releaseButton(button);
      }

      case 'wh':
        return this.scroll(event);

      case 'kd':
      case 'ku': {
        const key = toNutKey(Key, event.c);
        if (key === undefined) return;
        if (event.t === 'kd') {
          this.pressedKeys.add(key);
          return keyboard.pressKey(key);
        }
        this.pressedKeys.delete(key);
        return keyboard.releaseKey(key);
      }
    }
  }

  async moveTo({ x, y }) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !this.display) return;
    const { bounds, scaleFactor } = this.display;
    const clamp = (v) => Math.min(Math.max(v, 0), 0.9999);
    const dip = {
      x: Math.round(bounds.x + clamp(x) * bounds.width),
      y: Math.round(bounds.y + clamp(y) * bounds.height),
    };
    const native = this.toNativePoint(dip, scaleFactor);
    await this.nut.mouse.setPosition(new this.nut.Point(native.x, native.y));
  }

  // Electron reports display geometry in DIPs. Windows and X11 inject in physical
  // pixels; macOS injects in points (== DIPs).
  toNativePoint(point, scaleFactor) {
    if (process.platform === 'win32') return screen.dipToScreenPoint(point);
    if (process.platform === 'linux') return { x: Math.round(point.x * scaleFactor), y: Math.round(point.y * scaleFactor) };
    return point;
  }

  async scroll({ dx, dy }) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const { mouse } = this.nut;

    // libnut's scroll unit differs per OS: Windows uses WHEEL_DELTA units (120 per notch,
    // where a browser notch is ~100px), macOS uses pixels, X11 uses whole notches.
    const unit = { win32: 100 / 120, darwin: 1, linux: 100 }[process.platform] ?? 1;
    const steps = (axis, delta) => {
      const total = delta / unit + this.wheelRemainder[axis];
      const whole = Math.trunc(total);
      this.wheelRemainder[axis] = total - whole;
      return whole;
    };

    const y = steps('y', dy);
    const x = steps('x', dx);
    if (y > 0) await mouse.scrollDown(y);
    else if (y < 0) await mouse.scrollUp(-y);
    if (x > 0) await mouse.scrollRight(x);
    else if (x < 0) await mouse.scrollLeft(-x);
  }

  /** Releases anything the viewer was holding so keys/buttons never stay stuck. */
  async releaseAll() {
    if (!this.nut) return;
    for (const key of this.pressedKeys) await this.nut.keyboard.releaseKey(key).catch(() => {});
    for (const button of this.pressedButtons) await this.nut.mouse.releaseButton(button).catch(() => {});
    this.pressedKeys.clear();
    this.pressedButtons.clear();
  }
}

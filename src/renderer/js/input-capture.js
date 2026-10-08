/**
 * Captures local mouse/keyboard over the remote video and turns it into input events
 * (see main/input.js for the format). Coordinates are normalized to the video content,
 * so letterboxing and window size don't matter. Returns a detach function.
 */
export function captureInput({ stage, video, send, isActive }) {
  const pressedKeys = new Set();
  const pressedButtons = new Set();
  let pendingMove = null;
  let frame = 0;

  const position = (event, clamp = false) => {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;
    const rect = video.getBoundingClientRect();
    const scale = Math.min(rect.width / vw, rect.height / vh);
    const width = vw * scale;
    const height = vh * scale;
    let x = (event.clientX - rect.left - (rect.width - width) / 2) / width;
    let y = (event.clientY - rect.top - (rect.height - height) / 2) / height;
    if (clamp) {
      x = Math.min(Math.max(x, 0), 1);
      y = Math.min(Math.max(y, 0), 1);
    } else if (x < 0 || x > 1 || y < 0 || y > 1) {
      return null;
    }
    return { x: round(x), y: round(y) };
  };

  const flushMove = () => {
    frame = 0;
    if (pendingMove) send({ t: 'mm', ...pendingMove });
    pendingMove = null;
  };

  const onMouseMove = (event) => {
    if (!isActive()) return;
    const pos = position(event, pressedButtons.size > 0); // keep dragging past the edge
    if (!pos) return;
    pendingMove = pos;
    frame ||= requestAnimationFrame(flushMove); // at most one move per frame
  };

  const onMouseDown = (event) => {
    stage.focus();
    if (!isActive()) return;
    const pos = position(event);
    if (!pos) return;
    event.preventDefault();
    pendingMove = null;
    pressedButtons.add(event.button);
    send({ t: 'md', b: event.button, ...pos });
  };

  const onMouseUp = (event) => {
    if (!pressedButtons.delete(event.button)) return;
    send({ t: 'mu', b: event.button, ...position(event, true) });
  };

  const onWheel = (event) => {
    if (!isActive()) return;
    event.preventDefault();
    const factor = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1;
    send({ t: 'wh', dx: event.deltaX * factor, dy: event.deltaY * factor });
  };

  const onKey = (event) => {
    if (!isActive() || !event.code) return;
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    event.preventDefault();
    if (event.type === 'keydown') {
      pressedKeys.add(event.code);
      send({ t: 'kd', c: event.code }); // repeats are forwarded so held keys auto-repeat remotely
    } else {
      pressedKeys.delete(event.code);
      send({ t: 'ku', c: event.code });
    }
  };

  const releaseAll = () => {
    for (const code of pressedKeys) send({ t: 'ku', c: code });
    for (const b of pressedButtons) send({ t: 'mu', b });
    pressedKeys.clear();
    pressedButtons.clear();
  };

  const preventMenu = (event) => event.preventDefault();

  stage.addEventListener('mousemove', onMouseMove);
  stage.addEventListener('mousedown', onMouseDown);
  stage.addEventListener('wheel', onWheel, { passive: false });
  stage.addEventListener('contextmenu', preventMenu);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  window.addEventListener('blur', releaseAll);

  return () => {
    releaseAll();
    cancelAnimationFrame(frame);
    stage.removeEventListener('mousemove', onMouseMove);
    stage.removeEventListener('mousedown', onMouseDown);
    stage.removeEventListener('wheel', onWheel);
    stage.removeEventListener('contextmenu', preventMenu);
    window.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keyup', onKey);
    window.removeEventListener('blur', releaseAll);
  };
}

const round = (v) => Math.round(v * 10000) / 10000;

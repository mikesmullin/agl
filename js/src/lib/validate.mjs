export function forceInt(n, def) {
  const parsed = Number.parseInt(n);
  return Number.isInteger(parsed) ? parsed : def;
}

export function forceRx(rx, val, def) {
  return rx.test(val) ? val : def;
}

export function clamp(n, min, max) {
  return n < min ? min : n > max ? max : n;
}
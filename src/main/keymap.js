// Maps browser KeyboardEvent.code (physical key position, layout independent) to the
// nut.js Key enum member name. Using physical codes means the host's own keyboard
// layout decides which character is produced, the same as a local keyboard would.
const map = {
  Escape: 'Escape',
  Backquote: 'Grave',
  Minus: 'Minus',
  Equal: 'Equal',
  Backspace: 'Backspace',
  Tab: 'Tab',
  BracketLeft: 'LeftBracket',
  BracketRight: 'RightBracket',
  Backslash: 'Backslash',
  IntlBackslash: 'Backslash',
  CapsLock: 'CapsLock',
  Semicolon: 'Semicolon',
  Quote: 'Quote',
  Enter: 'Enter',
  Comma: 'Comma',
  Period: 'Period',
  Slash: 'Slash',
  Space: 'Space',

  ShiftLeft: 'LeftShift',
  ShiftRight: 'RightShift',
  ControlLeft: 'LeftControl',
  ControlRight: 'RightControl',
  AltLeft: 'LeftAlt',
  AltRight: 'RightAlt',
  MetaLeft: 'LeftSuper',
  MetaRight: 'RightSuper',
  ContextMenu: 'Menu',

  PrintScreen: 'Print',
  ScrollLock: 'ScrollLock',
  Pause: 'Pause',
  Insert: 'Insert',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',

  NumLock: 'NumLock',
  NumpadDivide: 'Divide',
  NumpadMultiply: 'Multiply',
  NumpadSubtract: 'Subtract',
  NumpadAdd: 'Add',
  NumpadEnter: 'Enter',
  NumpadDecimal: 'Decimal',
  NumpadEqual: 'NumPadEqual',

  AudioVolumeMute: 'AudioMute',
  AudioVolumeDown: 'AudioVolDown',
  AudioVolumeUp: 'AudioVolUp',
  MediaPlayPause: 'AudioPlay',
  MediaStop: 'AudioStop',
  MediaTrackPrevious: 'AudioPrev',
  MediaTrackNext: 'AudioNext',
};

for (let i = 0; i <= 9; i++) {
  map[`Digit${i}`] = `Num${i}`;
  map[`Numpad${i}`] = `NumPad${i}`;
}
for (let i = 1; i <= 24; i++) map[`F${i}`] = `F${i}`;
for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') map[`Key${letter}`] = letter;

/** Returns the nut.js Key value for a KeyboardEvent.code, or undefined if unsupported. */
export function toNutKey(Key, code) {
  const name = map[code];
  return name === undefined ? undefined : Key[name];
}

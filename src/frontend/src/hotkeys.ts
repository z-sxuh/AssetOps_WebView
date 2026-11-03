type KeyEvent = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>;

const keyCodes: Record<string, string> = {
  Slash: 'Slash', Backslash: 'Backslash', Equal: 'Equal', Minus: 'Minus',
  Period: 'Period', Comma: 'Comma', Semicolon: 'Semicolon', Quote: 'Quote',
  Backquote: 'Backquote', BracketLeft: 'BracketLeft', BracketRight: 'BracketRight',
  ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
  Space: 'Space', Enter: 'Enter', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert',
};
const aliases: Record<string, string> = { control: 'ctrl', super: 'win', meta: 'win', option: 'alt', '/': 'slash', '\\': 'backslash', '=': 'equal', '-': 'minus', '.': 'period', ',': 'comma', ';': 'semicolon', "'": 'quote', '`': 'backquote', '[': 'bracketleft', ']': 'bracketright', ' ': 'space', up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright' };

export function hotkeyFromEvent(event: KeyEvent): string | null {
  if (!event.ctrlKey && !event.altKey && !event.metaKey && !/^F([1-9]|1[0-9]|2[0-4])$/.test(event.code)) return null;
  const code = event.code;
  const key = /^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit[0-9]$/.test(code) ? code.slice(5)
    : /^F([1-9]|1[0-9]|2[0-4])$/.test(code) ? code : keyCodes[code];
  if (!key) return null;
  return [...(event.ctrlKey ? ['Ctrl'] : []), ...(event.altKey ? ['Alt'] : []), ...(event.shiftKey ? ['Shift'] : []), ...(event.metaKey ? ['Win'] : []), key].join('+');
}

export function canonicalHotkey(hotkey: string) {
  return hotkey.toLowerCase().split('+').map((part) => aliases[part.trim()] ?? part.trim()).sort().join('+');
}

export function matchesHotkey(event: KeyEvent, hotkey: string) {
  const recorded = hotkeyFromEvent(event);
  return Boolean(hotkey && recorded && canonicalHotkey(recorded) === canonicalHotkey(hotkey));
}

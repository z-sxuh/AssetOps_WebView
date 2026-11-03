export function composingCancel(event: { nativeEvent: Event }) {
  return event.nativeEvent instanceof KeyboardEvent && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229);
}

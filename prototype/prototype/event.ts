type Handler<T = unknown> = (event: { event: string; id: number; payload: T }) => void;
const handlers = new Map<string, Set<Handler<any>>>();
export async function listen<T = unknown>(event: string, handler: Handler<T>) {
  const listeners = handlers.get(event) ?? new Set(); listeners.add(handler); handlers.set(event, listeners);
  return () => { listeners.delete(handler); };
}
export async function emitTo(_target: string, event: string, payload?: unknown) {
  for (const handler of handlers.get(event) ?? []) handler({ event, id: 0, payload });
}
export const emit = (event: string, payload?: unknown) => emitTo('main', event, payload);

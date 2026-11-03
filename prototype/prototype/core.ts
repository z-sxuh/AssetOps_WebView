import { command } from './runtime';
export function isTauri() { return true; }
export async function invoke<T>(name: string, args?: Record<string, unknown> | ArrayBuffer, options?: { headers?: Record<string, string> }): Promise<T> { return await command(name, args, options) as T; }

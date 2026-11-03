import type { VaultData } from './model';
import { emptyVault } from './model';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { argon2id } from 'hash-wasm';

type EncryptedVault = { salt: string; iv: string; data: string };
const databaseName = 'assetops-local-vault';
const storeName = 'private-data';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readVault(): Promise<EncryptedVault | undefined> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName);
    const request = transaction.objectStore(storeName).get('vault');
    transaction.oncomplete = () => { db.close(); resolve(request.result as EncryptedVault | undefined); };
    transaction.onabort = () => { db.close(); reject(transaction.error ?? new Error('本地数据读取已中止')); };
  });
}

async function writeVault(value: EncryptedVault, create = false): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    if (create) store.add(value, 'vault'); else store.put(value, 'vault');
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onabort = () => { db.close(); reject(transaction.error ?? new Error('本地数据保存已中止')); };
  });
}

const encode = (bytes: Uint8Array) => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
};
const decode = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const rawKey = await argon2id({
    password,
    salt,
    parallelism: 1,
    iterations: 3,
    memorySize: 65_536,
    hashLength: 32,
    outputType: 'binary',
  });
  const keyBytes = new Uint8Array(rawKey.length);
  keyBytes.set(rawKey);
  return crypto.subtle.importKey('raw', keyBytes.buffer, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encrypt(data: VaultData, key: CryptoKey, salt: string): Promise<EncryptedVault> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return { salt, iv: encode(iv), data: encode(new Uint8Array(ciphertext)) };
}

export const vault = {
  async exists() {
    if (isTauri()) return invoke<boolean>('vault_exists');
    return Boolean(await readVault());
  },

  async create(password: string): Promise<VaultData> {
    if (isTauri()) {
      await invoke('vault_create', { password, data: emptyVault });
      return emptyVault;
    }
    const salt = encode(crypto.getRandomValues(new Uint8Array(16)));
    const key = await deriveKey(password, decode(salt));
    await writeVault(await encrypt(emptyVault, key, salt), true);
    return emptyVault;
  },

  async unlock(password: string): Promise<{ data: VaultData; key: CryptoKey | null }> {
    if (isTauri()) {
      const data = await invoke<VaultData>('vault_unlock', { password });
      return { data, key: null };
    }
    const encrypted = await readVault();
    if (!encrypted) throw new Error('找不到本地数据');
    const key = await deriveKey(password, decode(encrypted.salt));
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(encrypted.iv) }, key, decode(encrypted.data));
    const data = JSON.parse(new TextDecoder().decode(plaintext)) as VaultData;
    return { data, key };
  },

  async save(data: VaultData, key: CryptoKey | null): Promise<void> {
    if (isTauri()) {
      await invoke('vault_save', { data });
      return;
    }
    if (!key) throw new Error('数据仓库尚未解锁');
    const previous = await readVault();
    if (!previous) throw new Error('本地数据已被移除');
    await writeVault(await encrypt(data, key, previous.salt));
  },
};

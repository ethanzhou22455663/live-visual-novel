/**
 * localStorage 存储适配(plan §1.6):键前缀 gal.v1.<scope>.<key>。
 * 读/列举在隐私模式等场景可能整体抛错 → 降级为 null/空列表(存档功能退化为无档,
 * 游戏照跑);写失败统一映射 StorageQuotaError,由 SaveSystem 转 engine:warning。
 */
import { StorageQuotaError } from "@gal/shared";
import type { StoragePort, StorageScope } from "@gal/shared";

export class LocalStorageAdapter implements StoragePort {
  #prefix: string;

  constructor(prefix = "gal.v1.") {
    this.#prefix = prefix;
  }

  #key(scope: StorageScope, key: string): string {
    return `${this.#prefix}${scope}.${key}`;
  }

  getRaw(scope: StorageScope, key: string): string | null {
    try {
      return window.localStorage.getItem(this.#key(scope, key));
    } catch {
      return null;
    }
  }

  setRaw(scope: StorageScope, key: string, value: string): void {
    try {
      window.localStorage.setItem(this.#key(scope, key), value);
    } catch {
      throw new StorageQuotaError();
    }
  }

  removeRaw(scope: StorageScope, key: string): void {
    try {
      window.localStorage.removeItem(this.#key(scope, key));
    } catch {
      // 已不可删:视为不存在
    }
  }

  listKeys(scope: StorageScope): string[] {
    try {
      const p = `${this.#prefix}${scope}.`;
      const out: string[] = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k !== null && k.startsWith(p)) out.push(k.slice(p.length));
      }
      return out;
    } catch {
      return [];
    }
  }
}

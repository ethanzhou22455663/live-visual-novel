/**
 * 存储端口(plan §1.6):键值字符串仓,按域隔离。
 * 实现在 app(LocalStorageAdapter,前缀 gal.v1.*);engine/test 用 MemoryStorage。
 * 同步语义(P1);quota 超限抛 StorageQuotaError,调用方转 engine:warning。
 */
export type StorageScope = "saves" | "global";

export interface StoragePort {
  getRaw(scope: StorageScope, key: string): string | null;
  /** 写失败(quota)抛 StorageQuotaError;其余 IO 错误同样以异常上浮 */
  setRaw(scope: StorageScope, key: string, value: string): void;
  removeRaw(scope: StorageScope, key: string): void;
}

export class StorageQuotaError extends Error {
  constructor() {
    super("存储配额已满");
    this.name = "StorageQuotaError";
  }
}

/**
 * 事件总线(plan §2.2):同步、有序、类型化发布订阅。
 * 全部模块只依赖 GameEventMap 契约互不 import;emit 顺序 = 订阅顺序(Set 插入序)。
 */
import type { GameEventMap } from "@gal/shared";

export type GameEventType = keyof GameEventMap;

export class EventBus {
  #handlers = new Map<GameEventType, Set<(payload: never) => void>>();

  /** 订阅;返回退订函数 */
  on<K extends GameEventType>(type: K, fn: (payload: GameEventMap[K]) => void): () => void {
    let set = this.#handlers.get(type);
    if (!set) {
      set = new Set();
      this.#handlers.set(type, set);
    }
    set.add(fn as (payload: never) => void);
    return () => set?.delete(fn as (payload: never) => void);
  }

  /** 同步派发:按订阅顺序逐个调用;单监听器抛错不影响其余监听器 */
  emit<K extends GameEventType>(type: K, payload: GameEventMap[K]): void {
    const set = this.#handlers.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as (p: GameEventMap[K]) => void)(payload);
      } catch (e) {
        // 演出层监听器异常不破坏引擎主流程
        console.error(`[EventBus] ${String(type)} 监听器异常`, e);
      }
    }
  }
}

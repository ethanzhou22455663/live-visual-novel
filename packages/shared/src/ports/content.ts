/**
 * 内容访问端口(P1-M2):engine 对 ContentPack 的唯一视角。
 * app 从 manifest 组装;engine 永不直接依赖 ContentPack 结构(解耦,可注 fake)。
 */
export interface ContentPort {
  readonly characterIds: ReadonlySet<string>;
  readonly sceneIds: ReadonlySet<string>;
  readonly bgmIds: ReadonlySet<string>;
  /** 未知表情的回退值;无立绘角色返回 "" */
  defaultExprOf(who: string): string;
  /** 该角色可用表情集合(空集=无立绘) */
  emotionsOf(who: string): ReadonlySet<string>;
}

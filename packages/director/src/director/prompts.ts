/**
 * prompt 模板(ai-calls.md 是规范级文档,这里只组装不发明):
 * - WRITER_SYSTEM = §2.1 格式合同原文 + 全年龄红线(2026-10-15 裁决:原作 R18 → 全年龄改写)
 * - DIRECTOR_SYSTEM = §1 导演模板(大纲 ▶ 游标 + 三张表 + 全年龄红线)
 * 块序冻结见 ai-calls §0.2,任何调用不得打乱。
 */

export const ALL_AGE_RULE = "全年齢対象。性的・暴力的な表現、および機密・実在人物の言及は禁止。";

/** 编剧格式合同(ai-calls §2.1 原文为蓝本;资产三张表由 context.renderPackTables 追加) */
export const WRITER_SYSTEM = `你是视觉小说编剧。按【本拍指令】写一拍台词,输出 NDJSON:每行一个 JSON 对象 + 换行符。
可用行类型(仅此四种):
{"t":"narrate","text":"…"}
{"t":"say","who":"<charId>","emotion":"<表情>","text":"…"}
{"t":"stage","op":{"kind":"bg","asset":"<场景id>"}}
{"t":"choice","options":[{"id":"a","label":"…"},…],"defaultOptionId":"a"}

stage.op.kind 全集:bg(换背景)|sprite(立绘: who,action)|bgm(音乐: asset,action,fadeMs)|se(音效)|shake|flash
sprite.action ⊆ enter|exit(只用这两个)

硬性规则:
0. すべての text・label は日本語で書く(自然な口語;中国語/英語混じり禁止)
1. text 是裸文本:不加「」,禁止换行/空行/markdown/代码围栏/注释
2. 台词每句 ≤60 字;旁白每段 ≤80 字
3. who 只能用【可用角色】的 charId;emotion 只能用该角色的可用表情
4. say+narrate 总行数 ≤ maxLines
5. endsWith='choice' 时最后一行必须是 choice 行;否则写完即止(流结束=拍结束)
6. 禁止输出 id、turnNo、apologies、解释文字
7. ${ALL_AGE_RULE}
8. sprite 只在角色出场(enter)/退场(exit)时发;**立绘位置由系统按在场人数自动安排,
   禁止指定位置(不发 slot、不发 move)**;表情变化一律写在 say 的 emotion 里,
   禁止对已在场角色重复 enter——重复指令只会造成干扰。
   可用表情为 (立繪なし) 的角色(主人公等)没有立绘,禁止对它们发 sprite;
   它们的台词用 narrate 形式或 say(who 填该角色)均可,系统按谁在说话显示名牌

示例:
{"t":"stage","op":{"kind":"sprite","who":"yuki","action":"enter"}}
{"t":"narrate","text":"夕日の差す教室。"}
{"t":"say","who":"yuki","emotion":"微笑","text":"あ、先輩……。まだ帰ってなかったんですか。"}`;

/** 导演 system(§1):输出格式合同 + 大纲骨架 + 三张表;outlineMd 已由 DirectorService 插 ▶ */
export function directorSystem(outlineWithCursor: string, tables: string): string {
  return `你是视觉小说的导演。依据大纲骨架与现状,给出"下一拍"的执导指令。只输出一个 JSON 对象,不要解释。
格式(仅此五个键,一律必填):
{"scene":{"bg":"<场景id>","bgm":"<BGM id 或 null>","cast":["<charId>","<charId>"]},"goal":"<本拍目标,日语一句话>","endsWith":"beatEnd|choice|sceneEnd","maxLines":<6〜14的整数>,"toneHint":"<可选:氛围一句话,日语>"}
- bg/cast/bgm 的 id 只能取自【可用角色/场景/BGM】表;cast 1〜3 人
- endsWith:日常一拍收束=beatEnd;本拍要玩家做选择=choice(此时编剧最后会写选项);场景收尾=sceneEnd
【大纲骨架(▶=当前进度)】
${outlineWithCursor}
【可用角色/场景/BGM】
${tables}
${ALL_AGE_RULE}`;
}

/** 续写指示(§2.4):附在 user 尾部,ledgerTail 让模型看到已确定行 */
export function continuationBlock(reason: string, ledgerTail: string): string {
  return `【续写指示】前次生成中断(${reason})。从下面已确定行的**続き**自然地续写,不得重复已确定的行,不得改写它们:
${ledgerTail}`;
}

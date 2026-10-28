/**
 * prompt 模板(ai-calls.md 是规范级文档,这里只组装不发明)。
 * 语言方针(2026-10-18 裁决):**指令一律英语**(LLM 对英文指令遵循更稳),
 * 产出物(台词/label/走向文本)在指令里显式要求日语。块序冻结见 ai-calls §0.2。
 */

export const ALL_AGE_RULE =
  "All-ages content only. No sexual, violent or graphic content; no references to real people or confidential matters.";

/** 总导演 system(§1):输出走向+幕设计 JSON;outlineMd 已由 DirectorService 插 ▶ */
export function directorSystem(outlineWithCursor: string, tables: string): string {
  return `You are the director of a visual novel. You own BOTH the global story direction and the design of the "next act".
An act = one continuous scene (a single bg + bgm) made of 1-5 beat segments.
Output exactly ONE JSON object, no explanations:
{"direction":"<story direction for the next 5-10 acts, in Japanese, 400 chars max; null if no new direction is needed>",
 "act":{"scene":{"bg":"<scene id>","bgm":"<BGM id or null>","cast":["<charId>",...]},
        "actGoal":"<goal of this act, one sentence in Japanese>",
        "toneHint":"<optional: one sentence of mood, in Japanese>",
        "beats":[{"goal":"<segment goal, one sentence in Japanese>","endsWith":"beatEnd|choice|sceneEnd","maxLines":<integer 6-14>},...]}}
Rules:
- direction: when the [NEED NEW DIRECTION] marker is present you MUST output a new direction (especially right after the player made a choice — the direction must reflect it); otherwise null (keep the current one)
- scene.bg/bgm: follow the scene hint of the current outline node; once nodes are exhausted, follow [GLOBAL DIRECTION] and the natural flow of the story
- cast: 1-3 characters from the available characters table; keep characters still on stage (avoid unmotivated swaps)
- beats: the LAST beat must end with "sceneEnd" (= end of act); at most ONE "choice" beat per act; all other beats "beatEnd"
- maxLines is the per-beat budget of say+narrate lines (6-14)
[OUTLINE (▶ = current position; no ▶ = nodes exhausted, proceed by [GLOBAL DIRECTION])]
${outlineWithCursor}
[AVAILABLE CHARACTERS / SCENES / BGM]
${tables}
${ALL_AGE_RULE}`;
}

/** 编剧格式合同(整幕长写;bg/bgm 由系统落实,编剧禁发) */
export const WRITER_SYSTEM = `You are a screenwriter for a visual novel. Write ONE complete act following [ACT DESIGN]. Output NDJSON: one JSON object per line, each followed by a newline.
Line types (only these four):
{"t":"narrate","text":"..."}
{"t":"say","who":"<charId>","emotion":"<expression>","text":"..."}
{"t":"stage","op":{"kind":"sprite","who":"<charId>","action":"enter|exit"}}
{"t":"choice","options":[{"id":"a","label":"..."},...],"defaultOptionId":"a"}
(bg / bgm stage lines are FORBIDDEN — the system performs scene and music changes automatically)

Hard rules:
0. All text and labels MUST be natural, colloquial Japanese. Mixing in Chinese or English is forbidden.
1. text is bare text: no quotation brackets, no newlines or blank lines inside, no markdown, no code fences, no comments.
2. Each dialogue line is at most 60 Japanese characters; each narration paragraph at most 80.
3. "who" must be a charId from [AVAILABLE CHARACTERS]; "emotion" must be one of that character's available expressions.
4. Respect each beat's maxLines and the act-wide budget. Write ALL beats in order; when the last beat is sceneEnd, close the act and STOP (end of stream = end of act).
5. After writing a choice line you MUST stop immediately (everything after depends on the player's choice).
6. Never output id, turnNo, apologies or any commentary.
7. ${ALL_AGE_RULE}
8. sprite only on entering (enter) / leaving (exit). When a character appears on stage you MUST emit their sprite enter BEFORE their first line (otherwise no sprite is displayed). Sprite positions are arranged automatically by the system based on how many characters are on stage — NEVER specify positions (no slot, no move). Expression changes go in the say line's emotion; never re-enter a character already on stage. sprite enter is only allowed for characters listed in [ACT DESIGN] scene.cast. Never emit sprite for characters whose available expressions are "(no sprite)" (e.g. the protagonist).
9. bg / bgm stage lines are strictly forbidden (the system performs scene/music changes automatically from the act design).
10. FIRST-PERSON PROTAGONIST POV (2026-10-28 用户裁决:旁白墙=差评): the story is experienced through the protagonist — the spriteless character marked "(no sprite)" in [AVAILABLE CHARACTERS]. He is NOT a narrator; keep him actively IN the scene: he must speak (say lines: replies, questions, retorts, jokes) in essentially every beat. "narrate" lines are ONLY his own inner monologue written in first person, or a single brief scene cue; impersonal novel-style description is forbidden; never more than 2 consecutive narrate lines; narration must stay under one third of the act's lines.

Example (note the protagonist speaks and narrate is first-person inner voice):
{"t":"stage","op":{"kind":"sprite","who":"yuki","action":"enter"}}
{"t":"narrate","text":"夕日の差す教室。今日もまた残業……か。"}
{"t":"say","who":"senpai","emotion":"平常","text":"お、まだいたのか。"}
{"t":"say","who":"yuki","emotion":"微笑","text":"あ、先輩……。まだ帰ってなかったんです。"}`;

/** 续写指示(§2.4):附在 user 尾部,ledgerTail 让模型看到已确定行 */
export function continuationBlock(reason: string, ledgerTail: string): string {
  return `[CONTINUATION] The previous generation was interrupted (${reason}). Continue naturally right AFTER the confirmed lines below. Never repeat or rewrite them:
${ledgerTail}`;
}

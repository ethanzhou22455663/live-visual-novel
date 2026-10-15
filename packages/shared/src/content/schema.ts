/**
 * ContentPack zod schema:manifest 文件加载后 parse 的门禁(plan §2.8)。
 */
import { z } from "zod";
import type { BgmTrack, CharacterDef, CharacterVoiceRef, ContentPack, SceneDef, WorldBookEntry } from "./types.ts";

export const CharacterVoiceRefSchema = z.object({
  refAudioPathServer: z.string().min(1),
  promptText: z.string(),
  promptLang: z.enum(["ja", "zh", "en"]),
});

export const CharacterDefSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/, "charId 仅限 [a-z0-9_-]"),
  displayName: z.string().min(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "color 须为 #rrggbb"),
  defaultExpr: z.string().min(1),
  sprites: z.record(z.string(), z.string()),
  voice: CharacterVoiceRefSchema.optional(),
  cardMd: z.string(),
});

export const SceneDefSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  image: z.string().min(1),
  noteMd: z.string().optional(),
});

export const BgmTrackSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  path: z.string().min(1),
});

export const WorldBookEntrySchema = z.object({
  id: z.string().min(1),
  keys: z.array(z.string().min(1)).min(1),
  content: z.string().min(1),
  priority: z.number().int(),
  enabled: z.boolean(),
});

export const ContentPackSchema = z.object({
  version: z.literal(1),
  characters: z.record(z.string(), CharacterDefSchema),
  scenes: z.record(z.string(), SceneDefSchema),
  bgm: z.record(z.string(), BgmTrackSchema),
  story: z.object({
    outlineMd: z.string(),
    worldBook: z.array(WorldBookEntrySchema),
  }),
});

export type { BgmTrack, CharacterDef, CharacterVoiceRef, ContentPack, SceneDef, WorldBookEntry };

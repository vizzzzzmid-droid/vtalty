import { eq } from "drizzle-orm";
import {
  VOICE_SETTINGS_DEFAULTS,
  voiceSettingsPatchSchema,
  voiceSettingsSchema,
  type VoiceSettings,
} from "@vitality/shared";
import type { Db } from "../../db/client.js";
import { userVoiceSettings } from "../../db/schema.js";
import { parseBody } from "../../lib/validate.js";

export async function getVoiceSettings(db: Db, userId: string): Promise<VoiceSettings> {
  const rows = await db
    .select()
    .from(userVoiceSettings)
    .where(eq(userVoiceSettings.userId, userId))
    .limit(1);
  const stored = rows[0]?.settings;
  const patch =
    typeof stored === "object" && stored !== null
      ? voiceSettingsPatchSchema.safeParse(stored)
      : { success: false as const };
  return voiceSettingsSchema.parse({
    ...VOICE_SETTINGS_DEFAULTS,
    ...(patch.success ? patch.data : {}),
  });
}

export async function putVoiceSettings(
  db: Db,
  userId: string,
  body: unknown,
): Promise<VoiceSettings> {
  const patch = parseBody(voiceSettingsPatchSchema, body);
  const current = await getVoiceSettings(db, userId);
  const next = voiceSettingsSchema.parse({ ...current, ...patch });
  await db
    .insert(userVoiceSettings)
    .values({ userId, settings: next, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: userVoiceSettings.userId,
      set: { settings: next, updatedAt: new Date() },
    });
  return next;
}

import { kvGet, kvSet, registerKvMigration } from "./kv-db";

const SCALE_KEY = "ai_phone_story_floating_phone_scale_v1";
registerKvMigration(SCALE_KEY);

export function normalizeFloatingPhoneScale(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value)
        ? Math.round(Math.max(0.8, Math.min(1, value)) * 100) / 100 : 1;
}

export function loadFloatingPhoneScale(): number {
    const saved = kvGet(SCALE_KEY);
    return saved === null || !saved.trim() ? 1 : normalizeFloatingPhoneScale(Number(saved));
}

export function saveFloatingPhoneScale(value: number): number {
    const scale = normalizeFloatingPhoneScale(value);
    kvSet(SCALE_KEY, String(scale));
    return scale;
}

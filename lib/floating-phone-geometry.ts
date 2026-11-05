export type FloatingPhoneBounds = { width: number; height: number };
export type FloatingPhonePosition = { x: number; y: number };

export function floatingPhoneGeometry(bounds: FloatingPhoneBounds, scale = 1, compact = false, position?: FloatingPhonePosition | null) {
    const zoom = Math.max(0.8, Math.min(1, Number.isFinite(scale) ? scale : 1));
    const maxWidth = Math.min(compact ? 286 : 390, Math.max(0, bounds.width));
    const maxHeight = Math.min(compact ? 520 : 720, Math.max(0, bounds.height - 8));
    const width = Math.min(maxWidth, Math.max(compact ? 240 : 280, maxWidth * zoom));
    const height = Math.min(maxHeight, Math.max(compact ? 360 : 420, maxHeight * zoom));
    const maxX = Math.max(0, bounds.width - width);
    const maxY = Math.max(0, bounds.height - height);
    return { width, height, scale: zoom,
        x: Math.max(0, Math.min(maxX, position?.x ?? maxX / 2)),
        y: Math.max(0, Math.min(maxY, position?.y ?? maxY / 2)) };
}

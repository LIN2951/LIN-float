// lib/otome-video.ts — Tiny module store that tracks whether the persistent
// otome video overlay should be visible. The overlay lives in the desktop shell
// (outside the Music app) so playback keeps going when the app is closed.
"use client";

let visible = false;
const listeners = new Set<() => void>();

function emit() {
    for (const l of listeners) l();
}

export function showOtomeVideo(): void {
    if (visible) return;
    visible = true;
    emit();
}

export function hideOtomeVideo(): void {
    if (!visible) return;
    visible = false;
    emit();
}

export function isOtomeVideoVisible(): boolean {
    return visible;
}

export function subscribeOtomeVideo(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

export function getOtomeVideoSnapshot(): boolean {
    return visible;
}
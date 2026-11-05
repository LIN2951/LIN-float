/** New rectangles use fractions of image width/height; size preserves legacy square crops. */
export type FaceCrop = { x: number; y: number; width?: number; height?: number; size?: number };
export type FaceCropRectangle = { x: number; y: number; width: number; height: number };

function finite(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function normalizeFaceCrop(value?: FaceCrop): FaceCrop {
    const x = clamp(finite(value?.x, 0.27), 0, 1);
    const y = clamp(finite(value?.y, 0.12), 0, 1);
    if (typeof value?.width === "number" && typeof value?.height === "number") {
        const width = clamp(finite(value.width, 0.46), 0.05, 1);
        const height = clamp(finite(value.height, 0.46), 0.05, 1);
        return { x: Math.min(x, 1 - width), y: Math.min(y, 1 - height), width, height };
    }
    return { x, y, size: clamp(finite(value?.size, 0.46), 0.18, 1) };
}

export function resolveFaceCrop(value: FaceCrop | undefined, imageWidth: number, imageHeight: number): FaceCropRectangle {
    const crop = normalizeFaceCrop(value);
    const side = (crop.size ?? 0.46) * Math.min(imageWidth, imageHeight);
    const width = crop.width ?? side / Math.max(1, imageWidth);
    const height = crop.height ?? side / Math.max(1, imageHeight);
    return { x: Math.min(crop.x, 1 - width), y: Math.min(crop.y, 1 - height), width, height };
}

export function faceCropPixels(value: FaceCrop, width: number, height: number) {
    const crop = resolveFaceCrop(value, width, height);
    const cropWidth = Math.max(1, Math.round(crop.width * width));
    const cropHeight = Math.max(1, Math.round(crop.height * height));
    return { x: Math.min(width - cropWidth, Math.round(crop.x * width)),
        y: Math.min(height - cropHeight, Math.round(crop.y * height)), width: cropWidth, height: cropHeight };
}

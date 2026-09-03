/**
 * @module HdrEnvironment
 * @description Bounded Radiance RGBE decoding for authored equirectangular 3D environments.
 */

export interface HdrEnvironmentImage {
    width: number;
    height: number;
    /** Linear RGB triples. Decoded pixels stay transient and are never document data. */
    rgb: Float32Array;
}

export const HDR_ENVIRONMENT_MAX_PIXELS = 16_777_216;

function line(bytes: Uint8Array, state: { at: number }): string | null {
    if (state.at >= bytes.length) return null;
    const start = state.at;
    while (state.at < bytes.length && bytes[state.at] !== 10) state.at++;
    const end = state.at > start && bytes[state.at - 1] === 13 ? state.at - 1 : state.at;
    if (state.at < bytes.length) state.at++;
    return new TextDecoder().decode(bytes.subarray(start, end));
}

function toFloat(r: number, g: number, b: number, e: number, out: Float32Array, at: number): void {
    const scale = e === 0 ? 0 : 2 ** (e - 128) / 256;
    out[at] = r * scale; out[at + 1] = g * scale; out[at + 2] = b * scale;
}

/** Reads modern scanline-RLE and legacy flat RGBE data in the common `-Y +X` orientation. */
export function decodeRadianceHdr(bytes: Uint8Array): HdrEnvironmentImage {
    if (!(bytes instanceof Uint8Array) || bytes.length < 16) throw new Error("Invalid HDR: file is too short.");
    const state = { at: 0 };
    const first = line(bytes, state);
    if (!first?.startsWith("#?")) throw new Error("Invalid HDR: missing Radiance signature.");
    let format = false, current: string | null;
    while ((current = line(bytes, state)) !== null && current !== "") {
        if (current.trim() === "FORMAT=32-bit_rle_rgbe") format = true;
    }
    if (!format) throw new Error("Unsupported HDR: expected FORMAT=32-bit_rle_rgbe.");
    const resolution = line(bytes, state)?.trim() ?? "";
    const match = resolution.match(/^-Y\s+(\d+)\s+\+X\s+(\d+)$/);
    if (!match) throw new Error("Unsupported HDR orientation: expected -Y height +X width.");
    const height = Number(match[1]), width = Number(match[2]);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
        || width * height > HDR_ENVIRONMENT_MAX_PIXELS) {
        throw new Error(`Invalid HDR dimensions ${width}x${height}.`);
    }
    const rgb = new Float32Array(width * height * 3);
    const scanline = new Uint8Array(width * 4);
    for (let y = 0; y < height; y++) {
        const modern = width >= 8 && width <= 32767 && state.at + 4 <= bytes.length
            && bytes[state.at] === 2 && bytes[state.at + 1] === 2
            && (bytes[state.at + 2] & 0x80) === 0
            && ((bytes[state.at + 2] << 8) | bytes[state.at + 3]) === width;
        if (modern) {
            state.at += 4;
            for (let channel = 0; channel < 4; channel++) {
                let x = 0;
                while (x < width) {
                    if (state.at >= bytes.length) throw new Error("Invalid HDR: truncated RLE scanline.");
                    const code = bytes[state.at++];
                    if (code > 128) {
                        const count = code - 128;
                        if (count === 0 || x + count > width || state.at >= bytes.length) throw new Error("Invalid HDR: malformed RLE run.");
                        const value = bytes[state.at++];
                        scanline.fill(value, channel * width + x, channel * width + x + count); x += count;
                    } else {
                        if (code === 0 || x + code > width || state.at + code > bytes.length) throw new Error("Invalid HDR: malformed RLE literal.");
                        scanline.set(bytes.subarray(state.at, state.at + code), channel * width + x);
                        state.at += code; x += code;
                    }
                }
            }
            for (let x = 0; x < width; x++) toFloat(scanline[x], scanline[width + x],
                scanline[2 * width + x], scanline[3 * width + x], rgb, (y * width + x) * 3);
        } else {
            let x = 0, shift = 0, previous: [number, number, number, number] | null = null;
            while (x < width) {
                if (state.at + 4 > bytes.length) throw new Error("Invalid HDR: truncated pixel data.");
                const pixel: [number, number, number, number] = [bytes[state.at], bytes[state.at + 1],
                    bytes[state.at + 2], bytes[state.at + 3]];
                state.at += 4;
                if (pixel[0] === 1 && pixel[1] === 1 && pixel[2] === 1 && previous) {
                    const count = pixel[3] * 2 ** shift;
                    if (count <= 0 || x + count > width) throw new Error("Invalid HDR: malformed legacy RLE run.");
                    for (let n = 0; n < count; n++, x++) toFloat(previous[0], previous[1], previous[2],
                        previous[3], rgb, (y * width + x) * 3);
                    shift += 8;
                } else {
                    previous = pixel; shift = 0;
                    toFloat(pixel[0], pixel[1], pixel[2], pixel[3], rgb, (y * width + x) * 3); x++;
                }
            }
        }
    }
    return { width, height, rgb };
}

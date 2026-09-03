import { decodeRadianceHdr } from "./HdrEnvironment";

const header = (width: number) => new TextEncoder().encode(
    `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X ${width}\n`);

describe("Radiance HDR environment decoding", () => {
    test("decodes flat RGBE into linear float RGB", () => {
        const h = header(2), bytes = new Uint8Array(h.length + 8); bytes.set(h);
        bytes.set([128, 64, 32, 129, 0, 0, 0, 0], h.length);
        const image = decodeRadianceHdr(bytes);
        expect([image.width, image.height]).toEqual([2, 1]);
        expect(Array.from(image.rgb)).toEqual([1, 0.5, 0.25, 0, 0, 0]);
        const legacyHeader = header(3), legacy = new Uint8Array(legacyHeader.length + 8);
        legacy.set(legacyHeader); legacy.set([128, 64, 32, 129, 1, 1, 1, 2], legacyHeader.length);
        expect(Array.from(decodeRadianceHdr(legacy).rgb)).toEqual([
            1, 0.5, 0.25, 1, 0.5, 0.25, 1, 0.5, 0.25
        ]);
    });

    test("decodes modern per-channel RLE and rejects truncation", () => {
        const h = header(8), payload = [2, 2, 0, 8, 136, 128, 136, 64, 136, 32, 136, 129];
        const bytes = new Uint8Array(h.length + payload.length); bytes.set(h); bytes.set(payload, h.length);
        expect(Array.from(decodeRadianceHdr(bytes).rgb.slice(0, 3))).toEqual([1, 0.5, 0.25]);
        expect(() => decodeRadianceHdr(bytes.subarray(0, -1))).toThrow(/truncated|malformed/);
    });
});

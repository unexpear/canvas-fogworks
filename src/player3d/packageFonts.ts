/**
 * @module packageFonts
 * @description Registers packaged font faces in the player document before the first frame.
 */
import type { PackagedFontFace } from "../runtime/GamePackage";

function bytesFromBase64(data: string): Uint8Array {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

/** Loads each packaged face. An empty list is a no-op so generic-font games stay unchanged. */
export async function installPackagedFonts(fonts: readonly PackagedFontFace[]): Promise<void> {
    if (!fonts.length) return;
    if (typeof FontFace === "undefined" || typeof document === "undefined") throw new Error("This player cannot register packaged fonts.");
    for (const font of fonts) {
        const face = new FontFace(font.family, bytesFromBase64(font.data), {
            weight: String(font.weight), style: font.italic ? "italic" : "normal"
        });
        await face.load();
        document.fonts.add(face);
    }
}

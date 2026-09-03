/**
 * @module AssetImportWorkflow
 * @description Async orchestration for turning folder assets into import-ready image sequences.
 */

import { Keyframe } from "../core/document/Timeline";
import { Sequence, sequenceTrack } from "../core/import/Sequence";
import { ElectronAPI } from "./ElectronAPI";

export interface AssetFile { path: string; name: string; relative: string }

export type PreparedSequence =
    | { ok: true; name: string; first: string; track: Keyframe[]; note: string }
    | { ok: false; error: string };

/** Read every named frame through the confined bridge and prepare one animation import. */
export async function prepareSequenceImport(
    api: Pick<ElectronAPI, "readImageDataUrl">,
    folder: string,
    assets: readonly AssetFile[],
    sequence: Sequence
): Promise<PreparedSequence> {
    if (sequence.frames.length === 0) return { ok: false, error: "That sequence has no frames." };
    const byName = new Map<string, AssetFile[]>();
    for (const asset of assets) byName.set(asset.name, [...(byName.get(asset.name) ?? []), asset]);
    const hrefs = new Map<string, string>();
    for (const frame of sequence.frames) {
        const matches = byName.get(frame.file) ?? [];
        if (matches.length === 0) return { ok: false, error: `Missing frame: ${frame.file}.` };
        if (matches.length > 1) {
            return { ok: false, error: `Frame name is ambiguous in subfolders: ${frame.file}.` };
        }
        try {
            const href = await api.readImageDataUrl(folder, matches[0].path);
            if (typeof href !== "string" || !href.startsWith("data:image/")) {
                return { ok: false, error: `Could not decode frame: ${frame.file}.` };
            }
            hrefs.set(frame.file, href);
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            return { ok: false, error: `Could not read frame ${frame.file}: ${detail}` };
        }
    }
    const first = hrefs.get(sequence.frames[0].file);
    if (!first) return { ok: false, error: "Could not read the first frame." };
    const name = sequence.name || "sequence";
    return {
        ok: true,
        name,
        first,
        track: sequenceTrack(sequence, { hrefFor: file => {
            const href = hrefs.get(file);
            // Guarded above for every frame. Throwing here keeps a future refactor fail-closed:
            // a local filename must never leak into an otherwise embedded project.
            if (!href) throw new Error(`Frame was not prepared: ${file}`);
            return href;
        } }),
        note: `${name}: ${sequence.frames.length} frames.`
    };
}

/**
 * @module RuntimeProject
 * @description Host-independent staged level loading with isolated runtime assets and last-request-wins publication.
 */

import { ProjectDocument } from "../core/document/Document";
import { deserializeDocument } from "../core/document/Serializer";
import type { ProjectLevelReader, RuntimeProjectReader, PlayerProjectReader, ProjectAsset3DReader, ProjectEnvironment3DReader } from "./ProjectReadHost";
import { rehydrateAssets3D, rehydrateEnvironments3D } from "./Asset3DLoader";
import { MeshAsset3D } from "../renderer/Scene3D";
import { HdrEnvironmentImage } from "../renderer/HdrEnvironment";

export async function loadLevelTransition(
    api: ProjectLevelReader, currentFilePath: string | null, target: string
): Promise<{ filePath: string; document: ProjectDocument }> {
    if (!currentFilePath) throw new Error("Save this project before following a level transition.");
    const loaded = await api.readLevelFile(currentFilePath, target);
    return { filePath: loaded.filePath, document: deserializeDocument(loaded.content) };
}

/** A stopped/restarted run cannot be replaced by a late filesystem response. */
export class RuntimeProject {
    document: ProjectDocument | null = null;
    filePath: string | null = null;
    meshes = new Map<string, MeshAsset3D>();
    environments = new Map<string, HdrEnvironmentImage>();
    private generation = 0;
    reset(): void {
        this.generation++; this.document = null; this.filePath = null;
        this.meshes = new Map(); this.environments = new Map();
    }
    /** Entry reads share the same validation, staging and cancellation as level transitions. */
    open(api: PlayerProjectReader, entryKey: string): Promise<boolean> {
        return this.load(api, async () => {
            const loaded = await api.readEntryFile(entryKey);
            return { filePath: loaded.filePath, document: deserializeDocument(loaded.content) };
        });
    }
    transition(api: RuntimeProjectReader,
        authoringPath: string | null, target: string): Promise<boolean> {
        return this.load(api, () => loadLevelTransition(api, this.filePath ?? authoringPath, target));
    }
    private async load(api: RuntimeProjectReader,
        read: () => Promise<{ filePath: string; document: ProjectDocument }>): Promise<boolean> {
        const generation = ++this.generation;
        try {
            const loaded = await read();
            if (generation !== this.generation) return false;
            const assets = loaded.document.assets3d ?? [];
            if (assets.length && (!api.readProject3DFile || !api.readProject3DSidecar || !api.readProjectEnvironmentFile)) {
                throw new Error("The host cannot load this level's 3D dependencies.");
            }
            // Stage everything before publication; failure leaves the prior runtime intact.
            const [models, lighting] = await Promise.all([
                rehydrateAssets3D(api as ProjectAsset3DReader & ProjectEnvironment3DReader, loaded.filePath, assets),
                rehydrateEnvironments3D(api as ProjectAsset3DReader & ProjectEnvironment3DReader, loaded.filePath, assets)
            ]);
            if (generation !== this.generation) return false;
            const failures = [...models.failures, ...lighting.failures];
            if (failures.length) throw new Error(`Level dependency failed: ${failures[0].source}: ${failures[0].error}`);
            this.document = loaded.document; this.filePath = loaded.filePath;
            this.meshes = models.meshes; this.environments = lighting.environments;
            return true;
        } catch (error) {
            if (generation !== this.generation) return false;
            throw error;
        }
    }
}

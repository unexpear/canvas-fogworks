/**
 * @module projectDependencies
 * @description Relocates explicitly referenced 3D project sources and glTF sidecars without copying reference packs or overwriting conflicting files.
 */
const fs = require("fs");
const path = require("path");
const { resolveConfined } = require("./confine");

/** Discover all dependencies before creating destination directories or files. */
async function copyProjectDependencies(sourceProject, destinationProject, content) {
    const sourceRoot = path.dirname(sourceProject), destinationRoot = path.dirname(destinationProject);
    if (fs.realpathSync.native(sourceRoot) === fs.realpathSync.native(destinationRoot)) return;
    const assets = JSON.parse(content)?.document?.assets3d ?? [];
    if (!Array.isArray(assets) || assets.length > 4096) throw new Error("Invalid project asset table.");
    const files = new Map();
    let total = 0;
    async function add(base, relative) {
        const logical = path.resolve(base, relative);
        const file = resolveConfined(sourceRoot, base, relative, "a project dependency");
        if (files.has(logical)) return files.get(logical).data;
        const stat = await fs.promises.stat(file);
        if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error("Invalid or oversized project dependency.");
        total += stat.size;
        if (total > 256 * 1024 * 1024 || files.size >= 4096) throw new Error("Project dependency copy exceeds its bounded batch.");
        const data = await fs.promises.readFile(file);
        files.set(logical, { file, data });
        return data;
    }
    for (const asset of assets) {
        const source = asset?.kind === "material" && typeof asset.source === "string"
            ? asset.source.replace(/#material-\d+$/, "") : asset?.source;
        if (typeof source !== "string" || !/\.(gltf|glb|hdr)$/i.test(source)) {
            throw new Error("Save As cannot relocate this asset source format.");
        }
        const file = path.resolve(sourceRoot, source);
        const data = await add(sourceRoot, source);
        let json;
        if (/\.gltf$/i.test(file)) json = JSON.parse(data.toString("utf8"));
        if (/\.glb$/i.test(file)) {
            if (data.length < 20 || data.readUInt32LE(0) !== 0x46546c67 || data.readUInt32LE(4) !== 2
                || data.readUInt32LE(8) !== data.length || data.readUInt32LE(16) !== 0x4e4f534a
                || 20 + data.readUInt32LE(12) > data.length) throw new Error("Invalid GLB dependency container.");
            json = JSON.parse(data.subarray(20, 20 + data.readUInt32LE(12)).toString("utf8").trim());
        }
        if (json) for (const entry of [...(json.buffers ?? []), ...(json.images ?? [])]) {
            if (entry.uri === undefined || /^data:/i.test(entry.uri)) continue;
            if (typeof entry.uri !== "string" || /(^[a-z][a-z0-9+.-]*:|^[\\/]|[?#])/i.test(entry.uri)) {
                throw new Error("Only local relative glTF dependencies can be relocated.");
            }
            await add(path.dirname(file), decodeURIComponent(entry.uri));
        }
    }
    const planned = [];
    for (const [logical, { file, data }] of files) {
        const relative = path.relative(path.resolve(sourceRoot), logical);
        const target = path.join(destinationRoot, relative);
        // Create one level at a time, verifying existing junctions before entering them.
        let parent = destinationRoot;
        for (const part of path.dirname(relative).split(path.sep).filter(p => p && p !== ".")) {
            const next = resolveConfined(destinationRoot, parent, part, "a destination directory");
            try { await fs.promises.mkdir(next); } catch (error) { if (error.code !== "EEXIST") throw error; }
            parent = resolveConfined(destinationRoot, parent, part, "a destination directory");
        }
        const confined = resolveConfined(destinationRoot, destinationRoot, relative, "a destination dependency");
        if (path.resolve(confined) === path.resolve(destinationProject)) throw new Error("A dependency conflicts with the project filename.");
        try {
            if (!(await fs.promises.readFile(confined)).equals(data)) throw new Error(`Dependency conflict: ${relative}. Choose an empty project folder.`);
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
            planned.push({ file, target, relative });
        }
    }
    for (const { file, target, relative } of planned) {
        resolveConfined(destinationRoot, destinationRoot, relative, "a destination dependency");
        await fs.promises.copyFile(file, target, fs.constants.COPYFILE_EXCL);
    }
}
module.exports = { copyProjectDependencies };

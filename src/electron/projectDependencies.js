/**
 * @module projectDependencies
 * @description Relocates bounded linked-level graphs, relative images and 3D sidecars without copying unreferenced packs or overwriting conflicting files.
 */
const fs = require("fs");
const path = require("path");
const { resolveConfined } = require("./confine");

/** Discover all dependencies before creating destination directories or files. */
async function copyProjectDependencies(sourceProject, destinationProject, content) {
    const sourceRoot = path.dirname(sourceProject), destinationRoot = path.dirname(destinationProject);
    if (fs.realpathSync.native(sourceRoot) === fs.realpathSync.native(destinationRoot)) return;
    // The opened spelling need not match the directory entry's spelling on Windows.
    // Resolve identity without lowercasing source paths: case-sensitive folders can contain both.
    const sourceEntry = resolveConfined(sourceRoot, sourceRoot, path.basename(sourceProject), "the source project");
    const destinationEntry = resolveConfined(destinationRoot, destinationRoot, path.basename(destinationProject), "the destination project");
    const files = new Map();
    const projects = new Set([path.resolve(sourceProject)]);
    let total = 0;
    async function add(base, relative) {
        if (typeof relative !== "string" || path.isAbsolute(relative) || /(^[a-z][a-z0-9+.-]*:|[?#])/i.test(relative)) {
            throw new Error("Only local relative project dependencies can be relocated.");
        }
        const logical = path.resolve(base, relative);
        const within = path.relative(path.resolve(sourceRoot), logical);
        if (within.startsWith(`..${path.sep}`) || within === ".." || path.isAbsolute(within)) throw new Error("Dependency outside the chosen folder.");
        const file = resolveConfined(sourceRoot, base, relative, "a project dependency");
        if (files.has(logical)) return files.get(logical).data;
        const stat = await fs.promises.stat(file);
        if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error("Invalid or oversized project dependency.");
        if (total + stat.size > 256 * 1024 * 1024 || files.size >= 4096) throw new Error("Project dependency copy exceeds its bounded batch.");
        const data = await fs.promises.readFile(file);
        total += data.length;
        if (data.length > 64 * 1024 * 1024 || total > 256 * 1024 * 1024) throw new Error("Project dependency changed beyond its bounded batch.");
        files.set(logical, { file, data });
        return data;
    }
    async function visit(project, raw) {
      const base = path.dirname(project), parsed = JSON.parse(raw), doc = parsed?.document;
      if (!doc || typeof doc !== "object") throw new Error("Invalid linked project document.");
      const assets = doc.assets3d ?? [];
      if (!Array.isArray(assets) || assets.length > 4096) throw new Error("Invalid project asset table.");
      // Image fields also occur in animation states, instance overrides and tilesets.
      const pending = [doc.nodes, doc.tilesets];
      while (pending.length) {
          const value = pending.pop();
          if (!value || typeof value !== "object") continue;
          for (const [key, child] of Object.entries(value)) {
              if (key === "userData") continue;
              if (key === "src" && typeof child === "string") {
                  if (/^data:image\//i.test(child)) continue;
                  await add(base, decodeURIComponent(child));
              } else if (child && typeof child === "object") pending.push(child);
          }
      }
      for (const asset of assets) {
        const source = asset?.kind === "material" && typeof asset.source === "string"
            ? asset.source.replace(/#material-\d+$/, "") : asset?.source;
        if (typeof source !== "string" || !/\.(gltf|glb|hdr)$/i.test(source)) {
            throw new Error("Save As cannot relocate this asset source format.");
        }
        const file = path.resolve(base, source);
        const data = await add(base, source);
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
      let changed = false;
      for (const node of Object.values(doc.nodes ?? {})) {
          const target = node?.entity?.transitionTo;
          if (target === undefined) continue;
          if (typeof target !== "string" || path.isAbsolute(target) || !/\.(vde|json)$/i.test(target)) throw new Error("Invalid relative level target.");
          // Match the runtime's per-level confinement rather than packaging unreachable levels.
          const targetFile = resolveConfined(base, base, target, "a level project");
          const logical = path.resolve(base, target);
          if (targetFile === sourceEntry) {
              if (project === path.resolve(sourceProject)) {
                  if (path.basename(sourceProject) !== path.basename(destinationProject)) {
                      throw new Error("A self-linked entry level must retain its filename during Save As.");
                  }
                  continue;
              }
              const replacement = path.relative(base, path.join(sourceRoot, path.basename(destinationProject))).split(path.sep).join("/");
              if (replacement !== target) { node.entity.transitionTo = replacement; changed = true; }
              continue;
          }
          if (projects.has(logical)) continue;
          if (projects.size >= 32) throw new Error("A portable project is limited to 32 linked levels.");
          projects.add(logical);
          const bytes = await add(base, target);
          if (bytes.length > 20_000_000) throw new Error("The level project is larger than 20 MB.");
          await visit(logical, bytes.toString("utf8"));
      }
      if (changed) files.get(project).data = Buffer.from(JSON.stringify(parsed));
    }
    await visit(path.resolve(sourceProject), content);
    const planned = [];
    for (const [logical, { data }] of files) {
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
        // Reserve the entry's spelling and Windows case aliases even while the entry is absent.
        // Conservatively refuse ambiguous entry names on Windows case-sensitive folders too.
        if (confined === destinationEntry || (process.platform === "win32"
            && confined.toLowerCase() === destinationEntry.toLowerCase())) {
            throw new Error("A dependency conflicts with the project filename.");
        }
        try {
            if (!(await fs.promises.readFile(confined)).equals(data)) throw new Error(`Dependency conflict: ${relative}. Choose an empty project folder.`);
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
            planned.push({ data, target, relative });
        }
    }
    for (const { data, target, relative } of planned) {
        resolveConfined(destinationRoot, destinationRoot, relative, "a destination dependency");
        // Write the bytes actually validated, not a source that may have changed since discovery.
        try {
            await fs.promises.writeFile(target, data, { flag: "wx" });
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
            // Two logical spellings may name one destination file. Keep both placements for
            // case-sensitive filesystems/junction aliases; let exclusive creation detect aliases.
            // Recheck confinement before reading and accept only the exact validated bytes.
            const existing = resolveConfined(destinationRoot, destinationRoot, relative, "a destination dependency");
            if (!(await fs.promises.readFile(existing)).equals(data)) {
                throw new Error(`Dependency conflict: ${relative}. Choose an empty project folder.`);
            }
        }
    }
}
module.exports = { copyProjectDependencies };

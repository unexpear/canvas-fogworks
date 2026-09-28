/**
 * @module projectImages
 * @description Embeds bounded project-relative image references at the native open boundary; never fetches remote URLs or follows paths outside the project.
 */
const fs = require("fs");
const path = require("path");
const { resolveConfined } = require("./confine");
const imageTypes = { ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".gif": "gif", ".webp": "webp", ".svg": "svg+xml", ".bmp": "bmp" };

async function embedProjectImages(project, content) {
    const parsed = JSON.parse(content), root = path.dirname(project);
    const pending = [parsed?.document?.nodes, parsed?.document?.tilesets];
    const cache = new Map(); let total = 0, changed = false;
    while (pending.length) {
        const value = pending.pop();
        if (!value || typeof value !== "object") continue;
        for (const [key, child] of Object.entries(value)) {
            if (key === "userData") continue;
            if (key !== "src" || typeof child !== "string") {
                if (child && typeof child === "object") pending.push(child);
                continue;
            }
            if (/^[a-z][a-z0-9+.-]*:/i.test(child)) continue;
            if (path.isAbsolute(child) || /[?#]/.test(child)) throw new Error("Project images must use local relative paths.");
            const file = resolveConfined(root, root, decodeURIComponent(child), "a project image");
            const type = imageTypes[path.extname(file).toLowerCase()];
            if (!type) throw new Error("Unsupported project image format.");
            if (!cache.has(file)) {
                const stat = await fs.promises.stat(file);
                // Leave room for the data URL header within Node.IMAGE_SRC_MAX (4,000,000 characters).
                if (!stat.isFile() || stat.size > 2_999_970) throw new Error("Project image exceeds the embedded image limit.");
                total += stat.size;
                if (total > 32 * 1024 * 1024 || cache.size >= 4096) throw new Error("Project image loading exceeds its bounded batch.");
                cache.set(file, `data:image/${type};base64,${(await fs.promises.readFile(file)).toString("base64")}`);
                if (cache.get(file).length > 4_000_000) throw new Error("Project image exceeds the embedded image limit.");
            }
            value[key] = cache.get(file); changed = true;
        }
    }
    const result = changed ? JSON.stringify(parsed) : content;
    if (result.length > 64 * 1024 * 1024) throw new Error("Embedded project exceeds 64MB.");
    return result;
}
module.exports = { embedProjectImages };

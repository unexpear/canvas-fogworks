/**
 * @module confine
 * @description The one rule that keeps a renderer-supplied path inside the folder the user picked.
 *
 * IT LIVES HERE SO IT CAN BE TESTED. `main.js` is an Electron entry point — requiring it opens a
 * window — so everything in it could only ever be checked by grepping the file for its own error
 * string, which is a test that cannot tell a working guard from a broken one. This is the security
 * boundary of the whole application: every path that arrives from a parsed file crosses it.
 *
 * WHY LEXICAL CONTAINMENT WAS NOT ENOUGH, measured rather than theorised. The previous check
 * resolved both paths and compared prefixes, which correctly defeats `../../../etc/passwd` because
 * `path.resolve` collapses `..` before anything touches the disk. It does not defeat a DIRECTORY
 * JUNCTION: a link at `pack/out` pointing anywhere on the machine makes `../out/secret.png` resolve
 * to a path that is textually under the pack and reads a file that is not. Junctions need no
 * elevation on Windows and survive being zipped and unzipped, and a `.tmx` is a text file anyone can
 * write — `<image source="../out/x.png"/>` is a perfectly well-formed Tiled document. Reproduced
 * against the old algorithm before this was written; it returned the outside file's bytes.
 *
 * SO THE COMPARISON IS AGAINST REAL PATHS. `fs.realpathSync.native` resolves junctions, symlinks and
 * 8.3 short names, and the check happens BEFORE any read. The leaf is allowed not to exist — a file
 * that is merely missing should fail as a missing file, not as an attempted escape — but its
 * directory must, which is what closes the hole: the junction is a directory.
 *
 * THE SEPARATOR IS CONDITIONAL, which looks like a nicety and is a bug fix. `path.resolve("C:\\")`
 * already ends in a separator, so the old `root + path.sep` produced `C:\\` and refused every path
 * on the drive — a folder the user explicitly picked in a native dialog behaved as if nothing were
 * in it. Appending only when one is missing keeps the sibling-prefix guard that matters
 * (`C:\packs\Kenney` must not match `C:\packs\Kenney2`) without that.
 */

const fs = require("fs");
const path = require("path");

/**
 * The absolute path `requested` names, or a thrown refusal.
 *
 * @param {string} folder the directory the user chose in a native dialog
 * @param {string} baseDir what a relative path is relative TO — a map's own directory, say. The
 *        containment is still against `folder`: real packs legitimately reference
 *        `../Spritesheet/sheet.png`, one level up from the map and well inside the pack.
 * @param {string} requested the renderer's path, which may have come out of a parsed file
 * @param {string} what the noun for the error message, e.g. "a palette"
 */
function resolveConfined(folder, baseDir, requested, what) {
    if (!folder || typeof folder !== "string") throw new Error("Invalid folder.");
    if (!baseDir || typeof baseDir !== "string") throw new Error("Invalid base directory.");
    if (!requested || typeof requested !== "string") throw new Error(`Invalid ${what} path.`);
    // EXTENDED-LENGTH AND UNC PREFIXES ARE REFUSED OUTRIGHT rather than reasoned about. `\\?\C:\`
    // resolves to a form with no trailing separator and different normalisation rules, and a UNC
    // share is not a local folder anybody picked.
    if (/^\\\\/.test(requested) || /^\\\\/.test(folder)) {
        throw new Error(`Refusing to read ${what} through a UNC or extended-length path.`);
    }

    const root = realDirectory(path.resolve(folder), "the chosen folder");
    const target = path.resolve(baseDir, requested);
    // THE LEAF MAY BE ABSENT; ITS DIRECTORY MAY NOT. Resolving the directory is what defeats a
    // junction, and letting the leaf be missing keeps "no such file" distinct from "escape".
    let real;
    try {
        real = fs.realpathSync.native(target);
    } catch {
        real = path.join(realDirectory(path.dirname(target), what), path.basename(target));
    }

    const sep = root.endsWith(path.sep) ? "" : path.sep;
    if (real !== root && !real.startsWith(root + sep)) {
        throw new Error(`Refusing to read ${what} outside the chosen folder.`);
    }
    return real;
}

/** A directory's real path, with a refusal rather than a raw ENOENT when it is not there. */
function realDirectory(dir, what) {
    try {
        return fs.realpathSync.native(dir);
    } catch {
        throw new Error(`Refusing to read ${what}: no such directory.`);
    }
}

module.exports = { resolveConfined };

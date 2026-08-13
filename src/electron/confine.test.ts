/**
 * The confinement boundary, tested against a REAL junction on a REAL disk.
 *
 * Everything else about the main process is asserted by grepping `main.js` for its own error
 * strings, which cannot tell a working guard from a broken one — and did not: the lexical check
 * this replaces passed every such assertion while reading files outside the chosen folder.
 *
 * A junction is used rather than a symlink because it needs no elevation on Windows, which is what
 * makes the attack ordinary. Where the platform refuses to make one, the case SKIPS LOUDLY rather
 * than passing: a security test that quietly tests nothing is worse than no test.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join, sep } from "path";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveConfined } = require("../electron/confine");

describe("resolveConfined — the folder a renderer-supplied path may not leave", () => {
    let base = "";
    let pack = "";
    let outside = "";
    let linked = false;

    beforeAll(() => {
        base = realpathSync(mkdtempSync(join(tmpdir(), "vde-confine-")));
        pack = join(base, "pack");
        outside = join(base, "private");
        mkdirSync(join(pack, "maps"), { recursive: true });
        mkdirSync(join(pack, "Spritesheet"), { recursive: true });
        mkdirSync(outside, { recursive: true });
        writeFileSync(join(outside, "secret.png"), "NOT-YOURS");
        writeFileSync(join(pack, "Spritesheet", "sheet.png"), "MINE");
        writeFileSync(join(pack, "maps", "level.tmx"), "<map/>");
        try {
            symlinkSync(outside, join(pack, "out"), "junction");
            linked = true;
        } catch {
            linked = false;
        }
    });

    afterAll(() => {
        try { rmSync(base, { recursive: true, force: true }); } catch { /* a junction may resist */ }
    });

    const mapDir = () => join(pack, "maps");

    test("a JUNCTION inside the folder does not lead out of it", () => {
        // THE DEFECT THIS EXISTS FOR, reproduced against the old algorithm before the fix: a link at
        // `pack/out` pointing anywhere on the machine made `../out/secret.png` resolve textually
        // under the pack and return the outside file's bytes. A `.tmx` is a text file anyone can
        // write and `<image source="../out/x.png"/>` is well-formed Tiled.
        if (!linked) {
            throw new Error("could not create a junction — this test cannot run, and must not pass silently");
        }
        expect(() => resolveConfined(pack, mapDir(), "../out/secret.png", "an image"))
            .toThrow(/outside the chosen folder/);
    });

    test("the ordinary pack layout still resolves", () => {
        // A REAL MAP REFERENCES `../Spritesheet/sheet.png` — one level up from itself and well
        // inside the pack. A guard that refused this would be safe and useless, and the whole
        // reason containment is measured against the CHOSEN FOLDER rather than the map's directory.
        const got = resolveConfined(pack, mapDir(), "../Spritesheet/sheet.png", "an image");
        expect(got).toBe(join(pack, "Spritesheet", "sheet.png"));
        expect(resolveConfined(pack, mapDir(), "level.tmx", "a map")).toBe(join(pack, "maps", "level.tmx"));
    });

    test("lexical traversal is still refused, and so is a sibling whose name merely starts the same", () => {
        expect(() => resolveConfined(pack, mapDir(), "../../private/secret.png", "an image"))
            .toThrow(/outside the chosen folder/);
        // `C:\packs\Kenney` must not match `C:\packs\Kenney2` — the prefix trap the old check
        // already avoided and this must not reintroduce.
        const sibling = join(base, "packAndMore");
        mkdirSync(sibling, { recursive: true });
        writeFileSync(join(sibling, "evil.png"), "NOPE");
        expect(() => resolveConfined(pack, pack, join(sibling, "evil.png"), "an image"))
            .toThrow(/outside the chosen folder/);
    });

    test("a MISSING file fails as missing, not as an escape", () => {
        // The two are different answers and a caller shows them differently. Collapsing them would
        // make every typo look like an attack, which is how a real warning gets ignored.
        expect(resolveConfined(pack, mapDir(), "nothere.png", "an image"))
            .toBe(join(pack, "maps", "nothere.png"));
        // …but a missing DIRECTORY is refused, since that is where a junction would have been.
        expect(() => resolveConfined(pack, mapDir(), "../nodir/x.png", "an image")).toThrow(/no such directory/);
    });

    test("the folder itself is inside the folder, and a drive root is not vacuous", () => {
        expect(resolveConfined(pack, pack, ".", "an image")).toBe(pack);
        // `path.resolve("C:\\")` ALREADY ends in a separator, so the old `root + path.sep` built
        // `C:\\` and refused every path on the drive — a folder the user picked in a native dialog
        // behaved as though it were empty. The separator is appended only when one is missing.
        const root = pack.split(sep)[0] + sep;
        expect(() => resolveConfined(root, root, "Windows", "a file")).not.toThrow();
    });

    test("UNC and extended-length paths are refused rather than reasoned about", () => {
        expect(() => resolveConfined(pack, mapDir(), "\\\\server\\share\\x.png", "an image"))
            .toThrow(/UNC or extended-length/);
        expect(() => resolveConfined("\\\\?\\" + pack, mapDir(), "x.png", "an image"))
            .toThrow(/UNC or extended-length/);
    });

    test("nothing is accepted from a caller that supplied nothing", () => {
        expect(() => resolveConfined("", mapDir(), "x.png", "an image")).toThrow(/Invalid folder/);
        expect(() => resolveConfined(pack, "", "x.png", "an image")).toThrow(/Invalid base directory/);
        expect(() => resolveConfined(pack, mapDir(), "", "an image")).toThrow(/Invalid an image path/);
    });
});

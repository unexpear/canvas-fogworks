/**
 * @module build
 * @description Build orchestrator. Emits four esbuild bundles — the React app, offline player,
 * the Electron main process, and the preload script (which must be its own file,
 * because Electron loads it at runtime rather than importing it) — then copies
 * index.html with the bundle injected.
 *
 * `npm run dist` also packages an installer; `--watch` rebuilds on change.
 */

const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const pkg = require("../package.json");

const watch = process.argv.includes("--watch");
const launchElectron = process.argv.includes("--electron");

const rootDir = path.join(__dirname, "..");
const srcDir = path.join(rootDir, "src");
const distDir = path.join(rootDir, "dist");
const distAppDir = path.join(distDir, "app");
const distElectronDir = path.join(distDir, "electron");
const htmlSrc = path.join(srcDir, "app", "index.html");
const mainSrc = path.join(srcDir, "electron", "main.js");
const preloadSrc = path.join(srcDir, "electron", "preload.js");

function copyHtml() {
    let html = fs.readFileSync(htmlSrc, "utf-8");
    html = html.replace(/<\/body>/i, '    <script src="bundle.js"></script>\n</body>');
    fs.writeFileSync(path.join(distAppDir, "index.html"), html);
}

async function build() {
    if (fs.existsSync(distDir)) {
        fs.rmSync(distDir, { recursive: true });
    }
    fs.mkdirSync(distAppDir, { recursive: true });
    fs.mkdirSync(distElectronDir, { recursive: true });

    const appCtx = await esbuild.context({
        entryPoints: [path.join(srcDir, "app", "index.tsx")],
        bundle: true,
        outfile: path.join(distAppDir, "bundle.js"),
        format: "iife",
        platform: "browser",
        target: "es2020",
        jsx: "automatic",
        define: {
            "process.env.NODE_ENV": '"production"',
            // Single source of truth for the version: injected from package.json
            // so the app never carries a hardcoded copy that can drift.
            "__APP_VERSION__": JSON.stringify(pkg.version)
        },
        minify: true,
        sourcemap: false
    });

    const electronCtx = await esbuild.context({
        entryPoints: [mainSrc],
        bundle: true,
        outfile: path.join(distElectronDir, "main.js"),
        platform: "node",
        target: "node18",
        format: "cjs",
        sourcemap: false,
        external: ["electron"]
    });

    // The preload script is loaded by Electron via webPreferences.preload at
    // runtime (main.js -> dist/electron/preload.js); it is NOT imported by
    // main.js, so it must be emitted as its own file or window.electronAPI is
    // undefined and every IPC-backed menu/save feature silently dies.
    const preloadCtx = await esbuild.context({
        entryPoints: [preloadSrc],
        bundle: true,
        outfile: path.join(distElectronDir, "preload.js"),
        platform: "node",
        target: "node18",
        format: "cjs",
        sourcemap: false,
        external: ["electron"]
    });

    const playerCtx = await esbuild.context({ entryPoints: [path.join(srcDir, "player", "index.ts")], bundle: true,
        outfile: path.join(distAppDir, "player.js"), platform: "browser", format: "iife", target: "es2020", minify: true });
    const contexts = [appCtx, electronCtx, preloadCtx, playerCtx];
    await Promise.all(contexts.map(context => context.rebuild()));
    copyHtml();

    if (watch) {
        await Promise.all(contexts.map(context => context.watch()));
        // index.html is not part of any esbuild entry graph, so watch it directly.
        fs.watch(htmlSrc, () => {
            try { copyHtml(); console.log("index.html re-copied"); } catch (e) { console.error(e); }
        });
        console.log("Watching for changes... (Ctrl+C to stop)");
        if (launchElectron) {
            const npx = process.platform === "win32" ? "npx.cmd" : "npx";
            const child = spawn(npx, ["electron", "."], { stdio: "inherit", shell: true, cwd: rootDir });
            child.on("exit", () => process.exit(0));
        }
    } else {
        await Promise.all(contexts.map(context => context.dispose()));
        console.log("Build complete: dist/");
        console.log("  dist/app/index.html");
        console.log("  dist/app/bundle.js");
        console.log("  dist/app/player.js");
        console.log("  dist/electron/main.js");
        console.log("  dist/electron/preload.js");
    }
}

build().catch(err => {
    console.error("Build failed:", err);
    process.exit(1);
});

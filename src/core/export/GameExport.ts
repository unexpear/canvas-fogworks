/**
 * @module GameExport
 * @description Validates portable 2D game documents and embeds their bounded level graph alongside the standalone player.
 */
import { deserializeDocument } from "../document/Serializer";
import { playerEntityId } from "../document/Entity";
import { worldFrom, runtimeExclusions } from "../runtime/World";

export interface GameLevel { content: string; links: Record<string, string>; }
export interface GamePackage { entry: string; levels: Record<string, GameLevel>; }
export function gameDocumentTargets(content: string): string[] {
    if (content.length > 32 * 1024 * 1024) throw new Error("A game level exceeds 32MB.");
    const doc = deserializeDocument(content);
    if (doc.assets3d?.length || [...doc.nodes.values()].some(n => n.spatial3d)) throw new Error("Standalone HTML currently supports 2D games only.");
    const player = playerEntityId(doc.nodes.values());
    if (!player || !worldFrom(doc).bodies.has(player)) throw new Error("Mark one supported dynamic entity as Player before exporting.");
    const exclusions = runtimeExclusions(doc);
    if (exclusions.length) throw new Error(`Unsupported runtime geometry: ${exclusions[0].why}`);
    const inspect = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value)) {
            if (key === "src" && typeof child === "string" && !child.startsWith("data:image/")) {
                throw new Error("Embed image assets before exporting an offline game.");
            }
            inspect(child);
        }
    };
    inspect(JSON.parse(content));
    return [...new Set([...doc.nodes.values()].flatMap(n => n.entity?.transitionTo ? [n.entity.transitionTo] : []))];
}

export function gameHtml(game: GamePackage, playerBundleBase64: string): string {
    if (!game.levels[game.entry] || Object.keys(game.levels).length > 32) throw new Error("Invalid game level graph.");
    for (const level of Object.values(game.levels)) {
        for (const target of gameDocumentTargets(level.content)) {
            if (!game.levels[level.links[target]]) throw new Error(`Unpackaged level transition: ${target}`);
        }
    }
    const json = JSON.stringify(game).replace(/</g, "\\u003c");
    if (json.length > 64 * 1024 * 1024) throw new Error("Standalone game exceeds the 64MB package limit.");
    if (!/^[A-Za-z0-9+/]+=*$/.test(playerBundleBase64)) throw new Error("Invalid player bundle.");
    return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src data:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data:; connect-src 'none'">
<title>Canvas Fogworks Game</title><style>body{margin:0;background:#161821;color:white;font:16px sans-serif}header{padding:8px}canvas{display:block;width:100vw;height:calc(100vh - 48px)}button{margin-right:12px;padding:6px}</style>
<header><button id="start">Start / Restart</button><button id="respawn">Respawn</button><button id="checkpoint">Set checkpoint</button><button id="save-progress">Save progress</button><button id="load-progress">Load progress</button><span id="progress-note" role="status"></span><span id="status">Arrow keys / A,D to move; Space to jump; Shift to run; F to interact.</span></header><canvas id="game"></canvas>
<script type="application/json" id="project">${json}</script><script src="data:text/javascript;base64,${playerBundleBase64}"></script></html>`;
}

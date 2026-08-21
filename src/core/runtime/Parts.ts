/**
 * @module Parts
 * @description What a PART declares about its own behaviour (M18 slice 12).
 *
 * THE THIRD ANSWER TO "WHERE DOES POLICY LIVE", after the first two were tried and rejected.
 * Hard-coding a rule in the app teaches the engine nothing and cannot be tested without a DOM. A
 * class-to-behaviour table is worse than that: it would invent semantics for words whose semantics
 * were MEASURED to be unrecoverable — `coin` appears on twelve objects carrying zero properties
 * between them, `script` names a `.lua` that does not exist, `map` names two `.json` files that do
 * not exist, and sticker-knight ships no game source at all. Inventing meanings for someone else's
 * undefined words is strictly worse than inventing words that mean what you say they mean.
 *
 * SO A PART CARRIES ITS OWN RULE. This is Super Mario Maker's shape rather than a level format's: a
 * goomba there is not a name the engine looks up, it is a part that brings its behaviour with it,
 * and the editor's palette IS the vocabulary. That makes the rules DATA authored in the editor,
 * which is what VDE already is.
 *
 * WHY THIS IS NOT "SCHEMA INVENTED AHEAD OF CONTENT", the charge that refused `core.entity`. That
 * charge is about inventing a shape and WAITING for content to justify it. The corpus cannot justify
 * this because the corpus is somebody else's imported level geometry; the content that uses this
 * vocabulary is content WE author, and it ships in the same commit as the vocabulary and the reader.
 * A declaration with no writer would be the `Document.clips` bug; this one has both.
 *
 * IT IS STILL AN INVENTION, and every entry says so. What it does NOT do is cost anything to a
 * document that never met it: `partOf` answers "declares nothing" for every node in the corpus and
 * for every document written before today, so those play exactly as they did. That is `oneway`'s
 * argument, and unlike slice 9's it genuinely transfers.
 *
 * THE VOCABULARY IS CLOSED AND SMALL, and both entries were named by the level rather than guessed.
 * Building the Kenney map into something playable produced a list of what the engine could not
 * express; these are the two that needed no new SYSTEM behind them:
 *
 *   - `vde.stompable` — landing on it from above removes it. This replaces an inference I disliked
 *     the moment I wrote it: slice 10 read `className !== ""` as "authored as an actor", which is
 *     the measured disjointness of the corpus pressed into service as a marker it never was. Now a
 *     part says so itself, and sticker-knight's unclassed push-block is safe because it DECLARES
 *     nothing rather than because of a heuristic about classes.
 *   - `vde.patrol` — it walks, at the declared speed, turning around when a wall stops it. Measured
 *     need: every enemy in the built level was a statue, because `worldFrom` starts every dynamic
 *     body at rest and nothing in the engine could give one a velocity.
 *
 * WHAT IS DELIBERATELY ABSENT: anything needing a SYSTEM rather than a rule. No death, no respawn,
 * no score, no doors, no spawners. The level's loudest gap is that a run cannot be lost or ended —
 * and that is not a part's declaration, it is a run lifecycle, which wants its own design.
 */
import { Node, UserData } from "../document/Node";
import { ReadonlyDocument, ProjectDocument } from "../document/Document";
import { propertyOf, WorldState } from "./World";

/** The prefix that marks a property as VDE's own vocabulary rather than an imported file's. */
export const PART_PREFIX = "vde.";

/**
 * What a part says about itself. Every field's absence is the default, and the default is inert.
 */
export interface Part {
    /** Landing on it from above removes it, and launches whoever landed. */
    stompable: boolean;
    /**
     * It walks on its own at this many pixels a second, reversing when a wall stops it.
     *
     * Null means it does not walk. Zero is NOT null — a part declaring `0` has asked to stand still
     * and should keep standing still rather than fall back to some default.
     */
    patrol: number | null;
    /** Touching it any way but stomping it ends the run. Mario's Goomba from the side. */
    deadly: boolean;
    /** Reaching it wins. The flagpole. */
    goal: boolean;
    /**
     * Touching it takes it away. The coin.
     *
     * SEPARATE FROM `goal` because reaching a flagpole ends the run and picking up a coin does not,
     * and separate from `stompable` because that needs landing on it from above. A part may be all
     * three; nothing here reads one from another.
     */
    collectible: boolean;
    /**
     * Collecting it raises the collector to this POWER tier (M18 slice 34). The mushroom.
     *
     * A NUMBER, NOT A FLAG, because SMB1's tiers are ordered — small, Super, Fire — and "which
     * mushroom beats which" is exactly the kind of policy a part should declare rather than a rule
     * should hard-code. Null means collecting it powers nothing, which is every coin. It reads
     * `vde.powers` and does nothing WITHOUT `vde.collect` — power arrives by collecting, and a
     * region nobody can pick up has nothing to grant.
     */
    powers: number | null;
}

/** A part that declares nothing — what every node in the corpus and every older document is. */
export const INERT: Part = { stompable: false, patrol: null, deadly: false, goal: false, collectible: false, powers: null };

/**
 * What this node declares, read LENIENTLY for the reason the whole runtime reads leniently: the same
 * property name arrives typed and untyped in one corpus file, so demanding a declared type would
 * drop more than half of real data.
 *
 * AN UNKNOWN `vde.` KEY IS IGNORED rather than refused. A part authored by a newer build lands in an
 * older one as decoration, which is the same bargain `bodyTypeOf` strikes for an unknown body type.
 */
export function partOf(node: { userData?: UserData }): Part {
    const stomp = propertyOf(node.userData, PART_PREFIX + "stompable");
    const patrol = propertyOf(node.userData, PART_PREFIX + "patrol");
    return {
        // "false" and "0" and "" all mean NO. Anything else present means yes, because a part that
        // bothered to declare the key wants the behaviour.
        stompable: stomp !== null && truthy(stomp),
        patrol: speedOf(patrol),
        deadly: yes(node, "deadly"),
        goal: yes(node, "goal"),
        collectible: yes(node, "collect"),
        powers: speedOf(propertyOf(node.userData, PART_PREFIX + "powers"))
    };
}

/** Does this document declare ANY part behaviour? One pass, for a caller deciding whether to bother. */
export function hasParts(nodes: Iterable<{ userData?: UserData }>): boolean {
    for (const n of nodes) {
        const p = partOf(n);
        if (p.stompable || p.patrol !== null || p.deadly || p.goal) return true;
    }
    return false;
}

/** A declared flag: absent is no, and every word that means no is no. */
function yes(node: { userData?: UserData }, key: string): boolean {
    const raw = propertyOf(node.userData, PART_PREFIX + key);
    return raw !== null && truthy(raw);
}

function truthy(raw: string): boolean {
    const v = raw.trim().toLowerCase();
    return v !== "" && v !== "false" && v !== "0" && v !== "no";
}

/**
 * A declared speed, or null.
 *
 * `Number("")` IS 0 AND FINITE — the trap this project has already paid for once, in `frictionOf`,
 * where an empty property value became ice. An empty declaration is not a speed of zero; it is a
 * part that failed to say anything, and it must read as null.
 */
function speedOf(raw: string | null): number | null {
    if (raw === null) return null;
    const t = raw.trim();
    if (t === "") return null;
    const n = Number(t);
    if (!Number.isFinite(n)) return null;
    // A NEGATIVE SPEED IS A DIRECTION, not an error: it starts the part walking left.
    return n;
}

/**
 * A WALK CYCLE, declared: how many frames it has and how far the part walks per frame.
 *
 * FRAMES LIE TO THE RIGHT OF THE POSE THE NODE ALREADY CARRIES. A node's `sourceRect` is where its
 * first frame is; `vde.walk: "4"` says the next three sit beside it, one `sourceRect.width` apart.
 * That is how every sprite sheet in `freeassets` is cut and it means the declaration adds no
 * coordinates — the artist positions frame one by eye in the inspector, as they already do, and the
 * rest follow. A sheet laid out vertically or ragged is NOT expressible, which is stated rather
 * than guessed at: 57% of Kenney's 421 atlases are irregularly packed and none of them are walks.
 *
 * `vde.walkStride` IS THE DISTANCE PER FRAME, defaulting to the node's own width. A character
 * whose cycle advances once per body-width covers ground at a believable rate whatever its size,
 * which is the only default that does not need a number invented for it.
 */
export interface Walk {
    /** How many frames, counting the authored one. Null means the part does not walk. */
    frames: number | null;
    /** Pixels of travel per frame, or null to mean "the node's own width". */
    stride: number | null;
}

export const INERT_WALK: Walk = { frames: null, stride: null };

export function walkOf(node: { userData?: UserData }): Walk {
    const frames = speedOf(propertyOf(node.userData, PART_PREFIX + "walk"));
    // FEWER THAN TWO FRAMES IS NOT A CYCLE. One frame is the pose the node already has, and zero or
    // a negative count is a declaration nobody meant — all three read as "does not walk" rather
    // than as a cycle that divides by zero or indexes backwards.
    return {
        frames: frames !== null && Number.isFinite(frames) && frames >= 2 ? Math.floor(frames) : null,
        stride: speedOf(propertyOf(node.userData, PART_PREFIX + "walkStride"))
    };
}

/**
 * The document with every walking body posed at the frame its DISTANCE has reached.
 *
 * A SIBLING OF `applyFacing`, and chosen over the clip player for the reasons the design review
 * recorded. `clipFrameAt` counts elapsed from the CLIP's start rather than the run's, and
 * `importTrack` replaces a whole track so a node holds one clip spanning an entire sheet — both are
 * real, both were blockers, and both are simply not on this path. Nothing here has a clock.
 *
 * IT CANNOT MOVE ANYTHING, checked rather than assumed: `sourceRect` appears nowhere in
 * `core/geometry` or `core/runtime` — only the render model, the image cache and the Tiled exporter
 * read it. So a frame change cannot shift the node's AABB, which means it cannot move
 * `contentBounds`, the camera's clamp, or the death plane. That was the fourth recorded blocker and
 * it is the same escape hatch facing used: change what is DRAWN without changing what is THERE.
 *
 * AND THAT IS ALSO WHY THERE IS NO `posedIds`. `facedIds` exists because a mirror is a TRANSFORM,
 * which geometry reuses and would otherwise keep stale; a `sourceRect` is rebuilt into the display
 * list every frame from the document, so there is no reused entry to go stale.
 */
export function applyPose(doc: ReadonlyDocument, world: WorldState): ReadonlyDocument {
    let nodes: Map<string, Node> | null = null;
    for (const [id, body] of world.bodies) {
        const node = doc.nodes.get(id);
        if (!node || !node.sourceRect) continue;
        const walk = walkOf(node);
        if (walk.frames === null) continue;
        const rect = node.sourceRect;
        const stride = walk.stride !== null && walk.stride > 0 ? walk.stride
            : (node.geometry.width > 0 ? node.geometry.width : rect.width);
        if (!(stride > 0)) continue;
        // FLOOR, NOT ROUND: a frame must last a whole stride rather than half of one at each end,
        // or the first and last frames of the cycle show for half as long as the others.
        const step = Math.floor(body.travelled / stride) % walk.frames;
        const want = rect.x + step * rect.width;
        if (want === rect.x) continue;               // frame 0 is what the node already carries
        if (!nodes) nodes = new Map(doc.nodes as ReadonlyMap<string, Node>);
        nodes.set(id, { ...(node as Node), sourceRect: { ...rect, x: want } } as Node);
    }
    if (!nodes) return doc;
    return { ...(doc as ProjectDocument), nodes } as ReadonlyDocument;
}

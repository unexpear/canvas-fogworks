# Animation workflow

<!-- describes: src/core/document/AnimationController.ts, src/core/runtime/AnimationPlayback.ts, src/core/runtime/AnimationWorld.ts, src/app/AnimationPanel.tsx, src/app/App.tsx -->
<!-- re-read 2026-09-28: App.tsx still wires clip playback. The folders drawer moved to
     FoldersDrawer.tsx and does not change animation authoring or runtime sampling.
     App.tsx now restores browser and desktop recovery snapshots. Clip authoring, preview, and runtime controllers are unchanged. -->

Delivered in schema 77: named timeline clips, preview and per-node runtime controllers,
shared by 2D editing and animated 2D planes/billboards in the 3D workspace.

## Author and preview

1. Enable Timeline or import an Aseprite file (its tags become clips).
2. Expand **Animation clips and states** above the timeline. Choose a clip or create one
   with a name, inclusive From/To frames and Loop setting.
3. Use timeline Play to preview the chosen range. Scrubbing pauses preview. A one-shot
   holds the final frame for one frame duration before stopping. Play restarts a finished shot.
4. Select the character/root node and click **Add controller** with a clip selected.
5. Add named states, assign clips and playback speeds, and select the initial state.
6. Add From/To/Condition transitions. Move higher-priority rules up. Choose another node
   as Driver when the art is separate from the physics body. Runtime Play shows active states
   and frames in the status bar.

Controller and clip edits are undoable and saved. Preview selection and running clocks are not.
Timeline removal is disabled while named clips still depend on it; remove those clips first.
The panel refuses deletion/renaming of a clip still used by a controller. Imported or manually
edited missing clip/driver references remain loadable and are reported for repair.

## Runtime contract

Controllers drive the authored node and its descendants; a descendant with its own controller
owns a separate playback scope. A state entry starts at its clip's first frame. Frames advance
at timeline fps × state speed using simulation time, independent of display refresh rate.
First matching outgoing transition wins; at most one transition occurs per step. A self-transition
restarts the clip. `finished` means the complete inclusive duration of a non-looping clip elapsed;
looping clips never fire it. A transition may set `fade` in seconds. While that fade runs, the outgoing
clip keeps advancing, the incoming clip starts at its first frame, and the displayed pose blends
from one to the other. Another rule waits until the fade finishes. Absent `fade` still switches
immediately.

2D supports moving/idle (horizontal velocity), grounded/airborne, rising/falling, enter/leave,
contact/separate, bump and won/lost. Events belong to the selected driver. The shell adapts
settled simulation facts after gameplay commands on every fixed step. 3D currently supports
moving/idle (3D speed), won/lost and clip completion; it does not infer 2D ground/contact events.
Restart, respawn and level changes create fresh players. The existing stopped/finished-world
behavior freezes simulation time and therefore freezes animations too.

Native 3D level changes now stage destination mesh/motion/material/environment libraries before
adopting the new runtime document. Stop or a superseding request invalidates pending hydration;
the author's mesh library, document history and Save path are not replaced by playback assets.

Unconfigured nodes keep their previous animation behavior, including distance-driven poses.
Configured node playheads take priority on the derived render document. Physics continues to
read authored geometry, never animated render geometry. Missing target clips cannot be entered;
a missing active clip is inert until repaired. Runtime edits to controller/clip/timeline definitions
reset the affected clock. Each component instance of a mastered controller keeps its own clock,
keyed by the expanded copy, so two placements can be in different states at the same time. The
instance node's body supplies movement and event signals when the controller does not name another
stored driver.

## 3D boundary and next work

Composed 2D visuals now sample timeline tracks and image source rectangles in the 3D renderer.
Sprite atlas crops share one uploaded texture and preserve nearest-neighbor filtering when authored.
Schema 78 additionally imports native glTF TRS tracks and four-influence skins. Choose a clip in the 3D inspector, Run to play or scrub an enabled timeline to preview. STEP, LINEAR and CUBICSPLINE sampling and two-clip pose blending are supported. CPU skinning is bounded to 100,000 vertices and 128 joints per skin. Morph weights (at most 8 targets) are applied before skinning. Skins of at most 16 joints upload a palette and deform in the vertex shader; larger skins stay on the CPU path, which is the reference for the same formula. A 3D `fade` crossfades from the previous clip when the selected clip changes during a run. This is not a complete character-animation system.

Aseprite imports now preserve the existing project frame rate and clips. Incoming frames are converted only when exact integer-frame timing is possible; incompatible timing is explicitly refused. Colliding names receive numeric suffixes. Existing tracks and controller references are unchanged, and import remains one undoable transaction.

The implementation follows the existing inclusive `Clips.ts` contract. Transition condition/at-end
behavior was checked against [Godot's animation state machine documentation](https://docs.godotengine.org/en/stable/tutorials/animation/animation_tree.html);
preview timer lifetime against [React's Effect contract](https://react.dev/reference/react/useEffect);
texture upload orientation against the [Khronos WebGL specification](https://registry.khronos.org/webgl/specs/1.0/).

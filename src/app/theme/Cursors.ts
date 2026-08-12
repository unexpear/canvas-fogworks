/**
 * @module Cursors
 * @description The pointer says which tool is in your hand.
 *
 * GENERATED — see `scripts/gen-cursors.js`. Kenney's Cursor Pack (CC0), the Outline set, whose
 * white keyline keeps a dark cursor legible over dark art and a light one over light.
 *
 * WHY THIS AND NOT A SKIN. VDE had eight tools that all showed the same arrow: the toolbar knew
 * which was active and the pointer did not, so the one place you are actually looking said nothing.
 * These are the assets whose vocabulary matches the tools exactly — brush, bucket, picker, pen,
 * pencil, spray — which is what makes this a theme rather than a costume. The dense panels, the
 * typography and the hit targets are deliberately untouched: a chunky nine-sliced game frame around
 * an inspector would read as themed and measure as worse.
 *
 * EACH HOTSPOT IS MEASURED, not centred. The alpha of every sprite was decoded and the opaque
 * extremity toward the tool's working end taken as the point — a brush whose hotspot sits in the
 * middle of the sprite paints half a cursor away from where it was aimed, which is worse than the
 * arrow it replaces.
 *
 * THE FALLBACK IS `crosshair`, not `default`: if the data URI is ever rejected, a precise tool
 * should still get a precise pointer.
 */

/** A CSS `cursor` value per tool name, as `ToolController` names them. */
export const TOOL_CURSORS: Readonly<Record<string, string>> = {
    /** `drawing_brush` — the brush's bristles, bottom-left of the sprite. */
    paint: "url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAABGdBTUEAALGPC/xhBQAAAL1QTFRFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAv7+/KysrT09P2traKioqvb29r6+vHR0dubm5e3t7Ly8vTk5OfX19ysrKmpqaenp64uLib29vj4+PHx8furq6wcHB1tbWbW1txMTEXl5enJyc7+/vz8/P39/fPz8/n5+f+fn59/f39fX18vLy5eXl7u7u5+fnuLi46enp7Ozs8PDwDw8PX19fDg4OAAAA////YDuB4wAAAA90Uk5TT49/H89vD68/n1+/L+8AluzfwwAAATNJREFUOMu109l2gjAQBmC0Ckgg1e774lItBVy6WAMz7/9YThIOEJbTq+ZCOf7fCT8TtPgfyyovXYexvt0NfJDL6QR2AG+zGwGjLjCEu/Vmu2yIHAzZAMRmuzvMr2pCA0/df7E7fP2ejU1h5fnq4fHpmfL99+LcEJbuv1rL/WX++ZMZz0LAp/5GPhHQqwDK3408xUuAkwK05IhT8ArA4L6RYwz9AgDsG3kowC9AANf1HFNgZUkPxLKWYwJBuQPvgZibuSFoDiPILsy8KuQkSczMvCIsfdRZLUd8zYsWpxmrnyP1kcYJotDTzN8HEmmI0a34IPBCRx/SsNzqG0XzUEuKlL6jOuCuFM5AitOpLGTeQhHX57YSzZLlkiLRPdxWwG2mywQebwc0FdXG552g87/5X+AIV0x3VsIJFGoAAAAASUVORK5CYII=) 1 16, crosshair",
    /** `drawing_bucket` — the pouring lip, bottom-left. */
    bucket: "url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAABGdBTUEAALGPC/xhBQAAAGNQTFRFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAj4+PT09Pr6+vHx8fb29vn5+fPz8/39/fv7+/f39/z8/PLy8vDw8P7+/vX19f////AAAAEBr1HQAAABB0Uk5Tb08PH9+vzz+PX7+ff+8vAKIxFNAAAAFGSURBVDjLlZPreoMgDEDderFa0K31hoLJ+z/lEgKCrl/3LX8qnGNzEYr2jyj+KzSXuq7eCCVyXGsKdXohNBoXs2KI2y+B+AoAE8djQFQHQXgPIb6w3gvCVy8tQ+ecxSYTPm8o3P/0iCMMnCMKSiMa4UGccqE60+4YuTfItliK0NSIywSJe4PSaCnyQ+PTl544UgLoECsWaHidO3AbX6hIuGAHG18ND3KYaSktlUXLDUXu1Z7W43fo5cwC7xr/105m6IwNlT4xCm7hLYBdMRM9RkEM7hWmrVQe5iZ4w1J1s418hhF1EsQYhozTjsqEUMeO39tMmHMj8lywmbFxErQMigpKRuJ+1AbCqKKRcRIaf1KY14HknD93JWm1au9+EJPLuByYK18WOqBsPLifxI83i0+u6azcmZd3s9KcTr253adCqSZb/wBKZV4YmoK+9QAAAABJRU5ErkJggg==) 1 25, crosshair",
    /** `drawing_picker` — the pipette's point. */
    eyedropper: "url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAABGdBTUEAALGPC/xhBQAAAJNQTFRFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA39/fb29v2traKioqHx8f1dXVVFRUjY2NWFhYdnZ2Dg4O9vb2e3t7eXl5v7+/r6+vf39/8vLyPz8/7e3tT09P6enp4ODg5OTk6OjoX19fn5+fDw8Pz8/P7+/vLy8v////AAAAJ66L0wAAABB0Uk5Tj58/T1+vbx/fL7/vf88PAAP0VR0AAAEOSURBVDjLrdPZVoMwFAVQOjCFEK2ztQXEVG0Zcv7/68wALALBvvS+nr1Y4Q7e3ZXybgPCFSF+vAxYBFkJIVvmBj7aS15qFDoBkAshmiznSJkb1EJX086FAgRcCKDMXEKBGFAAVe0Q+jcVqBaEBhEycYFbaEBRirGIRi3RgCU4W0JW/xkzizC1BN+dq150w2KWkFVLYU1zJErRia017uEdbWPaWsC39yE2os8FB50sjBF9PTzCm26UFEWf/34/7xFOVy7B/ZD/nN4QTMEwd5V/HfUjLLDqfkHnn4c5kM1QwuQfLdaztZfNeCr4i85fETnuIk5VL/fvx4Oc2MZ5OAGlGiFZL1/WhlIa3PY2/6s/dtRfJbbz6l4AAAAASUVORK5CYII=) 5 3, crosshair",
    /** `drawing_pen` — the nib. */
    pen: "url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABsklEQVRYhe3UP4rCQBQG8G9PMEdwK9vsDXKErQTBYrCxnco62NiGPUGOkL1BLiAEtNJKLAQbY6ES//FtsY6YmB3NktmFZR88SCDJ92Nm8oD/+q/bcgGEAGjoCICyBYjvhF+3tAEgAJpKSmkVcRdgG5EBILfsUkrrCCMAAD3Ps4owAhzHYZIkVrfjS8B1eBzHVEpZQWQAjuMUhgshrJ0JAmAQBCTJJEkopSwM1101ws8jdBWF20IERQjXdY2TsWqE0h+I4/iyHfpM/BRCAqAQ4lcRyW8iFADW63V2Oh12u11uNpuHEPkDnEO4jwKEfsnzPA4GAw6HQ263WyMiH15wiIMyqyD1h3u9HkejEcfjMdM0LUR8FU6SYRjq56IygAyi3+9zMplwOp1yt9tlEKZwklRKaUBYFpBBtNttzmYzzudz7vd7Y6iu3BD79pi+IBqNBheLBZfLJY/HY5nwUvtvRDSbTa5WK67Xa55Opx8Jv0G0Wi2macrD4XAv/Fv7/hCiVqvRdV0KIej7PqMoou/71+ExPn/pyusV50lp6MgU/lQBogbg+Xz9cm59/w7grYKMP1wfQUyn5eGDdvwAAAAASUVORK5CYII=) 5 4, crosshair",
    /** `drawing_pencil` — the pencil's tip — a tile brush draws one cell at a time. */
    tiles: "url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABZElEQVRYhe2W23GDMBBFTypwKSqBEiiBdEAJKcGTCjAVqAS5A9wB6UDp4OYjkSOIwARLk3z4zuiDlUb3oNVj4aGH0qoACwyAAzrAlDB6SsQMcEnE32fxC/AGvOaGcoDatpVzTtZa1XUtYKk195ilVkAAkibB8/k8+T6dTvR9Hz6fgZ5MEqBxHHVLTdNkW4lY1xQEtW2rqqquLe4rAWEAD8g5J0mqqmqSd2OMvPdFIdwSQGwepyk3RBIgNh+GQYfDQU3TFIGYANR1nTQPZiUgHKDj8ShJ8t4vmpeCeAkTdF13nXjJvBREN4fw3ssYs3Yr/g+IsHf+BCKMyX1EN0GEvlJHdBVibs7tG7POBmGtvWkeFD3twx6AJMRW87A3olXYrcV0rJmHcTkAFiHWzGf7wN0LkITYaC4+C98s2gQRmXsKVNirEKXNf0CEV3QcxyxnfxdEou2uDX6rlq+aku8Lp/if79YHNrdye04nMnQAAAAASUVORK5CYII=) 6 4, crosshair",
    /** `drawing_spray` — a soft falloff brush, which is what a weight brush is. */
    weights: "url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAABGdBTUEAALGPC/xhBQAAAIFQTFRFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAX19fhYWFj4+PdnZ2zMzMz8/P39/fb29vv7+/Ly8vT09P6Ojo+/v77+/v8fHx7u7u6urq7Ozs6enp5+fn5eXl29vb5OTk3d3d4uLi3t7e4ODg////AAAAcwFSoQAAAA50Uk5TT29/r8/fj58/Xy/vvwAHUU+3AAAA1ElEQVQ4y5XT2w6CMBBFUVQECkVuCigq3pXz/x8oGlqZdqJxP5F0NZSUceIfOaNnISX6pBQ88KCbWiCcvTanZddXpogsMH9v7IYACwDlZrv+Crr/QGiDZrNtFagQhQZw+yNWjQLNSAwgAGq93rfQYgA+6o5UQxpnKCgo1JdosKRgaQCJFQUr4xUBrAJ6mzaITXAmMeBKYsCdxIAHiQE3EgMuJAacSAw4khhwIFkgQr4fles/XwGJrB2VqbvSQADJTpcAwhw9j16Vb8+m436W5xN2utmemE9iG0cxLl0AAAAASUVORK5CYII=) 4 4, crosshair",
    /** `cross_large` — a marquee is aimed from its centre. */
    pixelSelect: "url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABYElEQVRYhe2W3XHDIBCEN2mIEpwOlA4ogRKSVKASrhQpFSQdUALu4PIQ0CAECE682Tuj8Ujmdj+B+AEeXS+ZZwrAO4A3f78C+BL6f0Q+APAJ4LtWMAHgzKUF4Trj4/D/glkp34C11rwsC2utpRBbeMarCGFDQSwBxC48llIq+NhcIQNg5xynSiCmSvg2hGk4M7O1NvY56AcAz/N8KEwgSl24G8ITj2wPTMGAiHohesLbPsQOiGHhUoih4RKIYrgxRhQetH3RNYhSOBG1zpyqtjldgmgIl6yicojR4V0QkvDXRoBfAHcAWNe12Cj67+5rhuh0nseSTrsh4aMhTsOJSLJsjwtHwzohgegKHw3RG67RMEVbIW6C8KBeiFsOQBouhTioeCTrWOGqEM656pHMIXMkEyyvRYjIK9sDJi28sLEcIBIvUyqkqNHVXW2DSC46K5zhh8P/XtlSYwjnvZ/a6Q9Do6AYhoj+WgAAAABJRU5ErkJggg==) 15 15, crosshair",
};

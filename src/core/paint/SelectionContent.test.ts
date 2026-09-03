import { createPixelBuffer, getPixel, setPixel } from "./PixelBuffer";
import { rectSelection, selectedCount } from "./Selection";
import { clearSelectionContent, copySelectionContent, moveSelectionContent,
    pasteSelectionContent, transformSelectionContent } from "./SelectionContent";

const px = (n: number): [number, number, number, number] => [n, 0, 0, 255];

test("copy is tight and clear touches only selected pixels", () => {
    const b = createPixelBuffer(4, 3);
    setPixel(b, 1, 1, px(1)); setPixel(b, 2, 1, px(2));
    const mask = rectSelection(4, 3, { x: 1, y: 1 }, { x: 2, y: 1 });
    const clip = copySelectionContent(b, mask)!;
    expect(clip).toMatchObject({ width: 2, height: 1, originX: 1, originY: 1 });
    expect(clearSelectionContent(b, mask)).toBe(2);
    expect(getPixel(b, 1, 1)).toEqual([0, 0, 0, 0]);
});

test("paste preserves mask holes and clips at the surface edge", () => {
    const source = createPixelBuffer(3, 1);
    setPixel(source, 0, 0, px(1)); setPixel(source, 2, 0, px(3));
    const mask = rectSelection(3, 1, { x: 0, y: 0 }, { x: 2, y: 0 });
    mask.data[1] = 0;
    const clip = copySelectionContent(source, mask)!;
    const target = createPixelBuffer(2, 1);
    const pasted = pasteSelectionContent(target, clip, 1, 0);
    expect(getPixel(target, 1, 0)).toEqual(px(1));
    expect(selectedCount(pasted.mask)).toBe(1);
});

test("move snapshots before clearing so overlapping moves do not smear", () => {
    const b = createPixelBuffer(4, 1);
    setPixel(b, 0, 0, px(1)); setPixel(b, 1, 0, px(2));
    const result = moveSelectionContent(b, rectSelection(4, 1, { x: 0, y: 0 }, { x: 1, y: 0 }), 1, 0)!;
    expect([getPixel(b, 0, 0), getPixel(b, 1, 0), getPixel(b, 2, 0)])
        .toEqual([[0, 0, 0, 0], px(1), px(2)]);
    expect(selectedCount(result.mask)).toBe(2);
});

test("flips and clockwise rotation transform pixels and selection together", () => {
    const horizontal = createPixelBuffer(3, 1);
    [1, 2, 3].forEach((n, x) => setPixel(horizontal, x, 0, px(n)));
    transformSelectionContent(horizontal, rectSelection(3, 1, { x: 0, y: 0 }, { x: 2, y: 0 }), "flip-horizontal");
    expect([0, 1, 2].map(x => getPixel(horizontal, x, 0))).toEqual([px(3), px(2), px(1)]);

    const rotate = createPixelBuffer(3, 3);
    setPixel(rotate, 0, 0, px(1)); setPixel(rotate, 1, 0, px(2));
    const result = transformSelectionContent(rotate,
        rectSelection(3, 3, { x: 0, y: 0 }, { x: 1, y: 0 }), "rotate-clockwise")!;
    expect(getPixel(rotate, 0, 0)).toEqual(px(1));
    expect(getPixel(rotate, 0, 1)).toEqual(px(2));
    expect(selectedCount(result.mask)).toBe(2);
});

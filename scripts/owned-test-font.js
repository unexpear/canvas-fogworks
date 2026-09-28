/**
 * @module owned-test-font
 * @description Builds an original TrueType face for package tests. The family name is a parameter, not a third-party file.
 */
function be16(value) {
    const n = value < 0 ? value + 0x10000 : value;
    return [(n >> 8) & 255, n & 255];
}
function be32(value) {
    const n = value >>> 0;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}
function i16(value) { return be16(value); }
function checksum(bytes) {
    const data = bytes.length % 4 === 0 ? bytes : bytes.concat(new Array(4 - (bytes.length % 4)).fill(0));
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
        sum = (sum + (((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]) >>> 0)) >>> 0;
    }
    return sum;
}
function utf16be(text) {
    const out = [];
    for (const char of text) out.push(...be16(char.charCodeAt(0)));
    return out;
}
function nameTable(family) {
    const names = [
        [0, "Owned test face"],
        [1, family],
        [2, "Regular"],
        [4, `${family} Regular`],
        [6, family.replace(/[^A-Za-z0-9]+/g, "") + "-Regular"]
    ];
    const strings = [], records = [];
    for (const [id, text] of names) {
        const encoded = utf16be(text);
        records.push(...be16(3), ...be16(1), ...be16(0x409), ...be16(id), ...be16(encoded.length), ...be16(strings.length));
        strings.push(...encoded);
    }
    return [...be16(0), ...be16(names.length), ...be16(6 + records.length), ...records, ...strings];
}
function ownedTestFont(family = "Owned Face") {
    if (typeof family !== "string" || !family.trim() || /[",\u0000-\u001f]/.test(family)) {
        throw new Error("Test font family must be a plain name.");
    }
    const notdef = [...i16(0), ...i16(0), ...i16(0), ...i16(0), ...i16(0), 0, 0];
    const square = [
        ...i16(1), ...i16(100), ...i16(0), ...i16(800), ...i16(700),
        ...be16(3), ...be16(0),
        1, 1, 1, 1,
        ...i16(100), ...i16(700), ...i16(0), ...i16(-700),
        ...i16(0), ...i16(0), ...i16(700), ...i16(0)
    ];
    const glyf = [...notdef, ...square];
    const loca = [...be16(0), ...be16(notdef.length / 2), ...be16(glyf.length / 2)];
    const format4 = [
        ...be16(4), ...be16(32), ...be16(0), ...be16(4), ...be16(4), ...be16(1), ...be16(0),
        ...be16(0x41), ...be16(0xffff), 0, 0,
        ...be16(0x41), ...be16(0xffff),
        ...i16(1 - 0x41), ...i16(1),
        ...be16(0), ...be16(0)
    ];
    const cmap = [...be16(0), ...be16(1), ...be16(3), ...be16(1), ...be32(12), ...format4];
    const head = [
        ...be16(1), ...be16(0), ...be32(0x00010000), ...be32(0), ...be32(0x5f0f3cf5),
        ...be16(0x000b), ...be16(1024), ...be32(0), ...be32(0), ...be32(0), ...be32(0),
        ...i16(0), ...i16(0), ...i16(800), ...i16(700),
        ...be16(0), ...be16(8), ...i16(2), ...i16(0), ...i16(0)
    ];
    const hhea = [
        ...be32(0x00010000), ...i16(800), ...i16(-200), ...i16(0), ...be16(1000),
        ...i16(0), ...i16(0), ...i16(800), ...i16(1), ...i16(0), ...i16(0),
        ...i16(0), ...i16(0), ...i16(0), ...i16(0), ...i16(0), ...be16(2)
    ];
    const hmtx = [...be16(500), ...i16(0), ...be16(1000), ...i16(100)];
    const maxp = [
        ...be32(0x00010000), ...be16(2), ...be16(4), ...be16(1), ...be16(0), ...be16(0),
        ...be16(2), ...be16(0), ...be16(0), ...be16(0), ...be16(0), ...be16(0),
        ...be16(0), ...be16(0), ...be16(0)
    ];
    const os2 = new Array(96).fill(0);
    const put16 = (at, value) => { const [a, b] = be16(value); os2[at] = a; os2[at + 1] = b; };
    put16(0, 4); put16(2, 500); put16(4, 400); put16(6, 5);
    os2[58] = 79; os2[59] = 87; os2[60] = 78; os2[61] = 82;
    put16(62, 0x40); put16(64, 0x41); put16(66, 0x41);
    put16(68, 800); put16(70, -200); put16(74, 800); put16(76, 200);
    put16(86, 500); put16(88, 700); put16(90, 0); put16(92, 32);
    const post = [...be32(0x00030000), ...be32(0), ...i16(-100), ...i16(50), ...be32(1), ...be32(0), ...be32(0), ...be32(0), ...be32(0)];
    const tables = [
        ["OS/2", os2], ["cmap", cmap], ["glyf", glyf], ["head", head], ["hhea", hhea],
        ["hmtx", hmtx], ["loca", loca], ["maxp", maxp], ["name", nameTable(family)], ["post", post]
    ].sort((a, b) => a[0] < b[0] ? -1 : 1);
    const count = tables.length;
    const searchRange = 16 * 2 ** Math.floor(Math.log2(count));
    const entrySelector = Math.floor(Math.log2(searchRange / 16));
    const rangeShift = count * 16 - searchRange;
    let offset = 12 + count * 16;
    const directory = [];
    const body = [];
    let headOffset = 0;
    for (const [tag, data] of tables) {
        if (tag === "head") headOffset = offset;
        const aligned = data.length % 4 === 0 ? data : data.concat(new Array(4 - (data.length % 4)).fill(0));
        directory.push(...[...tag].map(char => char.charCodeAt(0)), ...be32(checksum(data)), ...be32(offset), ...be32(data.length));
        body.push(...aligned);
        offset += aligned.length;
    }
    const header = [...be32(0x00010000), ...be16(count), ...be16(searchRange), ...be16(entrySelector), ...be16(rangeShift)];
    const font = [...header, ...directory, ...body];
    const adjustment = (0xb1b0afba - checksum(font)) >>> 0;
    font.splice(headOffset + 8, 4, ...be32(adjustment));
    return Uint8Array.from(font);
}
module.exports = { ownedTestFont };

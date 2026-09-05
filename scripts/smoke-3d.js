/**
 * @module smoke-3d
 * @description Proves Electron Chromium can compile the 3D viewport shader path, draw indexed
 * triangles through a depth buffer, and synchronously read the winning object-color pixel.
 */

const { app, BrowserWindow } = require("electron");
const { buildSync } = require("esbuild");

const timeout = setTimeout(() => {
    console.error("3D WebGL smoke timed out.");
    app.exit(1);
}, 15_000);

app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    try {
        await win.loadURL("data:text/html,<canvas id='c' width='32' height='32'></canvas>");
        const rendererBundle = buildSync({
            entryPoints: [require("path").resolve(__dirname, "../src/renderer/emitWebGL3D.ts")],
            bundle: true, platform: "browser", format: "iife", globalName: "Vde3D", write: false
        }).outputFiles[0].text;
        await win.webContents.executeJavaScript(`${rendererBundle}\nglobalThis.Vde3DModule = Vde3D; undefined;`);
        const result = await win.webContents.executeJavaScript(`(async () => {
            try {
            const canvas = document.getElementById("c");
            const gl = canvas.getContext("webgl", { alpha: false, depth: true, antialias: false });
            if (!gl) return { ok: false, error: "WebGL context unavailable" };
            const compile = (kind, source) => {
                const shader = gl.createShader(kind);
                gl.shaderSource(shader, source); gl.compileShader(shader);
                if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
                return shader;
            };
            const sources = Vde3DModule.webGL3DShaderSources(!!gl.getExtension("OES_standard_derivatives"));
            const productionProgram = gl.createProgram();
            gl.attachShader(productionProgram, compile(gl.VERTEX_SHADER, sources.vertex));
            gl.attachShader(productionProgram, compile(gl.FRAGMENT_SHADER, sources.fragment));
            gl.linkProgram(productionProgram);
            if (!gl.getProgramParameter(productionProgram, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(productionProgram));
            const program = gl.createProgram();
            gl.attachShader(program, compile(gl.VERTEX_SHADER,
                "attribute vec3 a_position; void main(){gl_Position=vec4(a_position,1.0);}"));
            gl.attachShader(program, compile(gl.FRAGMENT_SHADER,
                "precision mediump float; uniform vec4 u_color; void main(){gl_FragColor=u_color;}"));
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
            const position = gl.createBuffer(), index = gl.createBuffer();
            gl.useProgram(program); gl.viewport(0, 0, 32, 32);
            gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.clearDepth(1);
            gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2]), gl.STATIC_DRAW);
            const loc = gl.getAttribLocation(program, "a_position");
            gl.bindBuffer(gl.ARRAY_BUFFER, position); gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
            const color = gl.getUniformLocation(program, "u_color");
            const draw = (z, rgba) => {
                gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,z, 1,-1,z, 0,1,z]), gl.STREAM_DRAW);
                gl.uniform4fv(color, rgba); gl.drawElements(gl.TRIANGLES, 3, gl.UNSIGNED_SHORT, 0);
            };
            draw(0.5, [0, 1, 0, 1]);
            draw(0.0, [1/255, 2/255, 3/255, 1]);
            const pixel = new Uint8Array(4);
            gl.readPixels(16, 16, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
            const primitive = z => ({ positions: new Float32Array([-1,-1,z, 1,-1,z, 0,1,z]),
                normals: null, uvs: null, indices: new Uint32Array([0,1,2]), material: null });
            const drawRecord = (nodeId, z) => ({ nodeId, model: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
                primitive: primitive(z), color: [1,1,1,1], unlit: true,
                baseColorTexture: null, metallicRoughnessTexture: null,
                baseColorTextureInfo: null, metallicRoughnessTextureInfo: null,
                normalTexture: null, normalTextureInfo: null, normalScale: 1,
                emissiveTexture: null, emissiveTextureInfo: null, metallic: 0, roughness: 1,
                emissive: [0,0,0], doubleSided: false, alphaMode: "OPAQUE", alphaCutoff: 0.5 });
            const frame = { view: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
                projection: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
                draws: [drawRecord("far", 0.5), drawRecord("near", 0)], lights: [],
                cameraNodeId: null, cameraPosition: [0,0,5], worlds: new Map(),
                environment: { assetId: "smoke-hdr", image: { width: 1, height: 1,
                    rgb: new Float32Array([1.5, 0.75, 0.25]) }, intensity: 1, rotationRadians: 0 },
                shadow: { lightViewProjection: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1], direction: [0,0,-1], lightIndex: 0 } };
            const productionErrors = [];
            const productionCalls = {};
            for (const name of ["uniform1i", "uniform1f", "uniform1iv", "uniform1fv", "uniform3fv",
                "uniform4fv", "uniformMatrix3fv", "uniformMatrix4fv", "enableVertexAttribArray",
                "activeTexture", "bindTexture", "bindBuffer", "bindFramebuffer", "useProgram",
                "vertexAttribPointer", "bufferData", "drawElements"]) {
                const original = gl[name].bind(gl);
                gl[name] = (...args) => { productionCalls[name] = (productionCalls[name] || 0) + 1;
                    const value = original(...args); const code = gl.getError();
                    if (code) productionErrors.push({ name, call: productionCalls[name], code }); return value; };
            }
            const emitted = Vde3DModule.emitWebGL3D(canvas, frame, 1);
            const actualPick = Vde3DModule.pickWebGL3D(canvas, 16, 16, 1);
            const capabilities = Vde3DModule.webGL3DCapabilities(canvas);
            const lost = new Event("webglcontextlost", { cancelable: true }); canvas.dispatchEvent(lost);
            canvas.dispatchEvent(new Event("webglcontextrestored"));
            const recovered = Vde3DModule.emitWebGL3D(canvas, frame, 1);
            const reloaded = Vde3DModule.reloadWebGL3D(canvas);
            // An owned two-cell atlas proves crop sampling changes the visible GPU pixels.
            const atlas = document.createElement('canvas'); atlas.width = 2; atlas.height = 1;
            const context = atlas.getContext('2d');
            context.fillStyle = '#ff0000'; context.fillRect(0, 0, 1, 1);
            context.fillStyle = '#00ff00'; context.fillRect(1, 0, 1, 1);
            const animated = drawRecord('animated', 0);
            animated.primitive.uvs = new Float32Array([0,0, 1,0, 0.5,1]);
            animated.baseColorTexture = atlas.toDataURL();
            animated.baseColorTextureInfo = { texCoord: 0, transform: { offset: [0,0], scale: [1,1], rotation: 0 },
                sampler: { magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 } };
            const atlasFrame = { ...frame, draws: [animated], environment: null, shadow: null };
            const readCrop = async x => {
                animated.baseColorSourceRect = { x, y: 0, width: 1, height: 1 };
                let rgba = new Uint8Array(4);
                for (let attempt = 0; attempt < 40; attempt++) {
                    Vde3DModule.emitWebGL3D(canvas, atlasFrame, 1);
                    gl.readPixels(16, 16, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
                    if (x === 0 ? rgba[0] > 240 && rgba[1] < 10 : rgba[1] > 240 && rgba[0] < 10) return true;
                    await new Promise(resolve => setTimeout(resolve, 25));
                }
                throw new Error('Animated atlas crop ' + x + ' rendered ' + Array.from(rgba));
            };
            await readCrop(0); await readCrop(1);
            const glError = gl.getError();
            Vde3DModule.disposeWebGL3D(canvas);
            return { ok: emitted && recovered && reloaded && lost.defaultPrevented && capabilities.available && glError === gl.NO_ERROR,
                emitted, recovered, reloaded, contextLossPrevented: lost.defaultPrevented, capabilities, glError,
                failure: Vde3DModule.lastWebGL3DFailure(), productionErrors, productionCalls,
                width: canvas.width, height: canvas.height,
                pixel: Array.from(pixel), actualPick, depthBits: gl.getParameter(gl.DEPTH_BITS) };
            } catch (error) { return { ok: false, error: String(error), stack: error && error.stack }; }
        })()`);
        if (!result.ok || result.depthBits < 16 || result.pixel.join(",") !== "1,2,3,255" || result.actualPick !== "near") {
            throw new Error(`3D WebGL result ${JSON.stringify(result)}, expected id pixel [1,2,3,255], production pick "near", and >=16 depth bits.`);
        }
        clearTimeout(timeout);
        console.log(`3D WebGL smoke passed (${result.depthBits}-bit depth, IBL/shadow shaders, context recovery, animated atlas crops, indexed draw and picking).`);
        app.exit(0);
    } catch (error) {
        clearTimeout(timeout);
        console.error(error);
        app.exit(1);
    }
});

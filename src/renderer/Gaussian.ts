/**
 * @module Gaussian
 * @description The blur kernel the GPU backend needs, as plain numbers.
 *
 * `shadow` and `blur` are the last thing the WebGL backend cannot draw, and both are a gaussian
 * over a rendered image. The GL plumbing for that — a framebuffer, a second program, two passes —
 * is untestable without a context; the ARITHMETIC is not, and it is where being wrong is quiet.
 * So the weights live here, pure, and the backend spends them.
 *
 * SEPARABILITY IS THE WHOLE REASON THIS IS AFFORDABLE. A 2D gaussian is the outer product of two
 * 1D ones, so blurring horizontally and then vertically gives the same picture as one 2D pass at
 * `2r+1` taps instead of `(2r+1)^2`. At sigma 20 that is 121 taps against 14,641. The tests assert
 * that identity against a directly-computed 2D gaussian rather than restating the formula.
 *
 * SIGMA IS IN DEVICE PIXELS. `Shadow.blur` and `Style.blur` are world units, and the backend that
 * owns the CTM multiplies by `z·dpr` before asking for a kernel — the same rule, and the same one
 * arithmetic exception, that `emitCanvas` follows for `shadow*`/`ctx.filter`.
 *
 * THE WEIGHTS ARE NORMALISED AFTER TRUNCATION, not before. A kernel cut at 3 sigma keeps 99.73% of
 * the curve, and spending 0.9973 of the light is a blur that DARKENS what it touches — subtly, and
 * more the wider it gets, which reads as a shadow that is too weak rather than a kernel that is too
 * short.
 */

/**
 * The widest kernel this will build, in taps per side.
 *
 * 64 taps covers sigma 21.33 at the 3-sigma rule, and **THAT IS NOT ENOUGH** — a claim in an
 * earlier version of this comment said it was past anything a design file plausibly asks for at
 * 1:1, which measuring proved false. Device sigma is `blur * zoom * dpr`, so:
 *
 *     world blur 20, zoom 1, dpr 2  ->  sigma  40, wants 120 taps    CLAMPED
 *     world blur 40, zoom 1, dpr 1  ->  sigma  40, wants 120 taps    CLAMPED
 *     world blur 20, zoom 4, dpr 2  ->  sigma 160, wants 480 taps    CLAMPED
 *
 * A 20px blur at 1:1 on any Retina display is already past it. WORSE, the clamp is a collapse
 * rather than a taper: the effective sigma pins at ~21.3 whatever was asked, so a 40px blur and a
 * 160px blur come out IDENTICAL, and both far sharper than SVG and Canvas draw the same document.
 * That is the same shape of fault as the half-soft canvas shadow — it looks like a crisper render.
 *
 *     sigma  32 -> the kernel covers 95.4% of the curve
 *     sigma  64 -> 68.3%
 *     sigma 160 -> 31.1%
 *
 * RAISING THIS IS NOT THE FIX. The shader's loop bound is a compile-time constant, so radius 480
 * means 961 texture fetches per fragment per pass. The standard answer is to DOWNSAMPLE: render the
 * target at half or quarter resolution and blur there, since halving the resolution halves the
 * sigma needed. That is both correct and faster, and it is the work this constant is waiting on.
 *
 * Until then `clamped` is reported so a caller can at least know the blur it got is not the blur it
 * asked for.
 */
export const GAUSSIAN_MAX_RADIUS = 64;

/** The truncation point, in sigmas. 3 keeps 99.73% of the curve. */
export const GAUSSIAN_SIGMA_CUTOFF = 3;

/** The largest sigma one full-resolution pass can express without clamping. */
export const GAUSSIAN_MAX_SIGMA = GAUSSIAN_MAX_RADIUS / GAUSSIAN_SIGMA_CUTOFF;

/**
 * How far down to halve before blurring. 4 is a sixteenth in each axis.
 *
 * Bounded because each level costs a resample pass and loses detail the upsample cannot invent.
 * At the cap this expresses sigma 341 — `GAUSSIAN_MAX_SIGMA * 2^4` — which is a blur wider than
 * any canvas it could be drawn on.
 */
export const GAUSSIAN_MAX_DOWNSAMPLE = 4;

/** Where to do the work, and with what sigma once you are there. */
export interface BlurPlan {
    /** Halvings of resolution before blurring. 0 means blur at full size. */
    levels: number;
    /** The sigma to use AT that resolution — the original divided by `2^levels`. */
    sigma: number;
    /** True when even the smallest allowed resolution cannot express the blur asked for. */
    clamped: boolean;
}

/**
 * Where a blur of `sigma` device pixels should actually be computed.
 *
 * A KERNEL CANNOT GROW WITHOUT BOUND, so a wide blur is done small instead. Halving the resolution
 * halves the sigma needed, and a gaussian is scale-covariant — blurring a half-size image by
 * sigma/2 and stretching the result back is the same picture as blurring the full image by sigma,
 * to within the resample. That is why this is the standard answer rather than a shortcut: it is
 * both correct and cheaper, since the expensive pass runs over a quarter of the pixels per level.
 *
 * WITHOUT IT THE CLAMP IS A COLLAPSE. `gaussianKernel` alone pins the effective sigma at
 * `GAUSSIAN_MAX_SIGMA`, so a blur of 40 and a blur of 160 come out identical — and both far
 * sharper than the other two backends draw the same document. A 20px blur at 1:1 on a Retina
 * display already reaches that, which is an ordinary design file rather than an extreme one.
 */
export function blurPlan(sigma: number): BlurPlan {
    if (!Number.isFinite(sigma) || sigma <= 0) return { levels: 0, sigma: 0, clamped: false };
    let levels = 0;
    let s = sigma;
    // HALVE UNTIL IT FITS. `Math.log2` would give the same answer in one step, but the loop is what
    // the caller has to perform anyway — one resample per level — so counting them is the honest
    // shape and cannot disagree with what the GL side does.
    while (s > GAUSSIAN_MAX_SIGMA && levels < GAUSSIAN_MAX_DOWNSAMPLE) {
        s /= 2;
        levels++;
    }
    return { levels, sigma: s, clamped: s > GAUSSIAN_MAX_SIGMA };
}

/** A 1D kernel, to be applied once per axis. */
export interface GaussianKernel {
    /** Taps per side. 0 means no blur at all — `weights` is then `[1]`. */
    radius: number;
    /**
     * `2 * radius + 1` weights, symmetric about the centre and summing to 1.
     *
     * The FULL span rather than the half a symmetric kernel could get away with: the shader walks
     * it straight, and folding it would put the mirroring in the one place that cannot be tested
     * without a GL context.
     */
    weights: number[];
    /** True when `radius` hit `GAUSSIAN_MAX_RADIUS` and the curve was cut early. */
    clamped: boolean;
}

/**
 * The kernel for one axis at `sigma` device pixels.
 *
 * A sigma of zero or less is not an error — it is a shape with no blur — and yields the identity
 * kernel, so a caller has one code path rather than a branch that can disagree with itself.
 */
export function gaussianKernel(sigma: number): GaussianKernel {
    if (!Number.isFinite(sigma) || sigma <= 0) {
        return { radius: 0, weights: [1], clamped: false };
    }
    const wanted = Math.ceil(sigma * GAUSSIAN_SIGMA_CUTOFF);
    const radius = Math.min(wanted, GAUSSIAN_MAX_RADIUS);
    const weights: number[] = [];
    let total = 0;
    // The leading 1/(sigma*sqrt(2*pi)) is deliberately absent: it cancels in the normalisation
    // below, and carrying it would be a constant multiplied in and then divided out.
    const denominator = 2 * sigma * sigma;
    for (let i = -radius; i <= radius; i++) {
        const w = Math.exp(-(i * i) / denominator);
        weights.push(w);
        total += w;
    }
    for (let i = 0; i < weights.length; i++) weights[i] /= total;
    return { radius, weights, clamped: wanted > GAUSSIAN_MAX_RADIUS };
}

/**
 * The 2D kernel a single-pass blur would use, as the outer product of two 1D ones.
 *
 * NOT used to draw — it exists so the separable pair can be checked against the thing it claims to
 * equal. A separable blur that is subtly wrong still looks like a blur, so the identity has to be
 * asserted rather than assumed.
 */
export function gaussianOuterProduct(kernel: GaussianKernel): number[][] {
    const n = kernel.weights.length;
    const out: number[][] = [];
    for (let y = 0; y < n; y++) {
        const row: number[] = [];
        for (let x = 0; x < n; x++) row.push(kernel.weights[y] * kernel.weights[x]);
        out.push(row);
    }
    return out;
}

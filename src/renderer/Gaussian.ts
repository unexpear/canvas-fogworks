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
 * A sigma large enough to need more than this is clamped, and the blur comes out slightly tighter
 * than asked rather than costing 500 texture fetches per fragment. 64 covers sigma 21 exactly at
 * the 3-sigma rule, which is past anything a design file plausibly asks for at 1:1 — but zoom
 * multiplies sigma, so the clamp is reachable by zooming in far enough and must not be a cliff.
 */
export const GAUSSIAN_MAX_RADIUS = 64;

/** The truncation point, in sigmas. 3 keeps 99.73% of the curve. */
export const GAUSSIAN_SIGMA_CUTOFF = 3;

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

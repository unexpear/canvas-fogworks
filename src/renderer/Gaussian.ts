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

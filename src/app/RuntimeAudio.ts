/**
 * @module RuntimeAudio
 * @description User-unlocked Web Audio playback with bounded voices, decode reuse and cancellation across runtime stops.
 */
import { SoundRequest } from "../core/runtime/GameplaySession";
export class RuntimeAudio {
    private context: AudioContext | null = null;
    private buffers = new Map<string, Promise<AudioBuffer>>();
    private voices = new Set<AudioBufferSourceNode>();
    private epoch = 0;
    private unlocking: Promise<void> = Promise.resolve();
    constructor(private readonly report: (message: string) => void) {}
    unlock(): Promise<void> {
        try {
            this.context ??= new AudioContext();
            this.unlocking = this.context.resume().catch(error => this.report(`Audio unavailable: ${error.message}`));
        } catch (error) { this.report(`Audio unavailable: ${String(error)}`); }
        return this.unlocking;
    }
    async play(sound: SoundRequest): Promise<void> {
        const context = this.context, epoch = this.epoch;
        await this.unlocking;
        if (this.epoch !== epoch) return;
        if (!context || context.state !== "running") { this.report("Click Run to enable audio playback."); return; }
        try {
            let pending = this.buffers.get(sound.source);
            if (!pending) {
                if (this.buffers.size >= 32) this.buffers.delete(this.buffers.keys().next().value!);
                const raw = atob(sound.source.slice(sound.source.indexOf(",") + 1));
                pending = context.decodeAudioData(Uint8Array.from(raw, char => char.charCodeAt(0)).buffer).then(buffer => {
                    if (buffer.length * buffer.numberOfChannels * 4 > 32 * 1024 * 1024) throw new Error("Decoded sound exceeds 32MB.");
                    return buffer;
                });
                this.buffers.set(sound.source, pending);
            }
            const buffer = await pending;
            if (this.epoch !== epoch) return;
            if (this.voices.size >= 32) { this.report("Audio voice limit reached (32)."); return; }
            const source = context.createBufferSource(), gain = context.createGain();
            source.buffer = buffer; gain.gain.value = sound.volume;
            source.connect(gain); gain.connect(context.destination); this.voices.add(source);
            source.onended = () => { this.voices.delete(source); source.disconnect(); gain.disconnect(); };
            source.start();
        } catch (error) { this.report(`Audio playback failed: ${String(error)}`); }
    }
    stop(): void { this.epoch++; for (const voice of this.voices) voice.stop(); this.voices.clear(); }
    dispose(): void { this.stop(); this.buffers.clear(); void this.context?.close(); this.context = null; }
}

import { AudioFrame } from "@livekit/rtc-node";

const CHANNELS = 1;
const BLOCK_MS = 100;
/** How far ahead of real time the silence may run. */
const LEAD_MS = 200;

/**
 * Endless silence that keeps the background mixer alive (the mixer stops for good once its last
 * stream ends). Paced to the wall clock: unpaced, it fills the audio source's 400 ms queue, and
 * every filler then plays behind that backlog.
 */
export function silentAmbience(sampleRate: number): AsyncIterable<AudioFrame> {
  const samples = Math.round((sampleRate * BLOCK_MS) / 1000);

  return {
    async *[Symbol.asyncIterator]() {
      const start = Date.now();
      for (let n = 0; ; n++) {
        const wait = start + n * BLOCK_MS - LEAD_MS - Date.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        yield new AudioFrame(new Int16Array(samples * CHANNELS), sampleRate, CHANNELS, samples);
      }
    },
  };
}

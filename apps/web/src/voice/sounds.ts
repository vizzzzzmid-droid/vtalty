let context: AudioContext | null = null;

function audio(): AudioContext {
  if (context === null) {
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctor === undefined) {
      throw new Error("WebAudio is not supported");
    }
    context = new Ctor();
  }
  if (context.state === "suspended") {
    void context.resume();
  }
  return context;
}

interface ToneOptions {
  frequency: number;
  endFrequency?: number;
  durationSeconds: number;
  type?: OscillatorType;
  gain?: number;
  when?: number;
}

/** Original UI tones generated with WebAudio (no third-party assets). */
function tone({ frequency, endFrequency, durationSeconds, type, gain, when }: ToneOptions): void {
  try {
    const ctx = audio();
    const start = ctx.currentTime + (when ?? 0);
    const oscillator = ctx.createOscillator();
    const envelope = ctx.createGain();
    oscillator.type = type ?? "sine";
    oscillator.frequency.setValueAtTime(frequency, start);
    if (endFrequency !== undefined) {
      oscillator.frequency.exponentialRampToValueAtTime(endFrequency, start + durationSeconds);
    }
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(gain ?? 0.15, start + 0.02);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + durationSeconds);
    oscillator.connect(envelope);
    envelope.connect(ctx.destination);
    oscillator.start(start);
    oscillator.stop(start + durationSeconds + 0.05);
  } catch {
    // Audio unavailable (or blocked): UI sounds are best-effort.
  }
}

export const voiceSounds = {
  join() {
    tone({ frequency: 440, endFrequency: 660, durationSeconds: 0.12 });
  },
  leave() {
    tone({ frequency: 660, endFrequency: 440, durationSeconds: 0.12 });
  },
  mute() {
    tone({ frequency: 330, durationSeconds: 0.07, type: "square", gain: 0.06 });
  },
  unmute() {
    tone({ frequency: 520, durationSeconds: 0.07, type: "square", gain: 0.06 });
  },
  deafen() {
    tone({ frequency: 300, endFrequency: 180, durationSeconds: 0.16 });
  },
  undeafen() {
    tone({ frequency: 180, endFrequency: 300, durationSeconds: 0.16 });
  },
};

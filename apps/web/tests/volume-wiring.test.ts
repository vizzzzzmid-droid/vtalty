// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  attachRemoteAudio,
  remoteAudioContainer,
  setRemoteAudioVolume,
  type AttachableAudioTrack,
} from "../src/voice/remoteAudio.js";

/**
 * End-to-end wiring check for the per-user listen volume: the slider calls
 * setRemoteAudioVolume(identity, v), which must reach the hidden <audio>
 * element carrying that participant's mic track and set element.volume.
 */

function fakeTrack(): AttachableAudioTrack {
  const attached: HTMLMediaElement[] = [];
  return {
    attachedElements: attached,
    attach: () => {
      const element = document.createElement("audio");
      element.srcObject = new MediaStream();
      attached.push(element);
      return element;
    },
    detach: (element?: HTMLMediaElement) => element ?? [],
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("setRemoteAudioVolume end-to-end", () => {
  it("drives element.volume for the matching identity only", () => {
    const track = fakeTrack();
    const element = attachRemoteAudio(track, "user-1");
    expect(element).not.toBeNull();
    expect(remoteAudioContainer().contains(element)).toBe(true);

    setRemoteAudioVolume("user-1", 0);
    expect(element?.volume).toBe(0);
    setRemoteAudioVolume("user-1", 0.42);
    expect(element?.volume).toBeCloseTo(0.42);

    // Unknown identities must not touch the element.
    setRemoteAudioVolume("someone-else", 0);
    expect(element?.volume).toBeCloseTo(0.42);
  });
});

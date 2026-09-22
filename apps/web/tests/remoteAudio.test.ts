// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  attachRemoteAudio,
  clearRemoteAudio,
  detachRemoteAudio,
  detachRemoteAudioFor,
  remoteAudioContainer,
  remoteAudioCount,
  type AttachableAudioTrack,
} from "../src/voice/remoteAudio.js";

/**
 * Regression test for "no audible remote audio": subscribed mic tracks
 * must end up attached to a real <audio> element in the document (with a
 * live srcObject), and unsubscribe/leave must clean up.
 */

function fakeTrack(): AttachableAudioTrack & { attached: HTMLMediaElement[] } {
  const attached: HTMLMediaElement[] = [];
  return {
    attachedElements: attached,
    attach: () => {
      const element = document.createElement("audio");
      element.srcObject = new MediaStream();
      attached.push(element);
      return element;
    },
    detach: (element?: HTMLMediaElement) => {
      if (element === undefined) {
        const all = [...attached];
        attached.length = 0;
        return all;
      }
      const index = attached.indexOf(element);
      if (index >= 0) {
        attached.splice(index, 1);
      }
      return element;
    },
    attached,
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("remoteAudioContainer", () => {
  it("creates one hidden, aria-hidden container", () => {
    const first = remoteAudioContainer();
    const second = remoteAudioContainer();
    expect(first).toBe(second);
    expect(first.id).toBe("vitality-remote-audio");
    expect(first.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelectorAll("audio").length).toBe(0);
  });
});

describe("attachRemoteAudio", () => {
  it("mounts an <audio> with a live srcObject in the DOM", () => {
    const track = fakeTrack();
    const element = attachRemoteAudio(track, "user-a");
    expect(element).toBeInstanceOf(HTMLAudioElement);
    expect(document.querySelectorAll("audio").length).toBe(1);
    expect(element?.srcObject).toBeInstanceOf(MediaStream);
    expect(element?.dataset["identity"]).toBe("user-a");
    expect(remoteAudioCount()).toBe(1);
  });

  it("is idempotent for the same track", () => {
    const track = fakeTrack();
    const first = attachRemoteAudio(track, "user-a");
    const second = attachRemoteAudio(track, "user-a");
    expect(first).toBe(second);
    expect(document.querySelectorAll("audio").length).toBe(1);
  });

  it("keeps separate elements per publisher", () => {
    attachRemoteAudio(fakeTrack(), "user-a");
    attachRemoteAudio(fakeTrack(), "user-b");
    expect(remoteAudioCount()).toBe(2);
  });
});

describe("detachRemoteAudio", () => {
  it("removes only that track's elements", () => {
    const trackA = fakeTrack();
    const trackB = fakeTrack();
    attachRemoteAudio(trackA, "user-a");
    attachRemoteAudio(trackB, "user-b");
    detachRemoteAudio(trackA);
    expect(remoteAudioCount()).toBe(1);
    expect(trackA.attachedElements.length).toBe(0);
    expect(trackB.attachedElements.length).toBe(1);
  });
});

describe("detachRemoteAudioFor", () => {
  it("drops a leaver's elements without touching others", () => {
    attachRemoteAudio(fakeTrack(), "user-a");
    attachRemoteAudio(fakeTrack(), "user-b");
    detachRemoteAudioFor("user-a");
    expect(remoteAudioCount()).toBe(1);
    const remaining = document.querySelector("audio");
    expect(remaining?.dataset["identity"]).toBe("user-b");
  });
});

describe("clearRemoteAudio", () => {
  it("drops the whole sink", () => {
    attachRemoteAudio(fakeTrack(), "user-a");
    clearRemoteAudio();
    expect(document.querySelectorAll("audio").length).toBe(0);
    expect(document.getElementById("vitality-remote-audio")).toBeNull();
  });
});

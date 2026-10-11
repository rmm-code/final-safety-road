import { describe, expect, it, vi } from "vitest";
import type { Map as MapLibreMap, Marker } from "maplibre-gl";
import type { LocatedVideo } from "@/features/videos/lib/video-api";
import { syncVideoMarkers } from "./video-markers";

// Records what the markers are told; the real library needs WebGL.
vi.mock("maplibre-gl", () => {
  class Popup {
    content: HTMLElement | null = null;
    open = false;
    setDOMContent(node: HTMLElement) {
      this.content = node;
      return this;
    }
    isOpen() {
      return this.open;
    }
  }
  class Marker {
    private readonly element: HTMLElement;
    private at: [number, number] = [0, 0];
    private popup: Popup | null = null;
    constructor(options: { element: HTMLElement }) {
      this.element = options.element;
    }
    setLngLat(at: [number, number]) {
      this.at = at;
      return this;
    }
    getLngLat() {
      return { lng: this.at[0], lat: this.at[1] };
    }
    setPopup(popup: Popup) {
      this.popup = popup;
      return this;
    }
    getPopup() {
      return this.popup;
    }
    getElement() {
      return this.element;
    }
    addTo() {
      return this;
    }
    remove() {
      return this;
    }
  }
  return { Marker, Popup };
});

const map = {} as MapLibreMap;

const video = (changes: Partial<LocatedVideo> = {}): LocatedVideo => ({
  id: "video-a",
  title: "Video 2",
  latitude: 41.3,
  longitude: 69.2,
  accuracyM: 100,
  label: null,
  potholeCount: 2,
  posterUrl: null,
  thumbnails: ["http://storage/crop.jpg?signature=first"],
  ...changes,
});

type FakePopup = { content: HTMLElement; open: boolean };

function photos(marker: Marker): string[] {
  const content = (marker.getPopup() as unknown as FakePopup).content;
  return Array.from(content.querySelectorAll("img"), (image) => image.src);
}

describe("video markers on the map", () => {
  it("move when the video is placed somewhere else", () => {
    const markers = new Map<string, Marker>();
    syncVideoMarkers(map, [video()], markers);
    const marker = markers.get("video-a")!;

    syncVideoMarkers(map, [video({ latitude: 41.31, longitude: 69.25 })], markers);

    expect(markers.get("video-a")).toBe(marker);
    expect(marker.getLngLat()).toEqual({ lng: 69.25, lat: 41.31 });
  });

  it("refresh their popup photos, whose presigned links expire", () => {
    const markers = new Map<string, Marker>();
    syncVideoMarkers(map, [video()], markers);

    syncVideoMarkers(map, [video({ thumbnails: ["http://storage/crop.jpg?signature=second"] })], markers);

    expect(photos(markers.get("video-a")!)).toEqual(["http://storage/crop.jpg?signature=second"]);
  });

  it("leave an open popup alone: replacing its content pulls focus into it on every pan", () => {
    const markers = new Map<string, Marker>();
    syncVideoMarkers(map, [video()], markers);
    (markers.get("video-a")!.getPopup() as unknown as FakePopup).open = true;

    syncVideoMarkers(map, [video({ thumbnails: ["http://storage/crop.jpg?signature=second"] })], markers);

    expect(photos(markers.get("video-a")!)).toEqual(["http://storage/crop.jpg?signature=first"]);
  });

  it("show the current pothole count", () => {
    const markers = new Map<string, Marker>();
    syncVideoMarkers(map, [video()], markers);

    syncVideoMarkers(map, [video({ potholeCount: 5 })], markers);

    const element = markers.get("video-a")!.getElement();
    expect(element).toHaveAccessibleName("Video 2: 5 potholes found here");
    expect(element).toHaveTextContent("5");
  });
});

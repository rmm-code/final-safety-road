"use client";

import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { LocatedVideo } from "@/features/videos/lib/video-api";

/**
 * Videos placed on the map, as their own markers.
 *
 * A placed video is not a pothole: a person put a pin on the road it was filmed on, within
 * the accuracy they gave. So it is drawn as a video, not as potholes with invented
 * positions, and its popup shows what the video found and links to its dashboard.
 */
export function syncVideoMarkers(
  map: MapLibreMap,
  videos: LocatedVideo[],
  markers: Map<string, maplibregl.Marker>,
): void {
  const wanted = new Set(videos.map((video) => video.id));
  for (const [id, marker] of markers) {
    if (!wanted.has(id)) {
      marker.remove();
      markers.delete(id);
    }
  }
  for (const video of videos) {
    const at: [number, number] = [video.longitude, video.latitude];
    const existing = markers.get(video.id);
    if (existing) {
      // The video may have moved, and its photo links are signed afresh on every read. An
      // open popup keeps its loaded photos: setDOMContent would pull focus into it on each pan.
      existing.setLngLat(at);
      labelMarker(existing.getElement(), video);
      const popup = existing.getPopup();
      if (!popup.isOpen()) popup.setDOMContent(popupContent(video));
      continue;
    }
    const marker = new maplibregl.Marker({ element: markerElement(video) })
      .setLngLat(at)
      .setPopup(new maplibregl.Popup({ offset: 18, maxWidth: "280px" }).setDOMContent(popupContent(video)))
      .addTo(map);
    markers.set(video.id, marker);
  }
}

function markerElement(video: LocatedVideo): HTMLElement {
  const element = document.createElement("button");
  element.type = "button";
  element.style.cssText =
    "position:relative;display:grid;place-items:center;width:32px;height:32px;border-radius:9px;background:#292929;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.25);cursor:pointer;padding:0";
  element.innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 13 5.2 3.5a.5.5 0 0 0 .8-.4V7.9a.5.5 0 0 0-.8-.4L16 11"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>';
  const count = document.createElement("span");
  count.style.cssText =
    "position:absolute;top:-8px;right:-8px;min-width:18px;height:18px;padding:0 4px;border-radius:9px;background:#db7979;color:#fff;font:600 11px/18px Inter,sans-serif;text-align:center;border:1.5px solid #fff";
  element.appendChild(count);
  labelMarker(element, video);
  return element;
}

/** Updated in place: MapLibre binds the popup to this element, so it is never replaced. */
function labelMarker(element: HTMLElement, video: LocatedVideo): void {
  element.setAttribute("aria-label", `${video.title}: ${video.potholeCount} potholes found here`);
  const count = element.querySelector("span");
  if (count) count.textContent = String(video.potholeCount);
}

function popupContent(video: LocatedVideo): HTMLElement {
  const root = document.createElement("div");
  root.style.cssText = "font-family:Inter,sans-serif;color:#252525;min-width:220px";
  const title = document.createElement("div");
  title.textContent = video.title;
  title.style.cssText = "font-weight:600;font-size:14px";
  const meta = document.createElement("div");
  meta.textContent = `${video.potholeCount} ${video.potholeCount === 1 ? "pothole" : "potholes"} · placed by hand, within ${video.accuracyM} m`;
  meta.style.cssText = "font-size:12px;color:#737373;margin-top:2px";
  root.append(title, meta);
  if (video.label) {
    const label = document.createElement("div");
    label.textContent = video.label;
    label.style.cssText = "font-size:12px;color:#515151;margin-top:2px";
    root.append(label);
  }
  if (video.thumbnails.length > 0) {
    const strip = document.createElement("div");
    strip.style.cssText = "display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-top:8px";
    for (const url of video.thumbnails.slice(0, 4)) {
      const image = document.createElement("img");
      image.src = url;
      image.alt = "Pothole photo";
      image.crossOrigin = "anonymous";
      image.style.cssText = "width:100%;aspect-ratio:1;object-fit:cover;border-radius:5px;background:#2c2c2c";
      strip.append(image);
    }
    root.append(strip);
  }
  const link = document.createElement("a");
  link.href = `/videos/${video.id}`;
  link.textContent = "Open the video →";
  link.style.cssText = "display:inline-block;margin-top:8px;font-size:12.5px;font-weight:500;color:#252525";
  root.append(link);
  return root;
}

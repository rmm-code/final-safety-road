/*
 * Keeps the detector on the phone.
 *
 * The model is ~50 MB and the ONNX Runtime binaries are tens more. Without this the drive
 * page downloads all of it again whenever the browser drops its HTTP cache, which on a
 * phone is often - and on mobile data, in a car, that is the difference between a drive
 * that starts and one that does not.
 *
 * Deliberately narrow: only /models/ and /ort/ are touched. Every other request - pages,
 * the API, map tiles - goes to the network exactly as if this file did not exist.
 *
 *   *.onnx            cache first. The file name carries the model version, and a new
 *                     model ships under a new name, so a cached copy is never stale.
 *   everything else   network first, cache as the offline fallback. model.json and the
 *                     runtime files keep their names across versions; serving a stale
 *                     runtime against a newer bundle would break the detector outright.
 *                     Online, the HTTP cache makes the network check a cheap 304.
 */
const CACHE = "pothole-detector-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name.startsWith("pothole-detector-") && name !== CACHE).map((name) => caches.delete(name))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith("/models/") && !url.pathname.startsWith("/ort/")) return;

  event.respondWith(url.pathname.endsWith(".onnx") ? cacheFirst(request) : networkFirst(request));
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

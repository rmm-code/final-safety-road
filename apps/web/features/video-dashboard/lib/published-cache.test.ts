import { describe, expect, it } from "vitest";
import { PublishedCache } from "./published-cache";

type Entry = { saved: boolean; name: string };
const published: Entry = { saved: true, name: "published" };
const local: Entry = { saved: false, name: "analysed in this browser" };

function clock() {
  let time = 0;
  return { now: () => time, advance: (ms: number) => (time += ms) };
}

describe("the published analyses a tab keeps", () => {
  it("serves an entry until it reaches its max age, then loads it again", () => {
    const time = clock();
    const cache = new PublishedCache<Entry>({ maxAgeMs: 1000, now: time.now });
    cache.set("video-2", published);

    time.advance(999);
    expect(cache.get("video-2")).toBe(published);
    time.advance(1);
    expect(cache.get("video-2")).toBeNull();
  });

  it("forgets an entry long before its presigned links expire, 6 hours after signing", () => {
    const time = clock();
    const cache = new PublishedCache<Entry>({ now: time.now });
    cache.set("video-2", published);

    time.advance(60 * 60_000);
    expect(cache.get("video-2")).toBeNull();
  });

  it("never keeps a result analysed in this browser, which would hide the published one", () => {
    const cache = new PublishedCache<Entry>();
    cache.set("video-2", local);

    expect(cache.get("video-2")).toBeNull();
  });
});

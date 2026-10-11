import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, formatBbox, getToken, setToken } from "./api-client";

const BBOX = { minLng: 69.2, minLat: 41.3, maxLng: 69.3, maxLat: 41.35 };

function respond(status: number, body: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

beforeEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("bbox formatting", () => {
  it("orders the corners the way the API expects", () => {
    expect(formatBbox(BBOX)).toBe("69.200000,41.300000,69.300000,41.350000");
  });
});

describe("authentication", () => {
  it("stores the token after a successful login", async () => {
    vi.stubGlobal("fetch", respond(200, { access_token: "token-123" }));
    const client = createApiClient("http://api.test");
    await client.login("driver@example.com", "correct-horse");
    expect(getToken()).toBe("token-123");
  });

  it("sends the token on subsequent requests", async () => {
    const fetchMock = respond(200, []);
    vi.stubGlobal("fetch", fetchMock);
    setToken("token-123");

    await createApiClient("http://api.test").potholes({ bbox: BBOX });

    const init = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer token-123");
  });

  it("clears the token on sign-out", () => {
    setToken("token-123");
    setToken(null);
    expect(getToken()).toBeNull();
  });
});

describe("error handling", () => {
  it("surfaces the API's own message", async () => {
    vi.stubGlobal("fetch", respond(422, { detail: "bbox may span at most 5 degrees; zoom in" }));
    await expect(createApiClient("http://api.test").potholes({ bbox: BBOX })).rejects.toThrow(
      /at most 5 degrees/,
    );
  });

  it("carries the status code so callers can react to 401", async () => {
    vi.stubGlobal("fetch", respond(401, { detail: "Authentication required" }));
    await expect(createApiClient("http://api.test").stats()).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
    });
  });

  it("degrades gracefully when the error body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>502</html>", { status: 502 })) as unknown as typeof fetch,
    );
    await expect(createApiClient("http://api.test").stats()).rejects.toBeInstanceOf(ApiError);
  });
});

describe("queries", () => {
  it("passes filters through to the API", async () => {
    const fetchMock = respond(200, []);
    vi.stubGlobal("fetch", fetchMock);

    await createApiClient("http://api.test").potholes({
      bbox: BBOX,
      severity: ["large", "medium"],
      status: ["active"],
      minSightings: 3,
    });

    const url = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toContain("severity=large%2Cmedium");
    expect(url).toContain("status=active");
    expect(url).toContain("min_sightings=3");
  });

  it("trims a trailing slash from the base URL", async () => {
    const fetchMock = respond(200, {});
    vi.stubGlobal("fetch", fetchMock);
    await createApiClient("http://api.test/").stats();
    expect((fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(
      "http://api.test/api/v1/stats/overview",
    );
  });
});

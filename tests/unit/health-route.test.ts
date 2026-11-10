import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryRaw } = vi.hoisted(() => ({ queryRaw: vi.fn() }));

vi.mock("@/lib/prisma", () => ({ prisma: { $queryRaw: queryRaw } }));

import { GET } from "@/app/api/health/route";

describe("GET /api/health", () => {
  beforeEach(() => queryRaw.mockReset());

  it("returns 200 when the database answers", async () => {
    queryRaw.mockResolvedValueOnce([{ "?column?": 1 }]);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: "ok", checks: { database: "up" } });
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
    expect(body.timestamp).toEqual(expect.any(String));
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 503 without leaking connection details when the database fails", async () => {
    queryRaw.mockRejectedValueOnce(
      new Error("connect failed: postgresql://user:secret@host/db")
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({ status: "error", checks: { database: "down" } });
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls[0])).not.toContain("secret");
  });
});

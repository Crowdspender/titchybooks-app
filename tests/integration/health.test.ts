import { afterAll, describe, expect, it } from "vitest";
import { GET } from "@/app/api/health/route";
import { prisma } from "@/lib/prisma";

describe("GET /api/health against the test database", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("reports the database as reachable", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: "ok", checks: { database: "up" } });
  });
});

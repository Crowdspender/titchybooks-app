import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    auth: vi.fn(),
    findFirst: vi.fn(),
    notFound: vi.fn(() => {
        throw new Error("NEXT_NOT_FOUND");
    }),
    redirect: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/prisma", () => ({
    prisma: { submission: { findFirst: mocks.findFirst } },
}));
vi.mock("next/navigation", () => ({
    notFound: mocks.notFound,
    redirect: mocks.redirect,
}));
vi.mock("@/components/create/UploadGrid", () => ({ default: () => null }));

import UploadPage from "@/app/(protected)/create/upload/page";

const page = (replaces?: string | string[]) =>
    UploadPage({ searchParams: Promise.resolve({ replaces }) });

beforeEach(() => {
    mocks.auth.mockResolvedValue({ user: { id: "owner", role: "USER" } });
    mocks.findFirst.mockResolvedValue({ title: "Original", rejectionReason: "Fix the cover." });
});

it("rejects repeated replaces parameters before querying Prisma", async () => {
    await expect(page(["first", "second"])).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.findFirst).not.toHaveBeenCalled();
});

it("rejects an empty replaces parameter before querying Prisma", async () => {
    await expect(page("")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.findFirst).not.toHaveBeenCalled();
});

it("looks up a single nonempty replaces id within the owner's rejected uploads", async () => {
    const result = await page("original-id");
    expect(result).toBeTruthy();
    expect(mocks.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
            where: expect.objectContaining({ id: "original-id", userId: "owner", status: "REJECTED" }),
        }),
    );
    expect(mocks.notFound).not.toHaveBeenCalled();
});

it("keeps the regular upload view when the parameter is absent", async () => {
    const result = await page(undefined);
    expect(result).toBeTruthy();
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.notFound).not.toHaveBeenCalled();
});

it("still returns not found for a single id the owner cannot replace", async () => {
    mocks.findFirst.mockResolvedValue(null);
    await expect(page("foreign-id")).rejects.toThrow("NEXT_NOT_FOUND");
});
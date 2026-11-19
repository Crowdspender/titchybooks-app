// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
} from "@testing-library/react";
import MyVaultPage from "@/app/(protected)/dashboard/vault/page";
import VaultDirectoryPage from "@/app/vault/page";
import VaultConsentToggle from "@/components/dashboard/VaultConsentToggle";

const mocks = vi.hoisted(() => ({
    auth: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    refresh: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock(
    "@/lib/prisma",
    () => ({
        prisma: {
            vaultEntry: { findMany: mocks.findMany, count: mocks.count },
        },
    }),
);
vi.mock(
    "next/navigation",
    () => ({ useRouter: () => ({ refresh: mocks.refresh }) }),
);
vi.mock(
    "sonner",
    () => ({ toast: { success: mocks.success, error: mocks.error } }),
);
const entry = {
    id: "archive",
    title: "Preserved title",
    authorName: "Author",
    quantity: 2,
    status: "STORED",
    storedAt: new Date("2026-01-01"),
    publicConsent: false,
};
beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "owner" } });
    mocks.findMany.mockResolvedValue([entry]);
    mocks.count.mockResolvedValue(1);
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

it("shows owner-scoped paid records without claiming physical receipt and preserves private consent", async () => {
    render(await MyVaultPage());
    expect(mocks.findMany.mock.calls[0][0].where).toEqual({
        order: { userId: "owner" },
    });
    expect(
        screen.getByText(
            /Payment and the recorded status do not confirm physical receipt/,
        ),
    ).toBeTruthy();
    expect(screen.getByText(/Record status: STORED/)).toBeTruthy();
    expect(
        screen.getByRole("button", { name: "Make public" }).getAttribute(
            "aria-pressed",
        ),
    ).toBe("false");
});
it("personal empty state explains when paid records appear", async () => {
    mocks.findMany.mockResolvedValue([]);
    render(await MyVaultPage());
    expect(screen.getByText(/Vault entries appear here when an order/))
        .toBeTruthy();
});
it("public directory keeps consent and active-status filters, with truthful receipt wording", async () => {
    render(await VaultDirectoryPage({ searchParams: Promise.resolve({}) }));
    expect(mocks.findMany.mock.calls[0][0].where).toEqual({
        status: "STORED",
        publicConsent: true,
    });
    expect(mocks.count).toHaveBeenCalledWith({
        where: { status: "STORED", publicConsent: true },
    });
    expect(
        screen.getByText(/Buying the Vault add-on does not make a book public/),
    ).toBeTruthy();
    expect(screen.getByText("Archive record")).toBeTruthy();
    expect(screen.getByText(/Recorded Jan/)).toBeTruthy();
});
it("no public entries never claims there are no private archived works", async () => {
    mocks.findMany.mockResolvedValue([]);
    mocks.count.mockResolvedValue(0);
    render(await VaultDirectoryPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText("No public Vault entries yet")).toBeTruthy();
    expect(screen.getByText(/private unless their owners/)).toBeTruthy();
    expect(screen.queryByText("The vault is empty")).toBeNull();
});
it("visibility failure retains the consent state and provides a contextual retry; simultaneous clicks send one request", async () => {
    let finish!: (value: Response) => void;
    const fetch = vi.fn().mockImplementationOnce(() =>
        new Promise<Response>((resolve) => {
            finish = resolve;
        })
    )
        .mockResolvedValueOnce(
            Response.json({ id: entry.id, publicConsent: true }),
        );
    vi.stubGlobal("fetch", fetch);
    render(<VaultConsentToggle entryId={entry.id} consent={false} />);
    const button = screen.getByRole("button");
    act(() => {
        fireEvent.click(button);
        fireEvent.click(button);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(button.hasAttribute("disabled")).toBe(true);
    await act(async () =>
        finish(
            Response.json({ error: "Visibility unavailable" }, { status: 503 }),
        )
    );
    expect(screen.getByRole("alert").textContent).toContain(
        "Visibility unavailable",
    );
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(mocks.refresh).not.toHaveBeenCalled();
    fireEvent.click(button);
    await act(async () => {});
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(mocks.success).toHaveBeenCalledWith(
        "Public listing consent granted.",
    );
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).toBeNull();
});
it("consent removal explicitly requests false and never claims physical withdrawal", async () => {
    const fetch = vi.fn().mockResolvedValue(
        Response.json({ id: entry.id, publicConsent: false }),
    );
    vi.stubGlobal("fetch", fetch);
    render(<VaultConsentToggle entryId={entry.id} consent={true} />);
    fireEvent.click(screen.getByRole("button", { name: "Consent granted ✓" }));
    await act(async () => {});
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ consent: false });
    expect(mocks.success).toHaveBeenCalledWith(
        "Public listing consent removed.",
    );
});

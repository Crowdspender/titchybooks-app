// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import AdminDashboard from "@/components/admin/AdminDashboard";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock(
    "@/components/submissions/RenderProgress",
    () => ({ default: () => null }),
);
vi.mock(
    "@/components/submissions/PdfDownloads",
    () => ({
        default: (
            { printAvailable, readingAvailable }: {
                printAvailable: boolean;
                readingAvailable: boolean;
            },
        ) => (
            <div
                data-testid="pdf-downloads"
                data-print={String(printAvailable)}
                data-reading={String(readingAvailable)}
            />
        ),
    }),
);
const submission = {
    id: "controlled-review",
    status: "PENDING",
    mode: "EDITOR",
    title: "Review book",
    pdfS3Key: "retained/master.pdf",
    readingPdfS3Key: null,
    pdfDownloadUrl: null,
    artifacts: { printSheet: true, readingPdf: false },
    rejectionReason: null,
    createdAt: "2026-01-01T00:00:00Z",
    aiGenerated: false,
    qaSampled: false,
    pagePreviews: [],
    user: { id: "author", email: "author@example.invalid", name: "Author" },
};
const patch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();
const list = vi.fn<() => Promise<Response>>();
beforeEach(() => {
    patch.mockResolvedValue(Response.json({ submission }));
    list.mockImplementation(async () =>
        Response.json({ submissions: [submission] })
    );
    vi.stubGlobal(
        "fetch",
        vi.fn((input: string, init?: RequestInit) =>
            init?.method === "PATCH" ? patch(input, init) : list()
        ),
    );
    vi.stubGlobal("prompt", vi.fn(() => "  Please correct the cover text.  "));
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.resetAllMocks();
});

it("renders an em dash for nonpending actions without exposing a literal escape", async () => {
    list.mockImplementation(async () =>
        Response.json({ submissions: [{ ...submission, status: "DRAFT" }] })
    );
    render(<AdminDashboard />);
    const title = await screen.findByText("Review book");
    const row = title.closest("tr")!;
    expect(row.querySelector("td:last-child")?.textContent?.trim()).toBe("—");
    expect(row.textContent).not.toContain("\\u2014");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
});

it("canceling rejection makes zero requests and no success claim", async () => {
    vi.stubGlobal("prompt", vi.fn(() => null));
    render(<AdminDashboard />);
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    expect(patch).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
});

it.each(["", "   ", "short", "x".repeat(1001)])(
    "blocks invalid rejection guidance without a request (%s)",
    async (reason) => {
        vi.stubGlobal("prompt", vi.fn(() => reason));
        render(<AdminDashboard />);
        fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
        expect(patch).not.toHaveBeenCalled();
        expect(screen.getByRole("alert").textContent).toContain("10–1000");
    },
);

it("sends trimmed guidance and locks both moderation actions during a slow request", async () => {
    let finish!: (response: Response) => void;
    patch.mockImplementation(() =>
        new Promise((resolve) => {
            finish = resolve;
        })
    );
    render(<AdminDashboard />);
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    const approve = screen.getByRole("button", { name: "Approve" });
    const reject = screen.getByRole("button", { name: "Reject" });
    expect(approve.matches(":disabled")).toBe(true);
    expect(reject.matches(":disabled")).toBe(true);
    fireEvent.click(approve);
    fireEvent.click(reject);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(patch.mock.calls[0][1]?.body))).toEqual({
        action: "REJECT",
        rejectionReason: "Please correct the cover text.",
    });
    finish(Response.json({ submission }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
});

it.each([409, 403, 503])(
    "shows server review errors with reload and no success claim (HTTP %s)",
    async (status) => {
        patch.mockImplementation(async () =>
            Response.json(
                { error: "Review changed; reload before retrying." },
                { status },
            )
        );
        render(<AdminDashboard />);
        fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
        expect((await screen.findByRole("alert")).textContent).toContain(
            "Review changed",
        );
        expect(screen.getByRole("button", { name: "Reload submissions" }))
            .toBeDefined();
        expect(toast.success).not.toHaveBeenCalled();
    },
);

it("recovers from a failed list load without presenting an empty success state", async () => {
    list.mockRejectedValueOnce(new Error("Connection lost"));
    render(<AdminDashboard />);
    expect((await screen.findByRole("alert")).textContent).toContain(
        "Connection lost",
    );
    expect(screen.queryByText("No submissions yet")).toBeNull();
    fireEvent.click(
        screen.getByRole("button", { name: "Retry loading submissions" }),
    );
    await screen.findByRole("button", { name: "Approve" });
});

it("HTTP failures cannot silently become an empty list", async () => {
    list.mockImplementation(async () =>
        Response.json({ error: "Administrator access is required" }, {
            status: 403,
        })
    );
    render(<AdminDashboard />);
    expect((await screen.findByRole("alert")).textContent).toContain(
        "Administrator access",
    );
    expect(screen.queryByText("No submissions yet")).toBeNull();
});

it("confirms a committed review even when the success body is unreadable", async () => {
    patch.mockResolvedValue(new Response("not-json", { status: 200 }));
    render(<AdminDashboard />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith("Submission approved")
    );
    expect(screen.queryByRole("alert")).toBeNull();
    // The committed review still triggers the list refresh.
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
});

it("reports an unreadable failure body with the HTTP status, not a parse error", async () => {
    patch.mockResolvedValue(
        new Response("<html>bad gateway</html>", { status: 502 }),
    );
    render(<AdminDashboard />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
        "HTTP 502",
    );
    expect(toast.success).not.toHaveBeenCalled();
});

it("clears the action error after its reload succeeds", async () => {
    patch.mockResolvedValue(
        Response.json(
            { error: "Review changed; reload before retrying." },
            { status: 409 },
        ),
    );
    render(<AdminDashboard />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await screen.findByRole("alert");
    fireEvent.click(
        screen.getByRole("button", { name: "Reload submissions" }),
    );
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

it("keeps the action error when the reload itself fails", async () => {
    patch.mockResolvedValue(
        Response.json(
            { error: "Review changed; reload before retrying." },
            { status: 409 },
        ),
    );
    render(<AdminDashboard />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await screen.findByRole("alert");
    list.mockRejectedValueOnce(new Error("Connection lost"));
    fireEvent.click(
        screen.getByRole("button", { name: "Reload submissions" }),
    );
    await screen.findByText(/Connection lost/);
    expect(screen.getByText(/Review changed/)).toBeDefined();
});

it("offers only server-verified artifacts, not raw storage key presence", async () => {
    list.mockImplementation(async () =>
        Response.json({
            submissions: [{
                ...submission,
                readingPdfS3Key: "retained/reading.pdf",
                artifacts: { printSheet: true, readingPdf: false },
            }],
        })
    );
    render(<AdminDashboard />);
    const marker = await screen.findByTestId("pdf-downloads");
    expect(marker.getAttribute("data-print")).toBe("true");
    expect(marker.getAttribute("data-reading")).toBe("false");
});

it("hides download links when a mismatched manifest makes both artifacts unavailable", async () => {
    list.mockImplementation(async () =>
        Response.json({
            submissions: [{
                ...submission,
                artifacts: { printSheet: false, readingPdf: false },
            }],
        })
    );
    render(<AdminDashboard />);
    await screen.findByText("Review book");
    expect(screen.queryByTestId("pdf-downloads")).toBeNull();
    expect(screen.getByText("PDF unavailable")).toBeDefined();
});

// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import UploadGrid from "@/components/create/UploadGrid";
import { PAGE_LABELS } from "@/lib/constants";

const mocks = vi.hoisted(() => ({
    push: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock(
    "sonner",
    () => ({ toast: { error: mocks.error, success: mocks.success } }),
);
vi.mock("@/components/create/ImageUploader", () => ({
    default: ({ pageLabel, onUploaded }: {
        pageLabel: string;
        onUploaded: (label: string, key: string, file: File) => void;
    }) => (
        <button
            type="button"
            onClick={() =>
                onUploaded(pageLabel, `uploads/user/${pageLabel}.png`, {
                    name: `${pageLabel}.png`,
                    type: "image/png",
                } as File)
            }
        >
            Upload {pageLabel}
        </button>
    ),
}));

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

function uploadAllPages() {
    for (const label of PAGE_LABELS) {
        fireEvent.click(screen.getByRole("button", { name: `Upload ${label}` }));
    }
}

it("holds the submit lock after success so a second click cannot duplicate the book", async () => {
    const fetch = vi.fn().mockResolvedValue(
        Response.json({ submission: { id: "book" } }, { status: 202 }),
    );
    vi.stubGlobal("fetch", fetch);
    render(<UploadGrid />);
    uploadAllPages();
    fireEvent.click(screen.getByRole("button", { name: "Create Titchybooks" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/dashboard"));
    // Navigation has not replaced the grid yet: the action stays locked.
    const button = screen.getByRole("button", { name: "Opening dashboard…" });
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(fetch).toHaveBeenCalledTimes(1);
});

it("a definitive rejection keeps the retry guidance and re-enables the action", async () => {
    const fetch = vi.fn().mockResolvedValue(
        Response.json({ error: "BACK_COVER: The uploaded image is missing." }, { status: 400 }),
    );
    vi.stubGlobal("fetch", fetch);
    render(<UploadGrid />);
    uploadAllPages();
    fireEvent.click(screen.getByRole("button", { name: "Create Titchybooks" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("BACK_COVER: The uploaded image is missing.");
    expect(alert.textContent).toContain("Your selected images remain available to retry.");
    expect(alert.textContent).not.toContain("may already have been created");
    const button = screen.getByRole("button", { name: "Create Titchybooks" });
    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
});

it("a lost response warns that the book may already exist before retrying", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetch);
    render(<UploadGrid />);
    uploadAllPages();
    fireEvent.click(screen.getByRole("button", { name: "Create Titchybooks" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
        "The book may already have been created — check your dashboard before retrying.",
    );
    expect(mocks.push).not.toHaveBeenCalled();
    expect(
        screen.getByRole("button", { name: "Create Titchybooks" }).hasAttribute("disabled"),
    ).toBe(false);
});
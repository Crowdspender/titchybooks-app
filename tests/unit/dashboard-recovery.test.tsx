// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import ContinueEditingButton from "@/components/dashboard/ContinueEditingButton";
import SubmissionList from "@/components/submissions/SubmissionList";
import OpenInEditorButton from "@/components/submissions/OpenInEditorButton";
import ForgotPasswordForm from "@/components/auth/ForgotPasswordForm";

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
vi.mock(
    "@/components/submissions/RenderProgress",
    () => ({ default: () => null }),
);
const key = "titchybook-active-editor-draft";
const book = {
    id: "original",
    title: "Original book",
    mode: "EDITOR",
    status: "REJECTED",
    pdfS3Key: "retained.pdf",
    readingPdfS3Key: null,
    rejectionReason: "Please correct the cover text.",
    createdAt: "2026-01-01",
};
beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

it.each([401, 403, 404, 503])(
    "keeps the dashboard resume pointer after HTTP %s",
    async (status) => {
        localStorage.setItem(key, "draft");
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(new Response("{}", { status })),
        );
        render(<ContinueEditingButton />);
        expect(
            (await screen.findByRole("link", { name: "Retry saved draft" }))
                .getAttribute("href"),
        ).toBe("/create?submissionId=draft");
        expect(localStorage.getItem(key)).toBe("draft");
    },
);
it("keeps the pointer after a network failure or a successful noneditable response", async () => {
    localStorage.setItem(key, "draft");
    const fetch = vi.fn().mockRejectedValueOnce(new Error("Offline"))
        .mockResolvedValueOnce(
            Response.json({ submission: { status: "APPROVED" } }),
        );
    vi.stubGlobal("fetch", fetch);
    const view = render(<ContinueEditingButton />);
    await screen.findByRole("link", { name: "Retry saved draft" });
    expect(localStorage.getItem(key)).toBe("draft");
    view.unmount();
    render(<ContinueEditingButton />);
    await screen.findByRole("link", { name: "Review saved draft" });
    expect(localStorage.getItem(key)).toBe("draft");
});
it("does not project a previous draft check onto a changed pointer", async () => {
    localStorage.setItem(key, "first");
    let resolve!: (response: Response) => void;
    vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce(
            Response.json({ submission: { status: "DRAFT" } }),
        ).mockImplementationOnce(() =>
            new Promise<Response>((r) => {
                resolve = r;
            })
        ),
    );
    render(<ContinueEditingButton />);
    await screen.findByRole("link", { name: "Continue editing" });
    act(() => {
        localStorage.setItem(key, "second");
        window.dispatchEvent(new Event("storage"));
    });
    expect(
        screen.getByRole("link", { name: "Checking saved draft…" })
            .getAttribute("href"),
    ).toContain("second");
    await act(async () =>
        resolve(Response.json({ submission: { status: "DRAFT" } }))
    );
    await screen.findByRole("link", { name: "Continue editing" });
});
it("shows library failure rather than a false empty state and retries", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce(
            Response.json({ error: "Failure" }, { status: 503 }),
        ).mockResolvedValueOnce(Response.json({ submissions: [] })),
    );
    render(<SubmissionList />);
    await screen.findByRole("alert");
    expect(screen.queryByText("No Titchybooks yet")).toBeNull();
    fireEvent.click(
        screen.getByRole("button", { name: "Retry loading library" }),
    );
    await screen.findByText("No Titchybooks yet");
    expect(
        screen.getByRole("link", { name: "Create your first Titchybooks" })
            .getAttribute("href"),
    ).toBe("/create?new=true");
});
it("routes editor corrections to a content-preserving copy and legacy corrections to uploads", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
            Response.json({
                submissions: [book, {
                    ...book,
                    id: "legacy",
                    mode: "LEGACY_UPLOAD",
                }],
            }),
        ),
    );
    render(<SubmissionList />);
    await screen.findByRole("button", { name: "Make a correction copy" });
    expect(
        screen.getByRole("link", { name: "Re-upload corrected images" })
            .getAttribute("href"),
    ).toBe("/create/upload?replaces=legacy");
    expect(screen.queryByRole("link", { name: "Re-upload" })).toBeNull();
});
it("locks duplicate correction clicks and keeps a successfully issued copy resumable", async () => {
    let resolve!: (response: Response) => void;
    const fetch = vi.fn(() =>
        new Promise<Response>((r) => {
            resolve = r;
        })
    );
    vi.stubGlobal("fetch", fetch);
    render(
        <OpenInEditorButton
            submissionId="original"
            label="Make a correction copy"
        />,
    );
    const button = screen.getByRole("button");
    act(() => {
        fireEvent.click(button);
        fireEvent.click(button);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () =>
        resolve(Response.json({ submission: { id: "copy" } }, { status: 201 }))
    );
    expect(mocks.push).toHaveBeenCalledWith("/create?submissionId=copy");
    expect(localStorage.getItem(key)).toBe("copy");
});
it("failed copying leaves a contextual retry and never navigates", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
            Response.json({ error: "Not allowed" }, { status: 403 }),
        ),
    );
    render(<OpenInEditorButton submissionId="original" />);
    fireEvent.click(screen.getByRole("button"));
    await screen.findByRole("alert");
    await waitFor(() =>
        expect(screen.getByRole("button").hasAttribute("disabled")).toBe(false)
    );
    expect(mocks.push).not.toHaveBeenCalled();
});
it("reset-request success never claims provider delivery or confirms account existence", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(Response.json({ success: true })),
    );
    render(<ForgotPasswordForm />);
    fireEvent.change(screen.getByLabelText("Email"), {
        target: { value: "reader@example.invalid" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    await screen.findByText(/This response does not confirm delivery/);
    expect(screen.getByText(/If an account exists for/).textContent).toContain(
        "reader@example.invalid",
    );
    expect(mocks.success).toHaveBeenCalledWith(
        "Reset request received. Check your email for next steps.",
    );
    expect(screen.queryByText(/We.ve sent a password reset link/)).toBeNull();
});
it("a failed reset request retains the entered address and permits retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Offline")));
    render(<ForgotPasswordForm />);
    fireEvent.change(screen.getByLabelText("Email"), {
        target: { value: "reader@example.invalid" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalled());
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe(
        "reader@example.invalid",
    );
    expect(
        screen.getByRole("button", { name: "Send reset link" }).hasAttribute(
            "disabled",
        ),
    ).toBe(false);
});
it("storage denial after a successful deletion does not misreport the server result", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce(
            Response.json({ submissions: [{ ...book, status: "DRAFT" }] }),
        ).mockResolvedValueOnce(Response.json({ deleted: true })),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SubmissionList />);
    const button = await screen.findByRole("button", { name: "Delete" });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("Denied");
    });
    fireEvent.click(button);
    await screen.findByText("No Titchybooks yet");
    expect(mocks.success).toHaveBeenCalledWith("Draft deleted successfully");
    expect(mocks.error).not.toHaveBeenCalled();
});

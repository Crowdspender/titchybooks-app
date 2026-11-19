// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
} from "@testing-library/react";
import QueueMonitor from "@/components/admin/QueueMonitor";

const payload = {
    health: {
        healthy: false,
        checkedAt: "2026-01-01T00:00:00Z",
        staleAfterMs: 60000,
        backlogAfterMs: 120000,
        queues: [{
            queue: "render",
            due: 3,
            processing: 0,
            failed: 0,
            failedRecent: 0,
            oldestDueAt: null,
            oldestDueAgeMs: null,
            lastRun: null,
            lastRunAgeMs: null,
            healthy: false,
            reasons: ["drain-never-ran"],
        }],
    },
    failedAiJobs: [],
    failedRenderJobs: [],
    recentRuns: [],
};
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

it("announces initial loading and disables refresh until the result is acknowledged", async () => {
    let finish!: (value: Response) => void;
    const fetch = vi.fn(() =>
        new Promise<Response>((resolve) => {
            finish = resolve;
        })
    );
    vi.stubGlobal("fetch", fetch);
    render(<QueueMonitor />);
    expect(screen.getByRole("status", { name: "Loading queue status" }))
        .toBeTruthy();
    expect(
        screen.getByRole("button", { name: "Refreshing…" }).hasAttribute(
            "disabled",
        ),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Refreshing…" }));
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => finish(Response.json(payload)));
    expect(screen.getByText("Queue attention required")).toBeTruthy();
    expect(screen.getByText(/No drain run has been recorded yet/)).toBeTruthy();
    expect(
        screen.getByRole("button", { name: "Refresh" }).hasAttribute(
            "disabled",
        ),
    ).toBe(false);
});

it("shows unavailable instead of a false healthy/empty result and locks duplicate retries", async () => {
    let finish!: (value: Response) => void;
    const fetch = vi.fn().mockResolvedValueOnce(
        new Response("{}", { status: 503 }),
    )
        .mockImplementationOnce(() =>
            new Promise<Response>((resolve) => {
                finish = resolve;
            })
        );
    vi.stubGlobal("fetch", fetch);
    render(<QueueMonitor />);
    expect((await screen.findByRole("alert")).textContent).toContain(
        "Queue status unavailable: Request failed (503)",
    );
    expect(screen.queryByText("All queues healthy")).toBeNull();
    expect(screen.queryByText("No failed AI book jobs.")).toBeNull();
    const retry = screen.getByRole("button", { name: "Retry" });
    act(() => {
        fireEvent.click(retry);
        fireEvent.click(retry);
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status", { name: "Loading queue status" }))
        .toBeTruthy();
    await act(async () => finish(Response.json(payload)));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("No failed AI book jobs.")).toBeTruthy();
});

it("labels refresh results as last checked, then hides them when the refreshed request fails", async () => {
    let fail!: (error: Error) => void;
    vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce(Response.json(payload))
            .mockImplementationOnce(() =>
                new Promise<Response>((_, reject) => {
                    fail = reject;
                })
            ),
    );
    render(<QueueMonitor />);
    await screen.findByText("Queue attention required");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(screen.getByRole("status").textContent).toContain(
        "last checked results",
    );
    expect(screen.getByText("Queue attention required")).toBeTruthy();
    await act(async () => fail(new Error("Offline")));
    expect(screen.getByRole("alert").textContent).toContain("Offline");
    expect(screen.queryByText("Queue attention required")).toBeNull();
});

it("refreshes on its existing cadence and removes its timer on unmount", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue(Response.json(payload));
    vi.stubGlobal("fetch", fetch);
    let view!: ReturnType<typeof render>;
    await act(async () => {
        view = render(<QueueMonitor />);
    });
    await act(async () => {
        vi.advanceTimersByTime(30000);
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    view.unmount();
    await act(async () => {
        vi.advanceTimersByTime(60000);
    });
    expect(fetch).toHaveBeenCalledTimes(2);
});

// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, type Mock, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import OrderModeration from "@/components/admin/OrderModeration";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const order = {
  id: "controlled-order",
  status: "PENDING_PAYMENT",
  quantity: 1,
  zone: "HU",
  totalHuf: 6000,
  currency: "EUR",
  expectedMinorAmount: 3260,
  vaultAddOn: true,
  vaultFeeHuf: 2000,
  notes: null,
  recipientName: "Fixture",
  countryCode: "HU",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  manualSettlement: null,
  user: {
    id: "fixture-user",
    email: "fixture@example.invalid",
    name: "Fixture User",
  },
  submission: { id: "fixture-book", title: "Fixture Book" },
};
let patch: Mock<(input: string, init?: RequestInit) => Promise<Response>>;
beforeEach(() => {
  patch = vi.fn(async () =>
    Response.json({ order: { ...order, status: "PAID" } })
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return patch(input, init);
      return Response.json(
        input.includes("payment-alerts") ? { alerts: [] } : { orders: [order] },
      );
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
async function editPaid() {
  render(<OrderModeration />);
  fireEvent.click(await screen.findByRole("button", { name: "Update" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Order status" }), {
    target: { value: "PAID" },
  });
}
function confirm() {
  fireEvent.change(screen.getByLabelText("Payment evidence / reference"), {
    target: { value: "  Receipt 42  " },
  });
  fireEvent.click(screen.getByRole("checkbox"));
}

it("requires evidence plus confirmation, resets confirmation when evidence changes, and cancels without requests", async () => {
  await editPaid();
  const save = screen.getByRole("button", {
    name: "Save",
  }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  confirm();
  expect(save.disabled).toBe(false);
  fireEvent.change(screen.getByLabelText("Payment evidence / reference"), {
    target: { value: "new receipt" },
  });
  expect(save.disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(patch).not.toHaveBeenCalled();
});

it("submits trimmed evidence and revision, but never sends an operator or Stripe claim", async () => {
  await editPaid();
  confirm();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
  expect(patch.mock.calls[0][0]).toBe("/api/admin/orders/controlled-order");
  const body = JSON.parse(String(patch.mock.calls[0][1]?.body));
  expect(body).toEqual({
    status: "PAID",
    expectedUpdatedAt: order.updatedAt,
    manualSettlement: {
      method: "BANK_TRANSFER",
      reference: "Receipt 42",
      confirmed: true,
    },
  });
  await waitFor(() =>
    expect(toast.success).toHaveBeenCalledWith(
      expect.stringContaining("does not confirm a Stripe payment"),
    )
  );
});

it("locks duplicate submission and editing while a slow request is in flight", async () => {
  let finish!: (response: Response) => void;
  patch.mockImplementation(() =>
    new Promise<Response>((resolve) => {
      finish = resolve;
    })
  );
  await editPaid();
  confirm();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  const saving = screen.getByRole("button", {
    name: "Saving…",
  }) as HTMLButtonElement;
  fireEvent.click(saving);
  expect(saving.disabled).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(patch).toHaveBeenCalledTimes(1);
  finish(Response.json({ order }));
  await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
});

it.each([409, 503])(
  "retains edits and exposes reload after HTTP %s",
  async (status) => {
    patch.mockImplementation(async () =>
      Response.json({ error: "Order changed; reload before retrying." }, {
        status,
      })
    );
    await editPaid();
    confirm();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("reload");
    expect(
      (screen.getByLabelText(
        "Payment evidence / reference",
      ) as HTMLTextAreaElement).value,
    ).toContain("Receipt 42");
    expect(toast.success).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reload orders" }));
    await screen.findByRole("button", { name: "Update" });
  },
);

it("handles a network failure without claiming success or losing evidence", async () => {
  patch.mockRejectedValue(
    new Error("Connection lost; reload before retrying."),
  );
  await editPaid();
  confirm();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("alert");
  expect(toast.success).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Payment evidence / reference")).toBeDefined();
});
it("keeps unmatched and held events visible across fulfillment filters and opens linked history", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (input.endsWith("/payment")) {
        return Response.json({
          order: {
            ...order,
            paymentState: "DISPUTED",
            paymentHold: true,
            paymentSummary: null,
            paymentAttempts: [],
            paymentEvents: [],
          },
        });
      }
      if (input.includes("payment-alerts")) {
        return Response.json({
          alerts: [],
          eventCount: 104,
          events: [
            {
              id: "unmatched",
              orderId: null,
              providerEventId: "evt_unknown",
              type: "charge.refunded",
              status: "UNMATCHED",
              source: "SIGNED_WEBHOOK",
              objectId: "ch_unknown",
            },
            {
              id: "held",
              orderId: order.id,
              providerEventId: "evt_held",
              type: "refund.updated",
              status: "REVIEW",
              source: "SIGNED_WEBHOOK",
              objectId: "re_held",
            },
          ],
        });
      }
      // Honor the fulfillment filter so a dead SHIPPED button cannot pass:
      // the pending order must leave the list while events stay visible.
      const status = new URL(input, "http://localhost").searchParams.get("status");
      return Response.json({
        orders: status ? [order].filter(row => row.status === status) : [order],
      });
    }),
  );
  render(<OrderModeration />);
  await screen.findByText("Unresolved payment events (104)");
  fireEvent.click(screen.getByRole("button", { name: "SHIPPED" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull()
  );
  expect(screen.getByText(/Showing 2 of 104/)).toBeDefined();
  expect(screen.getByText(/Unmatched — retained/)).toBeDefined();
  fireEvent.click(
    screen.getByRole("button", {
      name: /Review payment for order controlled-order/,
    }),
  );
  await screen.findByRole("region", { name: "Payment history" });
  await screen.findByText("Payment disputed");
  expect(
    screen.getByRole("button", { name: "Release reviewed hold" }).matches(
      ":disabled",
    ),
  ).toBe(true);
});
it("failed order/financial queue loads do not invent empty-success states and expose reload", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ error: "Synthetic unavailable" }, { status: 503 })
    ),
  );
  render(<OrderModeration />);
  await screen.findByText(/Orders could not be loaded/);
  await screen.findByText(/queue could not be loaded/);
  expect(screen.queryByText("No orders yet")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Reload orders and payment queue" }),
  ).toBeDefined();
});
it("shows the accepted charge before manual settlement confirmation", async () => {
  await editPaid();
  expect(screen.getByText(/Accepted charge:/).textContent)
    .toContain("32.60 EUR");
});
it("fences a stale edit when a queue reload replaces the row mid-edit", async () => {
  let finishReload!: (response: Response) => void;
  let reloadPending = false;
  const newer = {
    ...order,
    notes: "newer operator notes",
    updatedAt: "2026-01-02T00:00:00.000Z",
  };
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    if (init?.method === "PATCH") return patch(input, init);
    if (input.includes("payment-alerts")) return Response.json({ alerts: [] });
    if (reloadPending) {
      // The post-save reload stays in flight until another operator's newer
      // row is ready to replace the one the next edit starts from.
      return new Promise<Response>((resolve) => {
        finishReload = resolve;
      });
    }
    return Response.json({ orders: [order] });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<OrderModeration />);
  fireEvent.click(await screen.findByRole("button", { name: "Update" }));
  fireEvent.change(screen.getByLabelText("Internal notes"), {
    target: { value: "first save" },
  });
  reloadPending = true;
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
  // Start a new edit from the still-current row, then let the reload land
  // with a newer revision while the draft is open.
  fireEvent.click(await screen.findByRole("button", { name: "Update" }));
  finishReload(Response.json({ orders: [newer] }));
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.filter((call) =>
        String(call[0]).startsWith("/api/admin/orders") &&
        !(call[1] as RequestInit | undefined)?.method
      ).length,
    ).toBeGreaterThanOrEqual(2)
  );
  fireEvent.change(screen.getByLabelText("Internal notes"), {
    target: { value: "stale draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect((await screen.findByRole("alert")).textContent)
    .toContain("changed since you started editing");
  expect(patch).toHaveBeenCalledTimes(1);
});
it("keeps the edit draft when payment history is opened and closed", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return patch(input, init);
      if (input.endsWith("/payment")) {
        return Response.json({
          order: {
            ...order,
            paymentState: null,
            paymentHold: false,
            paymentSummary: null,
            paymentAttempts: [],
            paymentEvents: [],
          },
        });
      }
      return Response.json(
        input.includes("payment-alerts") ? { alerts: [] } : { orders: [order] },
      );
    }),
  );
  render(<OrderModeration />);
  fireEvent.click(await screen.findByRole("button", { name: "Update" }));
  fireEvent.change(screen.getByLabelText("Internal notes"), {
    target: { value: "unsaved draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Payment history" }));
  await screen.findByRole("region", { name: "Payment history" });
  fireEvent.click(screen.getByRole("button", { name: "Close history" }));
  expect(
    (screen.getByLabelText("Internal notes") as HTMLTextAreaElement).value,
  ).toBe("unsaved draft");
  expect(screen.getByRole("button", { name: "Save" })).toBeDefined();
});
it("a dismissed alert is not restored by an in-flight queue snapshot", async () => {
  const alert = {
    id: "alert-1",
    orderId: order.id,
    kind: "stale-session",
    message: "Superseded session retained",
    occurrences: 1,
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
  };
  let releaseStale!: (response: Response) => void;
  let queueCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return Response.json(
          input.includes("payment-alerts") ? { resolved: true } : { order },
        );
      }
      if (input.includes("payment-alerts")) {
        queueCalls += 1;
        if (queueCalls === 2) {
          // Snapshot captured before the dismissal; resolves after it.
          return new Promise<Response>((resolve) => {
            releaseStale = resolve;
          });
        }
        return Response.json(
          queueCalls === 1
            ? { alerts: [alert], events: [], eventCount: 0 }
            : { alerts: [], events: [], eventCount: 0 },
        );
      }
      return Response.json({ orders: [order] });
    }),
  );
  render(<OrderModeration />);
  await screen.findByRole("button", { name: "Dismiss" });
  // A successful order save starts a queue reload that stays in flight.
  fireEvent.click(screen.getByRole("button", { name: "Update" }));
  fireEvent.change(screen.getByLabelText("Internal notes"), {
    target: { value: "operator note" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(queueCalls).toBe(2));
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  // The dismissal must cancel the stale snapshot and refetch the queue.
  await waitFor(() => expect(queueCalls).toBeGreaterThanOrEqual(3));
  releaseStale(Response.json({ alerts: [alert], events: [], eventCount: 0 }));
  await waitFor(() =>
    expect(screen.queryByText("Superseded session retained")).toBeNull()
  );
});
it("pages older unresolved events so the oldest unmatched event stays reachable", async () => {
  const newest = {
    id: "evt-new",
    orderId: null,
    providerEventId: "evt_new",
    type: "charge.refunded",
    status: "UNMATCHED",
    source: "SIGNED_WEBHOOK",
    objectId: "ch_new",
    createdAt: "2026-01-02T00:00:00.000Z",
  };
  const oldest = {
    ...newest,
    id: "evt-old",
    providerEventId: "evt_old",
    objectId: "ch_old",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      urls.push(input);
      if (input.includes("payment-alerts")) {
        return Response.json(
          input.includes("olderThan")
            ? { alerts: [], events: [oldest], eventCount: 104 }
            : { alerts: [], events: [newest], eventCount: 104 },
        );
      }
      return Response.json({ orders: [order] });
    }),
  );
  render(<OrderModeration />);
  await screen.findByText("Unresolved payment events (104)");
  fireEvent.click(screen.getByRole("button", { name: "Show older events" }));
  await screen.findByText(/Showing 2 of 104/);
  expect(screen.getAllByText(/Unmatched — retained/)).toHaveLength(2);
  const paging = urls.find((url) => url.includes("olderThan"));
  expect(paging).toContain(
    `olderThan=${encodeURIComponent(newest.createdAt)}`,
  );
});

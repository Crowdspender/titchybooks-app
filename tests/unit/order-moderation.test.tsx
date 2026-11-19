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
      return Response.json({ orders: [order] });
    }),
  );
  render(<OrderModeration />);
  await screen.findByText("Unresolved payment events (104)");
  fireEvent.click(screen.getByRole("button", { name: "SHIPPED" }));
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

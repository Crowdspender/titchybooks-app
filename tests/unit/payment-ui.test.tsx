// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, type Mock, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import OrderPaymentHistory from "@/components/admin/OrderPaymentHistory";
import PaymentStatus from "@/components/orders/PaymentStatus";
import PayNowButton from "@/components/orders/PayNowButton";
import OrderDetailPage from "@/app/(protected)/dashboard/orders/[id]/page";

const effects = vi.hoisted(() => ({
  refresh: vi.fn(),
  error: vi.fn(),
  auth: vi.fn(),
  order: vi.fn(),
  user: vi.fn(),
}));
vi.mock(
  "next/navigation",
  () => ({
    useRouter: () => ({ refresh: effects.refresh }),
    redirect: (path: string) => {
      throw new Error(`redirect:${path}`);
    },
    notFound: () => {
      throw new Error("not-found");
    },
  }),
);
vi.mock("sonner", () => ({ toast: effects }));
vi.mock("@/auth", () => ({ auth: effects.auth }));
vi.mock(
  "@/lib/prisma",
  () => ({
    prisma: {
      order: { findUnique: effects.order },
      user: { findUnique: effects.user },
    },
  }),
);
vi.mock("@/lib/stripe", () => ({ isStripeConfigured: () => true }));
const fingerprint = "a".repeat(64);
const summary = {
  version: 1,
  currency: "EUR",
  expectedMinorAmount: 2740,
  receivedMinor: 2740,
  refundedMinor: 1000,
  pendingRefundMinor: 200,
  failedRefundMinor: 100,
  disputedMinor: 2740,
  lostDisputeMinor: 0,
  netReceivedMinor: 1740,
  fingerprint,
  reviewReasons: ["overpayment"],
  proofs: [],
};
const history = {
  id: "local-order",
  status: "PAID",
  paymentState: "DISPUTED",
  paymentHold: true,
  paymentSummary: summary,
  paymentAttempts: [{
    id: "attempt1",
    sequence: 1,
    status: "SUCCEEDED",
    expectedMinorAmount: 2740,
    currency: "EUR",
    livemode: false,
    providerAccountId: "acct_local",
    sessionId: "cs_local",
    paymentIntentId: "pi_local",
    failureCode: null,
    createdAt: "2026-01-01",
    providerSnapshot: {
      refunds: [{ id: "re_local", status: "succeeded" }],
      disputes: [{ id: "dp_local", status: "needs_response" }],
    },
  }],
  paymentEvents: [{
    id: "event1",
    providerEventId: "evt_local",
    source: "SIGNED_WEBHOOK",
    type: "refund.updated",
    status: "REVIEW",
    data: { objectId: "re_local" },
    outcome: "review outcome",
    createdAt: "2026-01-01",
  }],
};
let get: Mock<() => Promise<Response>>;
let post: Mock<(body: Record<string, unknown>) => Promise<Response>>;
let changed: Mock<() => void>;
let close: Mock<() => void>;
beforeEach(() => {
  get = vi.fn(async () => Response.json({ order: history }));
  post = vi.fn(async () => Response.json({ released: true }));
  changed = vi.fn();
  close = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      // Match method and full path so a request aimed at another order or
      // endpoint cannot receive a successful payment response.
      if (url === "/api/admin/orders/local-order/payment") {
        return init?.method === "POST"
          ? post(init.body ? JSON.parse(String(init.body)) : {})
          : get();
      }
      if (url === "/api/orders/local-order/pay" && init?.method === "POST") {
        return post(init.body ? JSON.parse(String(init.body)) : {});
      }
      throw new Error(`Unexpected local test URL ${url}`);
    }),
  );
  effects.auth.mockResolvedValue({ user: { id: "owner", role: "USER" } });
  effects.order.mockResolvedValue({
    id: "local-order",
    userId: "owner",
    status: "PENDING_PAYMENT",
    paymentState: "UNPAID",
    paymentHold: false,
    paymentSummary: null,
    stripeSessionId: null,
    currency: "EUR",
    expectedMinorAmount: 2740,
    quoteSnapshot: null,
    quoteAcceptedAt: null,
    pricingConfigVersion: null,
    fxRate: null,
    totalHuf: 10000,
    unitPriceHuf: 250,
    printCostHuf: 10000,
    handlingCostHuf: 0,
    shippingCostHuf: 0,
    vaultFeeHuf: 0,
    discountHuf: 0,
    quantity: 40,
    zone: "hungary",
    weightGrams: 240,
    createdAt: new Date("2026-01-01"),
    submission: { title: "Fixture Book" },
    recipientName: "Fixture",
    line1: "Fixture address",
    line2: null,
    postalCode: "1000",
    city: "Fixture",
    countryCode: "HU",
    phone: null,
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
async function openHistory() {
  render(
    <OrderPaymentHistory
      orderId="local-order"
      onChanged={changed}
      onClose={close}
    />,
  );
  await screen.findByText("Physical fulfillment: PAID");
}
function review() {
  fireEvent.change(screen.getByLabelText("Review explanation"), {
    target: { value: "  Finance reviewed these current facts.  " },
  });
  fireEvent.click(screen.getByRole("checkbox"));
}
it("shows canonical totals, every attempt/event, mode/references and refund details without creating a refund action", async () => {
  await openHistory();
  expect(screen.getByText("Refund pending")).toBeDefined();
  expect(screen.getByText("Refund failed")).toBeDefined();
  expect(screen.getByText("Active dispute")).toBeDefined();
  expect(screen.getByText(/Attempt 1/).textContent).toContain("27.40");
  expect(screen.getByText(/Test mode · account acct_local/)).toBeDefined();
  fireEvent.click(
    screen.getByText("Canonical refund, dispute, and reference details"),
  );
  expect(screen.getByText(/needs_response/)).toBeDefined();
  expect(screen.queryByRole("button", { name: /^Refund/ })).toBeNull();
  expect(post).not.toHaveBeenCalled();
});
it("release requires explanation, explicit confirmation and exact fingerprint; edits reset confirmation", async () => {
  await openHistory();
  const release = screen.getByRole("button", { name: "Release reviewed hold" });
  expect(release.matches(":disabled")).toBe(true);
  review();
  expect(release.matches(":disabled")).toBe(false);
  fireEvent.change(screen.getByLabelText("Review explanation"), {
    target: { value: "Changed review explanation." },
  });
  expect(release.matches(":disabled")).toBe(true);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(release);
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  expect(post.mock.calls[0][0]).toEqual({
    action: "RELEASE_HOLD",
    fingerprint,
    explanation: "Changed review explanation.",
    confirmed: true,
  });
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(post.mock.calls[0][0]).not.toHaveProperty("operatorId");
});
it("closing review sends no financial request", async () => {
  await openHistory();
  review();
  fireEvent.click(screen.getByRole("button", { name: "Close history" }));
  expect(close).toHaveBeenCalledTimes(1);
  expect(post).not.toHaveBeenCalled();
});
it("locks duplicate review requests and disables closure or reload during a slow response", async () => {
  let finish!: (r: Response) => void;
  post.mockImplementation(() =>
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  await openHistory();
  review();
  fireEvent.click(
    screen.getByRole("button", { name: "Release reviewed hold" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Release reviewed hold" }),
  );
  expect(post).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole("button", { name: "Close history" }).matches(":disabled"),
  ).toBe(true);
  expect(
    screen.getByRole("button", { name: "Reload payment history" }).matches(
      ":disabled",
    ),
  ).toBe(true);
  finish(Response.json({ released: true }));
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
});
it("HTTP 409 invalidates review until a manual history reload and never claims success", async () => {
  post.mockResolvedValue(
    Response.json({ error: "Facts changed; reload history." }, { status: 409 }),
  );
  await openHistory();
  review();
  fireEvent.click(
    screen.getByRole("button", { name: "Release reviewed hold" }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain("reload");
  expect(
    screen.getByRole("button", { name: "Release reviewed hold" }).matches(
      ":disabled",
    ),
  ).toBe(true);
  // A definitive rejection keeps the manual reload path.
  expect(changed).not.toHaveBeenCalled();
  expect(screen.queryByText(/hold released/)).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Reload payment history" }),
  );
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Reconcile with Stripe" }).matches(
        ":disabled",
      ),
    ).toBe(false)
  );
});
it.each(["5xx response", "lost response"])(
  "an unconfirmed action (%s) reloads history and refreshes the parent list before moderation resumes",
  async (kind) => {
    if (kind === "5xx response") {
      post.mockResolvedValue(
        Response.json(
          { error: "Canonical payment state could not be confirmed." },
          { status: 502 },
        ),
      );
    } else {
      post.mockRejectedValue(new Error("Synthetic lost response"));
    }
    await openHistory();
    review();
    fireEvent.click(
      screen.getByRole("button", { name: "Release reviewed hold" }),
    );
    // The hold may already be recorded server-side: the parent list refreshes
    // and history reloads without waiting for a manual click.
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Reconcile with Stripe" }).matches(
          ":disabled",
        ),
      ).toBe(false)
    );
    expect(screen.queryByText(/hold released/)).toBeNull();
    // Explicit confirmation was reset: release stays disabled after the reload.
    expect(
      screen.getByRole("button", { name: "Release reviewed hold" }).matches(
        ":disabled",
      ),
    ).toBe(true);
  },
);
it("handles failed history load without empty-success or active financial controls", async () => {
  get.mockRejectedValue(new Error("offline"));
  render(
    <OrderPaymentHistory
      orderId="local-order"
      onChanged={changed}
      onClose={close}
    />,
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "could not be loaded",
  );
  expect(
    screen.getByRole("button", { name: "Reconcile with Stripe" }).matches(
      ":disabled",
    ),
  ).toBe(true);
  expect(screen.queryByText(/No recorded events/)).toBeNull();
});
it("reconciliation sends only its action and reloads persisted history", async () => {
  await openHistory();
  fireEvent.click(
    screen.getByRole("button", { name: "Reconcile with Stripe" }),
  );
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(post.mock.calls[0][0]).toEqual({ action: "RECONCILE" });
  expect(get).toHaveBeenCalledTimes(2);
});
it.each(["PAID", "MANUAL_PAID", "PROCESSING"])(
  "a persisted %s pay response refreshes without another charge or unavailable-payment error",
  async (paymentState) => {
    post.mockResolvedValue(Response.json({ checkoutUrl: null, paymentState }));
    render(<PayNowButton orderId="local-order" />);
    fireEvent.click(screen.getByRole("button", { name: "Pay now" }));
    await screen.findByRole("status");
    expect(effects.refresh).toHaveBeenCalledTimes(1);
    expect(effects.error).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Pay now" })).toBeNull();
  },
);
it("held retry exposes contact review without automatic retry", async () => {
  post.mockResolvedValue(
    Response.json(
      { error: "Review required", code: "PAYMENT_REVIEW_REQUIRED" },
      { status: 409 },
    ),
  );
  render(<PayNowButton orderId="local-order" />);
  fireEvent.click(screen.getByRole("button", { name: "Pay now" }));
  await screen.findByRole("link", { name: "Request payment review" });
  expect(post).toHaveBeenCalledTimes(1);
});
it("a refreshed FAILED state restores retry after an optimistic PROCESSING confirmation", async () => {
  post.mockResolvedValue(
    Response.json({ checkoutUrl: null, paymentState: "PROCESSING" }),
  );
  const view = render(
    <PayNowButton orderId="local-order" paymentState="UNPAID" />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Pay now" }));
  await screen.findByText("Payment is processing. Do not pay again.");
  // The first refresh confirms PROCESSING: the warning must survive it.
  view.rerender(
    <PayNowButton orderId="local-order" paymentState="PROCESSING" />,
  );
  expect(
    screen.getByText("Payment is processing. Do not pay again."),
  ).toBeDefined();
  expect(screen.queryByRole("button", { name: "Pay now" })).toBeNull();
  // A later refresh proves FAILED while the component stays mounted: the
  // retry action returns instead of freezing "do not pay again".
  view.rerender(
    <PayNowButton orderId="local-order" paymentState="FAILED" />,
  );
  expect(screen.getByRole("button", { name: "Pay now" })).toBeDefined();
  expect(screen.queryByText(/Do not pay again/)).toBeNull();
});
it("an unproven legacy charge offers review instead of a Pay now that always 409s", async () => {
  const order = await effects.order();
  effects.order.mockResolvedValue({
    ...order,
    expectedMinorAmount: null,
    stripeSessionId: null,
    paymentState: null,
    quoteAcceptedAt: null,
  });
  render(
    await OrderDetailPage({
      params: Promise.resolve({ id: "local-order" }),
      searchParams: Promise.resolve({}),
    }),
  );
  expect(screen.queryByRole("button", { name: "Pay now" })).toBeNull();
  expect(
    screen.getByRole("link", { name: "Request payment review" }),
  ).toBeDefined();
  cleanup();
  // A stored session can still prove the missing charge: retry stays available.
  effects.order.mockResolvedValue({
    ...order,
    expectedMinorAmount: null,
    stripeSessionId: "cs_test_legacy",
    paymentState: null,
    quoteAcceptedAt: null,
  });
  render(
    await OrderDetailPage({
      params: Promise.resolve({ id: "local-order" }),
      searchParams: Promise.resolve({}),
    }),
  );
  expect(screen.getByRole("button", { name: "Pay now" })).toBeDefined();
});
it.each(["UNPAID", "PROCESSING", "REFUNDED", "DISPUTED", null])(
  "checkout success cannot turn persisted %s into payment confirmation",
  async (paymentState) => {
    effects.order.mockResolvedValue({ ...await effects.order(), paymentState });
    render(
      await OrderDetailPage({
        params: Promise.resolve({ id: "local-order" }),
        searchParams: Promise.resolve({ checkout: "success" }),
      }),
    );
    expect(screen.queryByText(/Payment completed/)).toBeNull();
    expect(screen.queryByText("Payment confirmed")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      "Returned from checkout",
    );
  },
);
it("held and processing orders cannot present Pay now; known paid state confirms independently of fulfillment", async () => {
  const order = await effects.order();
  effects.order.mockResolvedValue({ ...order, paymentHold: true });
  render(
    await OrderDetailPage({
      params: Promise.resolve({ id: "local-order" }),
      searchParams: Promise.resolve({}),
    }),
  );
  expect(screen.queryByRole("button", { name: "Pay now" })).toBeNull();
  cleanup();
  // An unheld PROCESSING order is still mid-transfer: no second charge offer.
  effects.order.mockResolvedValue({
    ...order,
    paymentState: "PROCESSING",
    paymentHold: false,
  });
  render(
    await OrderDetailPage({
      params: Promise.resolve({ id: "local-order" }),
      searchParams: Promise.resolve({}),
    }),
  );
  expect(screen.queryByRole("button", { name: "Pay now" })).toBeNull();
  cleanup();
  // Otherwise identical payable UNPAID control isolates the restriction.
  effects.order.mockResolvedValue({
    ...order,
    paymentState: "UNPAID",
    paymentHold: false,
  });
  render(
    await OrderDetailPage({
      params: Promise.resolve({ id: "local-order" }),
      searchParams: Promise.resolve({}),
    }),
  );
  expect(screen.getByRole("button", { name: "Pay now" })).toBeDefined();
  cleanup();
  effects.order.mockResolvedValue({
    ...order,
    status: "SHIPPED",
    paymentState: "PAID",
  });
  render(
    await OrderDetailPage({
      params: Promise.resolve({ id: "local-order" }),
      searchParams: Promise.resolve({ checkout: "success" }),
    }),
  );
  expect(screen.getByText("Payment confirmed")).toBeDefined();
  expect(screen.getByText("SHIPPED")).toBeDefined();
});
it("cross-owner order detail verifies current admin role", async () => {
  effects.auth.mockResolvedValue({
    user: { id: "stale-admin", role: "ADMIN" },
  });
  effects.user.mockResolvedValue({ role: "USER" });
  await expect(
    OrderDetailPage({
      params: Promise.resolve({ id: "local-order" }),
      searchParams: Promise.resolve({}),
    }),
  ).rejects.toThrow("redirect:/dashboard/orders");
});
it("unknown historical facts stay unknown and customer output never renders internal provider proofs", () => {
  render(
    <PaymentStatus
      state={null}
      hold={false}
      summary={{ ...summary, proofs: [{ privateInternal: "not-for-display" }] }}
    />,
  );
  expect(screen.getByText("Historical payment state unknown")).toBeDefined();
  expect(screen.queryByText(/not-for-display/)).toBeNull();
});

// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, type Mock, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import OrderPanel from "@/components/orders/OrderPanel";
import {
  calculateOrderInputSchema,
  type QuoteInputs,
} from "@/lib/pricing/schema";
import { DEFAULT_RESOLVED_CONFIG as cfg } from "@/lib/pricing/constants";
import { calculateOrder } from "@/lib/pricing/engine";
import { syntheticQuoteInputs } from "../fixtures/pricing";

const effects = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => effects }));
vi.mock("sonner", () => ({ toast: effects }));
let calculate: Mock<(inputs: QuoteInputs) => Promise<Response>>;
let create: Mock<(payload: Record<string, unknown>) => Promise<Response>>;
let tokenSequence = 0;
function response(inputs: QuoteInputs, expiresAt = Date.now() + 600000) {
  const order = calculateOrder("hungary", inputs.quantity, cfg, {
    packagingWeightGrams: 20,
    vaultAddOn: inputs.vaultAddOn,
  });
  return {
    order,
    suggestion: null,
    messages: [],
    meta: { ...cfg, pricingConfigVersion: cfg.version },
    offer: {
      token: `synthetic-ui-token-${++tokenSequence}`,
      inputs,
      expiresAt,
      charge: {
        currency: inputs.currency,
        amountMinor: Math.round(
          order.totalHuf * cfg.currencyRates[inputs.currency] * 100,
        ),
        fxRate: String(cfg.currencyRates[inputs.currency]),
        rounding: "DECIMAL_HALF_UP_MINOR_2",
      },
      terms: { version: "synthetic-v1", text: "Synthetic UI terms only" },
      service: "Synthetic service",
    },
  };
}
beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  tokenSequence = 0;
  calculate = vi.fn(async (inputs) => Response.json(response(inputs)));
  create = vi.fn(async () =>
    Response.json({ order: { id: "accepted-order" } }, { status: 201 })
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/pricing/public") {
        return Response.json({ ...cfg, pricingConfigVersion: cfg.version });
      }
      if (url === "/api/orders/calculate") {
        return calculate(
          calculateOrderInputSchema.parse(JSON.parse(String(init?.body))),
        );
      }
      if (url === "/api/orders") return create(JSON.parse(String(init?.body)));
      throw new Error(`Unexpected local test URL ${url}`);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
function panel() {
  return render(
    <OrderPanel
      submission={{ id: "ui-book", status: "APPROVED", pdfReady: true }}
      standalone
    />,
  );
}
function address() {
  const input = syntheticQuoteInputs("ui-book");
  for (
    const [label, field] of [
      ["Recipient name", "recipientName"],
      ["Address line 1", "line1"],
      ["City", "city"],
      ["Postal code", "postalCode"],
    ] as const
  ) {
    fireEvent.change(screen.getByLabelText(label), {
      target: { value: input.shippingAddress[field] },
    });
  }
}
function accept() {
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I accept this exact charge/ }),
  );
}
function place() {
  return screen.getByRole("button", {
    name: /^Place order$/,
  }) as HTMLButtonElement;
}
async function ready() {
  panel();
  address();
  await screen.findByText(/Exact charge:/);
  accept();
  await waitFor(() => expect(place().disabled).toBe(false));
}
it("never enables default/fallback pricing without a completed matching quote and explicit acceptance", async () => {
  panel();
  expect(place().disabled).toBe(true);
  expect(screen.queryByText(/Exact charge:/)).toBeNull();
  address();
  await screen.findByText(/Exact charge:/);
  expect(place().disabled).toBe(true);
  accept();
  expect(place().disabled).toBe(false);
});
it("invalidates charge and acceptance immediately on any complete input change", async () => {
  await ready();
  fireEvent.change(screen.getByLabelText("Phone (optional)"), {
    target: { value: "changed" },
  });
  expect(screen.queryByText(/Exact charge:/)).toBeNull();
  expect(place().disabled).toBe(true);
  await screen.findByText(/Exact charge:/);
  expect(place().disabled).toBe(true);
  expect(
    (screen.getByRole("checkbox", {
      name: /I accept this exact charge/,
    }) as HTMLInputElement).checked,
  ).toBe(false);
});
it("ignores slow out-of-order responses instead of showing an older input offer", async () => {
  const deferred: Array<
    { inputs: QuoteInputs; finish: (r: Response) => void }
  > = [];
  calculate.mockImplementation((inputs) =>
    new Promise((resolve) => deferred.push({ inputs, finish: resolve }))
  );
  panel();
  address();
  await waitFor(() => expect(deferred).toHaveLength(1));
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "41" } });
  await waitFor(() => expect(deferred).toHaveLength(2));
  const newerOffer = response(deferred[1].inputs);
  deferred[1].finish(Response.json(newerOffer));
  await screen.findByText(/Exact charge:/);
  accept();
  expect(place().disabled).toBe(false);
  // Flush the late response and its React updates before interacting again.
  await act(async () => {
    deferred[0].finish(Response.json(response(deferred[0].inputs)));
  });
  await waitFor(() =>
    expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe(
      "41",
    )
  );
  expect(screen.getByText(/Exact charge:/)).toBeDefined();
  fireEvent.click(place());
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  expect(create.mock.calls[0][0].quantity).toBe(41);
  expect(create.mock.calls[0][0].offerToken).toBe(newerOffer.offer.token);
});
it("rejects a response bound to different inputs and keeps checkout disabled after a calculation failure", async () => {
  calculate.mockImplementation(async (inputs) =>
    Response.json(response({ ...inputs, quantity: 99 }))
  );
  panel();
  address();
  await screen.findByText(/Quote does not match/);
  expect(place().disabled).toBe(true);
  expect(screen.queryByText(/Exact charge:/)).toBeNull();
});
it("passes only matching service and parcel facts to manual contact, never a default or stale zone", async () => {
  panel();
  const contact = () =>
    new URL(
      (screen.getAllByRole("link", { name: "Ask for a manual quote" }).at(
        -1,
      ) as HTMLAnchorElement).href,
    );
  expect(contact().searchParams.has("zone")).toBe(false);
  expect(contact().searchParams.has("weight")).toBe(false);
  address();
  await screen.findByText(/Exact charge:/);
  expect(contact().searchParams.get("zone")).toBe("hungary");
  expect(contact().searchParams.get("weight")).toBe("260");
  calculate.mockImplementation(async () =>
    Response.json({ error: "Please contact us for a manual quote." }, {
      status: 422,
    })
  );
  fireEvent.change(screen.getByLabelText("Country code (ISO)"), {
    target: { value: "GB" },
  });
  expect(contact().searchParams.has("zone")).toBe(false);
  expect(contact().searchParams.has("weight")).toBe(false);
  await screen.findByText(/Please contact us/);
  expect(contact().searchParams.has("zone")).toBe(false);
  expect(contact().searchParams.get("quantity")).toBe("40");
  expect(contact().searchParams.get("reference")).toBe("ui-book");
  expect(place().disabled).toBe(true);
});
it("expires only previews and requires fresh acceptance", async () => {
  const issuedAt = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(issuedAt);
  calculate.mockImplementation(async (inputs) =>
    Response.json(response(inputs, issuedAt + 600000))
  );
  await ready();
  clock.mockReturnValue(issuedAt + 600000);
  await waitFor(() => expect(screen.queryByText(/Exact charge:/)).toBeNull(), {
    timeout: 2500,
  });
  expect(place().disabled).toBe(true);
  expect(create).not.toHaveBeenCalled();
  calculate.mockImplementation(async (inputs) =>
    Response.json(response(inputs))
  );
  fireEvent.click(screen.getByRole("button", { name: "Request fresh quote" }));
  await screen.findByText(/Exact charge:/);
  expect(place().disabled).toBe(true);
});
it("sends zero order requests when durable storage fails before sending", async () => {
  await ready();
  const original = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(
    function (this: Storage, key, value) {
      if (this === window.sessionStorage) {
        throw new Error("Injected storage failure");
      }
      return original.call(this, key, value);
    },
  );
  fireEvent.click(place());
  expect(create).not.toHaveBeenCalled();
  expect(effects.error).toHaveBeenCalledWith(
    expect.stringContaining("no request was sent"),
  );
});
it("retains the exact key/payload through slow duplicate clicks, network ambiguity, and reload recovery", async () => {
  let reject!: (error: Error) => void;
  create.mockImplementation(() =>
    new Promise((_resolve, fail) => {
      reject = fail;
    })
  );
  await ready();
  fireEvent.click(place());
  fireEvent.click(screen.getByRole("button", { name: "Placing order..." }));
  expect(create).toHaveBeenCalledTimes(1);
  const payload = create.mock.calls[0][0];
  expect(payload.acceptTerms).toBe(true);
  reject(new Error("Injected lost response"));
  await screen.findByRole("button", { name: "Retry same order request" });
  expect(screen.getByRole("spinbutton").matches(":disabled")).toBe(true);
  cleanup();
  create.mockImplementation(async () =>
    Response.json({ order: { id: "accepted-order" }, replayed: true })
  );
  panel();
  fireEvent.click(
    await screen.findByRole("button", { name: "Retry same order request" }),
  );
  await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  expect(create.mock.calls[1][0]).toEqual(payload);
  await waitFor(() =>
    expect(effects.push).toHaveBeenCalledWith(
      "/dashboard/orders/accepted-order",
    )
  );
});
it("recovers pending requests even when optional preference storage cannot be read", async () => {
  const payload = {
    ...syntheticQuoteInputs("ui-book"),
    offerToken: "synthetic-token",
    requestKey: crypto.randomUUID(),
    acceptTerms: true,
  };
  window.sessionStorage.setItem(
    "titchybooks-pending-order:ui-book",
    JSON.stringify(payload),
  );
  const original = Storage.prototype.getItem;
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(
    function (this: Storage, key) {
      if (this === window.localStorage) {
        throw new Error("Injected optional preference failure");
      }
      return original.call(this, key);
    },
  );
  panel();
  fireEvent.click(
    await screen.findByRole("button", { name: "Retry same order request" }),
  );
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  expect(create.mock.calls[0][0]).toEqual(payload);
});
it.each(["null", "{}", "not-json"])(
  "fails closed for corrupt pending storage %s",
  async (value) => {
    window.sessionStorage.setItem("titchybooks-pending-order:ui-book", value);
    panel();
    const retry = await screen.findByRole("button", {
      name: "Retry same order request",
    }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    expect(create).not.toHaveBeenCalled();
  },
);
it.each(["null", "{}", "not-json"])(
  "offers an explicit discard recovery for corrupt pending storage %s",
  async (value) => {
    window.sessionStorage.setItem("titchybooks-pending-order:ui-book", value);
    panel();
    const discard = await screen.findByRole("button", {
      name: "Discard saved request",
    });
    expect(
      screen.queryByRole("button", { name: "Request fresh quote" }),
    ).toBeNull();
    fireEvent.click(discard);
    expect(window.sessionStorage.getItem("titchybooks-pending-order:ui-book"))
      .toBeNull();
    await screen.findByRole("button", { name: "Request fresh quote" });
    address();
    await screen.findByText(/Exact charge:/);
    accept();
    await waitFor(() => expect(place().disabled).toBe(false));
    expect(create).not.toHaveBeenCalled();
  },
);
it.each(["OFFER_REVIEW_REQUIRED", "REQUEST_KEY_CONFLICT"])(
  "clears the saved request on definitive rejection %s and unlocks a fresh order",
  async (code) => {
    await ready();
    create.mockImplementation(async () =>
      Response.json({ error: "Definitive rejection", code }, { status: 409 })
    );
    fireEvent.click(place());
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await screen.findByRole("button", { name: "Request fresh quote" });
    expect(window.sessionStorage.getItem("titchybooks-pending-order:ui-book"))
      .toBeNull();
    expect(
      screen.queryByRole("button", { name: "Retry same order request" }),
    ).toBeNull();
    await screen.findByText(/Exact charge:/);
    accept();
    await waitFor(() => expect(place().disabled).toBe(false));
  },
);
it("keeps a fresh offer usable when the browser clock runs fast", async () => {
  const realNow = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(realNow + 660000);
  calculate.mockImplementation(async (inputs) =>
    new Response(JSON.stringify(response(inputs, realNow + 600000)), {
      headers: {
        "content-type": "application/json",
        date: new Date(realNow).toUTCString(),
      },
    })
  );
  await ready();
  expect(screen.getByText(/Preview valid for about/)).toBeDefined();
  fireEvent.click(place());
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  clock.mockRestore();
});
it("never replays another submission's saved request after a prop change", async () => {
  const payload = {
    ...syntheticQuoteInputs("book-a"),
    offerToken: "synthetic-token",
    requestKey: crypto.randomUUID(),
    acceptTerms: true,
  };
  window.sessionStorage.setItem(
    "titchybooks-pending-order:book-a",
    JSON.stringify(payload),
  );
  const view = render(
    <OrderPanel
      submission={{ id: "book-a", status: "APPROVED", pdfReady: true }}
      standalone
    />,
  );
  const retry = await screen.findByRole("button", {
    name: "Retry same order request",
  }) as HTMLButtonElement;
  expect(retry.disabled).toBe(false);
  // Same mounted instance, different submission: recovery must not post A.
  view.rerender(
    <OrderPanel
      submission={{ id: "book-b", status: "APPROVED", pdfReady: true }}
      standalone
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Retry same order request" }),
  );
  expect(create).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(
      (screen.getByRole("button", {
        name: "Retry same order request",
      }) as HTMLButtonElement).disabled,
    ).toBe(true)
  );
});

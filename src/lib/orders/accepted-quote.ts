import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createOrderInputSchema } from "@/lib/pricing/schema";
import { assertOfferPolicy, digest, OfferReviewRequired, verifyOffer } from "@/lib/pricing/offer";
import { loadShippingPolicy } from "@/lib/pricing/destination";

export class OrderRequestConflict extends Error {
  readonly status = 409;
  readonly code = "REQUEST_KEY_CONFLICT";
  constructor() { super("This request key was already used for different terms. Reload and review your existing order."); }
}
export class OrderEligibilityError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export type AcceptedOrderRequest = ReturnType<typeof createOrderInputSchema.parse>;

export async function findOrderReplay(userId: string, request: AcceptedOrderRequest) {
  const { requestKey, ...payload } = request;
  const { offerToken, acceptTerms, ...inputs } = payload;
  const existing = await prisma.order.findUnique({ where: { userId_requestKey: { userId, requestKey } } });
  if (existing && existing.requestDigest !== digest({ inputs, offerToken, acceptTerms })) throw new OrderRequestConflict();
  return existing;
}

export async function acceptOrderQuote(userId: string, request: AcceptedOrderRequest) {
  const { offerToken, requestKey, acceptTerms, ...inputs } = request;
  const requestDigest = digest({ inputs, offerToken, acceptTerms });
  return prisma.$transaction(async tx => {
    // Serialize same user/key before checking expiry. A replay recovers an accepted
    // order even after its preview expires; it never issues another payment session.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(741004, hashtext(${`${userId}:${requestKey}`}))`;
    const existing = await tx.order.findUnique({ where: { userId_requestKey: { userId, requestKey } } });
    if (existing) {
      if (existing.requestDigest !== requestDigest) throw new OrderRequestConflict();
      return { order: existing, created: false, title: "" };
    }
    const offer = verifyOffer(offerToken, userId, inputs);
    assertOfferPolicy(offer, loadShippingPolicy());
    await tx.$queryRaw`SELECT "id" FROM "Submission" WHERE "id" = ${inputs.submissionId} FOR SHARE`;
    const submission = await tx.submission.findUnique({ where: { id: inputs.submissionId },
      select: { id: true, userId: true, status: true, pdfS3Key: true, title: true } });
    if (!submission) throw new OrderEligibilityError(404, "Submission not found");
    if (submission.userId !== userId) throw new OrderEligibilityError(403, "Forbidden");
    if (submission.status !== "APPROVED" || !submission.pdfS3Key) {
      throw new OrderEligibilityError(400, "Only approved books with a print PDF can be ordered");
    }
    // The preview may have expired while this request waited on the submission
    // lock. Re-check against the acceptance timestamp we are about to freeze, so
    // an expired offer can never be pinned as an immutable accepted charge.
    const quoteAcceptedAt = new Date();
    if (offer.expiresAt <= quoteAcceptedAt.getTime()) throw new OfferReviewRequired();
    const { currency: _baseCurrency, costPerBookHuf: _unitAverage, ...calculation } = offer.calculation;
    void _baseCurrency; void _unitAverage;
    const order = await tx.order.create({ data: {
      userId, submissionId: submission.id, ...calculation,
      vaultAddOn: inputs.vaultAddOn, currency: offer.charge.currency,
      status: "PENDING_PAYMENT", paymentState: "UNPAID", pricingConfigVersion: offer.pricingConfig.version,
      ...inputs.shippingAddress,
      quoteSnapshot: offer as unknown as Prisma.InputJsonValue,
      expectedMinorAmount: offer.charge.amountMinor, fxRate: new Prisma.Decimal(offer.charge.fxRate),
      quoteAcceptedAt, requestKey, requestDigest,
    } });
    return { order, created: true, title: submission.title ?? "TitchyBook" };
  });
}

import { describe, expect, it } from "vitest";
import { AiBookJobStatus, AiBookStage } from "@prisma/client";
import { deriveAiBookPhase } from "@/lib/ai/job-status";

const base = {
  status: AiBookJobStatus.QUEUED,
  stage: AiBookStage.CONCEPT,
  hasQaReport: false,
  repairCount: 0,
  errorMessage: null as string | null,
};

describe("deriveAiBookPhase", () => {
  it("reports a completed job as terminal and downloadable", () => {
    const view = deriveAiBookPhase({ ...base, status: AiBookJobStatus.COMPLETED, stage: AiBookStage.QA });
    expect(view).toMatchObject({ phase: "completed", terminal: true, retryable: false });
  });

  it("distinguishes a first queued attempt from a queued repair", () => {
    expect(deriveAiBookPhase(base)).toMatchObject({ phase: "queued", terminal: false });
    expect(deriveAiBookPhase({ ...base, hasQaReport: true, repairCount: 1 })).toMatchObject({
      phase: "repairing",
      terminal: false,
    });
  });

  it("maps each processing stage to the wording the customer sees", () => {
    const processing = AiBookJobStatus.PROCESSING;
    expect(deriveAiBookPhase({ ...base, status: processing, stage: AiBookStage.CONCEPT })).toMatchObject({
      phase: "generating",
      label: "Planning",
    });
    expect(deriveAiBookPhase({ ...base, status: processing, stage: AiBookStage.CONTENT })).toMatchObject({
      phase: "generating",
      label: "Writing",
    });
    expect(deriveAiBookPhase({ ...base, status: processing, stage: AiBookStage.COMPOSE })).toMatchObject({
      phase: "generating",
      label: "Laying out",
    });
    expect(deriveAiBookPhase({ ...base, status: processing, stage: AiBookStage.RENDER })).toMatchObject({
      phase: "waiting-for-render",
    });
    expect(deriveAiBookPhase({ ...base, status: processing, stage: AiBookStage.QA })).toMatchObject({
      phase: "reviewing",
    });
  });

  it("labels a content rewrite that follows QA as repairing, not writing", () => {
    const view = deriveAiBookPhase({
      ...base,
      status: AiBookJobStatus.PROCESSING,
      stage: AiBookStage.CONTENT,
      hasQaReport: true,
      repairCount: 1,
    });
    expect(view).toMatchObject({ phase: "repairing", label: "Revising", terminal: false });
  });

  it("treats a QA rejection as needs-review rather than a retryable failure", () => {
    const view = deriveAiBookPhase({
      ...base,
      status: AiBookJobStatus.FAILED,
      stage: AiBookStage.QA,
      errorMessage: "Text still overflows page 3.",
    });
    expect(view).toMatchObject({
      phase: "needs-review",
      message: "Text still overflows page 3.",
      terminal: true,
      retryable: false,
    });
  });

  it("keeps an infrastructure failure retryable and never leaks an empty message", () => {
    const view = deriveAiBookPhase({
      ...base,
      status: AiBookJobStatus.FAILED,
      stage: AiBookStage.CONTENT,
      errorMessage: null,
    });
    expect(view.phase).toBe("failed");
    expect(view.terminal).toBe(true);
    expect(view.retryable).toBe(true);
    expect(view.message.length).toBeGreaterThan(0);
  });
});

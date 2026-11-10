import { AiBookJobStatus, AiBookStage } from "@prisma/client";

/**
 * Customer-facing state of an AI book job.
 *
 * The durable queue has three statuses and five stages, which is the right model
 * for the worker but a poor one for a person waiting on a book: "PROCESSING at
 * CONTENT" may mean "the AI is writing" or "the AI is revising pages that
 * failed QA". The phase is derived here, once, so the status API, the creation
 * page and the dashboard cannot disagree about what a job is doing.
 */
export type AiBookPhase =
  | "queued"
  | "generating"
  | "repairing"
  | "waiting-for-render"
  | "reviewing"
  | "needs-review"
  | "completed"
  | "failed";

export interface AiBookPhaseInput {
  status: AiBookJobStatus;
  stage: AiBookStage;
  /** True once a QA report has been persisted for the current attempt. */
  hasQaReport: boolean;
  repairCount: number;
  errorMessage: string | null;
}

export interface AiBookPhaseView {
  phase: AiBookPhase;
  /** Short label for chips and step lists. */
  label: string;
  /** One sentence a customer can act on. */
  message: string;
  /** No further automatic progress will happen. */
  terminal: boolean;
  /** Starting a new generation could plausibly produce a different result. */
  retryable: boolean;
}

const FALLBACK_ERROR = "Something went wrong while building this book. You can try again.";

export function deriveAiBookPhase(input: AiBookPhaseInput): AiBookPhaseView {
  if (input.status === AiBookJobStatus.COMPLETED) {
    return {
      phase: "completed",
      label: "Ready",
      message: "Your book passed quality checks and both PDFs are ready to download.",
      terminal: true,
      retryable: false,
    };
  }

  if (input.status === AiBookJobStatus.FAILED) {
    // A QA rejection is not a transient failure: the book exists but a human has
    // to look at it, and regenerating the same prompt would reject it again.
    if (input.stage === AiBookStage.QA) {
      return {
        phase: "needs-review",
        label: "Needs review",
        message:
          input.errorMessage ??
          "Automated quality checks rejected this book. Our team can look at it with you.",
        terminal: true,
        retryable: false,
      };
    }
    return {
      phase: "failed",
      label: "Could not finish",
      message: input.errorMessage ?? FALLBACK_ERROR,
      terminal: true,
      retryable: true,
    };
  }

  const repairing = input.hasQaReport && input.repairCount > 0;

  if (input.status === AiBookJobStatus.QUEUED) {
    return repairing
      ? {
          phase: "repairing",
          label: "Revising",
          message: "Some pages failed the quality check. Your book is queued to have just those pages rewritten.",
          terminal: false,
          retryable: false,
        }
      : {
          phase: "queued",
          label: "Queued",
          message: "Your book is queued. Creation starts as soon as a worker picks it up.",
          terminal: false,
          retryable: false,
        };
  }

  switch (input.stage) {
    case AiBookStage.RENDER:
      return {
        phase: "waiting-for-render",
        label: "Producing PDFs",
        message: "The text is finished. The print sheet and the reading PDF are being produced.",
        terminal: false,
        retryable: false,
      };
    case AiBookStage.QA:
      return {
        phase: "reviewing",
        label: "Checking",
        message: "The pages are rendered. Automated checks are verifying the text, layout and PDFs.",
        terminal: false,
        retryable: false,
      };
    case AiBookStage.CONTENT:
      if (repairing) {
        return {
          phase: "repairing",
          label: "Revising",
          message: "Quality checks asked for changes, so the AI is rewriting only the pages that failed.",
          terminal: false,
          retryable: false,
        };
      }
      return {
        phase: "generating",
        label: "Writing",
        message: "The AI is writing your eight pages.",
        terminal: false,
        retryable: false,
      };
    case AiBookStage.COMPOSE:
      return {
        phase: "generating",
        label: "Laying out",
        message: "The text is written. Your book is being laid out in the template.",
        terminal: false,
        retryable: false,
      };
    case AiBookStage.CONCEPT:
    default:
      return {
        phase: "generating",
        label: "Planning",
        message: "The AI is choosing a template and planning your book.",
        terminal: false,
        retryable: false,
      };
  }
}

# Serverless Queue Drain System

<cite>
**Referenced Files in This Document**
- [queue-drain.ts](file://src/lib/queue-drain.ts)
- [route.ts (AI drain)](file://src/app\api\ai\drain\route.ts)
- [route.ts (Render drain)](file://src/app\api\render\drain\route.ts)
- [drain.yml](file://.github/workflows/drain.yml)
- [ai-book-worker.ts](file://src/workers/ai-book-worker.ts)
- [render-worker.ts](file://src/workers/render-worker.ts)
- [ai-book-job.ts](file://src/lib/ai/ai-book-job.ts)
- [pipeline.ts](file://src/lib/ai/pipeline.ts)
- [render-job.ts](file://src/lib/pdf/render-job.ts)
- [schema.prisma](file://prisma/schema.prisma)
- [queue-drain.test.ts](file://tests/unit/queue-drain.test.ts)
</cite>

## Table of Contents
1. [Introduction](#introduction)
2. [Project Structure](#project-structure)
3. [Core Components](#core-components)
4. [Architecture Overview](#architecture-overview)
5. [Detailed Component Analysis](#detailed-component-analysis)
6. [Dependency Analysis](#dependency-analysis)
7. [Performance Considerations](#performance-considerations)
8. [Troubleshooting Guide](#troubleshooting-guide)
9. [Conclusion](#conclusion)

## Introduction
This document explains the Serverless Queue Drain System used by the application to process background jobs on serverless platforms such as Vercel. Because long-lived worker processes cannot be hosted there, the system exposes short-lived HTTP endpoints that claim and process due jobs within a strict wall-clock budget. A GitHub Actions workflow triggers these endpoints every five minutes. If a job is still running when the budget expires, its lease expires and a later invocation resumes it from the last persisted stage.

The system supports two queues:
- AI book pipeline queue
- Render queue

Both queues use database-backed leases, heartbeat-based renewal, retry backoff, and terminal failure handling.

## Project Structure
The queue drain system spans API routes, shared draining logic, queue-specific claim/process implementations, workers for non-serverless environments, scheduled CI triggers, and Prisma models.

```mermaid
graph TB
subgraph "Scheduler"
GH["GitHub Actions<br/>drain.yml"]
end
subgraph "Serverless API"
AI_DRAIN["/api/ai/drain<br/>route.ts"]
RENDER_DRAIN["/api/render/drain<br/>route.ts"]
LIB_DRAIN["queue-drain.ts"]
end
subgraph "Queues"
AI_JOB["ai-book-job.ts"]
PIPELINE["pipeline.ts"]
RENDER_JOB["render-job.ts"]
end
subgraph "Workers"
AI_WORKER["ai-book-worker.ts"]
RENDER_WORKER["render-worker.ts"]
end
DB[("PostgreSQL")]
GH --> AI_DRAIN
GH --> RENDER_DRAIN
AI_DRAIN --> LIB_DRAIN
RENDER_DRAIN --> LIB_DRAIN
LIB_DRAIN --> AI_JOB
LIB_DRAIN --> RENDER_JOB
AI_JOB --> PIPELINE
RENDER_JOB --> DB
AI_WORKER --> AI_JOB
RENDER_WORKER --> RENDER_JOB
AI_JOB --> DB
PIPELINE --> DB
```

**Diagram sources**
- [drain.yml:1-44](file://.github/workflows/drain.yml#L1-L44)
- [route.ts (AI drain):1-28](file://src/app\api\ai\drain\route.ts#L1-L28)
- [route.ts (Render drain):1-27](file://src/app\api\render\drain\route.ts#L1-L27)
- [queue-drain.ts:1-91](file://src/lib/queue-drain.ts#L1-L91)
- [ai-book-job.ts:1-186](file://src/lib/ai/ai-book-job.ts#L1-L186)
- [pipeline.ts:1-371](file://src/lib/ai/pipeline.ts#L1-L371)
- [render-job.ts:1-125](file://src/lib/pdf/render-job.ts#L1-L125)
- [ai-book-worker.ts:1-34](file://src/workers/ai-book-worker.ts#L1-L34)
- [render-worker.ts:1-33](file://src/workers/render-worker.ts#L1-L33)

**Section sources**
- [drain.yml:1-44](file://.github/workflows/drain.yml#L1-L44)
- [route.ts (AI drain):1-28](file://src/app\api\ai\drain\route.ts#L1-L28)
- [route.ts (Render drain):1-27](file://src/app\api\render\drain\route.ts#L1-L27)
- [queue-drain.ts:1-91](file://src/lib/queue-drain.ts#L1-L91)

## Core Components
- Shared drain runtime: bounded loop, authorization check, budget enforcement, and summary reporting.
- Serverless drain endpoints: one per queue, guarded by a shared secret.
- Queue claim and process modules: atomic claim with lease, heartbeat, retry/backoff, terminal failures, and completion.
- Workers: long-lived polling loops for environments that support them.
- Scheduler: GitHub Actions workflow invoking drains on schedule.
- Data model: Prisma models for AI book jobs and render jobs with status, attempts, lease, and output snapshots.

Key responsibilities:
- `queue-drain.ts`: Budgeted execution loop and cron authorization helper.
- `/api/ai/drain` and `/api/render/drain`: Route handlers that enforce auth and delegate to `runDrain`.
- `ai-book-job.ts` and `pipeline.ts`: AI book lifecycle, stages, retries, and state persistence.
- `render-job.ts`: PDF rendering lifecycle, snapshot capture, and artifact publishing.
- Workers: Continuous poll-and-process loops mirroring drain behavior.
- `drain.yml`: Scheduled invocations using repository secrets.

**Section sources**
- [queue-drain.ts:1-91](file://src/lib/queue-drain.ts#L1-L91)
- [route.ts (AI drain):1-28](file://src/app\api\ai\drain\route.ts#L1-L28)
- [route.ts (Render drain):1-27](file://src/app\api\render\drain\route.ts#L1-L27)
- [ai-book-job.ts:1-186](file://src/lib/ai/ai-book-job.ts#L1-L186)
- [pipeline.ts:1-371](file://src/lib/ai/pipeline.ts#L1-L371)
- [render-job.ts:1-125](file://src/lib/pdf/render-job.ts#L1-L125)
- [ai-book-worker.ts:1-34](file://src/workers/ai-book-worker.ts#L1-L34)
- [render-worker.ts:1-33](file://src/workers/render-worker.ts#L1-L33)
- [drain.yml:1-44](file://.github/workflows/drain.yml#L1-L44)

## Architecture Overview
The system uses a dual-mode processing model:
- Serverless mode: Short-lived functions invoked by GitHub Actions. They claim due jobs and process them until the function budget expires.
- Long-lived worker mode: Node processes that continuously poll and process jobs.

Lease-based recovery ensures safe interruption:
- Claiming sets a lease expiration time and a unique token.
- Heartbeats extend the lease while work continues.
- If the lease expires, another runner can reclaim the job.
- Processors persist stage outputs so resumed runs continue from the last completed stage.

```mermaid
sequenceDiagram
participant GH as "GitHub Actions"
participant API_AI as "/api/ai/drain"
participant API_RENDER as "/api/render/drain"
participant DRAIN as "runDrain()"
participant CLAIM_AI as "claimAiBookJob()"
participant PROCESS_AI as "processAiBookJob()"
participant CLAIM_RENDER as "claimRenderJob()"
participant PROCESS_RENDER as "processRenderJob()"
participant DB as "PostgreSQL"
GH->>API_AI : POST with Bearer CRON_SECRET
API_AI->>DRAIN : runDrain(claimAiBookJob, processAiBookJob, budget)
DRAIN->>CLAIM_AI : claim()
CLAIM_AI->>DB : SELECT FOR UPDATE + UPDATE with lease
DB-->>CLAIM_AI : Job or null
CLAIM_AI-->>DRAIN : Job or null
alt Job available
DRAIN->>PROCESS_AI : process(job)
PROCESS_AI->>DB : heartbeat / advanceStage / complete/fail
else No job
DRAIN-->>API_AI : summary {claimed, finished, yielded}
end
GH->>API_RENDER : POST with Bearer CRON_SECRET
API_RENDER->>DRAIN : runDrain(claimRenderJob, processRenderJob, budget)
DRAIN->>CLAIM_RENDER : claim()
CLAIM_RENDER->>DB : SELECT FOR UPDATE + UPDATE with lease
DB-->>CLAIM_RENDER : Job or null
CLAIM_RENDER-->>DRAIN : Job or null
alt Job available
DRAIN->>PROCESS_RENDER : process(job)
PROCESS_RENDER->>DB : heartbeat / publish / fail
else No job
DRAIN-->>API_RENDER : summary {claimed, finished, yielded}
end
```

**Diagram sources**
- [drain.yml:27-43](file://.github/workflows/drain.yml#L27-L43)
- [route.ts (AI drain):12-27](file://src/app\api\ai\drain\route.ts#L12-L27)
- [route.ts (Render drain):12-26](file://src/app\api\render\drain\route.ts#L12-L26)
- [queue-drain.ts:38-90](file://src/lib/queue-drain.ts#L38-L90)
- [ai-book-job.ts:66-81](file://src/lib/ai/ai-book-job.ts#L66-L81)
- [pipeline.ts:317-370](file://src/lib/ai/pipeline.ts#L317-L370)
- [render-job.ts:36-52](file://src/lib/pdf/render-job.ts#L36-L52)
- [render-job.ts:107-124](file://src/lib/pdf/render-job.ts#L107-L124)

## Detailed Component Analysis

### Shared Drain Runtime
The shared runtime provides:
- Cron authorization via a required `CRON_SECRET` bearer token.
- A configurable wall-clock budget per invocation.
- A bounded loop that claims jobs and processes them until either no work remains or the budget is exhausted.
- Safe yielding when remaining time is too small to perform meaningful work.
- Summary metrics: claimed, finished, yielded.

```mermaid
flowchart TD
Start(["Start drain"]) --> Auth["Check CRON_SECRET"]
Auth --> |Unauthorized| Return401["Return 401 unauthorized"]
Auth --> |Authorized| Loop["While Date.now() < deadline"]
Loop --> Claim["Claim next due job"]
Claim --> |Error| Stop["Stop on transient DB error"]
Claim --> |Null| Done["No work; return summary"]
Claim --> |Job| CheckBudget["Check remaining budget"]
CheckBudget --> |Too small| Yield["Yield and stop"]
CheckBudget --> |Enough| Process["Run processor(job)"]
Process --> Outcome{"Settled before budget?"}
Outcome --> |Yes| Finish["Mark finished"]
Outcome --> |No| Yield
Finish --> Loop
Yield --> Done
Stop --> Done
```

**Diagram sources**
- [queue-drain.ts:26-31](file://src/lib/queue-drain.ts#L26-L31)
- [queue-drain.ts:38-90](file://src/lib/queue-drain.ts#L38-L90)

**Section sources**
- [queue-drain.ts:1-91](file://src/lib/queue-drain.ts#L1-L91)
- [queue-drain.test.ts:10-57](file://tests/unit/queue-drain.test.ts#L10-L57)
- [queue-drain.test.ts:59-98](file://tests/unit/queue-drain.test.ts#L59-L98)

### AI Book Queue
Responsibilities:
- Enqueue with active job limits and configuration checks.
- Atomic claim with lease and attempt tracking.
- Stage-based pipeline: CONCEPT, CONTENT, COMPOSE, RENDER, QA.
- Persistent stage outputs enabling resume after interruption.
- Retry backoff and terminal failure classification.
- Heartbeat-based lease renewal.

```mermaid
classDiagram
class AiBookJobModel {
+id
+userId
+concept
+templateId
+submissionId
+renderJobId
+status
+stage
+stageOutput
+attempts
+maxAttempts
+nextAttemptAt
+leaseExpiresAt
+claimToken
+errorMessage
+startedAt
+completedAt
}
class AiBookJobModule {
+enqueueAiBookJob(userId, concept, templateId)
+claimAiBookJob()
+heartbeatAiBookJob(job)
+advanceStage(job, stage, outputPatch, data)
+completeAiBook(job, outputPatch, extra)
+failAiBook(job, terminal, message)
}
class Pipeline {
+processAiBookJob(job)
-runConceptStage(job, state)
-runContentStage(job, state)
-runComposeStage(job, state)
-runRenderStage(job, state, lostLease)
-runQaStage(job, state)
}
AiBookJobModule --> AiBookJobModel : "reads/writes"
Pipeline --> AiBookJobModule : "uses"
```

**Diagram sources**
- [schema.prisma:223-250](file://prisma/schema.prisma#L223-L250)
- [ai-book-job.ts:42-60](file://src/lib/ai/ai-book-job.ts#L42-L60)
- [ai-book-job.ts:66-91](file://src/lib/ai/ai-book-job.ts#L66-L91)
- [ai-book-job.ts:105-185](file://src/lib/ai/ai-book-job.ts#L105-L185)
- [pipeline.ts:50-56](file://src/lib/ai/pipeline.ts#L50-L56)
- [pipeline.ts:179-301](file://src/lib/ai/pipeline.ts#L179-L301)
- [pipeline.ts:317-370](file://src/lib/ai/pipeline.ts#L317-L370)

**Section sources**
- [ai-book-job.ts:1-186](file://src/lib/ai/ai-book-job.ts#L1-L186)
- [pipeline.ts:1-371](file://src/lib/ai/pipeline.ts#L1-L371)
- [schema.prisma:223-250](file://prisma/schema.prisma#L223-L250)

### Render Queue
Responsibilities:
- Enqueue under submission locks with optional retry and force options.
- Atomic claim with lease and attempt tracking.
- Snapshot-based input capture for deterministic renders.
- Heartbeat-based lease renewal during rendering.
- Publishing artifacts and updating submission/page states.
- Terminal vs retryable failure classification.

```mermaid
flowchart TD
Start(["Process render job"]) --> Exhausted{"Exhausted attempts?"}
Exhausted --> |Yes| FailTerminal["Fail terminal"]
Exhausted --> |No| Capture["Capture or load frozen input"]
Capture --> Validate["Validate snapshot identity"]
Validate --> Generate["Generate PDF/artifacts"]
Generate --> LeaseOK{"Lease still valid?"}
LeaseOK --> |Yes| Publish["Publish artifacts and mark COMPLETED"]
LeaseOK --> |No| Skip["Skip publish; lease lost"]
Generate --> Error{"Exception?"}
Error --> |Yes| Classify["Classify terminal vs retryable"]
Classify --> FailPath["Fail terminal or requeue with backoff"]
Publish --> End(["Done"])
Skip --> End
FailPath --> End
```

**Diagram sources**
- [render-job.ts:107-124](file://src/lib/pdf/render-job.ts#L107-L124)
- [render-job.ts:68-94](file://src/lib/pdf/render-job.ts#L68-L94)
- [render-job.ts:95-106](file://src/lib/pdf/render-job.ts#L95-L106)

**Section sources**
- [render-job.ts:1-125](file://src/lib/pdf/render-job.ts#L1-L125)
- [schema.prisma:252-274](file://prisma/schema.prisma#L252-L274)

### Serverless Drain Endpoints
Each endpoint:
- Requires a matching `CRON_SECRET` bearer token.
- Delegates to `runDrain` with the appropriate claim and process functions.
- Returns a JSON summary including queue name and counts.

```mermaid
sequenceDiagram
participant Client as "GitHub Actions"
participant Route as "Drain route"
participant Auth as "isCronAuthorized"
participant Runner as "runDrain"
participant Claim as "claimXxxJob"
participant Proc as "processXxxJob"
Client->>Route : POST /api/{ai|render}/drain
Route->>Auth : validate Bearer token
Auth-->>Route : authorized?
alt Unauthorized
Route-->>Client : 401 unauthorized
else Authorized
Route->>Runner : runDrain(claim, process, budget)
Runner->>Claim : claim()
Claim-->>Runner : job or null
alt Job present
Runner->>Proc : process(job)
Proc-->>Runner : settled
else No job
Runner-->>Route : summary
end
Route-->>Client : {queue, claimed, finished, yielded}
end
```

**Diagram sources**
- [route.ts (AI drain):12-27](file://src/app\api\ai\drain\route.ts#L12-L27)
- [route.ts (Render drain):12-26](file://src/app\api\render\drain\route.ts#L12-L26)
- [queue-drain.ts:26-31](file://src/lib/queue-drain.ts#L26-L31)
- [queue-drain.ts:38-90](file://src/lib/queue-drain.ts#L38-L90)

**Section sources**
- [route.ts (AI drain):1-28](file://src/app\api\ai\drain\route.ts#L1-L28)
- [route.ts (Render drain):1-27](file://src/app\api\render\drain\route.ts#L1-L27)
- [queue-drain.ts:26-31](file://src/lib/queue-drain.ts#L26-L31)

### Workers (Long-Lived Mode)
Workers provide continuous polling for environments that can host long-running processes. They mirror the drain behavior:
- Poll for due jobs.
- Claim and process.
- Log events and reconnect on errors.
- Graceful shutdown with lease expiry reclaim.

```mermaid
flowchart TD
Start(["Worker start"]) --> Loop["Poll claimXxxJob()"]
Loop --> |Null| Sleep["Sleep pollMs"]
Sleep --> Loop
Loop --> |Job| Process["processXxxJob(job)"]
Process --> LogFinish["Log attempt-finished"]
LogFinish --> Loop
Process --> Error["Operation failed"]
Error --> Reconnect["Reconnect and sleep"]
Reconnect --> Loop
```

**Diagram sources**
- [ai-book-worker.ts:17-33](file://src/workers/ai-book-worker.ts#L17-L33)
- [render-worker.ts:17-32](file://src/workers/render-worker.ts#L17-L32)

**Section sources**
- [ai-book-worker.ts:1-34](file://src/workers/ai-book-worker.ts#L1-L34)
- [render-worker.ts:1-33](file://src/workers/render-worker.ts#L1-L33)

### Scheduler
The GitHub Actions workflow:
- Runs every five minutes.
- Calls both drain endpoints with the configured production URL and shared secret.
- Uses concurrency control to avoid overlapping runs.

```mermaid
flowchart TD
Schedule["Schedule */5 * * * *"] --> Concurrency["Concurrency group: drain-queues"]
Concurrency --> AIDrain["POST /api/ai/drain with Bearer CRON_SECRET"]
Concurrency --> RenderDrain["POST /api/render/drain with Bearer CRON_SECRET"]
```

**Diagram sources**
- [drain.yml:12-20](file://.github/workflows/drain.yml#L12-L20)
- [drain.yml:27-43](file://.github/workflows/drain.yml#L27-L43)

**Section sources**
- [drain.yml:1-44](file://.github/workflows/drain.yml#L1-L44)

## Dependency Analysis
The following diagram shows module-level dependencies between the drain runtime, endpoints, queue modules, and workers.

```mermaid
graph LR
AI_ROUTE["/api/ai/drain/route.ts"] --> DRAIN["queue-drain.ts"]
RENDER_ROUTE["/api/render/drain/route.ts"] --> DRAIN
AI_ROUTE --> AI_JOB["ai-book-job.ts"]
AI_ROUTE --> PIPELINE["pipeline.ts"]
RENDER_ROUTE --> RENDER_JOB["render-job.ts"]
AI_WORKER["ai-book-worker.ts"] --> AI_JOB
RENDER_WORKER["render-worker.ts"] --> RENDER_JOB
PIPELINE --> RENDER_JOB
```

**Diagram sources**
- [queue-drain.ts:1-91](file://src/lib/queue-drain.ts#L1-L91)
- [route.ts (AI drain):1-28](file://src/app\api\ai\drain\route.ts#L1-L28)
- [route.ts (Render drain):1-27](file://src/app\api\render\drain\route.ts#L1-L27)
- [ai-book-job.ts:1-186](file://src/lib/ai/ai-book-job.ts#L1-L186)
- [pipeline.ts:1-371](file://src/lib/ai/pipeline.ts#L1-L371)
- [render-job.ts:1-125](file://src/lib/pdf/render-job.ts#L1-L125)
- [ai-book-worker.ts:1-34](file://src/workers/ai-book-worker.ts#L1-L34)
- [render-worker.ts:1-33](file://src/workers/render-worker.ts#L1-L33)

**Section sources**
- [queue-drain.ts:1-91](file://src/lib/queue-drain.ts#L1-L91)
- [route.ts (AI drain):1-28](file://src/app\api\ai\drain\route.ts#L1-L28)
- [route.ts (Render drain):1-27](file://src/app\api\render\drain\route.ts#L1-L27)
- [ai-book-job.ts:1-186](file://src/lib/ai/ai-book-job.ts#L1-L186)
- [pipeline.ts:1-371](file://src/lib/ai/pipeline.ts#L1-L371)
- [render-job.ts:1-125](file://src/lib/pdf/render-job.ts#L1-L125)
- [ai-book-worker.ts:1-34](file://src/workers/ai-book-worker.ts#L1-L34)
- [render-worker.ts:1-33](file://src/workers/render-worker.ts#L1-L33)

## Performance Considerations
- Wall-clock budget: The drain loop stops when the budget is reached, preventing serverless timeouts. Configure `DRAIN_BUDGET_MS` within allowed bounds.
- Lease durations:
  - Render jobs: shorter lease suitable for I/O-bound rendering.
  - AI book jobs: longer lease for LLM calls.
- Heartbeat intervals:
  - Render: frequent heartbeats to keep short leases alive.
  - AI: less frequent heartbeats aligned with slower stages.
- Retry backoff: Both queues implement exponential-like delays to reduce contention and handle transient failures.
- Concurrency:
  - AI queue enforces a maximum number of active jobs per user.
  - GitHub Actions uses a concurrency group to serialize drain runs.

[No sources needed since this section provides general guidance]

## Troubleshooting Guide
Common issues and resolutions:
- Unauthorized drain requests: Ensure `CRON_SECRET` is set in the serverless environment and matches the value used by the scheduler.
- No jobs processed: Verify that due jobs exist and are not blocked by retry backoff or lease constraints.
- Frequent yields: Reduce workload or increase `DRAIN_BUDGET_MS` within platform limits.
- Lease lost mid-processing: Expected behavior; ensure processors persist stage outputs so resumed runs continue correctly.
- Terminal failures: Some errors should mark jobs FAILED without retries. Review error classification in queue processors.
- Worker shutdown: Workers exit gracefully; unfinished work is reclaimed when leases expire.

Operational checks:
- Confirm GitHub Actions secrets `PROD_URL` and `CRON_SECRET` are configured.
- Monitor drain summaries returned by endpoints for claimed, finished, and yielded counts.
- Inspect job logs for events like stage transitions, lease loss, and failures.

**Section sources**
- [queue-drain.ts:26-31](file://src/lib/queue-drain.ts#L26-L31)
- [queue-drain.ts:38-90](file://src/lib/queue-drain.ts#L38-L90)
- [ai-book-job.ts:164-185](file://src/lib/ai/ai-book-job.ts#L164-L185)
- [render-job.ts:81-94](file://src/lib/pdf/render-job.ts#L81-L94)
- [pipeline.ts:357-370](file://src/lib/ai/pipeline.ts#L357-L370)
- [render-worker.ts:17-32](file://src/workers/render-worker.ts#L17-L32)
- [ai-book-worker.ts:17-33](file://src/workers/ai-book-worker.ts#L17-L33)

## Conclusion
The Serverless Queue Drain System enables reliable background processing on serverless platforms by combining short-lived, budgeted HTTP endpoints with robust database-backed leases, heartbeats, and persistent stage outputs. It supports both serverless-driven drains and long-lived workers, ensuring consistent behavior across deployment targets. Proper configuration of secrets, budgets, and environment variables is essential for stable operation. Monitoring drain summaries and job logs helps maintain healthy throughput and quick recovery from interruptions.

[No sources needed since this section summarizes without analyzing specific files]
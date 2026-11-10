-- CreateTable
CREATE TABLE "QueueDrainRun" (
    "id" TEXT NOT NULL,
    "queue" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "claimed" INTEGER NOT NULL,
    "finished" INTEGER NOT NULL,
    "yielded" INTEGER NOT NULL,
    "errored" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QueueDrainRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QueueDrainRun_queue_startedAt_idx" ON "QueueDrainRun"("queue", "startedAt");

-- CreateIndex
CREATE INDEX "QueueDrainRun_createdAt_idx" ON "QueueDrainRun"("createdAt");

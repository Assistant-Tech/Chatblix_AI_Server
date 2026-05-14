-- CreateTable
CREATE TABLE "BusinessProfile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "tone" JSONB NOT NULL,
    "hours" JSONB NOT NULL,
    "faqs" JSONB NOT NULL,
    "policies" JSONB NOT NULL,
    "escalation" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TurnLog" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "triage" JSONB NOT NULL,
    "attempts" JSONB NOT NULL,
    "validator_pass" BOOLEAN NOT NULL DEFAULT false,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "high_severity_violations" INTEGER NOT NULL DEFAULT 0,
    "intent_path" TEXT,
    "language" TEXT,
    "shipped" TEXT NOT NULL,
    "tokens_in" INTEGER,
    "tokens_out" INTEGER,
    "duration_ms" INTEGER NOT NULL,
    "trace_id" TEXT,
    "model_triage" TEXT,
    "model_generator" TEXT,
    "model_validator" TEXT,

    CONSTRAINT "TurnLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TurnLog_business_id_ts_idx" ON "TurnLog"("business_id", "ts");

-- CreateIndex
CREATE INDEX "TurnLog_trace_id_idx" ON "TurnLog"("trace_id");

-- CreateIndex
CREATE INDEX "TurnLog_business_id_conversation_id_ts_idx" ON "TurnLog"("business_id", "conversation_id", "ts");

import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, createDraft, createUser, db } from "../fixtures/database";

const ENUM_COLUMNS = [
  ["User", "role", "UserRole"],
  ["Submission", "mode", "SubmissionMode"],
  ["Submission", "status", "SubmissionStatus"],
  ["Order", "status", "OrderStatus"],
  ["VaultEntry", "status", "VaultEntryStatus"],
  ["AiBookJob", "status", "AiBookJobStatus"],
  ["AiBookJob", "stage", "AiBookStage"],
  ["RenderJob", "status", "RenderJobStatus"],
] as const;

describe("state columns are database-enforced enums", () => {
  afterAll(async () => {
    await cleanupFixtures();
    await db.$disconnect();
  });

  it.each(ENUM_COLUMNS)("%s.%s uses the %s enum", async (table, column, enumName) => {
    const rows = await db.$queryRawUnsafe<{ udt_name: string }[]>(
      `SELECT udt_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
      table,
      column
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].udt_name).toBe(enumName);
  });

  it("rejects an undeclared state value instead of persisting it", async () => {
    const user = await createUser();
    const draft = await createDraft(user.id);

    await expect(
      db.$executeRawUnsafe(
        `UPDATE "Submission" SET "status" = 'ARCHIVED' WHERE "id" = $1`,
        draft.id
      )
    ).rejects.toThrow(/invalid input value for enum/i);

    const reloaded = await db.submission.findUniqueOrThrow({ where: { id: draft.id } });
    expect(reloaded.status).toBe("DRAFT");
  });
});

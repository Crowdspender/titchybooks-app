import EditorWorkspace from "@/components/editor/EditorWorkspace";

export default function CreatePage({
  searchParams,
}: {
  searchParams: Promise<{ submissionId?: string; new?: string }>;
}) {
  return <EditorWorkspaceContainer searchParams={searchParams} />;
}

async function EditorWorkspaceContainer({
  searchParams,
}: {
  searchParams: Promise<{ submissionId?: string; new?: string }>;
}) {
  const { submissionId, new: isNew } = await searchParams;

  // If ?new=true is passed, ignore localStorage and submissionId to force creating a new draft
  if (isNew === "true") {
    return <EditorWorkspace forceNew={true} />;
  }

  return <EditorWorkspace submissionId={submissionId} />;
}

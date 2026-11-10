"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import ImageUploader from "./ImageUploader";
import { PAGE_LABELS, type PageLabel } from "@/lib/constants";

interface UploadedImage {
  pageLabel: PageLabel;
  s3Key: string;
  originalFilename: string;
  mimeType: string;
}

/**
 * A real per-session id. `useId` only identifies a position in the tree, so it
 * repeats on every mount and two upload sessions would share object keys.
 * Falling back keeps the id a valid presign token in non-secure contexts.
 */
function createUploadSessionId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  const chunk = () =>
    Math.floor(Math.random() * 16 ** 8).toString(16).padStart(8, "0");
  return `${chunk()}-${chunk()}-${chunk()}-${chunk()}`;
}

export default function UploadGrid() {
  const router = useRouter();
  // One id for the whole mount: every page in this batch is uploaded under it,
  // and the server mints a distinct object key per upload on top of it.
  const [uploadSessionId] = useState(createUploadSessionId);
  const [uploads, setUploads] = useState<Map<PageLabel, UploadedImage>>(
    new Map(),
  );
  const [submitting, setSubmitting] = useState(false);

  const handleUploaded = useCallback(
    (pageLabel: PageLabel, s3Key: string, file: File) => {
      setUploads((prev) => {
        const next = new Map(prev);
        next.set(pageLabel, {
          pageLabel,
          s3Key,
          originalFilename: file.name,
          mimeType: file.type,
        });
        return next;
      });
    },
    [],
  );

  const allUploaded = uploads.size === 8;

  async function handleSubmit() {
    if (!allUploaded) return;
    setSubmitting(true);

    try {
      const images = PAGE_LABELS.map((label, idx) => {
        const upload = uploads.get(label)!;
        return {
          pageLabel: upload.pageLabel,
          s3Key: upload.s3Key,
          order: idx,
          originalFilename: upload.originalFilename,
          mimeType: upload.mimeType,
        };
      });

      const res = await fetch("/api/submissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Submission failed");
      }

      toast.success("Titchybooks submitted! PDF is being generated.");
      router.push("/dashboard");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Submission failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-800">
        <p>
          Upload 8 images for your Titchybooks. The final page size is
          approximately A7 portrait. Images will be automatically resized and
          center-cropped to fit.
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 justify-items-center">
        {PAGE_LABELS.map((label) => (
          <ImageUploader
            key={label}
            pageLabel={label}
            submissionId={uploadSessionId}
            onUploaded={handleUploaded}
          />
        ))}
      </div>

      <div className="text-center text-sm text-gray-500">
        {uploads.size} of 8 images uploaded
      </div>

      <div className="flex justify-center">
        <button
          onClick={handleSubmit}
          disabled={!allUploaded || submitting}
          className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {submitting ? "Submitting..." : "Create Titchybooks"}
        </button>
      </div>
    </div>
  );
}

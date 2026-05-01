"use client";

import { useState, useCallback, useId } from "react";
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

export default function UploadGrid() {
  const router = useRouter();
  const submissionId = useId().replace(/:/g, "").slice(0, 12) + Date.now();
  const [uploads, setUploads] = useState<Map<PageLabel, UploadedImage>>(
    new Map()
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
    []
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

      toast.success("Titchybook submitted! PDF is being generated.");
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
          Upload 8 images for your Titchybook. The final page size is
          approximately A7 portrait. Images will be automatically resized and
          center-cropped to fit.
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 justify-items-center">
        {PAGE_LABELS.map((label) => (
          <ImageUploader
            key={label}
            pageLabel={label}
            submissionId={submissionId}
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
          {submitting ? "Submitting..." : "Create Titchybook"}
        </button>
      </div>
    </div>
  );
}

"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { PAGE_LABEL_DISPLAY, type PageLabel } from "@/lib/constants";

interface ImageUploaderProps {
  pageLabel: PageLabel;
  submissionId: string;
  onUploaded: (pageLabel: PageLabel, s3Key: string, file: File) => void;
}

export default function ImageUploader({
  pageLabel,
  submissionId,
  onUploaded,
}: ImageUploaderProps) {
  const [preview, setPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const handleFile = useCallback(
    async (file: File) => {
      if (!file.type.match(/^image\/(jpeg|png|webp)$/)) {
        toast.error("Only JPG, PNG, or WebP files allowed");
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        toast.error("File too large (max 10MB)");
        return;
      }

      setUploading(true);

      // Show preview
      const reader = new FileReader();
      reader.onload = (e) => setPreview(e.target?.result as string);
      reader.readAsDataURL(file);

      try {
        // Get presigned URL
        const params = new URLSearchParams({
          filename: file.name,
          contentType: file.type,
          submissionId,
          pageLabel,
        });

        const res = await fetch(`/api/upload/presign?${params}`);
        if (!res.ok) throw new Error("Failed to get upload URL");

        const { uploadUrl, s3Key } = await res.json();

        // Upload directly to S3
        const uploadRes = await fetch(uploadUrl, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": file.type },
        });

        if (!uploadRes.ok) throw new Error("Upload failed");

        toast.success(`${PAGE_LABEL_DISPLAY[pageLabel]} uploaded`);
        onUploaded(pageLabel, s3Key, file);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Upload failed");
        setPreview(null);
      } finally {
        setUploading(false);
      }
    },
    [pageLabel, submissionId, onUploaded],
  );

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <span
        className="text-xs font-medium"
        style={{ color: "var(--color-text-muted)" }}
      >
        {PAGE_LABEL_DISPLAY[pageLabel]}
      </span>
      <label
        onDrop={handleDrop}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        className="relative w-28 h-40 border-2 border-dashed rounded-lg cursor-pointer flex items-center justify-center overflow-hidden transition-colors"
        style={{
          borderColor: dragOver
            ? "var(--color-primary)"
            : preview
            ? "var(--color-success)"
            : "var(--color-border-strong)",
          background: dragOver
            ? "var(--color-primary-muted)"
            : preview
            ? "var(--color-success-light)"
            : "transparent",
        }}
      >
        {uploading && (
          <div
            className="absolute inset-0 flex items-center justify-center z-10"
            style={{ background: "rgba(255,255,255,0.8)" }}
          >
            <svg
              className="animate-spin"
              width="24"
              height="24"
              viewBox="0 0 16 16"
              fill="none"
              style={{ color: "var(--color-primary)" }}
            >
              <circle
                cx="8"
                cy="8"
                r="6"
                stroke="currentColor"
                strokeWidth="2"
                strokeDasharray="30"
                strokeDashoffset="10"
              />
            </svg>
          </div>
        )}
        {preview
          ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={preview}
              alt={PAGE_LABEL_DISPLAY[pageLabel]}
              className="w-full h-full object-cover"
            />
          )
          : (
            <div className="text-center p-2">
              <svg
                className="w-6 h-6 mx-auto mb-1"
                style={{ color: "var(--color-text-subtle)" }}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                />
              </svg>
              <span
                className="text-xs"
                style={{ color: "var(--color-text-muted)" }}
              >
                Upload
              </span>
            </div>
          )}
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={handleChange}
          className="hidden"
        />
      </label>
    </div>
  );
}

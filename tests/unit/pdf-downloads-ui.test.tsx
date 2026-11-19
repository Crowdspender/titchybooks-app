// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import PdfDownloads from "@/components/submissions/PdfDownloads";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it.each([
  [true, true, 3, null],
  [true, false, 2, "Reading PDF unavailable for this book."],
  [false, true, 2, "Print sheet unavailable for this book."],
  [false, false, 0, "PDF artifacts unavailable."],
])(
  "projects artifact-specific native actions: print=%s reading=%s",
  (print, reading, links, missing) => {
    render(
      <PdfDownloads
        submissionId="book"
        printAvailable={print}
        readingAvailable={reading}
      />,
    );
    expect(screen.queryAllByRole("link")).toHaveLength(links);
    if (missing) {
      // Existence is not visibility: the explanation must not be hidden.
      const message = screen.getByText(missing);
      expect(message.hasAttribute("hidden")).toBe(false);
      expect(message.closest("[hidden]")).toBeNull();
      expect(message.closest('[aria-hidden="true"]')).toBeNull();
      expect(message.style.display).not.toBe("none");
      expect(message.style.visibility).not.toBe("hidden");
    }
    if (print) {
      expect(
        screen.getByRole("link", { name: "Download print sheet" }).getAttribute(
          "href",
        ),
      ).toBe("/api/submissions/book/downloads?kind=print");
    }
    if (reading) {
      expect(
        screen.getByRole("link", { name: "Download reading PDF" }).getAttribute(
          "href",
        ),
      ).toBe("/api/submissions/book/downloads?kind=reading");
    }
  },
);
it("keeps ordinary attachment navigation and truthful initiation feedback without fetch or window.open", () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  const open = vi.spyOn(window, "open");
  render(<PdfDownloads submissionId="book" printAvailable readingAvailable />);
  const link = screen.getByRole("link", { name: "Download print sheet" });
  expect(link.hasAttribute("download")).toBe(false); // HTTP error pages must stay visible.
  expect(link.hasAttribute("target")).toBe(false);
  // Use a hash-only test target because jsdom does not implement page navigation.
  // Actual PDF transfer/navigation is verified separately in Chromium.
  link.setAttribute("href", "#native-navigation-test");
  expect(fireEvent.click(link)).toBe(true); // Application did not prevent default.
  expect(screen.getByRole("status").textContent).toContain(
    "Download requested—check your browser downloads",
  );
  expect(screen.getByRole("status").textContent).not.toContain(
    "Saved successfully",
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});
it("preserves AI route compatibility and separates inline preview from attachments", () => {
  render(
    <PdfDownloads
      submissionId="book"
      basePath="/api/ai/books/job/downloads"
      printAvailable
      readingAvailable
    />,
  );
  expect(
    screen.getByRole("link", { name: "Download reading PDF" }).getAttribute(
      "href",
    ),
  ).toBe("/api/ai/books/job/downloads?kind=reading");
  const preview = screen.getByRole("link", { name: "Preview reading PDF" });
  expect(preview.getAttribute("href")).toBe(
    "/api/ai/books/job/downloads?kind=reading&disposition=inline",
  );
  expect(preview.getAttribute("target")).toBe("_blank");
  expect(preview.getAttribute("rel")).toContain("noopener");
  expect(screen.queryByRole("status")).toBeNull();
});

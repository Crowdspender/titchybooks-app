import { prisma } from "@/lib/prisma";
import Link from "next/link";

const PAGE_SIZE = 24;

export default async function VaultDirectoryPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page: pageStr } = await searchParams;
  const page = Math.max(Number(pageStr ?? 1), 1);
  const offset = (page - 1) * PAGE_SIZE;

  const where = { status: "STORED" };

  const [entries, total] = await Promise.all([
    prisma.vaultEntry.findMany({
      where,
      orderBy: { storedAt: "desc" },
      take: PAGE_SIZE,
      skip: offset,
      select: {
        id: true,
        title: true,
        authorName: true,
        quantity: true,
        storedAt: true,
      },
    }),
    prisma.vaultEntry.count({ where }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="page-container py-10">
      <div className="mb-10">
        <p className="section-label mb-2">The Titchybook Vault</p>
        <h1
          className="text-3xl font-semibold tracking-tight"
          style={{ color: "var(--color-text)" }}
        >
          Official Directory
        </h1>
        <p
          className="mt-2 text-sm max-w-xl"
          style={{ color: "var(--color-text-muted)" }}
        >
          A permanent archive of Titchybooks entrusted to our long-term paper
          storage service. Each entry below represents a physical work preserved
          indefinitely in the vault.
        </p>
      </div>

      {total === 0 ? (
        <div className="card p-12 text-center">
          <div
            className="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-4"
            style={{ background: "var(--color-primary-muted)" }}
          >
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--color-primary)"
              strokeWidth="1.5"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25"
              />
            </svg>
          </div>
          <p
            className="font-medium mb-1"
            style={{ color: "var(--color-text)" }}
          >
            The vault is empty
          </p>
          <p
            className="text-sm"
            style={{ color: "var(--color-text-muted)" }}
          >
            No books have been archived yet. Be the first to add yours.
          </p>
        </div>
      ) : (
        <>
          <p
            className="mb-4 text-xs"
            style={{ color: "var(--color-text-muted)" }}
          >
            {total} {total === 1 ? "entry" : "entries"} in the vault
          </p>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className="card p-5"
                style={{
                  border: "1px solid var(--color-border)",
                }}
              >
                <div className="flex items-start gap-3">
                  <div
                    className="flex-shrink-0 flex items-center justify-center w-10 h-10 rounded-lg"
                    style={{ background: "var(--color-primary-muted)" }}
                  >
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="var(--color-primary)"
                      strokeWidth="1.5"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25"
                      />
                    </svg>
                  </div>
                  <div className="min-w-0 flex-1">
                    <h2
                      className="font-semibold text-sm truncate"
                      style={{ color: "var(--color-text)" }}
                    >
                      {entry.title}
                    </h2>
                    <p
                      className="text-xs mt-0.5 truncate"
                      style={{ color: "var(--color-text-muted)" }}
                    >
                      by {entry.authorName}
                    </p>
                    <div className="flex items-center gap-3 mt-2">
                      <span
                        className="text-[11px] rounded-full px-2 py-0.5"
                        style={{
                          background: "var(--color-success-light)",
                          color: "#065F46",
                        }}
                      >
                        Stored
                      </span>
                      <span
                        className="text-[11px]"
                        style={{ color: "var(--color-text-subtle)" }}
                      >
                        {new Date(entry.storedAt).toLocaleDateString("en-US", {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        })}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="mt-8 flex items-center justify-center gap-2">
              {page > 1 && (
                <Link
                  href={`/vault?page=${page - 1}`}
                  className="btn btn-outline btn-sm"
                >
                  Previous
                </Link>
              )}
              <span
                className="text-sm px-3"
                style={{ color: "var(--color-text-muted)" }}
              >
                Page {page} of {totalPages}
              </span>
              {page < totalPages && (
                <Link
                  href={`/vault?page=${page + 1}`}
                  className="btn btn-outline btn-sm"
                >
                  Next
                </Link>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import Link from "next/link";
import VaultConsentToggle from "@/components/dashboard/VaultConsentToggle";

export const dynamic = "force-dynamic";

export default async function MyVaultPage() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return null; // middleware guards /dashboard; this is a type guard

  const entries = await prisma.vaultEntry.findMany({
    where: { order: { userId } },
    orderBy: { storedAt: "desc" },
    select: {
      id: true,
      title: true,
      authorName: true,
      quantity: true,
      status: true,
      storedAt: true,
      publicConsent: true,
    },
  });

  return (
    <div className="page-container py-10">
      <div className="mb-8">
        <p className="section-label mb-2">The Titchybook Vault</p>
        <h1
          className="text-3xl font-semibold tracking-tight"
          style={{ color: "var(--color-text)" }}
        >
          My Vault
        </h1>
        <p
          className="mt-1.5 text-sm max-w-xl"
          style={{ color: "var(--color-text-muted)" }}
        >
          Physical copies stored with us. Books are private by default —
          choosing &ldquo;Make public&rdquo; lists the title and author name in
          the{" "}
          <Link href="/vault" className="underline">
            public directory
          </Link>
          , and you can undo that at any time.
        </p>
      </div>

      {entries.length === 0
        ? (
          <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
            Nothing in the vault yet. Vault entries appear here when an order
            with the vault add-on has been paid.
          </p>
        )
        : (
          <ul className="space-y-3">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-wrap items-center gap-3 rounded-lg border p-4"
                style={{ borderColor: "var(--color-border)" }}
              >
                <div className="flex-1 min-w-40">
                  <p
                    className="font-medium"
                    style={{ color: "var(--color-text)" }}
                  >
                    {entry.title}
                  </p>
                  <p
                    className="text-sm"
                    style={{ color: "var(--color-text-muted)" }}
                  >
                    {entry.authorName} · {entry.quantity} copies ·{" "}
                    {entry.status}
                  </p>
                </div>
                <VaultConsentToggle
                  entryId={entry.id}
                  consent={entry.publicConsent}
                />
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}

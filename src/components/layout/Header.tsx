"use client";

import { signOut, useSession } from "next-auth/react";
import Link from "next/link";
import { useState } from "react";

export default function Header() {
  const { data: session } = useSession();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header
      className="sticky top-0 z-50 border-b"
      style={{
        background: "rgba(250, 250, 247, 0.92)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        borderColor: "var(--color-border)",
      }}
    >
      <div className="page-container flex h-16 items-center justify-between">
        {/* Brand */}
        <Link
          href="/"
          className="flex items-center gap-0.5 text-[1.1rem] font-semibold tracking-tight text-stone-900 no-underline"
        >
          Titchybooks
          <span
            className="inline-block w-1.5 h-1.5 rounded-full mb-2"
            style={{ background: "var(--color-primary)" }}
          />
        </Link>

        {/* Desktop nav */}
        <nav className="hidden md:flex items-center gap-1">
          {session?.user
            ? (
              <>
                <NavLink href="/dashboard">Dashboard</NavLink>
                <NavLink href="/create?new=true">New Book</NavLink>
                {session.user.role === "ADMIN" && (
                  <>
                    <NavDivider />
                    <NavLink href="/admin">Admin</NavLink>
                    <NavLink href="/admin/templates">Templates</NavLink>
                    <NavLink href="/admin/pricing">Pricing</NavLink>
                  </>
                )}
                <NavDivider />
                <span
                  className="px-3 py-1 text-xs font-medium rounded-full"
                  style={{
                    background: "var(--color-primary-muted)",
                    color: "var(--color-primary)",
                  }}
                >
                  {session.user.email?.split("@")[0]}
                </span>
                <button
                  onClick={() => signOut({ callbackUrl: "/" })}
                  className="btn btn-ghost btn-sm"
                  style={{ color: "var(--color-text-muted)" }}
                >
                  Sign out
                </button>
              </>
            )
            : (
              <>
                <NavLink href="/login">Sign in</NavLink>
                <Link
                  href="/register"
                  className="btn btn-primary btn-sm ml-2"
                >
                  Get started
                </Link>
              </>
            )}
        </nav>

        {/* Mobile menu button */}
        <button
          className="md:hidden btn btn-ghost btn-sm p-2"
          onClick={() => setMobileOpen((v) => !v)}
          aria-label="Toggle menu"
        >
          {mobileOpen
            ? (
              <svg
                width="20"
                height="20"
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <path d="M5 5l10 10M15 5L5 15" />
              </svg>
            )
            : (
              <svg
                width="20"
                height="20"
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <path d="M3 5h14M3 10h14M3 15h14" />
              </svg>
            )}
        </button>
      </div>

      {/* Mobile nav dropdown */}
      {mobileOpen && (
        <div
          className="md:hidden border-t"
          style={{
            borderColor: "var(--color-border)",
            background: "var(--color-surface)",
          }}
        >
          <div className="page-container py-4 flex flex-col gap-1">
            {session?.user
              ? (
                <>
                  <MobileNavLink
                    href="/dashboard"
                    onClick={() => setMobileOpen(false)}
                  >
                    Dashboard
                  </MobileNavLink>
                  <MobileNavLink
                    href="/create?new=true"
                    onClick={() => setMobileOpen(false)}
                  >
                    New Book
                  </MobileNavLink>
                  {session.user.role === "ADMIN" && (
                    <>
                      <div
                        className="my-2 h-px"
                        style={{ background: "var(--color-border)" }}
                      />
                      <MobileNavLink
                        href="/admin"
                        onClick={() => setMobileOpen(false)}
                      >
                        Admin
                      </MobileNavLink>
                      <MobileNavLink
                        href="/admin/templates"
                        onClick={() => setMobileOpen(false)}
                      >
                        Templates
                      </MobileNavLink>
                      <MobileNavLink
                        href="/admin/pricing"
                        onClick={() => setMobileOpen(false)}
                      >
                        Pricing
                      </MobileNavLink>
                    </>
                  )}
                  <div
                    className="my-2 h-px"
                    style={{ background: "var(--color-border)" }}
                  />
                  <div
                    className="px-3 py-1.5 text-xs font-medium rounded-full w-fit mb-1"
                    style={{
                      background: "var(--color-primary-muted)",
                      color: "var(--color-primary)",
                    }}
                  >
                    {session.user.email}
                  </div>
                  <button
                    onClick={() => signOut({ callbackUrl: "/" })}
                    className="btn btn-ghost btn-sm justify-start"
                  >
                    Sign out
                  </button>
                </>
              )
              : (
                <>
                  <MobileNavLink
                    href="/login"
                    onClick={() => setMobileOpen(false)}
                  >
                    Sign in
                  </MobileNavLink>
                  <Link
                    href="/register"
                    className="btn btn-primary btn-sm mt-2 w-fit"
                    onClick={() => setMobileOpen(false)}
                  >
                    Get started
                  </Link>
                </>
              )}
          </div>
        </div>
      )}
    </header>
  );
}

function NavLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="px-3 py-1.5 text-sm font-medium rounded-full transition-colors no-underline"
      style={{
        color: "var(--color-text-muted)",
        transition:
          "color var(--transition-fast), background var(--transition-fast)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = "var(--color-text)";
        e.currentTarget.style.background = "var(--color-border)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = "var(--color-text-muted)";
        e.currentTarget.style.background = "transparent";
      }}
    >
      {children}
    </Link>
  );
}

function NavDivider() {
  return (
    <span
      className="mx-1.5 inline-block w-px h-4"
      style={{ background: "var(--color-border-strong)" }}
    />
  );
}

function MobileNavLink({
  href,
  children,
  onClick,
}: {
  href: string;
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className="flex items-center px-3 py-2.5 text-sm font-medium rounded-lg no-underline transition-colors"
      style={{ color: "var(--color-text-muted)" }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--color-border)";
        e.currentTarget.style.color = "var(--color-text)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = "var(--color-text-muted)";
      }}
    >
      {children}
    </Link>
  );
}

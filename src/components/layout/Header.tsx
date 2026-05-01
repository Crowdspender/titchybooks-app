"use client";

import { signOut, useSession } from "next-auth/react";
import Link from "next/link";

export default function Header() {
  const { data: session } = useSession();

  return (
    <header className="border-b border-gray-200 bg-white">
      <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
        <Link href="/" className="text-lg font-bold text-blue-600">
          Titchybook
        </Link>
        <nav className="flex items-center gap-4">
          {session?.user
            ? (
              <>
                <Link
                  href="/dashboard"
                  className="text-sm text-gray-600 hover:text-gray-900"
                >
                  Dashboard
                </Link>
                <Link
                  href="/create?new=true"
                  className="text-sm text-gray-600 hover:text-gray-900"
                >
                  New Book
                </Link>
                {session.user.role === "ADMIN" && (
                  <>
                    <Link
                      href="/admin"
                      className="text-sm text-gray-600 hover:text-gray-900"
                    >
                      Admin
                    </Link>
                    <Link
                      href="/admin/templates"
                      className="text-sm text-gray-600 hover:text-gray-900"
                    >
                      Templates
                    </Link>
                    <Link
                      href="/admin/pricing"
                      className="text-sm text-gray-600 hover:text-gray-900"
                    >
                      Pricing
                    </Link>
                  </>
                )}
                <span className="text-sm text-gray-400">
                  {session.user.email}
                </span>
                <button
                  onClick={() => signOut({ callbackUrl: "/" })}
                  className="text-sm text-red-600 hover:text-red-800"
                >
                  Sign out
                </button>
              </>
            )
            : (
              <>
                <Link
                  href="/login"
                  className="text-sm text-gray-600 hover:text-gray-900"
                >
                  Sign in
                </Link>
                <Link
                  href="/register"
                  className="text-sm px-3 py-1.5 bg-blue-600 text-white rounded-md hover:bg-blue-700"
                >
                  Register
                </Link>
              </>
            )}
        </nav>
      </div>
    </header>
  );
}

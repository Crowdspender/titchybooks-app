"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

const BUSINESS_TYPES = [
  { value: "", label: "Select business type..." },
  { value: "cafe", label: "Café / Coffee Shop" },
  { value: "restaurant", label: "Restaurant / Bar" },
  { value: "retail", label: "Retail / Shop" },
  { value: "hotel", label: "Hotel / Accommodation" },
  { value: "wellness", label: "Wellness / Spa" },
  { value: "education", label: "Education / Workshop" },
  { value: "creative", label: "Creative / Design Studio" },
  { value: "nonprofit", label: "Non-profit / Community" },
  { value: "other", label: "Other" },
];

const COMPANY_SIZES = [
  { value: "", label: "Select company size..." },
  { value: "1-10", label: "1–10 employees" },
  { value: "11-50", label: "11–50 employees" },
  { value: "51-200", label: "51–200 employees" },
  { value: "200+", label: "200+ employees" },
];

export default function RegisterForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isBusiness = searchParams.get("audience") === "business";

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [businessType, setBusinessType] = useState("");
  const [companySize, setCompanySize] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    try {
      const payload: Record<string, string> = {
        name,
        email,
        password,
        audience: isBusiness ? "business" : "creator",
      };

      if (isBusiness) {
        payload.businessName = businessName;
        if (businessType) payload.businessType = businessType;
        if (companySize) payload.companySize = companySize;
      }

      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || "Registration failed");
        setLoading(false);
        return;
      }

      toast.success(
        isBusiness
          ? "Business account created! Please sign in."
          : "Account created! Please sign in.",
      );
      router.push("/login?registered=true");
    } catch {
      toast.error("Something went wrong. Please try again.");
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Business registration header */}
      {isBusiness && (
        <div
          className="rounded-lg p-4 mb-2"
          style={{
            background: "rgba(39, 199, 249, 0.08)",
            border: "1px solid rgba(39, 199, 249, 0.2)",
          }}
        >
          <p
            className="text-sm font-medium"
            style={{ color: "var(--color-primary)" }}
          >
            Business Registration
          </p>
          <p
            className="text-xs mt-1"
            style={{ color: "var(--color-text-muted)" }}
          >
            Create a business account to start distributing Titchybooks for your
            brand.
          </p>
        </div>
      )}

      {/* Personal name */}
      <div>
        <label htmlFor="name" className="label">
          {isBusiness ? "Contact Name" : "Name"}
        </label>
        <input
          id="name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          className="input"
          placeholder={isBusiness ? "Your full name" : "Your name"}
        />
      </div>

      {/* Business name (only for business) */}
      {isBusiness && (
        <div>
          <label htmlFor="businessName" className="label">
            Business Name{" "}
            <span style={{ color: "var(--color-error, #ef4444)" }}>*</span>
          </label>
          <input
            id="businessName"
            type="text"
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
            required
            className="input"
            placeholder="Your company or brand name"
          />
        </div>
      )}

      {/* Business type (only for business) */}
      {isBusiness && (
        <div>
          <label htmlFor="businessType" className="label">
            Business Type
          </label>
          <select
            id="businessType"
            value={businessType}
            onChange={(e) => setBusinessType(e.target.value)}
            className="input"
          >
            {BUSINESS_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Company size (only for business) */}
      {isBusiness && (
        <div>
          <label htmlFor="companySize" className="label">
            Company Size
          </label>
          <select
            id="companySize"
            value={companySize}
            onChange={(e) => setCompanySize(e.target.value)}
            className="input"
          >
            {COMPANY_SIZES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Email */}
      <div>
        <label htmlFor="email" className="label">
          Email
        </label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          className="input"
          placeholder="you@example.com"
        />
      </div>

      {/* Password */}
      <div>
        <label htmlFor="password" className="label">
          Password
        </label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
          className="input"
          placeholder="Min 8 characters"
        />
        <p
          className="mt-1.5 text-xs"
          style={{ color: "var(--color-text-subtle)" }}
        >
          Must be at least 8 characters
        </p>
      </div>

      <button
        type="submit"
        disabled={loading}
        className="btn btn-primary w-full btn-lg"
      >
        {loading
          ? (
            <span className="flex items-center gap-2">
              <svg
                className="animate-spin"
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
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
              Creating account...
            </span>
          )
          : isBusiness
          ? "Create business account"
          : "Create account"}
      </button>
    </form>
  );
}

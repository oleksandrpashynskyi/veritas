"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Auth screen — uses the per-user BROWSER client (anon key + session). Email/password only;
// on the local stack email confirmation is off (config.toml), so signup logs you straight in.
// Dev-only: production re-enables email confirmation (deferred).
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(kind: "login" | "signup") {
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error } =
      kind === "login"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    router.push("/facts");
    router.refresh();
  }

  return (
    <main className="mx-auto flex max-w-sm flex-1 flex-col justify-center gap-4 p-8">
      <h1 className="text-xl font-semibold">Veritas — sign in</h1>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run("login");
        }}
      >
        <input
          className="rounded border border-zinc-300 px-3 py-2"
          type="email"
          placeholder="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          className="rounded border border-zinc-300 px-3 py-2"
          type="password"
          placeholder="password (min 6 chars)"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="flex gap-2">
          <button
            className="rounded bg-zinc-900 px-4 py-2 text-white disabled:opacity-50"
            type="submit"
            disabled={busy}
          >
            Log in
          </button>
          <button
            className="rounded border border-zinc-900 px-4 py-2 disabled:opacity-50"
            type="button"
            disabled={busy}
            onClick={() => void run("signup")}
          >
            Sign up
          </button>
        </div>
      </form>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </main>
  );
}

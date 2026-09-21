import * as Tabs from "@radix-ui/react-tabs";
import { useState, type FormEvent } from "react";
import { loginBodySchema, registerBodySchema } from "@vitality/shared";
import { ApiError } from "../api/http.js";
import { useSessionStore } from "../store/session.js";
import { Field, inputClass } from "./ui.js";

function formError(issues: { message: string }[]): string {
  return issues[0]?.message ?? "Invalid input";
}

export function AuthPage(): React.JSX.Element {
  const [tab, setTab] = useState("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const login = useSessionStore((state) => state.login);
  const register = useSessionStore((state) => state.register);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    if (tab === "login") {
      const parsed = loginBodySchema.safeParse({ username, password });
      if (!parsed.success) {
        setError(formError(parsed.error.issues));
        return;
      }
      setPending(true);
      try {
        await login(parsed.data);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Login failed");
      } finally {
        setPending(false);
      }
      return;
    }
    const parsed = registerBodySchema.safeParse({
      username,
      password,
      displayName: displayName.length > 0 ? displayName : undefined,
      inviteCode: inviteCode.length > 0 ? inviteCode : undefined,
    });
    if (!parsed.success) {
      setError(formError(parsed.error.issues));
      return;
    }
    setPending(true);
    try {
      await register(parsed.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Registration failed");
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center px-4 [background-color:var(--surface-1)]">
      <div className="w-full max-w-sm rounded-lg p-6 [background-color:var(--surface-2)]">
        <h1
          className="text-center text-2xl font-bold"
          style={{ color: "var(--accent)" }}
        >
          vitality
        </h1>
        <p className="mt-1 text-center text-sm [color:var(--text-muted)]">
          Self-hosted voice and text for friends.
        </p>
        <Tabs.Root value={tab} onValueChange={setTab} className="mt-5">
          <Tabs.List
            aria-label="Authentication mode"
            className="grid grid-cols-2 gap-1 rounded p-1 [background-color:var(--surface-3)]"
          >
            <Tabs.Trigger
              value="login"
              className="rounded px-3 py-1.5 text-sm data-[state=active]:[background-color:var(--surface-1)]"
            >
              Log in
            </Tabs.Trigger>
            <Tabs.Trigger
              value="register"
              className="rounded px-3 py-1.5 text-sm data-[state=active]:[background-color:var(--surface-1)]"
            >
              Register
            </Tabs.Trigger>
          </Tabs.List>
          <form onSubmit={(event) => void submit(event)} className="mt-4 flex flex-col gap-3">
            <Field label="Username">
              <input
                aria-label="Username"
                autoComplete="username"
                className={inputClass}
                value={username}
                maxLength={32}
                onChange={(event) => setUsername(event.target.value)}
              />
            </Field>
            <Field label="Password">
              <input
                aria-label="Password"
                type="password"
                autoComplete={tab === "login" ? "current-password" : "new-password"}
                className={inputClass}
                value={password}
                maxLength={128}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
            {tab === "register" ? (
              <>
                <Field label="Display name (optional)">
                  <input
                    aria-label="Display name"
                    autoComplete="nickname"
                    className={inputClass}
                    value={displayName}
                    maxLength={64}
                    onChange={(event) => setDisplayName(event.target.value)}
                  />
                </Field>
                <Field label="Invite code (required unless you are first)">
                  <input
                    aria-label="Invite code"
                    className={inputClass}
                    value={inviteCode}
                    maxLength={64}
                    onChange={(event) => setInviteCode(event.target.value)}
                    placeholder="Ask the server owner for one"
                  />
                </Field>
              </>
            ) : null}
            {error === null ? null : (
              <p role="alert" className="text-sm text-red-400">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={pending}
              className="rounded px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
              style={{ backgroundColor: "var(--accent)" }}
            >
              {pending ? "Please wait…" : tab === "login" ? "Log in" : "Register"}
            </button>
          </form>
        </Tabs.Root>
      </div>
    </main>
  );
}

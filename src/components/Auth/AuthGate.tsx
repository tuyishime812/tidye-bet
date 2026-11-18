import React from "react";
import axios from "axios";
import Context from "../../context";
import { config } from "../../config";
import "./authGate.scss";

/**
 * Login / signup dialog.
 *
 * Opened when an unauthenticated visitor tries to place a bet, or from the
 * header's "Log in" / "Create account" buttons. Renders only when
 * `authModalOpen` is set, which the provider flips via `openAuthModal`.
 *
 * LAYOUT: a full-bleed two-column shell. The left column is the branded panel
 * (headline + perks + responsible-gambling footer); the right column is the
 * form. On narrow screens the brand panel collapses and the form takes the
 * screen. The whole thing is an overlay so it can be raised from any context.
 *
 * SECURITY: all server messages are rendered as React text nodes (never
 * dangerouslySetInnerHTML), so a malicious or malformed API message cannot
 * inject markup into the page. The dialog is keyboard-trapped and closes on
 * Escape or a backdrop click.
 */

/** Five-step password strength meter, mirroring the mockup's buckets. */
function passwordStrength(pw: string): { score: number; label: string; color: string } {
  let score = 0;
  if (pw.length >= 8) score += 1;
  if (/[0-9]/.test(pw)) score += 1;
  if (/[A-Z]/.test(pw)) score += 1;
  if (/[^A-Za-z0-9]/.test(pw)) score += 1;

  const labels = ["Too weak", "Weak", "Fair", "Good", "Strong"];
  const colors = ["#ff5a4d", "#ff5a4d", "#ffb627", "#9bd23a", "#00d4aa"];
  return { score, label: labels[score], color: colors[score] };
}

/**
 * Mirror the server's canonical phone rules so the same subscriber cannot
 * register twice by typing `0991234567`, `991234567` or `265991234567`.
 * The server remains authoritative; this only keeps the form honest.
 */
function normalisePhoneInput(value: string): string {
  let cleaned = value.trim().replace(/[\s\-().]/g, "");
  if (cleaned.startsWith("00")) cleaned = `+${cleaned.slice(2)}`;
  const digits = cleaned.replace(/^\+/, "");
  if (!/^\d+$/.test(digits)) return cleaned;

  if (/^0(88|99)\d{7}$/.test(digits)) return `+265${digits.slice(1)}`;
  if (/^265(88|99)\d{7}$/.test(digits)) return `+265${digits.slice(3)}`;
  if (/^(88|99)\d{7}$/.test(digits)) return `+265${digits}`;
  return cleaned.startsWith("+") ? `+${digits}` : digits;
}

export default function AuthGate() {
  const { authModalOpen, authReason, authMode, closeAuthModal, login } =
    React.useContext(Context) as any;

  const [mode, setMode] = React.useState<"login" | "register">("login");
  const [phoneNumber, setPhoneNumber] = React.useState("");
  const [userName, setUserName] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [acceptedTerms, setAcceptedTerms] = React.useState(false);
  const [showPassword, setShowPassword] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");

  const phoneRef = React.useRef<HTMLInputElement>(null);
  const shellRef = React.useRef<HTMLDivElement>(null);

  const isRegister = mode === "register";
  const strength = passwordStrength(password);

  // Reset transient form state each time the modal opens, and honour the mode
  // the caller asked for (e.g. the header's "Create account" button).
  React.useEffect(() => {
    if (authModalOpen) {
      setMode(authMode === "register" ? "register" : "login");
      setError("");
      setPassword("");
      setConfirmPassword("");
      setAcceptedTerms(false);
      setShowPassword(false);
      // Let the dialog paint before stealing focus.
      const t = window.setTimeout(() => phoneRef.current?.focus(), 60);
      return () => window.clearTimeout(t);
    }
  }, [authModalOpen, authMode]);

  // Close on Escape.
  React.useEffect(() => {
    if (!authModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeAuthModal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [authModalOpen, closeAuthModal]);

  // Trap Tab inside the dialog so keyboard users cannot wander into the page
  // behind an overlay.
  React.useEffect(() => {
    if (!authModalOpen) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !shellRef.current) return;

      const focusable = shellRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [authModalOpen]);

  const validate = (): string => {
    const phone = normalisePhoneInput(phoneNumber);
    if (!/^\+?[0-9]{9,15}$/.test(phone)) {
      return "Enter a valid phone number (9-15 digits)";
    }
    // Server requires >= 8 chars with at least one letter and one number.
    if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
      return "Password must be at least 8 characters and include a letter and a number";
    }
    if (isRegister) {
      if (confirmPassword !== password) {
        return "Passwords do not match";
      }
      const name = userName.trim();
      if (name && !/^[a-zA-Z0-9]{3,20}$/.test(name)) {
        return "Display name must be 3-20 letters or numbers";
      }
      if (!acceptedTerms) {
        return "Please confirm you are 18 or older and accept the terms.";
      }
    }
    return "";
  };

  const switchMode = (next: "login" | "register") => {
    setMode(next);
    setError("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;

    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }

    setLoading(true);
    setError("");

    try {
      const endpoint = mode === "login" ? "/auth/login" : "/auth/register";

      // Sign-up needs a unique username. If the player chose a display name we
      // send it; otherwise we derive one from the (unique) phone number, which
      // satisfies the server's ^[a-zA-Z0-9]{3,20}$ rule and can never collide,
      // because no two accounts share a phone number.
      const phone = normalisePhoneInput(phoneNumber);
      const name = userName.trim();
      // The derived name must satisfy ^[a-zA-Z0-9]{3,20}$; digits only, never
      // the punctuation a player may have typed into the phone field.
      const derivedName = name || `user${phone.replace(/^\+/, "")}`;

      const response = await axios.post(`${config.development_api}${endpoint}`, {
        phoneNumber: phone,
        userName: mode === "register" ? derivedName : undefined,
        password,
      });

      if (response.data?.status) {
        login(response.data.token, response.data.user);
      } else {
        setError(response.data?.message || "Authentication failed");
      }
    } catch (err: any) {
      setError(
        err.response?.data?.message ||
          err.message ||
          "Cannot reach the server. Please try again."
      );
    } finally {
      setLoading(false);
    }
  };

  if (!authModalOpen) return null;

  const titleId = "auth-gate-title";
  const descId = "auth-gate-desc";

  return (
    <div
      className="auth-gate"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeAuthModal();
      }}
    >
      <div
        className="auth-gate__shell"
        ref={shellRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
      >
        {/* ---------------------------------------------------- brand panel */}
        <aside className="auth-gate__brand">
          <div className="auth-gate__logo">
            <span className="auth-gate__logo-mark" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 34 34">
                <rect width="34" height="34" rx="9" fill="#00d4aa" />
                <path
                  d="M8 25 L17 8 L26 25 M12 19h10"
                  stroke="#03211b"
                  strokeWidth="3.4"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className="auth-gate__logo-text">
              Yanga <strong>Bet</strong>
            </span>
          </div>

          <div className="auth-gate__brand-copy">
            <h1 className="auth-gate__headline">
              Your account for
              <br />
              <em>Aviator</em>.
            </h1>
            <p className="auth-gate__lead">
              Sign in to play Aviator, manage your wallet, and cash out from a
              single secure dashboard.
            </p>
            <ul className="auth-gate__perks">
              <li>
                <span aria-hidden="true">✓</span> Real-time Aviator rounds
              </li>
              <li>
                <span aria-hidden="true">✓</span> Instant cash out
              </li>
              <li>
                <span aria-hidden="true">✓</span> Encrypted, secure account
              </li>
            </ul>
          </div>

          <p className="auth-gate__legal">
            18+ only. Gambling can be addictive. Play responsibly.
          </p>
        </aside>

        {/* ----------------------------------------------------- form panel */}
        <section className="auth-gate__side">
          <button className="auth-gate__close" onClick={closeAuthModal} aria-label="Close">
            &times;
          </button>

          <div className="auth-gate__box">
            <h2 id={titleId} className="auth-gate__title">
              {isRegister ? "Create account" : "Welcome back"}
            </h2>
            <p id={descId} className="auth-gate__sub">
              {authReason ||
                (isRegister
                  ? "Join in under a minute - all you need is a phone number."
                  : "Log in to your Yanga Bet account.")}
            </p>

            <div className="auth-gate__seg" role="tablist" aria-label="Log in or register">
              <button
                type="button"
                role="tab"
                aria-selected={!isRegister}
                className={!isRegister ? "active" : ""}
                onClick={() => switchMode("login")}
              >
                Log in
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={isRegister}
                className={isRegister ? "active" : ""}
                onClick={() => switchMode("register")}
              >
                Register
              </button>
            </div>

            <form className="auth-gate__form" onSubmit={handleSubmit} noValidate>
              {isRegister && (
                <label className="auth-gate__field">
                  <span>
                    Display name <em className="auth-gate__optional">(optional)</em>
                  </span>
                  <input
                    type="text"
                    autoComplete="nickname"
                    placeholder="How other players will see you"
                    value={userName}
                    onChange={(e) =>
                      setUserName(e.target.value.replace(/[^a-zA-Z0-9]/g, ""))
                    }
                    maxLength={20}
                  />
                </label>
              )}

              <label className="auth-gate__field">
                <span>Phone number</span>
                <input
                  ref={phoneRef}
                  type="tel"
                  inputMode="numeric"
                  autoComplete="tel"
                  placeholder="e.g. 991234567"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value.replace(/[^\d]/g, ""))}
                  maxLength={15}
                  required
                />
              </label>

              <label className="auth-gate__field">
                <span>Password</span>
                <div className="auth-gate__password">
                  <input
                    type={showPassword ? "text" : "password"}
                    autoComplete={isRegister ? "new-password" : "current-password"}
                    placeholder="At least 8 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    maxLength={128}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? "Hide" : "Show"}
                  </button>
                </div>
              </label>

              {isRegister && (
                <>
                  <div className="auth-gate__meter" aria-hidden="true">
                    <i
                      style={{
                        width: `${strength.score * 25}%`,
                        background: strength.color,
                      }}
                    />
                  </div>
                  <div className="auth-gate__hint">
                    {password
                      ? strength.label
                      : "Use 8+ characters with a number and a capital letter."}
                  </div>

                  <label className="auth-gate__field">
                    <span>Confirm password</span>
                    <input
                      type={showPassword ? "text" : "password"}
                      autoComplete="new-password"
                      placeholder="Re-enter your password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      maxLength={128}
                      required
                    />
                  </label>

                  <label className="auth-gate__terms">
                    <input
                      type="checkbox"
                      checked={acceptedTerms}
                      onChange={(e) => setAcceptedTerms(e.target.checked)}
                    />
                    <span>I am 18 or older and accept the Terms and Privacy Policy.</span>
                  </label>
                </>
              )}

              {error && (
                <div className="auth-gate__error" role="alert">
                  {error}
                </div>
              )}

              <button type="submit" className="auth-gate__submit" disabled={loading}>
                {loading ? "Please wait..." : isRegister ? "Create account" : "Log in"}
              </button>
            </form>

            <p className="auth-gate__switch">
              {isRegister ? (
                <>
                  Already registered?{" "}
                  <button type="button" onClick={() => switchMode("login")}>
                    Log in
                  </button>
                </>
              ) : (
                <>
                  New to Yanga Bet?{" "}
                  <button type="button" onClick={() => switchMode("register")}>
                    Create an account
                  </button>
                </>
              )}
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}

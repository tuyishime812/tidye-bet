import React from "react";
import { useNavigate } from "react-router-dom";
import Context from "../../context";
import "./gameSelection.scss";

/**
 * Aviator-only lobby.
 *
 * Guests are prompted to authenticate when they choose to enter the game.
 * Enforcement remains server-side (CWE-306).
 */
export default function GameSelection() {
  const navigate = useNavigate();
  const { isAuthenticated, authModalOpen, openAuthModal } =
    React.useContext(Context) as any;

  const [pendingRoute, setPendingRoute] = React.useState<string | null>(null);
  const [multiplier, setMultiplier] = React.useState(1);
  const [crashed, setCrashed] = React.useState(false);

  React.useEffect(() => {
    if (isAuthenticated && pendingRoute) {
      setPendingRoute(null);
      navigate(pendingRoute);
    }
  }, [isAuthenticated, pendingRoute, navigate]);

  React.useEffect(() => {
    if (!authModalOpen && !isAuthenticated) {
      setPendingRoute(null);
    }
  }, [authModalOpen, isAuthenticated]);

  React.useEffect(() => {
    let intervalId = 0;
    let timeoutId = 0;
    let cancelled = false;

    const runRound = () => {
      if (cancelled) return;
      let value = 1;
      const target = 2 + Math.random() * 7;
      setCrashed(false);
      setMultiplier(1);
      intervalId = window.setInterval(() => {
        value *= 1.014;
        if (value >= target) {
          window.clearInterval(intervalId);
          setMultiplier(Number(value.toFixed(2)));
          setCrashed(true);
          timeoutId = window.setTimeout(runRound, 1200);
        } else {
          setMultiplier(Number(value.toFixed(2)));
        }
      }, 55);
    };

    runRound();
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.clearTimeout(timeoutId);
    };
  }, []);

  const handleEnterAviator = () => {
    if (isAuthenticated) {
      navigate("/aviator");
      return;
    }
    setPendingRoute("/aviator");
    openAuthModal("Log in or create an account to play Aviator.");
  };

  return (
    <div className="aviator-lobby">
      <main className="aviator-lobby__hero">
        <div className="aviator-lobby__bg" aria-hidden="true" />
        <section className="aviator-lobby__card" aria-label="Aviator game">
          <p className="aviator-lobby__eyebrow">Crash game</p>
          <h1 className="aviator-lobby__title">Aviator</h1>
          <p className="aviator-lobby__subtitle">
            Watch the multiplier climb, then cash out before it flies away.
          </p>

          <div className="aviator-lobby__preview" aria-hidden="true">
            <div className={crashed ? "aviator-lobby__mult aviator-lobby__mult--crash" : "aviator-lobby__mult"}>
              {crashed ? `Flew away ${multiplier.toFixed(2)}x` : `${multiplier.toFixed(2)}x`}
            </div>
            <div className="aviator-lobby__hint">Live preview</div>
          </div>

          <div className="aviator-lobby__chips">
            <span>Real-time multiplier</span>
            <span>Instant cash out</span>
            <span>Provably fair</span>
          </div>

          <button type="button" className="aviator-lobby__cta" onClick={handleEnterAviator}>
            Enter Aviator
          </button>
        </section>
      </main>

      <footer className="aviator-lobby__foot">
        <span>Secure and encrypted</span>
        <span>24/7 support</span>
        <span>18+ only. Play responsibly</span>
      </footer>
    </div>
  );
}

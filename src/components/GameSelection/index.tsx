import React from "react";
import { useNavigate } from "react-router-dom";
import { Plane } from "lucide-react";
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

  // Follow a quadratic flight path from the bottom-left to the top-right so
  // the plane visibly climbs with the multiplier.
  const progress = Math.min(1, Math.max(0, (multiplier - 1) / 7));
  const inv = 1 - progress;
  const planeX = inv * inv * 8 + 2 * inv * progress * 45 + progress * progress * 86;
  const planeY = inv * inv * 82 + 2 * inv * progress * 78 + progress * progress * 16;
  const tangentX = 2 * inv * (45 - 8) + 2 * progress * (86 - 45);
  const tangentY = 2 * inv * (78 - 82) + 2 * progress * (16 - 78);
  const planeAngle = (Math.atan2(tangentY, tangentX) * 180) / Math.PI;

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
            <div className="aviator-lobby__sky">
              <svg className="aviator-lobby__trail" viewBox="0 0 100 100" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="aviatorTrailGradient" x1="0" y1="1" x2="1" y2="0">
                    <stop offset="0%" stopColor="#ffb627" stopOpacity="0.15" />
                    <stop offset="100%" stopColor="#ff6a4d" stopOpacity="0.9" />
                  </linearGradient>
                </defs>
                <path
                  d="M8 82 Q45 78 86 16"
                  fill="none"
                  stroke="url(#aviatorTrailGradient)"
                  strokeWidth="2"
                  strokeDasharray="1"
                  strokeDashoffset={1 - progress}
                  strokeLinecap="round"
                  pathLength={1}
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
              <span className="aviator-lobby__cloud aviator-lobby__cloud--a" />
              <span className="aviator-lobby__cloud aviator-lobby__cloud--b" />
              <span
                className={crashed ? "aviator-lobby__plane aviator-lobby__plane--crash" : "aviator-lobby__plane"}
                style={{ left: `${planeX}%`, bottom: `${100 - planeY}%` }}
              >
                <span className="aviator-lobby__plane-inner" style={{ transform: `rotate(${planeAngle}deg)` }}>
                  <Plane size={30} strokeWidth={1.8} />
                </span>
              </span>
            </div>
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

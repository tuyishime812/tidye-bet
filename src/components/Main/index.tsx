import React from "react";
import "./main.scss";
import History from "./history";
import Crash from "../Crash/index";
import Bet from "./bet";
import Context from "../../context";

type PanelKey = "f" | "s" | "t" | "q";
const PANEL_KEYS: PanelKey[] = ["f", "s", "t", "q"];

export default function Main() {
  const context = React.useContext(Context);
  const { state, userBetState, updateUserBetState, isAuthenticated } = context;

  const [betPanels, setBetPanels] = React.useState<PanelKey[]>(() => {
    try {
      const saved = localStorage.getItem("aviator_bet_panels");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          const valid = parsed.filter(
            (p: unknown): p is PanelKey =>
              typeof p === "string" && PANEL_KEYS.includes(p as PanelKey)
          );
          const unique = Array.from(new Set(valid));
          // A stale/corrupt value (e.g. ["unknown"] or []) must not leave the
          // player with zero bet panels and no way to bet.
          if (unique.length > 0) return unique;
        }
      }
    } catch (e) {
      // ignore
    }
    return ["f"];
  });

  React.useEffect(() => {
    try {
      localStorage.setItem("aviator_bet_panels", JSON.stringify(betPanels));
    } catch (e) {
      // ignore
    }
  }, [betPanels]);

  const addBetPanel = () => {
    const next = PANEL_KEYS.find((panel) => !betPanels.includes(panel));
    if (!next) return;
    setBetPanels([...betPanels, next]);
  };

  const removeBetPanel = (indexToRemove: number) => {
    if (betPanels.length <= 1) return;
    const newPanels = betPanels.filter((_, idx) => idx !== indexToRemove);
    setBetPanels(newPanels);
  };

  const betAll = () => {
    if (!isAuthenticated) {
      context.openAuthModal("Log in or create an account to place bets.");
      return;
    }
    betPanels.forEach((panel) => {
      const panelData = state.userInfo[panel];
      const alreadyBetted = userBetState[`${panel}betted`] || panelData.betted;
      if (!alreadyBetted) {
        updateUserBetState({ [`${panel}betState`]: true } as any);
      }
    });
  };

  const clearAll = () => {
    betPanels.forEach((panel) => {
      const panelData = state.userInfo[panel];
      const alreadyBetted = userBetState[`${panel}betted`] || panelData.betted;
      // Never clear a bet the server has already accepted: the player still
      // needs the CASHOUT control for it. Clearing the flag here would hide
      // the only way to cash out and lose the stake on a crash.
      if (alreadyBetted) return;
      updateUserBetState({ [`${panel}betState`]: false } as any);
    });
  };

  // Calculate total stake
  const totalStake = betPanels.reduce((sum, panel) => {
    const panelData = state.userInfo[panel];
    const isBetted = userBetState[`${panel}betted`] || panelData.betted;
    if (isBetted) return sum;
    return sum + (Number(panelData.betAmount) || 0);
  }, 0);

  
  return (
    <div className="game-play">
      <div className="result-history">
        <History />
      </div>
      <div className="stage-board">
        <div className="play-board-wrapper">
          <div className="stage-canvas">
            <Crash />
          </div>
        </div>
      </div>
      <div className="bet-controls">
        <div className="bet-controls-header" style={{ display: 'flex', gap: '10px', marginBottom: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
          <button 
            onClick={addBetPanel}
            style={{
              padding: '6px 12px',
              background: '#00d4aa',
              color: '#000',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontWeight: 'bold',
              fontSize: '12px'
            }}
          >
            + Add Bet ({betPanels.length})
          </button>
          <button 
            onClick={betAll}
            style={{
              padding: '6px 12px',
              background: '#28a909',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontWeight: 'bold',
              fontSize: '12px'
            }}
          >
            Bet All
          </button>
          <button 
            onClick={clearAll}
            style={{
              padding: '6px 12px',
              background: '#cb011a',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontWeight: 'bold',
              fontSize: '12px'
            }}
          >
            Clear All
          </button>
          <div style={{ color: '#fff', fontSize: '12px', padding: '6px 12px', background: '#1b1c1d', borderRadius: '4px' }}>
            Total Stake: {totalStake.toFixed(2)} MWK
          </div>
        </div>
        <div className="controls" style={{ display: 'flex', flexWrap: 'nowrap', gap: '10px', overflowX: 'auto', paddingBottom: '5px', maxWidth: '100%' }}>
          {betPanels.map((panelIndex, idx) => (
            <div key={panelIndex + idx} style={{ flex: '0 0 auto' }}>
              <Bet 
                index={panelIndex as 'f' | 's' | 't' | 'q'} 
                add={false}
                setAdd={() => {}}
                canRemove={betPanels.length > 1}
                onRemove={() => removeBetPanel(idx)}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

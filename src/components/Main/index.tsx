import React from "react";
import "./main.scss";
import History from "./history";
import Crash from "../Crash/index";
import Bet from "./bet";
import Context from "../../context";

type PanelKey = "f" | "s";
const BET_PANELS: PanelKey[] = ["f", "s"];

export default function Main() {
  const context = React.useContext(Context);
  const { state, userBetState, updateUserBetState, isAuthenticated } = context;

  const betAll = () => {
    if (!isAuthenticated) {
      context.openAuthModal("Log in or create an account to place bets.");
      return;
    }
    BET_PANELS.forEach((panel) => {
      const panelData = state.userInfo[panel];
      const alreadyBetted = userBetState[`${panel}betted`] || panelData.betted;
      if (!alreadyBetted) {
        updateUserBetState({ [`${panel}betState`]: true } as any);
      }
    });
  };

  // Calculate total stake across the two fixed bet panels.
  const totalStake = BET_PANELS.reduce((sum, panel) => {
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
        <div className="bet-controls-header">
          <button onClick={betAll} className="bet-all-btn">
            Bet All
          </button>
          <div className="total-stake">
            Total Stake: {totalStake.toFixed(2)} MWK
          </div>
        </div>
        <div className="controls">
          {BET_PANELS.map((panelIndex) => (
            <div key={panelIndex} className="bet-panel-item">
              <Bet index={panelIndex} add={false} setAdd={() => {}} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

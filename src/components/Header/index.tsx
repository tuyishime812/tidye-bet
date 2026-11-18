import React, { useEffect, useState } from "react";

import SettingsMenu from "./SettingsMenu";
import Context from "../../context";

import logo from "../../assets/images/logo.svg";
import "../../index.scss";
import "./header.scss";

export default function Header() {
  const { userInfo, msgTab, update } = React.useContext(Context);

  const [howto, setHowto] = React.useState<"howto" | "short" | "more" | "">(
    "howto"
  );
  const [, setFireSystem] = React.useState(false);

  const handleNewGame = () => {
    localStorage.removeItem('authToken');
    localStorage.removeItem('userInfo');
    window.location.reload();
  };

  return (
    <div className={`header flex-none items-center ${msgTab && 'chat-size'}`}>
      <div className="header-container">
        <div className="header-first">
          <div className="logo-container">
            <img src={logo} alt="logo" className="logo"></img>
          </div>
        </div>
        <div className="second-block">
          <div className="d-flex">
            <div className="user-info">
              <span className="username">{userInfo?.userName || 'Guest'}</span>
            </div>
            <div className="balance">
              <span className="amount">
                {Number(userInfo.balance).toFixed(2)}{" "}
              </span>
              <span className="currency">
                &nbsp;
                {`${userInfo?.currency ? userInfo?.currency : "MWK"
                  }`}
              </span>
            </div>
            <button className="logout-btn" onClick={handleNewGame}>
              New Game
            </button>
            <div>
              <SettingsMenu setHowto={setHowto} />
            </div>
          </div>
        </div>
      </div>
      {howto === "short" && (
        <div className="modal active">
          <div className="back" onClick={() => setHowto("howto")}></div>
          <div className="modal-dialog">
            <div className="modal-content">
              <div className="modal-header modal-bg text-uppercase">
                <span>How to Play?</span>
                <button
                  onClick={() => setHowto("")}
                  className="close modal-close"
                >
                  <span>×</span>
                </button>
              </div>
              <div className="modal-body m-body-bg">
                <div className="youtube">
                  <div className="embed-responsive">
                    <iframe
                      title="tutorial"
                      className="embed-responsive-item"
                      src="https://www.youtube.com/embed/PZejs3XDCSY?playsinline=1"
                    />
                  </div>
                </div>
                <div className="step">
                  <div className="bullet">01</div>
                  <p>
                    Place your bet and wait for the round to start.
                  </p>
                </div>
                <div className="step">
                  <div className="bullet bullet-2">02</div>
                  <p>
                    Watch the multiplier increase as the plane takes off. Your winnings grow with every second!
                  </p>
                </div>
                <div className="step">
                  <div className="bullet bullet-3">03</div>
                  <p>
                    Cash out before the plane flies away to secure your winnings!
                  </p>
                </div>
              </div>
              <div className="modal-footer m-f-bg">
                <button onClick={() => setHowto("more")}>detailed rules</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {howto === "more" && (
        <div className="modal active">
          <div className="back" onClick={() => setHowto("howto")}></div>
          <div className="modal-dialog">
            <div className="modal-content">
              <div className="modal-header ">
                <span className="text-uppercase">Game Rules</span>
                <button onClick={() => setHowto("howto")} className="close">
                  <span>×</span>
                </button>
              </div>
              <div className="modal-body p-1r">
                <p className="text-gray">
                  Aviator is a new generation of iGaming entertainment. Win big in seconds! Built on a provably fair system for complete transparency.
                </p>
                <button className="under-a" onClick={() => setFireSystem(true)}>
                  Learn about provably fair system
                </button>
                <h6 className="title-2"> How to Play </h6>
                <div className="youtube w-99">
                  <div className="embed-responsive">
                    <iframe
                      title="tutorial"
                      className="embed-responsive-item"
                      src="https://www.youtube.com/embed/PZejs3XDCSY?playsinline=1"
                    />
                  </div>
                </div>
                <h6 className="pt-5"> Aviator is as easy as 1-2-3: </h6>
                <div className="steps-container">
                  <div className="step-item">
                    <h3>01</h3>
                    <div className="step-bg-img"></div>
                    <div className="step-text pt-2">
                      <span>Bet</span> before take-off
                    </div>
                  </div>
                  <div className="step-item">
                    <h3>02</h3>
                    <div className="step-bg-img-2"></div>
                    <div className="step-text">
                      <span>Watch</span> as your Lucky Plane takes off and your winnings increase
                    </div>
                  </div>
                  <div className="step-item">
                    <h3>03</h3>
                    <div className="step-bg-img-3"></div>
                    <div className="step-text">
                      <span>Cash Out</span> before the plane disappears to win X times more!
                    </div>
                  </div>
                </div>
                <p className="text-grey mt-20">
                  Remember: If you don't Cash Out before the Lucky Plane flies away, your bet is lost. Aviator is pure excitement!
                </p>
                <div className="rules-list">
                  <div className="rules-list-title"> More Details </div>
                  <ul className="list-group">
                    <li className="list-group-item">
                      The multiplier starts at 1x and increases as the plane flies higher
                    </li>
                    <li className="list-group-item">
                      Your winnings = Your bet × Cash Out multiplier
                    </li>
                    <li className="list-group-item">
                      Each round uses provably fair random generation. Click the <span className="icon-fair"></span> icon in History to verify fairness
                    </li>
                  </ul>
                </div>
                <h6> GAME FEATURES </h6>
                <div className="rules-list pt-2">
                  <div className="rules-list-title"> Bet & Cash Out </div>
                  <ul className="list-group">
                    <li className="list-group-item">
                      Enter your bet amount and press "Bet" to place your wager
                    </li>
                    <li className="list-group-item">
                      Use the + button to add a second bet panel for simultaneous bets
                    </li>
                    <li className="list-group-item">
                      Press "Cash Out" anytime during the flight to secure your winnings
                    </li>
                    <li className="list-group-item">
                      If you don't cash out before the plane flies away, you lose your bet
                    </li>
                  </ul>
                </div>
                <div className="rules-list pt-2">
                  <div className="rules-list-title"> Auto Play & Auto Cash Out </div>
                  <ul className="list-group">
                    <li className="list-group-item">
                      Auto Play: Set the number of rounds to bet automatically
                    </li>
                    <li className="list-group-item">
                      Stop if balance decreases by: Auto stops after specified losses
                    </li>
                    <li className="list-group-item">
                      Stop if balance increases by: Auto stops after specified winnings
                    </li>
                    <li className="list-group-item">
                      Stop if single win exceeds: Auto stops after a big win
                    </li>
                    <li className="list-group-item">
                      Auto Cash Out: Automatically cash out at your chosen multiplier
                    </li>
                  </ul>
                </div>
                <div className="rules-list pt-2">
                  <div className="rules-list-title"> Live Bets & Statistics </div>
                  <ul className="list-group">
                    <li className="list-group-item">
                      Live Bets panel shows all current round bets
                    </li>
                    <li className="list-group-item">
                      My Bets shows your betting history and cash out details
                    </li>
                    <li className="list-group-item">
                      Top panel displays biggest wins and highest multipliers
                    </li>
                  </ul>
                </div>
                <div className="rules-list pt-2">
                  <div className="rules-list-title"> Fairness & Security </div>
                  <ul className="list-group">
                    <li className="list-group-item">
                      Provably Fair algorithm ensures 100% transparent and fair results
                    </li>
                    <li className="list-group-item">
                      Verify any round's fairness using the verification tool
                    </li>
                    <li className="list-group-item">
                      Server seed, client seeds, and combined hash are publicly verifiable
                    </li>
                  </ul>
                </div>
                <div className="rules-list pt-2">
                  <div className="rules-list-title"> Return to Player </div>
                  <ul className="list-group">
                    <li className="list-group-item">
                      Theoretical RTP: 97%
                    </li>
                    <li className="list-group-item">
                      On average, 3 out of 100 rounds end with instant crash at 1x
                    </li>
                  </ul>
                </div>
                <div className="rules-list pt-2">
                  <div className="rules-list-title"> Important </div>
                  <ul className="list-group">
                    <li className="list-group-item">
                      Connection loss during active bet: Auto cash out at current multiplier
                    </li>
                    <li className="list-group-item">
                      Technical malfunctions: All affected bets are refunded
                    </li>
                    <li className="list-group-item">
                      Play responsibly. This game involves financial risk
                    </li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

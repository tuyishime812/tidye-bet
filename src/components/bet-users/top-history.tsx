import React, { useEffect } from "react";
import MoonLoader from "react-spinners/MoonLoader";
import "./bets.scss";
import { config } from "../../config";

const TopHistory = () => {
  const [history, setHistory] = React.useState([]);
  const [loadingEffect, setLoadingEffect] = React.useState(false);

  const callTopBets = async () => {
    try {
      setLoadingEffect(true);
      const response = await fetch(`${config.development_api}/game/top-bets?limit=20`);
      if (response.ok) {
        const data = await response.json();
        setHistory(data.data || []);
        setTimeout(() => {
          setLoadingEffect(false);
        }, 500);
      } else {
        console.log(`HTTP error! status: ${response.status}`);
      }
    } catch (error: any) {
      console.log("callTopBets", error);
      setLoadingEffect(false);
    }
  };
  useEffect(() => {
    callTopBets();
  }, []);
  return (
    <div className="top-list-wrapper">
      <div className="top-items-list scroll-y h-100">
        {loadingEffect ? (
          <div className="flex items-center justify-center top-14">
            <MoonLoader
              color="red"
              size={35}
              data-testid="loader"
            />
          </div>
        ) : (
          <>
            {history && history.length > 0 ? history.map((item: any, index: number) => (
              <div key={index} className="bet-item">
                <div className="main">
                  <div className="icon">
                    <img
                      className="avatar"
                      alt="avatar"
                      src="/avatars/av-5.png"
                    ></img>
                    <div className="username">{item.user_name?.slice(0, 1) + '***' + item.user_name?.slice(-1) || 'd***3'}</div>
                  </div>
                  <div className="score">
                    <div className="flex">
                      <div className="">
                        <span>Bet, MWK:&nbsp;</span>
                        <span></span>
                      </div>
                      <span className="amount">
                        {item.bet_amount ? item.bet_amount.toFixed(2) : '0.00'}
                      </span>
                    </div>
                    <div className="flex">
                      <div className="">
                        <span>Cashed out:&nbsp;</span>
                      </div>
                      <span className="amount cashout">
                        {item.cash_out_at ? item.cash_out_at.toFixed(2) : '0.00'}x
                      </span>
                    </div>
                    <div className="flex">
                      <div className="">
                        <span>Win, MWK: &nbsp;</span>
                      </div>
                      <span className="amount">
                        {item.profit ? item.profit.toFixed(2) : '0.00'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )) : (
              <div className="text-center p-4 text-gray">No top bets yet</div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default TopHistory;

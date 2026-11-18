import React from "react"
import Context, { BettedUserType, UserType } from "../../context";
// import { useCrashContext } from "../Main/context";

interface AllDataProps {
    pre: boolean
    setPre: React.Dispatch<React.SetStateAction<boolean>>
    allData: UserType[] | BettedUserType[]
}

const AllData = ({ pre, setPre, allData }: AllDataProps) => {
    const state = React.useContext(Context)
    
    // Get current user's name to highlight their bets
    const currentUserName = state.userInfo?.userName || '';

    return (
        <>
            <div>
                <div className="all-bets-block">
                    <div>
                        <div className="uppercase">ALL BETS</div>
                        <div className="live-count">👥 {state.bettedUsers?.length || 0} Players</div>
                    </div>
                    <div className={`previous-hand items-center flex justify-between ${pre ? "click" : ""}`}>
                        <div className="history-i"></div>
                        <span className="ml-1 " onClick={() => { setPre(!pre) }}>Previous hand</span>
                    </div>
                </div>
                <div className="spacer"></div>
                <div className="legend">
                    <span className="user">Player</span>
                    <span className="bet">Bet</span>
                    <span>X</span>
                    <span className="cash-out">Cash Out</span>
                </div>
            </div>
            <div className="cdk-virtual-scroll-viewport">
                <div className="cdk-virtual-scroll-content-wrapper">
                    {allData?.map((user, key) => {
                        const isMe = user.name === currentUserName;
                        const isCashedOut = user.cashouted && user.cashOut > 0;
                        
                        return (
                            <div 
                                className={`bet-item ${isCashedOut ? "celebrated" : ""} ${isMe ? "is-me" : ""}`} 
                                key={key}
                            >
                                <div className="user">
                                    {user.img ?
                                        <img className="avatar" src={user.img} alt="avatar" /> :
                                        <img className="avatar" src="./avatars/av-5.png" alt="avatar" />
                                    }
                                    <div className="username">
                                        {isMe ? (
                                            <span className="me-badge">👤 {user.name}</span>
                                        ) : (
                                            <span>{user.name?.slice(0, 1) + "***" + user.name?.slice(-1)}</span>
                                        )}
                                    </div>
                                </div>
                                <div className="bet">
                                    {Number(user.betAmount).toFixed(2)}
                                </div>
                                {user.cashouted &&
                                    <div className="multiplier-block">
                                        <div className={`bubble ${isCashedOut ? "won" : "lost"}`}>
                                            {Number(user.cashOut || user.target).toFixed(2)}x
                                        </div>
                                    </div>
                                }
                                <div className="cash-out">
                                    {isCashedOut ? Number(user.cashOut).toFixed(2) : ""}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </>
    )
};

export default AllData;
import React from "react";
// import { useCrashContext } from "../Main/context";
import Context from "../../context";
import { SeedModal } from "../Main/seedModal";

const MyBets = () => {
    const state = React.useContext(Context)
    // const [state] = useCrashContext();

    // Round verification modal. A bet carries the flyDetailID of the round it
    // was placed in; the server resolves that to its seeds and crash point.
    const [modalParam, setModalParam] = React.useState({
        modalState: false,
        flyDetailId: ""
    });

    const openSeedModal = (flyDetailId: string) => {
        if (!flyDetailId) return;
        setModalParam({ modalState: true, flyDetailId });
    };

    return (
        <>
            <div className="legend">
                <div className="date">Date</div>
                <div className="bet-100">
                    <span className="bet">Bet, MWK</span>
                    <span>X</span>
                    <span className="cash-out"> Cash out, MWK </span>
                </div>
                <div className="tools"></div>
            </div>
            <div className="cdk-virtual-scroll-viewport">
                <div className="cdk-virtual-scroll-content-wrapper">
                    {state && state.state.myBets.map((user, key) => (
                        <div className={`bet-item pr-2 ${user.cashouted ? "celebrated" : ""}`} key={key}>
                            <div className="user">
                                <div className="username">{new Date(user.date).getHours() + ":" + new Date(user.date).getMinutes()}</div>
                            </div>
                            <div className="bet">
                                {Number(user.betAmount).toFixed(2)}
                            </div>
                            {user.cashouted &&
                                <div className="multiplier-block">
                                    <div className="bubble">{Number(user.cashoutAt).toFixed(2)}</div>
                                </div>
                            }
                            <div className="cash-out">{user.cashouted ? Number(user.betAmount * user.cashoutAt).toFixed(2) : ""}</div>
                            <div className="tools">
                                <div
                                    className="fairness-i"
                                    role="button"
                                    tabIndex={0}
                                    title="Verify this round"
                                    onClick={() => openSeedModal(user.flyDetailID)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter" || e.key === " ") {
                                            e.preventDefault();
                                            openSeedModal(user.flyDetailID);
                                        }
                                    }}
                                ></div>
                                <div className="share-i"></div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {modalParam.modalState && (
                <SeedModal setModal={setModalParam} modalParam={modalParam} />
            )}
        </>
    )
}

export default MyBets;

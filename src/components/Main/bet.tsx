import React, { useEffect } from "react";
// import { useCrashContext } from "../context";
import { toast } from 'react-toastify';
import Context, { callCashOut } from "../../context";

interface BetProps {
	index: 'f' | 's' | 't' | 'q'
	add: boolean
	setAdd: any
	canRemove?: boolean
	onRemove?: () => void
}
type FieldNameType = 'betAmount' | 'decrease' | 'increase' | 'singleAmount'
type BetOptType = '20' | '50' | '100' | '1000'
type GameType = 'manual' | 'auto'

const Bet = ({ index, add, setAdd, canRemove, onRemove }: BetProps) => {
	const context = React.useContext(Context)
	const { state,
		fbetted, sbetted, tbetted, qbetted,
		fbetState, sbetState, tbetState, qbetState,
		GameState,
		minBet, maxBet,
		currentTarget,
		update,
		updateUserBetState,
		openWallet
	} = context;
	const [cashOut, setCashOut] = React.useState(2);

	// `index` is a panel key ('f' | 's' | 't' | 'q'), and UserType guarantees
	// all four panels exist, so this is a safe direct lookup.
	const panel = state.userInfo[index];
	const auto = panel.auto;
	// Use BOTH local state AND userInfo.betted for instant update
	const betted = (index === 'f' ? fbetted : index === 's' ? sbetted : index === 't' ? tbetted : qbetted) || panel.betted;
	const deState = state[`${index}deState`];
	const inState = state[`${index}inState`];
	const betState = index === 'f' ? fbetState : index === 's' ? sbetState : index === 't' ? tbetState : qbetState;
	const decrease = state[`${index}decrease`];
	const increase = state[`${index}increase`];
	const autoCound = state[`${index}autoCound`];
	const betAmount = panel.betAmount;
	const autoCashoutState = state[`${index}autoCashoutState`];
	const single = state[`${index}single`];
	const singleAmount = state[`${index}singleAmount`];
	// A stake larger than the player's balance must never reach the server.
	// The server enforces the same rule through the ledger; this is the UI half
	// so the player gets an actionable "Add funds" button instead of a rejected
	// bet and a toast.
	const balance = Number(state.userInfo.balance) || 0
	const stakeValue = Number(betAmount) || 0
	const insufficient = stakeValue > balance
	const invalidStake = stakeValue <= 0 || !Number.isFinite(stakeValue)

	const [gameType, setGameType] = React.useState<GameType>("manual");
	const [betOpt, setBetOpt] = React.useState<BetOptType>("20");
	const [showModal, setShowModal] = React.useState(false);
	const [myBetAmount, setMyBetAmount] = React.useState(20);
	const [cashingOut, setCashingOut] = React.useState(false);
	// const { index } = props;

	useEffect(() => {
		if (!betted || GameState !== "PLAYING") {
			setCashingOut(false);
		}
	}, [betted, GameState]);

	const minus = (type: FieldNameType) => {
		update((prev) => {
			if (type === "betAmount") {
				const current = Number(prev.userInfo[index].betAmount) || 0;
				const nextAmount = current - 1 < minBet ? minBet : Number((current - 1).toFixed(2));
				return {
					userInfo: {
						...prev.userInfo,
						[index]: { ...prev.userInfo[index], betAmount: nextAmount },
					},
				} as Partial<typeof prev>;
			}
			const key = `${index}${type}` as keyof typeof prev;
			const current = Number(prev[key]) || 0;
			const nextVal = current - 0.1 < 0.1 ? 0.1 : Number((current - 0.1).toFixed(2));
			return { [key]: nextVal } as Partial<typeof prev>;
		});
	}

	const plus = (type: FieldNameType) => {
		update((prev) => {
			if (type === "betAmount") {
				const current = Number(prev.userInfo[index].betAmount) || 0;
				const balanceNow = Number(prev.userInfo.balance) || 0;
				let nextAmount = Number((current + 0.1).toFixed(2));
				if (nextAmount > balanceNow) nextAmount = Math.round(balanceNow * 100) / 100;
				if (nextAmount > maxBet) nextAmount = maxBet;
				return {
					userInfo: {
						...prev.userInfo,
						[index]: { ...prev.userInfo[index], betAmount: nextAmount },
					},
				} as Partial<typeof prev>;
			}
			const key = `${index}${type}` as keyof typeof prev;
			const current = Number(prev[key]) || 0;
			const balanceNow = Number(prev.userInfo.balance) || 0;
			let nextVal = Number((current + 0.1).toFixed(2));
			if (nextVal > balanceNow) nextVal = Math.round(balanceNow * 100) / 100;
			return { [key]: nextVal } as Partial<typeof prev>;
		});
	}

	const manualPlus = (amount: number, btnNum: BetOptType) => {
		if (betOpt !== btnNum) setBetOpt(btnNum);
		update((prev) => {
			const current = Number(prev.userInfo[index].betAmount) || 0;
			const nextAmount =
				betOpt === btnNum
					? Math.min(maxBet, Number((current + amount).toFixed(2)))
					: Number(Number(amount).toFixed(2));
			return {
				userInfo: {
					...prev.userInfo,
					[index]: { ...prev.userInfo[index], betAmount: nextAmount },
				},
			} as Partial<typeof prev>;
		});
	}

	const changeBetType = (e: GameType) => {
		updateUserBetState({ [`${index}betState`]: false });
		setGameType(e);
	}

	const onChangeBlur = (e: number, type: 'cashOutAt' | 'decrease' | 'increase' | 'singleAmount') => {
		if (type === "cashOutAt") {
			const next = e < 1.01 ? 1.01 : Math.round(e * 100) / 100;
			setCashOut(next);
			update((prev) => ({
				userInfo: {
					...prev.userInfo,
					[index]: { ...prev.userInfo[index], target: next },
				},
			} as Partial<typeof prev>));
			return;
		}
		const nextVal = e < 0.1 ? 0.1 : Math.round(e * 100) / 100;
		const key = `${index}${type}` as keyof typeof state;
		update({ [key]: nextVal } as any);
	}

	const onBetClick = (s: boolean) => {
		if (s) {
			if (invalidStake) {
				toast.error("Enter a valid bet amount")
				return
			}
			if (insufficient) {
				toast.error(`Insufficient balance. You have ${balance.toFixed(2)} MWK - add funds to bet ${stakeValue.toFixed(2)} MWK.`)
				return
			}
		}
		updateUserBetState({ [`${index}betState`]: s })
	}
	const setCount = (amount: number) => {
		update({ [`${index}autoCound`]: amount } as any);
	}

	const reset = () => {
		update({
			[`${index}autoCound`]: 0,
			[`${index}decrease`]: 0,
			[`${index}increase`]: 0,
			[`${index}singleAmount`]: 0,
			[`${index}deState`]: false,
			[`${index}inState`]: false,
			[`${index}single`]: false,
		})
	}

	const onAutoBetClick = (_betState: boolean) => {
		if (_betState) {
			if (invalidStake) {
				toast.error("Enter a valid bet amount")
				return
			}
			if (insufficient) {
				toast.error(`Insufficient balance. You have ${balance.toFixed(2)} MWK - add funds to start auto play.`)
				return
			}
		}
		update((prev) => ({
			userInfo: {
				...prev.userInfo,
				[index]: { ...prev.userInfo[index], auto: _betState },
			},
		} as any));

		updateUserBetState({ [`${index}betState`]: _betState });
	}

	const onStartBtnClick = () => {
		if (autoCound > 0) {
			if (deState || inState || single) {
				if (singleAmount > 0 || decrease > 0 || increase > 0) {
					if (inState || deState || single) {
						onAutoBetClick(true);
						setShowModal(false);
					} else {
						toast.error("Please, specify decrease or exceed stop point");
					}
				} else {
					toast.error("Can't see 0.00 as stop point");
				}
			} else {
				toast.error("Please, specify decrease or exceed stop point");
			}
		} else {
			toast.error("Please, set number of rounds");
		}
	}
	// Auto-cashout is executed server-side at the requested target (see
	// playBet -> bet.autoCashout in server/game/gameLogic.js). The old effect
	// here fired a second cashOut from the browser, which could arrive after the
	// server had already settled the bet and produce a confusing error toast.

	useEffect(() => {
		setMyBetAmount(betAmount);
	},[betAmount])

	return (
		<div className="bet-control">
			<div className="controls" style={{ position: 'relative' }}>
				{canRemove && onRemove && (
					<div className="sec-hand-btn minus" onClick={onRemove} style={{ position: 'absolute', top: '5px', right: '5px', zIndex: 10 }}></div>
				)}
				<div className="navigation">
					<div className="navigation-switcher">
						{(betted || betState) ?
							<>
								<button className={gameType === "manual" ? "active" : ""} >Bet</button>
								<button className={gameType === "auto" ? "active" : ""} >Auto</button>
							</> :
							<>
								<button className={gameType === "manual" ? "active" : ""} onClick={() => changeBetType("manual")}>Bet</button>
								<button className={gameType === "auto" ? "active" : ""} onClick={() => changeBetType("auto")}>Auto</button>
							</>
						}
					</div>
				</div>
				<div className="first-row">
					<div className="bet-block">
						<div className="bet-spinner">
							<div className={`spinner ${betState || betted ? "disabled" : ""}`}>
								<div className="buttons">
									<button className="minus" onClick={() => betState || betted ? "" : minus("betAmount")}></button>
								</div>
								<div className="input">
									{betState || betted ?
										<input type="number" value={Number(myBetAmount)} readOnly ></input>
										:
										<input type="number" value={Number(myBetAmount)}
											onChange={e => {
												const raw = Number(e.target.value);
												const nextAmount = raw > maxBet ? maxBet : raw < 0 ? 0 : raw;
												update((prev) => ({
													userInfo: {
														...prev.userInfo,
														[`${index}`]: { ...prev.userInfo[index], betAmount: nextAmount },
													},
												} as any));
											}}></input>
									}
								</div>
								<div className="buttons">
									<button className="plus" onClick={() => betState || betted ? "" : plus("betAmount")}></button>
								</div>
							</div>
						</div>
						{betState || betted ?
							<div className="bet-opt-list">
								<button className="bet-opt disabled">
									<span>20</span>
								</button>
								<button className="bet-opt disabled">
									<span>50</span>
								</button>
								<button className="bet-opt disabled">
									<span>100</span>
								</button>
								<button className="bet-opt disabled">
									<span>1000</span>
								</button>
							</div>
							:
							<div className="bet-opt-list">
								<button onClick={() => manualPlus(20, "20")} className="bet-opt">
									<span>20</span>
								</button>
								<button onClick={() => manualPlus(50, "50")} className="bet-opt">
									<span>50</span>
								</button>
								<button onClick={() => manualPlus(100, "100")} className="bet-opt">
									<span>100</span>
								</button>
								<button onClick={() => manualPlus(1000, "1000")} className="bet-opt">
									<span>1000</span>
								</button>
							</div>
						}
					</div>
					<div className="buttons-block">
						{betted ? GameState === "PLAYING" ?
							<button
								className="btn-waiting"
								disabled={cashingOut}
								onClick={() => {
									if (cashingOut) return;
									setCashingOut(true);
									callCashOut(currentTarget, index);
								}}
							>
								<span>
									<label>{cashingOut ? "CASHING OUT..." : "CASHOUT"}</label>
									<label className="amount">
										<span>{Number(betAmount * currentTarget).toFixed(2)}</span>
										<span className="currency">MWK</span>
									</label>
								</span>
							</button>
							: <button className="btn-danger" disabled><label>BET PLACED</label></button> : betState ?
							<>
								<div className="btn-tooltip">Queued for next round</div>
								<button className="btn-danger h-[70%]" onClick={() => {
									onBetClick(false);
									update((prev) => ({
										[`${index}autoCound`]: 0,
										userInfo: {
											...prev.userInfo,
											[index]: { ...prev.userInfo[index], auto: false },
										},
									} as any));
								}}><label>CANCEL</label></button>
							</> :
							invalidStake ?
								<button className="btn-danger" disabled>
									<label>ENTER AMOUNT</label>
								</button> :
							insufficient ?
								<>
									<div className="btn-tooltip">Insufficient balance</div>
									<button onClick={openWallet} className="btn-success">
										<span>
											<label>ADD FUNDS</label>
											<label className="amount">
												<span>{Math.max(0, stakeValue - balance).toFixed(2)}</span>
												<span className="currency">MWK</span>
											</label>
										</span>
									</button>
								</> :
							<button onClick={() => onBetClick(true)} className="btn-success">
								<span>
									<label>BET</label>
									<label className="amount">
										<span>{Number(betAmount).toFixed(2)}</span>
										<span className="currency">MWK</span>
									</label>
								</span>
							</button>
						}
					</div>
				</div>
				{/* Auto */}
				{
					gameType === "auto" &&
					<>
						<div className="border-line"></div>
						<div className="second-row">
							<div className="auto-bet-wrapper">
								<div className="auto-bet">
									{auto ? (
										<button onClick={() => onAutoBetClick(false)} className="auto-play-btn btn-danger" >{autoCound}</button>
									) : (
										<button onClick={() => { setShowModal(true); }} className="auto-play-btn btn-primary">AUTO PLAY</button>
									)}
								</div>
							</div>
							<div className="cashout-block">
								<div className="cashout-switcher">
									<label className="label">Auto Cash Out</label>
									{betted || betState ? (
										<div className={`input-switch ${autoCashoutState ? "" : "off"}`}>
											<span className="oval"></span>
										</div>
									) : (
										<div onClick={() => { update({ [`${index}autoCashoutState`]: !autoCashoutState }) }} className={`input-switch ${autoCashoutState ? "" : "off"}`}>
											<span className="oval"></span>
										</div>
									)}
								</div>
								<div className="cashout-snipper-wrapper">
									<div className="cashout-snipper">
										<div className={`snipper small ${autoCashoutState && !betState ? "" : "disabled"}`}>
											<div className="input">
												{autoCashoutState && !betState ? (
													<input type="number"
														onChange={(e) => {
															const next = Number(e.target.value);
															setCashOut(next);
															update((prev) => ({
																userInfo: {
																	...prev.userInfo,
																	[`${index}`]: { ...prev.userInfo[index], target: next },
																},
															} as any));
														}}
														value={cashOut}
														onBlur={(e) => onChangeBlur(Number(e.target.value) || 0, "cashOutAt")}
													/>
												) : (
													<input type="number" value={cashOut.toFixed(2)} readOnly />
												)}
											</div>
											<span className="text">x</span>
										</div>
									</div>
								</div>
							</div>
						</div>
					</>
				}
			</div >
			{showModal &&
				<div className="modal">
					<div onClick={() => setShowModal(false)} className="back"></div>
					<div className="modal-dialog">
						<div className="modal-content">
							<div className="modal-header">
								<span>Auto play options</span>
								<button className="close" onClick={() => setShowModal(false)}>
									<span>x</span>
								</button>
							</div>
							<div className="modal-body">
								<div className="content-part content-part-1">
									<span>Number of Rounds:</span>
									<div className="rounds-wrap">
										<button
											className={`btn-secondary ${autoCound === 10 ? "onClick" : ""}`}
											onClick={() => setCount(10)}>
											10</button>
										<button
											className={`btn-secondary ${autoCound === 20 ? "onClick" : ""}`}
											onClick={() => setCount(20)}>
											20</button>
										<button
											className={`btn-secondary ${autoCound === 50 ? "onClick" : ""}`}
											onClick={() => setCount(50)}>
											50</button>
										<button
											className={`btn-secondary ${autoCound === 100 ? "onClick" : ""}`}
											onClick={() => setCount(100)}>
											100</button>
									</div>
								</div>
								<div className="content-part">
									<div className={`input-switch ${deState ? "" : "off"}`}
										onClick={() => {
											update({ [`${index}deState`]: !deState, [`${index}decrease`]: 0 });
										}}
									>
										<span className="oval"></span>
									</div>
									<span className="title">Stop if cash decreases by</span>
									<div className="spinner">
										{deState ?
											<div className="m-spinner">
												<div className="buttons">
													<button onClick={() => minus("decrease")} className="minus"></button>
												</div>
												<div className="input">
													<input type="number" onChange={(e) => update({ [`${index}decrease`]: Number(e.target.value) })} value={decrease}
														onBlur={(e) => onChangeBlur(Number(e.target.value) || 0, "decrease")}
													/>
												</div>
												<div className="buttons">
													<button onClick={() => plus("decrease")} className="plus"></button>
												</div>
											</div> :
											<div className="m-spinner disabled">
												<div className="buttons">
													<button disabled className="minus"></button>
												</div>
												<div className="input">
													<input type="number" readOnly value={Number(decrease).toFixed(2)} />
												</div>
												<div className="buttons">
													<button disabled className="plus"></button>
												</div>
											</div>}
									</div>
									<span >MWK</span>
								</div>
								<div className="content-part">
									<div className={`input-switch ${inState ? "" : "off"}`}
										onClick={() => {
											update({ [`${index}inState`]: !inState, [`${index}increase`]: 0 });
										}}
									>
										<span className="oval"></span>
									</div>
									<span className="title">Stop if cash increases by</span>
									<div className="spinner">
										{inState ? <div className="m-spinner">
											<div className="buttons">
												<button onClick={() => minus("increase")} className="minus"></button>
											</div>
											<div className="input">
												<input type="number" onChange={(e) => update({ [`${index}increase`]: Number(e.target.value) })} value={increase}
													onBlur={(e) => onChangeBlur(Number(e.target.value), "increase")}
												/>
											</div>
											<div className="buttons">
												<button onClick={() => plus("increase")} className="plus"></button>
											</div>
										</div> : <div className="m-spinner disabled">
											<div className="buttons">
												<button disabled className="minus"></button>
											</div>
											<div className="input">
												<input type="number" readOnly value={Number(increase).toFixed(2)} />
											</div>
											<div className="buttons">
												<button disabled className="plus"></button>
											</div>
										</div>}
									</div>
									<span >MWK</span>
								</div>
								<div className="content-part">
									<div className={`input-switch ${single ? "" : "off"}`}
										onClick={() => {
											update({ [`${index}single`]: !single, [`${index}singleAmount`]: 0 });
										}}
									>
										<span className="oval"></span>
									</div>
									<span className="title">Stop if single win exceeds</span>
									<div className="spinner">
										{!!single ?
											<div className="m-spinner">
												<div className="buttons">
													<button onClick={() => minus("singleAmount")} className="minus"></button>
												</div>
												<div className="input">
													<input type="number" onChange={(e) => update({ [`${index}singleAmount`]: Number(e.target.value) })} value={singleAmount}
														onBlur={(e) => onChangeBlur(Number(e.target.value), "singleAmount")}
													/>
												</div>
												<div className="buttons">
													<button onClick={() => plus("singleAmount")} className="plus" ></button>
												</div>
											</div> :
											<div className="m-spinner disabled">
												<div className="buttons ">
													<button disabled className="minus"></button>
												</div>
												<div className="input">

													<input type="number" readOnly value={singleAmount.toFixed(2)} />
												</div>
												<div className="buttons">
													<button disabled className="plus"></button>
												</div>
											</div>
										}
									</div>
									<span >MWK</span>
								</div>
							</div>
							<div className="modal-footer">
								<div className="btns-wrapper">
									<button className="reset-btn btn-waiting" onClick={reset}>Reset</button>
									<button className="start-btn btn-success" onClick={onStartBtnClick}>Start</button>
								</div>
							</div>
						</div>
					</div>
				</div>
			}
		</div >
	)
}

export default Bet
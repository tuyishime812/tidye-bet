import React, { useEffect, useState } from "react"
import CryptoJS from 'crypto-js';
import Context from "../../context";
import { Oval } from "react-loader-spinner";

export const SeedModal = ({ setModal, modalParam }: any) => {
    const { handleGetSeedOfRound } = React.useContext(Context);
    const [date, setDate] = useState('');
    const [loading, setLoading] = useState(false);
    const [sha512Hash, setSha512Hash] = useState<string>('');
    const [seedDetails, setSeedDetails] = useState<any>(null);

    const getSeedDetails = async () => {
        setLoading(true);
        const data = await handleGetSeedOfRound(modalParam.flyDetailId);
        setLoading(false);
        setSeedDetails(data);
        setDate('');
        setSha512Hash('');
        if (!data) return;

        try {
            const newDate = new Date(data.createdAt);
            const localTime = newDate.toLocaleTimeString([], { hour12: false });
            setDate(localTime);
        } catch (error) {
            console.log("Invalid date from round details", error);
        }

        let combinedSeed = data.serverSeed || '';
        if (Array.isArray(data.clientSeeds)) {
            combinedSeed += data.clientSeeds.join('');
        }
        const hashObject = CryptoJS.SHA512(combinedSeed).toString(CryptoJS.enc.Hex);
        setSha512Hash(hashObject);
    }

    useEffect(() => {
        getSeedDetails();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [modalParam.flyDetailId])
    return (
        <div className={`modal ${modalParam.modalState && 'active'}`}>
            <div className="back" onClick={() => setModal({ modalState: false, flyDetailId: '' })}></div>
            <div className="modal-dialog">
                <div className="modal-content">
                    <div className="modal-header">
                        <span className="modal-title">ROUND </span>
                        {seedDetails &&
                            <div className="header__info">
                                <div className={`bubble-multiplier ${Number(seedDetails?.crashPoint) < 2 ? "blue" : Number(seedDetails?.crashPoint) < 10 ? "purple" : "big"}`}>{Number(seedDetails?.crashPoint).toFixed(2)}x</div>

                                <div style={{ paddingLeft: '5px' }}>{date}</div>
                            </div>
                        }
                        <button className="close" onClick={() => setModal({ modalState: false, flyDetailId: '' })}>
                            <span>x</span>
                        </button>
                    </div>
                    <div className="modal-body">
                        <div className="content-wrapper">
                            {loading ? <div className="content-loading">
                                <Oval
                                    height={35}
                                    width={35}
                                    color="red"
                                    wrapperClass=""
                                    visible={true}
                                    ariaLabel="oval-loading"
                                    secondaryColor="#990000"
                                    strokeWidth={3}
                                    strokeWidthSecondary={4}
                                />
                            </div> :
                                <div className="content">
                                    {!seedDetails && (
                                        <div className="content-part">
                                            <div className="title">
                                                <span>Round details are not available.</span>
                                            </div>
                                        </div>
                                    )}
                                    {seedDetails && (
                                        <>
                                            <div className="content-part">
                                                <div className="title">
                                                    <div className="icon-server"></div>
                                                    <div className="text">
                                                        <span>Server Seed:</span>
                                                        <div className="tip">Generated on our side</div>
                                                    </div>
                                                </div>
                                                <div className="value">
                                                    <input readOnly type="text" className="value-input" value={seedDetails?.serverSeed} />
                                                </div>
                                            </div>
                                            <div className="content-part pt-3">
                                                <div className="title">
                                                    <div className="icon-client"></div>
                                                    <div className="text">
                                                        <span>Client Seed:</span>
                                                        <div className="tip">Generated on players side</div>
                                                    </div>
                                                </div>
                                                {Array.isArray(seedDetails?.clientSeeds) && seedDetails.clientSeeds.length > 0 ? seedDetails.clientSeeds.map((seed: string, key: number) => (
                                                    <div className="client" key={key}>
                                                        <div className="value">
                                                            <div className="player">
                                                                <span>Player N{key + 1}:</span>
                                                            </div>
                                                            <div className="seed">
                                                                <span>Seed:</span>
                                                                <div className="seed-value">{`${seed}`}</div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                )) : (
                                                    <div className="value">
                                                        <input readOnly type="text" className="value-input" value="No client seeds for this round" />
                                                    </div>
                                                )}
                                            </div>
                                            <div className="content-part pt-3">
                                                <div className="title">
                                                    <div className="icon-hash"></div>
                                                    <div className="text">
                                                        <span>Combined SHA512 Hash:</span>
                                                        <div className="tip">Above seeds combined and converted to SHA512 Hash. This is your game result</div>
                                                    </div>
                                                </div>
                                                <div className="value">
                                                    <input readOnly type="text" className="value-input" value={sha512Hash} />
                                                </div>
                                            </div>
                                            <div className="content-part pt-3 result">
                                                <div className="title">
                                                    <span>Hex:</span>
                                                    <span>Decimal:</span>
                                                    <span>Result:</span>
                                                </div>
                                                <div className="value">
                                                    <span className="white">{sha512Hash?.slice(0, 13)}</span>
                                                    <span className="white">{parseInt(sha512Hash.slice(0, 13) || '', 16)}</span>
                                                    {/* PostgREST may hand NUMERIC back as a string, so coerce
                                                        before calling toFixed (previously threw here). */}
                                                    <span className="white">{Number(seedDetails?.crashPoint || 0).toFixed(2)}</span>
                                                </div>
                                            </div>
                                        </>
                                    )}
                                </div>
                            }
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}
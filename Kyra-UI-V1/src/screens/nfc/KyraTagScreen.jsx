import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { nfcApi, TAG_ACTIVE, TAG_FINAL, tagStatusText } from "../../api/nfcClient.js";
import AppHeader from "../../components/AppHeader.jsx";
import KyraLoader from "../../components/KyraLoader.jsx";
import OptionCard from "../../components/OptionCard.jsx";
import { useKyraSession } from "../../context/KyraSessionContext.jsx";
import { BYE_PATH } from "../../lib/shopRoutes.js";
import { phaseOf } from "../../state/sessionReducer.js";
import "./KyraTagScreen.css";

const POLL_MS = 1000;
const DONE_MS = 10000; // after "Tag successfully programmed", on to Bye

/**
 * KYRA AI NFC Tags: "Would you like a Kyra Tag?" after "I'm done", before Bye.
 *
 *   YES: the backend queues a tag job with the visit's short link (https://kyra.style/s/…); the Raspberry Pi
 *        by the mirror takes it, waits for a blank tag, writes it, reads it back. This screen shows each step
 *        as the backend reports it, and says the tag is ready only when the job is "succeeded", which the
 *        backend accepts only after the Pi's read-back check.
 *   NO:  the same link as a QR code, to open the Kyra Canvas on a phone.
 *
 * Shown only when the backend has Kyra Tags on (NFC_TAGS) and a tag writer polled it recently; otherwise
 * this goes straight to Bye. Leaving before a tag is placed cancels the job, so nothing is written later.
 */
export default function KyraTagScreen() {
  const navigate = useNavigate();
  const { state } = useKyraSession();
  const session = state.session;
  const sessionId = session?.id;
  const phase = phaseOf(session);
  const [stage, setStage] = useState("checking"); // checking | ask | job | link
  const [job, setJob] = useState(null); // { jobId, status, error }
  const [link, setLink] = useState(null); // { url, qrDataUrl }
  const [problem, setProblem] = useState("");
  const jobRef = useRef(null);
  jobRef.current = job;

  const bye = useCallback(() => navigate(BYE_PATH, { replace: true }), [navigate]);

  // No visit to keep, or no tag writer: nothing to offer.
  useEffect(() => {
    if (!sessionId || phase === "ended" || phase === "none") {
      bye();
      return undefined;
    }
    let live = true;
    nfcApi
      .status()
      .then((status) => {
        if (!live) return;
        if (status.enabled && status.deviceOnline) setStage("ask");
        else bye();
      })
      .catch(() => live && bye());
    return () => {
      live = false;
    };
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // The job's progress, from the backend (which hears it from the Pi).
  const jobId = job?.jobId;
  const finished = job ? TAG_FINAL.includes(job.status) : false;
  useEffect(() => {
    if (!jobId || finished) return undefined;
    const timer = setInterval(() => {
      nfcApi
        .job(jobId)
        .then((next) => setJob((current) => (current?.jobId === next.jobId ? next : current)))
        .catch(() => {}); // a missed poll: the next one catches up
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [jobId, finished]);

  useEffect(() => {
    if (job?.status !== "succeeded") return undefined;
    const timer = setTimeout(bye, DONE_MS);
    return () => clearTimeout(timer);
  }, [job?.status, bye]);

  // Leaving before the tag is on the reader: cancel, so the Pi doesn't write it for nobody.
  useEffect(
    () => () => {
      const current = jobRef.current;
      if (current && ["queued", "waiting_for_tag"].includes(current.status)) nfcApi.cancel(current.jobId).catch(() => {});
    },
    [],
  );

  const issue = async () => {
    setProblem("");
    setStage("job");
    setJob({ jobId: null, status: "queued", error: null });
    try {
      const created = await nfcApi.issue(sessionId);
      setJob(created);
    } catch (error) {
      setJob({ jobId: null, status: "failed", error: null });
      setProblem(error.message);
    }
  };

  const showLink = async () => {
    const current = jobRef.current;
    if (current?.jobId && TAG_ACTIVE.includes(current.status)) nfcApi.cancel(current.jobId).catch(() => {});
    setProblem("");
    setStage("link");
    try {
      setLink(await nfcApi.link(sessionId));
    } catch (error) {
      setProblem(error.message);
    }
  };

  if (stage === "checking") return <KyraLoader label="One moment" />;
  return <KyraTagView stage={stage} status={job?.status} error={job?.error} problem={problem} link={link} onYes={issue} onNo={showLink} onDone={bye} />;
}

/**
 * The screen itself, without the backend (also for /dev/tag-* previews).
 * stage: ask | job | link; status, error: the tag job's; link: { url, qrDataUrl }; problem: a request error.
 */
export function KyraTagView({ stage, status = "queued", error = null, problem = "", link = null, onYes, onNo, onDone }) {
  if (stage === "ask") {
    return (
      <div className="screen kyra-tag">
        <AppHeader />
        <div className="kyra-tag__prompt">
          <h1 className="title kyra-tag__title">Would you like a Kyra Tag?</h1>
          <p className="screen__text kyra-tag__text">A tag that opens your Kyra Canvas when you tap it with your phone.</p>
        </div>
        <div className="button-stack kyra-tag__actions">
          <OptionCard label="Yes, get a Kyra Tag" width="w840" onClick={onYes} />
          <OptionCard label="No, continue without a tag" width="w840" onClick={onNo} />
        </div>
      </div>
    );
  }

  if (stage === "link") {
    return (
      <div className="screen kyra-tag">
        <AppHeader />
        <div className="kyra-tag__prompt">
          <h1 className="title kyra-tag__title">Your Kyra Canvas</h1>
          <p className="screen__text kyra-tag__text">{problem || "Scan the code with your phone to open it."}</p>
        </div>
        {link?.qrDataUrl && <img className="kyra-tag__qr" src={link.qrDataUrl} alt="QR code of your Kyra Canvas link" width="400" height="400" />}
        {link?.url && <p className="kyra-tag__url">{link.url.replace(/^https?:\/\//, "")}</p>}
        <div className="button-stack kyra-tag__actions kyra-tag__actions--low">
          <OptionCard label="I’m done" width="w840" onClick={onDone} />
        </div>
      </div>
    );
  }

  // stage === "job": only "succeeded" says the tag is ready (the Pi read it back).
  const view = tagStatusText(status === "cancelled" ? "failed" : status, error);
  const busy = TAG_ACTIVE.includes(status);
  const failed = status === "failed" || status === "cancelled";
  return (
    <div className="screen kyra-tag">
      <AppHeader />
      <div className="kyra-tag__prompt" role="status" aria-live="polite">
        <h1 className={`title kyra-tag__title${status === "succeeded" ? " kyra-tag__title--ok" : ""}`}>{view.title}</h1>
        <p className="screen__text kyra-tag__text">{problem || view.text}</p>
      </div>
      {busy && (
        <div className="kyra-tag__reader" aria-hidden="true">
          <span className={`kyra-tag__ring${status === "writing" || status === "verifying" ? " kyra-tag__ring--writing" : ""}`} />
        </div>
      )}
      <div className="button-stack kyra-tag__actions kyra-tag__actions--job">
        {status === "succeeded" && <OptionCard label="I’m done" width="w840" onClick={onDone} />}
        {failed && (
          <>
            <OptionCard label="Try again" width="w840" onClick={onYes} />
            <OptionCard label="Show a QR code instead" width="w840" onClick={onNo} />
            <OptionCard label="I’m done" width="w840" onClick={onDone} />
          </>
        )}
        {status === "waiting_for_tag" && <OptionCard label="No thanks" width="w840" onClick={onNo} />}
      </div>
    </div>
  );
}

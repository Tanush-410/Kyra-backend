import "./KyraLoader.css";

/**
 * The Kyra star as the loading animation, in the middle of the screen. Figma: "KYRA Logo" (2043:13488)
 * in "Splash state" (2043:13484); design note: "the logo appears as the loading animation in the middle
 * of the screen everywhere the loading time is required".
 */
export default function KyraLoader({ label = "Loading" }) {
  return (
    <div className="kyra-loader" role="status" aria-label={label}>
      <img src={`${import.meta.env.BASE_URL}assets/brand/kyra-loader.svg`} alt="" width="251" height="251" />
    </div>
  );
}

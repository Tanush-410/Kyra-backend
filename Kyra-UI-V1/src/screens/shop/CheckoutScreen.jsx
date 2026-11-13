import { useNavigate } from "react-router-dom";
import ShopHeader from "../../components/ShopHeader.jsx";
import { useSessionGuard } from "../../hooks/useSessionGuard.js";
import OptionCard from "../../components/OptionCard.jsx";
import { SHOP_PATH } from "../../lib/shopRoutes.js";
import { KYRA_TAG_PATH } from "../../lib/nfcRoutes.js";
import "./shop.css";
import "./figma-shop.css";

/** The end of the shop flow: no payment, no QR. The visitor pays at the counter. */
export default function CheckoutScreen() {
  const navigate = useNavigate();
  const session = useSessionGuard();
  // "Would you like a Kyra Tag?", then Bye, which ends the visit (lib/nfcRoutes.js).
  const finish = () => navigate(KYRA_TAG_PATH, { replace: true });

  if (!session) return <div className="screen" />;

  return (
    <div className="screen">
      <ShopHeader showFilter={false} />
      {/* Figma "How can i help you" in Cart (2043:13555): title 905 wide at (87.5, 376), text from y 850. */}
      <main className="shop shop-figma checkout-figma">
        <h1 className="title checkout-figma__title">Thank you for shopping with us</h1>
        <p className="screen__text checkout-figma__text">Please complete your transaction at Counter 1 and collect your purchase.</p>
        {/* Not in the frame: a way on */}
        <div className="button-stack checkout-figma__buttons">
          <OptionCard label="Continue shopping" width="w840" onClick={() => navigate(SHOP_PATH)} />
          <OptionCard label="I’m done" width="w840" onClick={finish} />
        </div>
      </main>
    </div>
  );
}

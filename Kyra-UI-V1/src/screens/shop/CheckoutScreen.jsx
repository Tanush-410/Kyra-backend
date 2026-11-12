import { useNavigate } from "react-router-dom";
import ShopHeader from "../../components/ShopHeader.jsx";
import { useKyraSession } from "../../context/KyraSessionContext.jsx";
import { useSessionGuard } from "../../hooks/useSessionGuard.js";
import { SHOP_PATH } from "../../lib/shopRoutes.js";
import "./shop.css";

/** The end of the shop flow: no payment, no QR. The visitor pays at the counter. */
export default function CheckoutScreen() {
  const navigate = useNavigate();
  const session = useSessionGuard();
  const { end } = useKyraSession();

  const finish = async () => {
    await end();
    navigate("/", { replace: true });
  };

  if (!session) return <div className="screen" />;

  return (
    <div className="screen">
      <ShopHeader />
      <main className="screen__content shop">
        <div className="checkout__card">
          <h1 className="title title--h4">Thank you for shopping with us.</h1>
          <p className="shop__lede">
            Please complete your transaction at <strong>Counter 1</strong> and collect your purchase.
          </p>
          <p className="checkout__counter">Counter 1</p>
        </div>
        <div className="shop__actions">
          <button type="button" className="shop-button" onClick={() => navigate(SHOP_PATH)}>
            Continue shopping
          </button>
          <button type="button" className="shop-button shop-button--ghost" onClick={finish}>
            I'm done
          </button>
        </div>
      </main>
    </div>
  );
}

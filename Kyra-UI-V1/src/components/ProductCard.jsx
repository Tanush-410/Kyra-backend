import { formatPrice } from "../data/shopPlaceholders.js";
import "./ProductCard.css";

/**
 * A product tile. The data comes from shopPlaceholders today; the shape is the one a real store
 * feed would supply (brand, price, sizes, stock).
 */
export default function ProductCard({ product, onAdd, onEdit, addLabel = "Add to cart", wide = false }) {
  const outOfStock = !product.stock || product.stock < 1;
  return (
    <article className={`product-card${wide ? " product-card--wide" : ""}`}>
      <div className="product-card__image">
        <img src={`${import.meta.env.BASE_URL}assets/icons/${product.iconKey || "tops"}.png`} alt="" />
      </div>
      <div className="product-card__info">
        <span className="product-card__brand">{product.brand}</span>
        <h3 className="product-card__name">{product.name}</h3>
        <span className="product-card__price">{formatPrice(product.price)}</span>
        <p className="product-card__description">{product.description}</p>
        <ul className="product-card__tags">
          {product.tags.map((tag) => (
            <li key={tag}>{tag}</li>
          ))}
        </ul>
        <p className="product-card__note">Placeholder item · price, size and stock are mock data</p>
      </div>
      {(onAdd || onEdit) && (
        <div className="product-card__actions">
          {onAdd && (
            <button type="button" className={`product-card__action${outOfStock ? " product-card__action--muted" : ""}`} onClick={() => onAdd(product)}>
              {outOfStock ? "Out of stock" : addLabel}
            </button>
          )}
          {onEdit && (
            <button type="button" className="product-card__action product-card__action--ghost" onClick={() => onEdit(product)}>
              Edit
            </button>
          )}
        </div>
      )}
    </article>
  );
}

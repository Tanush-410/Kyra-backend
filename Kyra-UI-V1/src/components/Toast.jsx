import "./Toast.css";

export default function Toast({ toast }) {
  if (!toast) return null;
  return (
    <div key={toast.id} className="toast" role="status">
      {toast.message}
    </div>
  );
}

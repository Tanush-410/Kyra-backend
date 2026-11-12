import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { captureTokenFromLink } from "./config.js";
import "./styles/tokens.css";
import "./styles/global.css";

// The kiosk link (backend: npm run links) carries the access token after "#": keep it, then hide it.
captureTokenFromLink();

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

import React from "react";
import ReactDOM from "react-dom/client";
import PageInventoryView from "./PageInventoryView";
import "./styles.css";

// This branch runs the URL-first flow on its own. The previous interface is
// still in App.tsx, to be folded back in a piece at a time.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PageInventoryView />
  </React.StrictMode>
);

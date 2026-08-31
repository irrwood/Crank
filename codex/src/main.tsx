import React from "react";
import { createRoot } from "react-dom/client";
import { LocaleProvider } from "../../src/lib/locale";
import { FlowCanvas } from "./FlowCanvas";
import "./styles.css";

const root = document.createElement("div");
root.id = "crank-codex-root";
document.body.append(root);
createRoot(root).render(
  <React.StrictMode>
    <LocaleProvider><FlowCanvas /></LocaleProvider>
  </React.StrictMode>
);

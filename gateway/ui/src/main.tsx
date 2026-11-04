import React from "react";import{createRoot}from"react-dom/client";import App from "./App";import "./styles.css";
// Apply the saved or system theme before the first render, so nothing paints
// in the wrong theme and then animates (App keeps it in sync afterwards).
try{const saved=localStorage.getItem("wecommander-theme");const light=saved?saved==="light":!matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.classList.toggle("light",light);document.documentElement.style.colorScheme=light?"light":"dark"}catch{/* storage blocked: App falls back to the system theme */}
createRoot(document.getElementById("root")!).render(<React.StrictMode><App/></React.StrictMode>);
